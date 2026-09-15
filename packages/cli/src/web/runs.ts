/**
 * 会话运行管理。
 *
 * 一个「运行」把一个 JSONL 会话文件和一个 Agent 实例绑在一起。多个运行可以同时存在，
 * 各自独立推流、互不影响——这就是界面上能同时开多个会话并行的原因。
 *
 * 事件既广播给当前订阅者，也累积成 `pending` 快照，让中途连接或断线重连的浏览器
 * 能直接恢复现场，而不需要服务端回放整条增量日志。
 */

import { join } from "node:path";
import { type Message, resolveModel, type Usage } from "limkenion-ai";
import {
	type Agent,
	type AgentEvent,
	type ApprovalAnswer,
	type ApprovalMode,
	type ApprovalRequest,
	type ApprovalRule,
	addUsage,
	CheckpointStore,
	describeCompaction,
	EXIT_PLAN_MODE_TOOL,
	type GoalList,
	type JobRegistry,
	type OutputStyle,
	type PlanMode,
	type PlanVerdict,
	parseArguments,
	type RewindResult,
	type SubagentProgressTable,
	type TodoList,
} from "limkenion-core";
import { getAgentDir } from "../config.ts";
import { buildCommandPrompt, findCustomCommand, listCustomCommands } from "../custom-commands.ts";
import { type ReplacementDiff, replacementDiff } from "../diff.ts";
import { createRunRuntime, type RunHostConfig } from "../run-agent.ts";
import type { Session } from "../session.ts";
import {
	emptyTurn,
	type PendingApproval,
	type PendingTurn,
	type RunNotice,
	type SessionFacts,
	type ToolCard,
	type ToolCardInfo,
	type WebEvent,
} from "./protocol.ts";

/** 等待确认的最长时间：超时按拒绝，避免会话永远挂着 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** 等待方案评审的最长时间：超时按退回（不能替用户批准一次没人看过的改动） */
const PLAN_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

/** 状态提示最多留这么多条：它是运行日志，不该无限增长 */
const NOTICE_LIMIT = 20;

/**
 * 创建一个运行所需的配置。
 *
 * 宿主的全局那一半在 `run-agent.ts` 的 `RunHostConfig` 里：工厂要用它，而它不该反向依赖这里
 * （见那边的文件头，循环 import 的处理方式）。这里只补「与某一个会话有关」的那几项。
 */
export interface RunOptions extends RunHostConfig {
	/** 工作目录（会话头缺失时的兜底） */
	cwd: string;
	/** 审批模式，默认 auto（网页确认卡片在 ask 模式下才会出现） */
	approval?: ApprovalMode;
	/** 计划模式档位，默认 off（网页上的模式条可在运行期改） */
	planMode?: PlanMode;
	/** 输出风格，默认 default（网页上的模式条可在运行期改） */
	style?: OutputStyle;
	/** 上下文压缩，默认 true（网页侧栏的开关可在运行期改） */
	compaction?: boolean;
}

/** 单个会话的运行状态 */
export class Run {
	/** 绑定的会话文件 */
	readonly session: Session;

	/**
	 * 这个会话真正的工作目录。
	 *
	 * 取自**会话头**，而不是注册表的全局 cwd：会话属于它创建时所在的那个目录，全局 cwd 是
	 * 「新会话开在哪儿」以及「网页上的文件/终端看哪儿」，不是「这个会话在哪儿干活」。
	 * 两者必须分开，否则打开一个别的工作区的会话就得先把全局 cwd 切过去（一换就牵扯到同一进程里
	 * 所有别的会话），而「只给这一个会话换目录」根本做不到。
	 */
	readonly cwd: string;

