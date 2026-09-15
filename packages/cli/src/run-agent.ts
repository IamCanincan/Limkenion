/**
 * 造一个「运行时」：Agent 本体，加上它干活时要用的那几样东西（后台任务、子代理进度、逐轮快照、待办与目标）。
 *
 * **装配**与**生命周期**分开：装配负责把一个 agent
 * 造出来并把它的工具集、权限、上下文全部接好，调用方只管等着它跑。这里做的是同一件事：`Run`
 * 的构造函数原先有近百行都在接这些东西，而「一个会话怎么跑」与「一个 agent 怎么造」是两件事。
 *
 * **两个载体共用这一份**：浏览器界面（`web/runs.ts`）与命令行（`cli.ts` 的 `createCliRuntime`）。
 * 这条是踩出来的——命令行原先自己拼工具集、忘了传 `subagents`，于是**终端里根本没有子代理工具**
 * （`createSystemTools` 只有在收到 `subagents` 时才注册那四个），而网页有。同一份能力不该因为
 * 载体不同就少一块，所以装配只有这一处。
 *
 * **刻意不抄它的一处**：那边的 `runAgent` 有 18 个位置参数、其中 4 个是回调（`runAgent.ts:248-329`），
 * 而三个分析报告都把它列为「明显不该照搬」——参数一多，调用点就读不出「谁是谁」，加一个开关就动
 * 全部调用点。这里改成**一个配置对象**，而且按「宿主配置 / 会话档位 / 三个回调」分了组。
 *
 * 这个模块**不 import `runs.ts`**：配置契约定义在工厂这一侧（`RunHostConfig`），`RunOptions` 去
 * extends 它。反过来的话 `runs.ts` ↔ `run-agent.ts` 就成环了——ESM 里类型环能编过去，但那属于
 * 「现在能跑、改一处就炸」的那类结构。
 */

import {
	Agent,
	type AgentEvent,
	type ApprovalAnswer,
	type ApprovalMode,
	type ApprovalRequest,
	CheckpointStore,
	createSystemTools,
	GoalList,
	JobRegistry,
	type OutputStyle,
	type PlanMode,
	type PlanVerdict,
	type PreToolUseHook,
	SPILL_TOOL_OUTPUT_BYTES,
	SubagentProgressTable,
	type SubagentTask,
	TodoList,
} from "limkenion-core";
import type { Session } from "./session.ts";

/**
 * 宿主的全局配置：这些东西与「哪一个会话」无关，整台服务器（或一次命令行调用）只有一份。
 *
 * 抽出来是为了不让工厂反向依赖 `RunOptions`（见文件头）。`RunOptions` extends 它。
 */
export interface RunHostConfig {
	/**
	 * 取当前生效的接口密钥。
	 *
	 * 是个函数而不是字符串：密钥可以在网页上填，取的时候才决定用哪一把，
	 * 这样填完立刻生效，也不用为了换密钥重建运行。
	 */
	resolveApiKey: () => string;
	/** 默认模型 id */
	modelId: string;
	/** 覆盖接口地址 */
	baseUrl?: string;
	/** 单次指令最多几轮工具调用 */
	maxTurns?: number;
	/** 请求失败（限速、5xx、网络抖动）时的重试次数，不给就用内核默认 */
	retries?: number;
	/** 全局配置目录，其 AGENTS.md 作为跨项目的个人偏好 */
	globalConfigDir?: string;
	/** 过大的工具输出落盘到这个目录 */
	spillDir?: string;
	/** 覆盖 fetch，仅用于测试 */
	fetchImpl?: typeof fetch;
	/** PreToolUse 钩子：命令行从设置里读，网页暂时没有这一项 */
	hooks?: PreToolUseHook[];
	/** 每次准备重试时回调；命令行用它往 stderr 打一行 */
	onRetry?: (info: { attempt: number; delayMs: number }) => void;
}

/** 造一个运行时所需的一切 */
export interface RunRuntimeConfig {
	/**
	 * 绑定的会话文件：历史、逐轮快照、子代理都用它的路径。
	 *
	 * `null` 表示这一次不落盘（命令行的一次性模式默认如此）：历史只活在内存里，
	 * 逐轮快照也就无从记起——`checkpoints` 因此是 undefined，`/rewind` 那类能力自动缺席。
	 */
	session: Session | null;
	/**
	 * 这个会话真正的工作目录。
	 *
	 * 由调用方从**会话头**取（不是全局 cwd）：会话属于它创建时所在的那个目录，全局 cwd 是
	 * 「新会话开在哪儿」，不是「这个会话在哪儿干活」。
	 */
	cwd: string;
	/** 宿主配置 */
	host: RunHostConfig;
	/** 几个档位的**初值**；运行期改动由 Agent 自己的状态承载 */
	modes: { approval: ApprovalMode; plan: PlanMode; style: OutputStyle; compaction: boolean };
	/**
	 * 压缩开关的**当前值**。
	 *
	 * 与上面那几个初值不同，它是取值函数：这个开关能在网页上随时改，而之后新起的子代理应当跟着
	 * 当前值跑（子代理在起的那一刻读它）。捕获成一个布尔值会把「改了开关但子代理还按老规矩压」
	 * 这种不一致固化下来。
	 */
	getCompaction: () => boolean;
	/** 事件出口：工具行、正文增量、错误都从这里出去 */
	onEvent: (event: AgentEvent) => void;
	/** 需要用户拿主意的两件事 */
	onApproval: (request: ApprovalRequest) => Promise<boolean | ApprovalAnswer>;
	onPlanReview: (plan: string) => Promise<PlanVerdict>;
	/** 直接指定逐轮快照；不给就按会话文件路径建（`session` 为 null 时没有） */
	checkpoints?: CheckpointStore;
}

