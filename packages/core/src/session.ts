/**
 * 会话状态。
 *
 * 内核的「事实来源」集中在这一个对象上：对话历史、模型与档位、放行记忆、token 校准、事件出口。
 * 它只存数据、不含流程——`Agent` 是它的公开壳，另外三个部件围着它转：
 * `context-manager.ts` 管模型看到的东西（历史、说明文件、压缩），`turn.ts` 驱动一轮，
 * `tool-pipeline.ts` 跑单次工具调用。
 *
 * 拆的理由：先把「状态是什么」写清楚，各个部件再只读自己该读的那几项。
 * 以前这些字段全是 `Agent` 的 private，任何一段流程要用都得挂在同一个类上，于是主循环、
 * 上下文压缩、工具派发越挤越紧，一个 600 行的类里同时住着四件事。
 *
 * 构造之后不再改的字段标 `readonly`（编译期约束）；运行期会变的字段不标——审批、计划模式、
 * 模型这几项本来就要在跑动中随时可改，网页版靠的就是这一点。
 */

import { DEFAULT_MODEL_ID, type Message } from "limkenion-ai";
import type { UsageCalibration } from "./compaction.ts";
import { applyPlanMode } from "./context-manager.ts";
import { RepeatGuard } from "./guard.ts";
import type { PreToolUseHook } from "./hooks.ts";
import type { InstructionFile } from "./instructions.ts";
import type { ApprovalAnswer, ApprovalRequest } from "./permissions/decision.ts";
import { ApprovalMemory } from "./permissions/memory.ts";
import type { ApprovalMode } from "./permissions/modes.ts";
import { createExitPlanModeTool, isPlanning, type PlanMode, type PlanVerdict } from "./plan.ts";
import type { OutputStyle } from "./style.ts";
import type { AgentEvent, AgentTool } from "./types.ts";

/** 构造 Agent 所需参数 */
export interface AgentOptions {
	/** DeepSeek 接口密钥 */
	apiKey: string;
	/** 模型 id，缺省 deepseek-flash */
	modelId?: string;
	/** 覆盖接口地址 */
	baseUrl?: string;
	/** 工具解析相对路径时使用的基准目录 */
	cwd: string;
	/** 可调用的工具 */
	tools: AgentTool[];
	/** 覆盖默认系统提示词 */
	systemPrompt?: string;
	/**
	 * 直接指定要注入的说明文件。
	 *
	 * 不传则每次 prompt 前自动从工作目录向上发现 AGENTS.md 一类文件；传空数组表示
	 * 明确不要注入任何项目说明。
	 */
	instructions?: InstructionFile[];
	/** 自动发现时使用的全局配置目录，其 AGENTS.md 作为跨项目的个人偏好 */
	globalConfigDir?: string;
	/** 单次 prompt 内最多几轮模型调用，防止工具调用成环 */
	maxTurns?: number;
	/** 采样温度 */
	temperature?: number;
	/** PreToolUse 钩子：内置判定放行后，交用户脚本再判断（可拒绝、可改写入参） */
	hooks?: PreToolUseHook[];
	/** 计划模式：`off` / `strict`（工具层强制只读）/ `guide`（提示词引导） */
	planMode?: PlanMode;
	/** 计划模式下用户评审方案的方式；不提供时 `exit_plan_mode` 会明确要求改用文字回答 */
	onPlanReview?: (plan: string) => Promise<PlanVerdict>;
	/** 输出风格：只影响怎么讲，不影响工具、审批与计划模式 */
	style?: OutputStyle;
	/** 上下文压缩：默认开启；传 false 关闭（长任务里不建议关） */
	compaction?: boolean;
	/** 触发摘要压缩的上下文占用比例，默认 0.75 */
	compactionThreshold?: number;
	/** 工具输出过大时的落盘目录；不给就照原样交给模型（工具自己会截断） */
	spillDir?: string;
	/** 审批模式：auto 全部放行、ask 读写前确认、readonly 只读 */
	approval?: ApprovalMode;
	/** ask 模式下怎么问用户；没有它时按拒绝处理。返回对象里的 remember 表示「本会话总是允许」 */
	onApproval?: (request: ApprovalRequest) => Promise<boolean | ApprovalAnswer>;
	/** 请求失败（限速、5xx、网络抖动）时的重试次数，默认 2 */
	retries?: number;
	/** 每次准备重试时回调，CLI 用它写一行 stderr 提示 */
	onRetry?: (info: { attempt: number; delayMs: number }) => void;
	/** 事件回调，用于渲染增量输出 */
	onEvent?: (event: AgentEvent) => void;
	/** 取消信号，触发后正在进行的模型调用与工具执行都会尽快停止 */
	signal?: AbortSignal;
	/** 覆盖 fetch，仅用于测试 */
	fetchImpl?: typeof fetch;
}

/** 默认的最大轮数（命令行与网页都拿它当默认值，所以导出而不是各处再写一个 25） */
export const DEFAULT_MAX_TURNS = 25;

/**
 * 会话状态。
 *
 * 上半段是「构造后即定下」的配置，下半段是运行期可改的运行态；分开写是为了让「谁会变」一目了然。
 */