	private readonly agent: Agent;
	private readonly options: RunOptions;
	/**
	 * 当前审批模式。
	 *
	 * 单独存一份的原因：这个值在运行期可变，而 `options` 是不可变的启动配置，不能互相覆盖；
	 * 它同时是 GET /modes 的答案来源。
	 */
	private currentApproval: ApprovalMode;
	/** 当前计划模式；同样是运行期可变，读的是 Agent 里那一份 */
	private plan: PlanMode;
	/** 当前输出风格；与 plan 一样是运行期可变的状态，真值在内核那份，这里只留一份给界面 */
	private styleName: OutputStyle;
	/** 上下文压缩开关；同样运行期可变（网页侧栏那个按钮就是改它） */
	private compactionOn: boolean;
	private readonly subscribers = new Set<(event: WebEvent) => void>();
	/** 工具调用开始时间，用于算耗时 */
	private readonly startedAt = new Map<string, number>();
	private abort: AbortController | null = null;
	/**
	 * 当前这一轮的收尾 promise。
	 *
	 * 单独存一份是为了让 `abortRun()` 能等到工具进程真的收完：网页上按停止只是终止生成，
	 * 但服务端关闭（尤其是测试里删临时目录）必须等到没有子进程还占着工作目录。
	 */
	private settled: Promise<void> = Promise.resolve();
	/** 逐轮快照：网页里也能回滚上一轮 */
	private readonly checkpoints: CheckpointStore;
	/** 这个会话的后台任务（界面那颗下拉按 id 轮询它） */
	readonly jobs: JobRegistry;
	/** 这个会话的子代理进度（界面那颗 subagents chip 按它画；取消开关也由它持有） */
	readonly subagents: SubagentProgressTable;
	/**
	 * 待办与目标的真值。
	 *
	 * 就**是**工具层正在用的那两份（`createRunRuntime` 建好、同时交给工具集），所以这里读到
	 * 的必然是模型刚写进去的那一份，不存在第二份状态要同步。
	 */
	private readonly todos: TodoList;
	private readonly goals: GoalList;
	/**
	 * 上一次播出去的 facts 指纹。
	 *
	 * 每次工具跑完比对一次，变了才发：这样不必在服务端写「哪些工具会改待办」的名单——
	 * 将来新增一个会写事实的工具，这里不用跟着改。代价是一次 JSON 序列化，几十项待办可以忽略。
	 */
	private factsFingerprint = "";
	/** 正在等待浏览器确认的那次工具调用 */
	private pendingApproval: ((answer: ApprovalAnswer) => void) | null = null;
	/** 正在等待浏览器评审的那个方案 */
	private pendingPlanReview: ((verdict: PlanVerdict) => void) | null = null;
	private pending: PendingTurn = emptyTurn();
	/** 已经写入磁盘的消息条数，避免重复追加 */
	private persisted = 0;
	/**
	 * 本会话的累计用量（跨轮）。
	 *
	 * 由服务端攒而不是浏览器攒：刷新页面、断线重连、两个标签页看同一个会话，都要看到同一个数——
	 * 浏览器自己攒会在刷新时归零，两个标签页还会各攒一份。它随快照重发。
	 */
	private usageTotals: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	private usageTurns = 0;
	/** 这个会话发生过的状态提示（压缩、救援、失败），有上限，随快照重发 */
	private readonly notices: RunNotice[] = [];
	private noticeSeq = 0;

	constructor(session: Session, options: RunOptions) {
		this.session = session;
		this.options = options;
		this.currentApproval = options.approval ?? "auto";
		this.plan = options.planMode ?? "off";
		this.styleName = options.style ?? "default";
		this.compactionOn = options.compaction ?? true;
		// 会话头是工作目录的权威来源，全局 cwd 只是兜底（老文件或手改坏了才会缺这个字段）。
		// 反过来取会串台：Run 会跟着「上一次全局切成什么」跑，同一个会话在两个目录之间来回漂。
		const cwd = session.header.cwd || options.cwd;
		this.cwd = cwd;

		/*
		 * 装配全部交给 `createRunRuntime`：这里原先有近百行
		 * 在接 agent 的工具集、后台任务、子代理与审批回调——「一个会话怎么跑」与「一个 agent 怎么造」
		 * 是两件事，混在构造函数里之后，光看 Run 是看不出它究竟装了些什么的。
		 */
		const runtime = createRunRuntime({
			session,
			cwd,
			host: options,
			modes: {
				approval: this.currentApproval,
				plan: this.plan,
				style: this.styleName,
				compaction: this.compactionOn,
			},
			// 取值函数而不是当前值：这个开关能在网页上随时改，之后新起的子代理要跟着当前值跑
			getCompaction: () => this.compactionOn,
			onEvent: (event) => this.handle(event),
			onApproval: (request) => this.requestApproval(request),
			onPlanReview: (plan) => this.requestPlanReview(plan),
		});
		this.agent = runtime.agent;
		this.jobs = runtime.jobs;
		this.subagents = runtime.subagents;
		// 网页这一侧一定有会话文件，快照必然建得出来；兜底只为把类型收紧，
		// 只有「不落盘的一次性模式」（命令行那边）才会真的没有快照。
		this.checkpoints = runtime.checkpoints ?? new CheckpointStore(session.file);
		// 这两份是工具层的状态本身，不是拷贝（见字段说明）
		this.todos = runtime.todos;
		this.goals = runtime.goals;

		// 续写已有会话的历史由工厂接上（`createRunRuntime` 里 `session.load()`）；
		// 这里只记下「已经落盘的是哪几条」，之后 persist() 从这里往后追加。
		this.persisted = this.agent.messages.length;
	}