/** 造出来的运行件 */
export interface RunRuntime {
	/** 主对话的 agent */
	agent: Agent;
	/** 这个会话的后台任务（界面那颗下拉按 id 轮询它，终端用 `/jobs`） */
	jobs: JobRegistry;
	/** 这个会话的子代理进度（界面那颗 chip 按它画，终端用 `/subagents`；取消开关也由它持有） */
	subagents: SubagentProgressTable;
	/** 逐轮快照：能回滚上一轮；一次性模式（不落盘）时是 undefined */
	checkpoints: CheckpointStore | undefined;
	/**
	 * 待办清单与目标的**真实状态**。
	 *
	 * 由工具层持有、调用方转给界面/终端，而不是让界面回头去解析历史里那条 `todo_write` 的入参。
	 * 解析法有个真缺陷：上下文压缩会把那条工具调用折进摘要，界面就再也找不到清单，
	 * 底部那行「还剩几项」会在跑到一半时凭空清空。状态在内存里，就不受压缩影响。
	 */
	todos: TodoList;
	goals: GoalList;
}

/** 造一个运行时 */
export function createRunRuntime(config: RunRuntimeConfig): RunRuntime {
	const { session, cwd, host } = config;

	// 后台任务归这个会话：注册表建在这里（不是 createSystemTools 里的兜底），
	// 这样界面/终端才拿得到它，进程收尾也能跟会话绑在一起。
	const jobs = new JobRegistry({ cwd });
	// 子代理进度表同理：界面画谱系用它，取消开关也由它持有。
	const subagents = new SubagentProgressTable();
	const checkpoints = config.checkpoints ?? (session === null ? undefined : new CheckpointStore(session.file));
	// 待办与目标：工具层改的就是这两份，调用方只把它们转给界面/终端（见 `RunRuntime` 的说明）
	const todos = new TodoList();
	const goals = new GoalList();

	/*
	 * 「怎么跑一个子代理」。
	 *
	 * 主 agent 与子代理的唯一区别在工具集：子代理那条路上传 `source: "subagent"`，于是子代理工具
	 * 根本不会被注册——套娃的代价是不可控的上下文与花费，深度上限 1 是硬规矩，而这条规矩靠能力裁剪
	 * 保证，不靠调用方记得少传一个参数。
	 *
	 * **档位、钩子与重试都跟着父 agent 走**（这一条是补上来的漏洞）：子代理从前一律 `auto` 起，
	 * 于是「ask 档下动手前要问一句」对子代理不成立——它可以在没人点头的情况下改文件；计划模式
	 * （严格）同理，父被挡住而子代理能写。子代理不弹确认卡片（它是主 agent 某一步的延伸，
	 * 一次委派弹两次会把「等你点一下」变成常态），所以继承 `ask` 之后它在没有确认入口时按
	 * **拒绝**处理——只读地干活，这正是要的 fail-closed。
	 */
	const subagentRun = async (task: SubagentTask, signal: AbortSignal): Promise<string> => {
		const child = new Agent({
			apiKey: host.resolveApiKey(),
			modelId: host.modelId,
			baseUrl: host.baseUrl,
			cwd,
			tools: createSystemTools({
				cwd,
				source: "subagent",
				checkpoints: checkpoints === undefined ? undefined : new CheckpointStore(checkpoints.file),
				maxBytes: SPILL_TOOL_OUTPUT_BYTES,
			}),
			// 读的是父 agent 当下的档位（运行期改过也跟得上），不是构造时的初值
			approval: agent.approvalMode,
			planMode: agent.plan,
			style: agent.style,
			compaction: config.getCompaction(),
			maxTurns: host.maxTurns,
			retries: host.retries,
			hooks: host.hooks,
			globalConfigDir: host.globalConfigDir,
			spillDir: host.spillDir,
			fetchImpl: host.fetchImpl,
			onRetry: host.onRetry,
		});
		// 取消开关由进度表持有（工具层起它时登记）：这里只跟着传进来的信号走
		await child.prompt(task.prompt, signal);
		// 结论取最后一条有正文的助理消息（工具行与推理不算）
		for (const message of [...child.messages].reverse()) {
			if (message.role === "assistant" && typeof message.content === "string" && message.content.trim() !== "") {
				return message.content;
			}
		}
		return "";
	};

	const agent = new Agent({
		apiKey: host.resolveApiKey(),
		modelId: host.modelId,
		baseUrl: host.baseUrl,
		cwd,
		tools: createSystemTools({
			cwd,
			checkpoints,
			maxBytes: SPILL_TOOL_OUTPUT_BYTES,
			jobs,
			subagents: { run: subagentRun, table: subagents },
			// 复用外面建的那两份：界面/终端要按它们显示，而工具层改的就是它们
			todos,
			goals,
		}),
		approval: config.modes.approval,
		planMode: config.modes.plan,
		style: config.modes.style,
		compaction: config.modes.compaction,
		onApproval: config.onApproval,
		// 方案评审：计划模式下模型调用 exit_plan_mode 时走到这里。不注册这个工具的话，
		// 提示词让模型「用 exit_plan_mode 提交方案」就成了一句空话——模型会调到一个不存在的工具，
		// 而且除了手动拨档位没有别的出路。
		onPlanReview: config.onPlanReview,
		maxTurns: host.maxTurns,
		retries: host.retries,
		hooks: host.hooks,
		onRetry: host.onRetry,
		globalConfigDir: host.globalConfigDir,
		spillDir: host.spillDir,
		fetchImpl: host.fetchImpl,
		onEvent: config.onEvent,
	});
	if (session !== null) {
		agent.messages.push(...session.load());
	}

	return { agent, jobs, subagents, checkpoints, todos, goals };
}