export interface SessionState {
	/** 完整对话历史，第一条固定是系统消息 */
	readonly messages: Message[];
	/** 可调用的工具（含内核自己挂上的 `exit_plan_mode`） */
	readonly tools: AgentTool[];
	/** 工作目录：工具解析相对路径、审批判越界都以它为准 */
	readonly cwd: string;
	/** 单次 prompt 内最多几轮模型调用 */
	readonly maxTurns: number;
	/** 采样温度 */
	readonly temperature: number | undefined;
	/** PreToolUse 钩子 */
	readonly hooks: PreToolUseHook[];
	/** 大输出落盘目录；不给就照原样交给模型 */
	readonly spillDir: string | undefined;
	/** 请求失败的重试次数 */
	readonly retries: number | undefined;
	/** 覆盖 fetch，仅用于测试 */
	readonly fetchImpl: typeof fetch | undefined;
	/** 未提供取消信号时用一个永不被触发的信号，省去调用方到处判空 */
	readonly signal: AbortSignal;
	/** 覆盖接口地址 */
	readonly baseUrl: string | undefined;
	/** 显式指定的系统提示词；设置后不再自动发现说明文件 */
	readonly systemPromptOverride: string | undefined;
	/** 显式指定的说明文件；undefined 表示每次进一轮之前自动发现 */
	readonly instructionsOverride: InstructionFile[] | undefined;
	/** 自动发现说明文件时使用的全局配置目录 */
	readonly globalConfigDir: string | undefined;
	/** 触发摘要压缩的上下文占用比例 */
	readonly compactionThreshold: number;
	/** 计划模式下请用户评审方案；不提供时不挂 `exit_plan_mode` */
	readonly onPlanReview: ((plan: string) => Promise<PlanVerdict>) | undefined;
	/** ask 模式下怎么问用户 */
	readonly onApproval: ((request: ApprovalRequest) => Promise<boolean | ApprovalAnswer>) | undefined;
	/** 每次准备重试时回调 */
	readonly onRetry: ((info: { attempt: number; delayMs: number }) => void) | undefined;
	/** 事件出口；构造时就把 onEvent 包一层，省得每个部件都判一次空 */
	readonly emit: (event: AgentEvent) => void;
	/**
	 * 本会话已被「总是允许」记下的前缀。
	 *
	 * 只在内存里、随会话生命周期存在：它放宽的是审批档位的重复询问，不是安全边界——越界与
	 * 危险命令永远每次都问（见 approval-memory.ts）。
	 */
	readonly approvals: ApprovalMemory;
	/** 重复调用追踪；跨轮存活，所以「同一个调用反复出现」能被认出来 */
	readonly repeats: RepeatGuard;

	/** 接口密钥；网页版可以在界面上换，所以运行期可改 */
	apiKey: string;
	/** 模型 id；换模型不影响历史 */
	modelId: string;
	/** 计划模式档位 */
	planMode: PlanMode;
	/** 输出风格 */
	style: OutputStyle;
	/** 是否开着上下文压缩 */
	compaction: boolean;
	/** 审批模式 */
	approval: ApprovalMode;
	/** 上一次真实请求的用量校准；拿不到时退回字符估算 */
	calibration: UsageCalibration | null;
	/** 上一次注入的说明文件指纹；null 表示还没算过（首次不算「变化」） */
	instructionsSignature: string | null;
}

/** 按构造参数建一份会话状态；系统消息由 context-manager 在最后补上 */
export function createSessionState(options: AgentOptions): SessionState {
	const state: SessionState = {
		messages: [],
		tools: [...options.tools],
		cwd: options.cwd,
		maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
		temperature: options.temperature,
		hooks: options.hooks ?? [],
		spillDir: options.spillDir,
		retries: options.retries,
		fetchImpl: options.fetchImpl,
		signal: options.signal ?? new AbortController().signal,
		baseUrl: options.baseUrl,
		systemPromptOverride: options.systemPrompt,
		instructionsOverride: options.instructions,
		globalConfigDir: options.globalConfigDir,
		compactionThreshold: options.compactionThreshold ?? 0.75,
		onPlanReview: options.onPlanReview,
		onApproval: options.onApproval,
		onRetry: options.onRetry,
		emit: (event) => options.onEvent?.(event),
		approvals: new ApprovalMemory(),
		repeats: new RepeatGuard(),
		apiKey: options.apiKey,
		modelId: options.modelId ?? DEFAULT_MODEL_ID,
		planMode: options.planMode ?? "off",
		style: options.style ?? "default",
		compaction: options.compaction ?? true,
		approval: options.approval ?? "auto",
		calibration: null,
		instructionsSignature: null,
	};

	// `exit_plan_mode` 由内核自己挂上：它要翻的就是内核自己的状态，交给外部拼装反而绕。
	// 没有评审入口时不注册，免得给模型一个必然失败的工具。
	if (options.onPlanReview !== undefined) {
		state.tools.push(
			createExitPlanModeTool({
				isPlanning: () => isPlanning(state.planMode),
				review: options.onPlanReview,
				// 方案被批准就离开计划模式：档位变了，系统提示词里那段引导也要跟着撤掉。
				onApproved: () => applyPlanMode(state, "off"),
			}),
		);
	}

	return state;
}