	/** 是否正在生成 */
	get running(): boolean {
		return this.abort !== null;
	}

	/**
	 * 是否在等浏览器点一下（工具确认 / 方案评审）。
	 *
	 * 会话行上的状态点用它与 `running` 分开表达：等你的那种往往没在跑，却更要紧。
	 */
	get waiting(): boolean {
		return this.pendingApproval !== null || this.pendingPlanReview !== null;
	}

	/** 当前模型 id */
	get model(): string {
		return this.agent.model;
	}

	/** 切换模型，历史保持不变 */
	setModel(modelId: string): void {
		this.agent.setModel(modelId);
	}

	/** 当前审批模式 */
	get approval(): ApprovalMode {
		return this.currentApproval;
	}

	/**
	 * 切换审批模式，立刻生效。
	 *
	 * 不重建 Agent：重建会丢掉对话历史，而审批模式只是「下一次工具调用前怎么判」，
	 * 内核本来每次调用都会重新读，所以改一个值就够了。
	 */
	setApproval(mode: ApprovalMode): void {
		this.agent.setApprovalMode(mode);
		// 已经在这一档就不广播：另一个标签页把档位改成同一个值时，这边没必要白重绘一遍
		// （状态没变（`Object.is`）就别通知订阅者）。
		if (this.currentApproval === mode) {
			return;
		}
		this.currentApproval = mode;
		this.broadcastModes();
	}

	/** 当前计划模式档位 */
	get planMode(): PlanMode {
		return this.plan;
	}

	/**
	 * 切换计划模式，立刻生效。
	 *
	 * 严格档在工具层拦截、引导档改系统提示词，两者都由 Agent 内部的同一份状态决定；
	 * 这里只负责转发并让界面知道当前档位。
	 */
	setPlanMode(mode: PlanMode): void {
		this.agent.setPlanMode(mode);
		if (this.plan === mode) {
			return;
		}
		this.plan = mode;
		this.broadcastModes();
	}

	/** 当前输出风格 */
	get style(): OutputStyle {
		return this.styleName;
	}

	/**
	 * 切换输出风格，立刻生效。
	 *
	 * 风格只写在系统提示词里，所以内核那边重算一次系统消息就够了；工具、审批与计划模式一概不动
	 * （与命令行的 `/style` 是同一套语义）。
	 */
	setStyle(style: OutputStyle): void {
		this.agent.setStyle(style);
		if (this.styleName === style) {
			return;
		}
		this.styleName = style;
		this.broadcastModes();
	}

	/** 当前是否开着上下文压缩 */
	get compaction(): boolean {
		return this.compactionOn;
	}

	/**
	 * 切换上下文压缩，下一轮生效。
	 *
	 * 关掉意味着上下文只会一直变长，通常只在排查「压缩是不是丢了我要的东西」时才关；已经在历史里的
	 * 内容不动，重新打开就继续按阈值压。
	 */
	setCompaction(enabled: boolean): void {
		this.agent.setCompaction(enabled);
		if (this.compactionOn === enabled) {
			return;
		}
		this.compactionOn = enabled;
		this.broadcastModes();
	}

	/**
	 * 把当前模式作为状态事件播出去。
	 *
	 * 模式是「会话的运行态」而不是单个标签页的偏好：多个标签页看着同一个会话时，
	 * 一个改了另一个也要跟着显示，否则界面会显示一个并不生效的档位。
	 *
	 * 只在切换时发，不进 snapshot：连接快照的成员是既有契约（`history` / `pending` /
	 * `status`），模式由 `GET /modes` 负责，初值走那里就够。
	 */
	private broadcastModes(): void {
		this.broadcast({
			type: "modes",
			approval: this.currentApproval,
			planMode: this.plan,
			style: this.styleName,
			compaction: this.compactionOn,
		});
	}

	/** 把界面那份计划模式同步成内核里的真值（内核可能自己改过：方案被批准就离开计划模式） */
	private syncPlanMode(): void {
		if (this.plan !== this.agent.plan) {
			this.plan = this.agent.plan;
			this.broadcastModes();
		}
	}

