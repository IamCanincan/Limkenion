/**
 * Agent 门面。
 *
 * 对外只有这一个类：建会话、读写档位、把一条用户消息交给一轮去跑。真正的分层在别处——
 * `session.ts` 存状态，`turn.ts` 驱动一轮，`turn-context.ts` 是一轮配置的快照，
 * `tool-pipeline.ts` 跑单次工具调用，`context-manager.ts` 管模型看到的东西（历史与说明文件）。
 *
 * 这里刻意只做转发：门面上少一分逻辑，改内部结构时就少一分顾虑。分层之前，主循环、上下文压缩、
 * 工具派发、说明文件注入全住在这一个类里，600 行里有四件互不相干的事。
 */

import type { Message } from "limkenion-ai";
import { applyPlanMode, applyStyle, forgetCalibration, refreshWorldState } from "./context-manager.ts";
import type { ApprovalMemory } from "./permissions/memory.ts";
import type { ApprovalMode } from "./permissions/modes.ts";
import { isPlanning, type PlanMode } from "./plan.ts";
import { type AgentOptions, createSessionState, type SessionState } from "./session.ts";
import type { OutputStyle } from "./style.ts";
import { runTurn } from "./turn.ts";
import type { AgentTool } from "./types.ts";

// 构造参数与默认轮数按原有路径转出：`limkenion-core` 的导出面与命令行、网页的取用点都不动。
export { type AgentOptions, DEFAULT_MAX_TURNS } from "./session.ts";

/** 最小 agent 内核 */
export class Agent {
	private readonly state: SessionState;

	constructor(options: AgentOptions) {
		this.state = createSessionState(options);
		// 建系统消息：构造时就算一次，之后每次进一轮之前再算。
		refreshWorldState(this.state);
	}

	/** 完整对话历史，第一条固定是系统消息 */
	get messages(): Message[] {
		return this.state.messages;
	}

	/**
	 * 本会话已被「总是允许」记下的前缀。
	 *
	 * 只在内存里、随 Agent 生命周期存在：它放宽的是审批档位的重复询问，不是安全边界——越界与
	 * 危险命令永远每次都问（见 approval-memory.ts）。
	 */
	get approvals(): ApprovalMemory {
		return this.state.approvals;
	}

	/** 当前是否处于计划模式（严格档或引导档都算） */
	get planning(): boolean {
		return isPlanning(this.state.planMode);
	}

	/** 当前计划模式档位 */
	get plan(): PlanMode {
		return this.state.planMode;
	}

	/** 当前输出风格 */
	get style(): OutputStyle {
		return this.state.style;
	}

	/** 当前是否开着上下文压缩 */
	get compactionEnabled(): boolean {
		return this.state.compaction;
	}

	/** 当前审批模式档位 */
	get approvalMode(): ApprovalMode {
		return this.state.approval;
	}

	/** 当前可调用的工具，宿主用它来展示能力清单 */
	listTools(): AgentTool[] {
		return this.state.tools;
	}

	/** 当前模型 id */
	get model(): string {
		return this.state.modelId;
	}

	/**
	 * 切换模型，历史保持不变。
	 *
	 * 用量校准跟着作废：它记的是「这批内容在那个模型上值多少 token」的比例，换了模型就不再成立，
	 * 留着只会把估算抬得虚高。
	 */
	setModel(modelId: string): void {
		if (this.state.modelId === modelId) {
			return;
		}
		this.state.modelId = modelId;
		forgetCalibration(this.state);
	}

	/**
	 * 换一把接口密钥。
	 *
	 * 供网页版这类「运行期才拿到密钥」的场景使用：密钥可以在界面上填，存下来之后下一次
	 * 调用就用新的，不需要重启进程。
	 */
	setApiKey(apiKey: string): void {
		this.state.apiKey = apiKey;
	}

	/**
	 * 切换上下文压缩，下一轮生效。
	 *
	 * 关掉它意味着上下文只会一直变长，直到撞上窗口上限——通常在排查「压缩是不是丢了我要的东西」
	 * 时才这么用。已经在历史里的内容不动：压缩不是破坏性操作，重新打开就继续按阈值压。
	 */
	setCompaction(enabled: boolean): void {
		this.state.compaction = enabled;
	}

	/**
	 * 切换输出风格。
	 *
	 * 风格只写在系统提示词里，所以重算一次系统消息就生效；工具、审批与计划模式一概不动。
	 */
	setStyle(style: OutputStyle): void {
		applyStyle(this.state, style);
	}

	/**
	 * 切换计划模式。
	 *
	 * 严格档下工具层只放行只读操作，其余一律拒绝并提示先交方案；引导档只改提示词。
	 * 提示词段落跟着档位走，所以这里要重算一次系统消息，切换立刻生效。
	 */
	setPlanMode(mode: PlanMode): void {
		applyPlanMode(this.state, mode);
	}

	/**
	 * 切换审批模式。
	 *
	 * 每次工具调用前都会重新读这个值，所以切换立刻生效，不需要重建 Agent；网页版让用户
	 * 按会话改「自动 / 每次确认 / 只读」靠的就是这里。
	 */
	setApprovalMode(mode: ApprovalMode): void {
		this.state.approval = mode;
	}

	/**
	 * 清空历史，只保留系统消息。
	 *
	 * 用量校准一并丢掉：它记的是刚才那批内容的真实 token 数，历史都没了还拿它当估算下限的话，
	 * 空会话的第一轮就会被判成「上下文该压缩了」。
	 */
	reset(): void {
		this.state.messages.splice(1);
		forgetCalibration(this.state);
	}

	/**
	 * 提交一条用户消息并跑完整个工具循环。
	 *
	 * 出错时发出 error 事件并返回，不会抛出：历史里不会留下残缺的助理消息，
	 * 因此调用方可以在修好问题后继续使用同一个 Agent。
	 *
	 * signal 用于取消本次调用；传新的 AbortController 就能实现「Ctrl+C 中断当前回答，
	 * 但继续留在会话里」，而不需要重建 Agent。
	 */
	async prompt(text: string, signal?: AbortSignal): Promise<void> {
		// 每轮开始前刷新：AGENTS.md 改了立刻生效，不改则保持原样。
		refreshWorldState(this.state);
		this.state.messages.push({ role: "user", content: text });
		await runTurn(this.state, signal ?? this.state.signal);
	}

	/**
	 * 接着当前这一轮继续跑，不追加新的用户消息。
	 *
	 * 给「上一轮失败了，重试一次」用：失败时用户消息已经进了历史、助理消息没有，历史正好停在
	 * 可以重发的位置。让宿主重新 prompt 一遍同一条指令会多出一条重复的用户消息，也会让「这一轮」
	 * 在会话记录里变成两轮。
	 */
	async resume(signal?: AbortSignal): Promise<void> {
		refreshWorldState(this.state);
		await runTurn(this.state, signal ?? this.state.signal);
	}
}