	/**
	 * 发给浏览器的历史消息：去掉系统提示词，并**把正在跑的那一轮投影掉**。
	 *
	 * 为什么最后这条必需：`turn.ts` 在跑工具**之前**就把助理消息推进了 `agent.messages`，所以那一轮
	 * 还没结束时它已经在历史里了；而这一轮的正文与工具行又由 `pending` 快照单独带着。两处都发，
	 * 界面上就是**同一个工具行画两遍**（一条「未完成」来自历史，一条「运行中」来自 pending），
	 * 助理正文也跟着重复一遍。
	 *
	 * 判据「单条助理消息带工具调用」就够准：工具结果一跑完就紧跟着推一条 `tool` 消息，所以一条
	 * **末尾**的、带工具调用的助理消息，只可能是「工具还没跑完」的那一条。不带工具调用的助理消息
	 * 不在此列——它要等流式收完才入历史，那时 `pending` 里只是半截正文，两者不重复。
	 */
	messages(): Message[] {
		const visible = this.agent.messages.filter((message) => message.role !== "system");
		const last = visible.at(-1);
		if (last !== undefined && last.role === "assistant" && last.toolCalls.length > 0) {
			return visible.slice(0, -1);
		}
		return visible;
	}

	/**
	 * 让工具自己说这次调用在界面上要用的东西。
	 *
	 * 摘要、路径、交付物三件都由工具自陈（core 的 `summarize` / `pathOf` / `deliverables`），
	 * 界面不该认任何字段名——从前它认 bash→command、write→path/content、present→files，
	 * 加一个工具就要改一次前端。名字对不上（历史里留着已经删掉的工具）时什么都不给，
	 * 界面自己退回一行 JSON 与一个没有附加卡片的行。
	 */
	private cardInfoOf(name: string, input: Record<string, unknown>): ToolCardInfo {
		const tool = this.agent.listTools().find((candidate) => candidate.name === name);
		if (tool === undefined) {
			return { summary: "", path: null, deliverables: [] };
		}
		return { summary: tool.summarize(input), path: tool.pathOf(input), deliverables: tool.deliverables(input) };
	}

	/**
	 * 这次调用是不是把某个文件整份换掉（工具自陈 `fileReplacement`）；是就把前后对比一起算好。
	 *
	 * 差异在这一侧算：只有这里同时拿得到会话的工作目录与磁盘上的内容，而算法是**同一份**
	 * （`diff.ts`，「历史」面板的逐轮差异也用它）。界面拿到的已经是编好行号、切好段的行，
	 * 照着画就行。不是整份替换（改几处、删除、新建目录）返回 null。
	 */
	private changeOf(name: string, input: Record<string, unknown>): ReplacementDiff | null {
		const replacement =
			this.agent
				.listTools()
				.find((candidate) => candidate.name === name)
				?.fileReplacement(input) ?? null;
		return replacement === null ? null : replacementDiff(replacement.path, replacement.content, this.cwd);
	}

	/**
	 * 底部 dock 的两样事实：待办清单与目标。
	 *
	 * 从工具层的状态里现读（`list()` / `current` 都返回拷贝，界面改不到内部那份）。
	 */
	private facts(): SessionFacts {
		return { todos: this.todos.list(), goal: this.goals.current };
	}

	/**
	 * 事实变了才播出去。
	 *
	 * 调用点只有「一次工具跑完」与「清空上下文」：前者覆盖所有会改这两样的工具（不管它叫什么
	 * 名字），后者让界面跟着模型一起忘掉旧计划。指纹比对让「跑十个工具但待办没动」不发一条事件。
	 */
	private broadcastFacts(): void {
		const facts = this.facts();
		const fingerprint = JSON.stringify(facts);
		if (fingerprint === this.factsFingerprint) {
			return;
		}
		this.factsFingerprint = fingerprint;
		this.broadcast({ type: "facts", ...facts });
	}

	/**
	 * 历史快照：消息 + 「工具调用 id → 这一次调用在界面上要用的东西」。
	 *
	 * 摘要、路径与交付物在服务端算而不是让前端算：历史里只有原始的 `Message[]`，「哪个字段最要紧」
	 * 「这次碰哪个文件」「交付了哪几件」只有工具自己知道。带上这张表，刷新页面后工具行、预览入口与
	 * 交付物卡片跟实时跑出来的长得一样——没有它就会出现「刚跑完显示命令原文，刷新一次变成一坨 JSON」。
	 */
	private historySnapshot(): { messages: Message[]; cards: Record<string, ToolCardInfo> } {
		const messages = this.messages();
		const cards: Record<string, ToolCardInfo> = {};
		for (const message of messages) {
			if (message.role !== "assistant") {
				continue;
			}
			for (const call of message.toolCalls) {
				cards[call.id] = this.cardInfoOf(call.name, parseArguments(call.arguments) ?? {});
			}
		}
		return { messages, cards };
	}

	/** 当前进行中的一轮 */
	get pendingTurn(): PendingTurn {
		return this.pending;
	}

	/** 订阅事件，返回取消订阅的函数 */
	subscribe(listener: (event: WebEvent) => void): () => void {
		this.subscribers.add(listener);
		return () => {
			this.subscribers.delete(listener);
		};
	}

	/**
	 * 连接建立时要发的初始快照。
	 *
	 * 六类：历史、进行中的一轮、生成状态、状态提示（压缩/失败）、会话累计用量、待办与目标。
	 * 快照的成员是被测试与客户端都依赖的约定，所以新增一类要同步改契约测试；模式不在这里——
	 * 它由 `GET /api/sessions/:id/modes` 提供，切换时另发一条 `modes` 事件。
	 */
	snapshot(): WebEvent[] {
		return [
			{ type: "history", ...this.historySnapshot() },
			{ type: "pending", turn: this.pending },
			{ type: "status", running: this.running },
			{ type: "notices", items: [...this.notices] },
			// 会话累计用量：刷新页面、断线重连、换标签页都要看到同一个数。
			{ type: "usage", turns: this.usageTurns, usage: this.usageTotals },
			// 待办与目标同理：刷新页面后那两行 dock 要还在。
			{ type: "facts", ...this.facts() },
		];
	}

	/**
	 * 等浏览器确认一次工具调用。
	 *
	 * 没有人回答（页面关掉、用户走开）不能无限等：超时按拒绝处理，并让界面看到结论。
	 * 浏览器可以答「本会话总是允许」，那就把内核给出的前缀连同答案一起回传——记不记、记什么
	 * 由内核决定，界面只是个传话的。
	 */
	private async requestApproval(request: ApprovalRequest): Promise<ApprovalAnswer> {
		const suggested = request.suggestedPrefix;
		const card: PendingApproval = {
			tool: request.tool,
			input: request.input,
			reason: request.reason,
			// 正文与「看起来不可逆」都是工具自陈的，这里只转手——界面不必认识任何工具的字段名。
			detail: request.detail,
			destructive: request.destructive,
			// 整份替换时的「哪个文件、换成什么」也由工具自陈：卡片据此补一节前后对比。
			change: this.changeOf(request.tool, request.input),
		};
		if (suggested !== undefined) {
			card.suggestedPrefix = suggested;
		}
		// 先记进快照再广播：这样即便用户此刻刷新页面，新连接拿到的快照里也带着这张待确认卡片。
		this.pending.approval = card;
		this.broadcast({
			type: "approval",
			tool: request.tool,
			input: request.input,
			reason: request.reason,
			detail: request.detail,
			destructive: request.destructive,
			change: card.change,
			suggestedPrefix: suggested ?? null,
		});
		const answer = await new Promise<ApprovalAnswer>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingApproval = null;
				resolve({ approved: false });
			}, APPROVAL_TIMEOUT_MS);
			const finish = (value: ApprovalAnswer): void => {
				clearTimeout(timer);
				this.pendingApproval = null;
				resolve(value);
			};
			this.pendingApproval = finish;
			// 用户点了停止就不再等：直接当作拒绝。
			request.signal.addEventListener("abort", () => finish({ approved: false }), { once: true });
		});
		this.pending.approval = null;
		this.broadcast({ type: "approval_result", tool: request.tool, approved: answer.approved });
		return answer;
	}

	/** 浏览器给出的确认结果；没有待确认的调用时返回 false */
	resolveApproval(approved: boolean, remember = false): boolean {
		const pending = this.pendingApproval;
		if (!pending) {
			return false;
		}
		pending(remember ? { approved, remember: true } : { approved });
		return true;
	}

	/**
	 * 等浏览器评审一次方案。
	 *
	 * 与工具确认同一套骨架：先记进快照再广播，超时按「退回」处理（不能替用户批准一次没人看过的
	 * 改动），用户点停止也按退回收尾。
	 */
	private async requestPlanReview(plan: string): Promise<PlanVerdict> {
		this.pending.planReview = { plan };
		this.broadcast({ type: "plan_review", plan });
		const verdict = await new Promise<PlanVerdict>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingPlanReview = null;
				resolve({ approved: false, feedback: `等待评审超过 ${PLAN_REVIEW_TIMEOUT_MS / 60000} 分钟，已退回。` });
			}, PLAN_REVIEW_TIMEOUT_MS);
			const finish = (value: PlanVerdict): void => {
				clearTimeout(timer);
				this.pendingPlanReview = null;
				resolve(value);
			};
			this.pendingPlanReview = finish;
			this.abort?.signal.addEventListener(
				"abort",
				() => finish({ approved: false, feedback: "用户停止了这一轮。" }),
				{
					once: true,
				},
			);
		});
		this.pending.planReview = null;
		this.broadcast({ type: "plan_review_result", approved: verdict.approved });
		return verdict;
	}

	/** 浏览器给出的评审结论；没有待评审的方案时返回 false */
	resolvePlanReview(verdict: PlanVerdict): boolean {
		const pending = this.pendingPlanReview;
		if (!pending) {
			return false;
		}
		pending(verdict);
		return true;
	}

	/** 本会话已放行的规则（「总是允许」记下的那些），供界面展示 */
	approvals(): ApprovalRule[] {
		return this.agent.approvals.list();
	}

	/** 忘掉全部放行规则；返回清掉了几条 */
	clearApprovals(): number {
		const count = this.agent.approvals.size;
		this.agent.approvals.clear();
		return count;
	}

	/**
	 * 清空上下文：保留会话文件（与命令行的 `/clear` 一致），只是让模型忘掉之前的对话。
	 *
	 * 除了清内存里的历史，还要往会话文件里写一条 `clear` 标记：文件是追加式的，不写标记的话
	 * 重启服务或重开这个会话时 `load()` 会把旧对话又读回来，用户会以为清空没生效。
	 */
	clear(): void {
		if (this.running) {
			throw new Error("该会话正在生成中，请先停止或等待完成");
		}
		this.agent.reset();
		// 待办与目标跟着一起清：它们只通过工具结果进上下文，上下文一清，模型就看不见这份清单了，
		// 界面再留着那两行就会出现「dock 说有 5 项，模型却不知道有这回事」。
		this.todos.replace([]);
		this.goals.clear();
		this.session.markCleared();
		this.persisted = this.agent.messages.length;
		this.pushNotice({ kind: "info", text: "已清空上下文：之前的对话不再发给模型，会话文件仍然保留" });
		this.broadcast({ type: "history", ...this.historySnapshot() });
		this.broadcast({ type: "pending", turn: this.pending });
		this.broadcastFacts();
	}

	/** 回滚最近一轮对文件的改动；没有可回滚的轮次时返回 null */
	rewind(): RewindResult | null {
		return this.checkpoints.rewind();
	}

	/** 把一次失败告诉界面：记进状态提示，再补一次状态收尾，免得界面一直停在「生成中」 */
	reportError(message: string): void {
		this.pushNotice({ kind: "error", text: message });
		this.broadcast({ type: "status", running: false });
	}

	/**
	 * 提交一条用户消息并跑完整个工具循环。
	 *
	 * 同一会话不允许并发：两个 prompt 同时写同一个 agent.messages 会让历史错乱。
	 * 界面上的「并行」指的是多个会话同时跑，不是同一会话同时发两条。
	 */
	async prompt(text: string): Promise<void> {
		if (this.running) {
			throw new Error("该会话正在生成中，请先停止或等待完成");
		}
		if (!this.ensureKey()) {
			return;
		}
		/*
		 * 斜杠命令在这里展开，而且只在这里：`retry()` 走的是 `agent.resume()`，用的是历史里那条
		 * 已经展开过的指令，所以重试不会把 `[自定义命令 …]` 再包一层。目录与命令行的
		 * `commandsDir` 同一处（cli.ts：<配置目录>/commands），每次重新读一遍文件即可生效。
		 */
		const expanded = expandSlashCommand(text, join(getAgentDir(), "commands"));
		await this.startTurn((signal) => this.agent.prompt(expanded, signal));
	}

	/**
	 * 重试上一轮：不追加新的用户消息，直接把历史里最后那条指令再跑一次。
	 *
	 * 只在上一轮以 error 结束时才有意义——失败时用户消息已经进了历史、助理消息没有，历史正好停在
	 * 可以重发的位置。界面上那个「重试」按钮走这里，而不是把同一条指令再提交一遍：后者会在会话
	 * 记录里多出一条重复的用户消息，也会让「一轮」变成两轮。
	 */
	async retry(): Promise<void> {
		if (this.running) {
			throw new Error("该会话正在生成中，请先停止或等待完成");
		}
		if (!this.ensureKey()) {
			return;
		}
		const lastUser = [...this.agent.messages].reverse().find((message) => message.role === "user");
		if (lastUser === undefined) {
			this.reportError("没有可重试的指令");
			return;
		}
		await this.startTurn((signal) => this.agent.resume(signal));
	}

	/** 生成前重新取一次密钥；返回 false 表示已经通过事件流报告过错误 */
	private ensureKey(): boolean {
		// 密钥在每次生成前重新取：网页上刚填的密钥立刻生效，不必重启服务。
		const key = this.options.resolveApiKey();
		if (key === "") {
			// HTTP 那边早就回了 202，只能通过事件流告诉界面，否则会卡在「生成中」。
			this.reportError("还没有配置接口密钥，先点侧栏的「接口密钥」填一个");
			return false;
		}
		this.agent.setApiKey(key);
		return true;
	}

	/** 一轮的公共外壳：起快照、置状态、提交回滚链、结束后整体重绘 */
	private async startTurn(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
		this.pending = emptyTurn();
		this.startedAt.clear();
		this.abort = new AbortController();
		// 一轮 = 一条用户指令；回滚的单位与命令行一致。
		this.checkpoints.begin();
		this.broadcast({ type: "status", running: true });

		let settle = (): void => {};
		this.settled = new Promise<void>((resolve) => {
			settle = resolve;
		});

		try {
			await run(this.abort.signal);
		} finally {
			this.abort = null;
			// 失败的轮次不提交，因此不会进入回滚链。
			this.checkpoints.commit();
		}

		this.persist();
		// 一轮结束后用权威历史整体重绘，客户端不需要自己对齐增量。
		this.pending = emptyTurn();
		this.broadcast({ type: "history", ...this.historySnapshot() });
		this.broadcast({ type: "pending", turn: this.pending });
		this.broadcast({ type: "status", running: false });
		settle();
	}

	/** 停止当前生成，返回本轮结束的 promise（本来就空闲时立即兑现） */
	abortRun(): Promise<void> {
		// 子代理是独立的模型循环：只停主对话的话，它们会接着烧 token
		this.stopSubagents();
		this.abort?.abort();
		return this.settled;
	}

	/** 收掉这个会话还在跑的子代理（取消开关由进度表持有，行会由 runSubagents 标成已中断） */
	stopSubagents(): void {
		this.subagents.stopAll();
	}

	/**
	 * 会话收尾：把这个会话起的后台任务与子代理一起收掉。
	 *
	 * 删除会话、服务端关闭时都要走这里——后台任务是**真的进程**、子代理是**独立的模型循环**，
	 * 会话没了还留着就是泄漏。子代理的进度表也跟着清（它的结论属于那个会话，会话不在了就没有意义）。
	 */
	cleanup(): void {
		this.jobs.killAll();
		this.stopSubagents();
		this.subagents.clear();
	}

	/** 把尚未落盘的消息追加到会话文件 */
	private persist(): void {
		for (const message of this.agent.messages.slice(this.persisted)) {
			this.session.append(message);
		}
		this.persisted = this.agent.messages.length;
	}

	/** 把 Agent 事件翻译成界面事件并维护进行中状态 */
	private handle(event: AgentEvent): void {
		switch (event.type) {
			case "reasoning":
				this.pending.reasoning += event.delta;
				this.broadcast({ type: "reasoning", delta: event.delta });
				return;
			case "text":
				this.pending.text += event.delta;
				this.broadcast({ type: "text", delta: event.delta });
				return;
			case "tool_start": {
				const info = this.cardInfoOf(event.name, event.input);
				const card: ToolCard = {
					id: event.id,
					name: event.name,
					input: event.input,
					...info,
					status: "running",
					content: "",
					ms: 0,
				};
				this.pending.tools.push(card);
				this.startedAt.set(event.id, Date.now());
				this.broadcast({ type: "tool_start", id: event.id, name: event.name, input: event.input, ...info });
				return;
			}
			case "tool_end": {
				const ms = Date.now() - (this.startedAt.get(event.id) ?? Date.now());
				this.startedAt.delete(event.id);
				const card = this.pending.tools.find((candidate) => candidate.id === event.id);
				if (card) {
					card.status = event.outcome.isError ? "error" : "ok";
					card.content = event.outcome.content;
					card.ms = ms;
				}
				// 方案被批准时内核会自己离开计划模式（onApproved 回调），这里把界面那份同步过来：
				// 否则档位 chip 还写着「计划 · 严格」，而模型已经开始动手了。
				if (event.name === EXIT_PLAN_MODE_TOOL) {
					this.syncPlanMode();
				}
				this.broadcast({
					type: "tool_end",
					id: event.id,
					name: event.name,
					content: event.outcome.content,
					isError: event.outcome.isError,
					ms,
					// 摘要在 tool_start 时已经算好并放进卡片；这里沿用，避免同一行前后换措辞。
					// 路径与交付物同理：同一行的三件信息都来自工具自陈，前后必须一致。
					summary: card?.summary ?? "",
					path: card?.path ?? null,
					deliverables: card?.deliverables ?? [],
				});
				// 待办与目标可能刚被这次调用改过（工具自己知道改了没，这里只比对指纹）。
				this.broadcastFacts();
				return;
			}
			case "done":
				/*
				 * 用量一并转出去。三个字段都是事实：`usage` 是本轮累计，`contextTokens` 是最后一次
				 * 请求实际发出去的 prompt token 数（上下文占用看的是它），`contextWindow` 是这一轮
				 * 所用模型的窗口——放在事件里，前端不必自己再维护一份模型表。
				 */
				this.broadcast({
					type: "done",
					turns: event.turns,
					usage: event.usage,
					contextTokens: event.contextTokens ?? null,
					contextWindow: resolveModel(this.agent.model).contextWindow,
				});
				// 会话累计由服务端攒：浏览器自己攒会在刷新时归零，两个标签页也会各攒一份。
				if (event.usage !== null) {
					this.usageTotals = addUsage(this.usageTotals, event.usage) ?? this.usageTotals;
					this.usageTurns += 1;
					this.broadcast({ type: "usage", turns: this.usageTurns, usage: this.usageTotals });
				}
				return;
			case "compaction":
				this.pushNotice({ kind: "info", text: describeCompaction(event) });
				return;
			case "error":
				// 失败原因的分类一并转出去：界面据此决定要不要给「重试」，而不是去猜错误文案。
				this.pushNotice({
					kind: "error",
					text: event.message,
					...(event.code === undefined ? {} : { code: event.code }),
					...(event.status === undefined ? {} : { status: event.status }),
					...(event.retryable === undefined ? {} : { retryable: event.retryable }),
					...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
				});
				return;
		}
	}

	/**
	 * 记一条状态提示并播出去。
	 *
	 * 只留最近 NOTICE_LIMIT 条：这是「运行日志」，不是无限增长的记录。连续重复的**普通提示**
	 * （比如反复裁剪同一段）只留一份，免得把日志刷满；失败不合并——用户点了重试又失败，
	 * 日志里就该多一条，否则看起来像什么都没发生。
	 */
	private pushNotice(notice: Omit<RunNotice, "id">): void {
		const last = this.notices.at(-1);
		if (notice.kind === "info" && last && last.kind === notice.kind && last.text === notice.text) {
			return;
		}
		this.noticeSeq += 1;
		this.notices.push({ id: this.noticeSeq, ...notice });
		if (this.notices.length > NOTICE_LIMIT) {
			this.notices.splice(0, this.notices.length - NOTICE_LIMIT);
		}
		this.broadcast({ type: "notices", items: [...this.notices] });
	}

	private broadcast(event: WebEvent): void {
		for (const listener of this.subscribers) {
			try {
				listener(event);
			} catch {
				// 单个订阅者出错（通常是 socket 已断）不能影响其它订阅者。
				this.subscribers.delete(listener);
			}
		}
	}
}

/**
 * 把以 `/` 开头的输入展开成自定义命令的提示词；不是已知命令就原样返回。
 *
 * 与 REPL 只差一处，而且是有意的：REPL 认不出命令时会报「未知命令 /xxx」并把这一行丢掉，
 * 网页则原样发给模型——`/etc/hosts 是什么` 这种问题本来就该问得出口，不该被当成命令吃掉，
 * 更不该回一句错误。命令名按 custom-commands.ts 的字符集（小写字母、数字、短横线、下划线）
 * 切出第一个词，所以 `/etc/hosts` 里那个 `/` 之后再出现斜杠时整条不匹配，路径不会被误判。
 *
 * 展开复用命令行同一份实现（`buildCommandPrompt` → `expandCommand`）：`$ARGUMENTS` 的替换、
 * 没有占位符时把参数附在末尾的做法、以及 `[自定义命令 /名字]` 这层包装完全一致。
 *
 * 纯函数：命令目录由调用方给，测试不用起服务器。
 */
export function expandSlashCommand(text: string, commandsDir: string): string {
	const match = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text);
	if (match === null) {
		return text;
	}
	// 每次读一遍目录：命令就是几个 Markdown 文件，改了文件不必重启服务。
	const command = findCustomCommand(listCustomCommands(commandsDir), match[1] ?? "");
	if (command === null) {
		return text;
	}
	return buildCommandPrompt(command, match[2] ?? "");
}
