/**
 * Web UI 的传输协议。
 *
 * 浏览器与服务端之间只有两类消息：POST 的 JSON 请求，以及 SSE 推送的事件。
 * 这里集中定义它们的形状。前端是手写 JS，不引用这份类型，靠字段名对齐；
 * 改动这里必须同步改 `public/app.js` 里对应的常量。
 */

import type { Message, Usage } from "limkenion-ai";
import type { ApprovalMode, Goal, OutputStyle, PlanMode, PresentFile, TodoItem } from "limkenion-core";
import type { ApiKeySource } from "../credentials.ts";
import type { ReplacementDiff } from "../diff.ts";

/** 会话摘要，用于左侧列表 */
export interface SessionSummary {
	/** 会话 id，来自会话头 */
	id: string;
	/** 会话文件绝对路径，同时用作前端切换会话的键 */
	file: string;
	/** 创建时间（ISO 字符串） */
	createdAt: string;
	/** 这个会话属于哪个工作目录；侧栏按它分组 */
	cwd: string;
	/** 最后一次写入（毫秒时间戳），组内排序与相对时间都用它 */
	updatedAt: number;
	/** 消息条数，不含文件头与系统消息 */
	messageCount: number;
	/** 首条用户消息的截断预览，可能为空 */
	preview: string;
	/** 使用者起的名字；没起过是空串（界面据此退回预览） */
	title: string;
	/**
	 * 使用者在侧栏里拖出来的次序；没拖过是 null。
	 *
	 * 越大越靠前，与 `updatedAt` 同一个量级（见 `Session.setOrder`），所以「排过序的按它、
	 * 没排过的按修改时间」是一条能直接比大小的规则——服务端已经把列表排好了，界面照单渲染。
	 */
	order: number | null;
	/** 是否有正在进行的生成 */
	running: boolean;
	/**
	 * 是否有**在等你点一下**的事（工具确认 / 方案评审还没答复）。
	 *
	 * 与 `running` 分开：在等你的会话往往没在跑，而它比「在跑」更要紧——会话行上的状态点
	 * 把它排在「运行中」前面。这件事只存在于服务端手里活着的那个 Run 里（会话文件里没有），
	 * 所以只有当前这一层注册表答得出来。
	 */
	waiting: boolean;
}

/**
 * 一次调用在界面上要用的东西，全部由**工具自陈**（core 的 `summarize` / `pathOf` / `deliverables`）。
 *
 * 单独抽出来是因为历史快照要按工具调用 id 下发这份信息：历史里只有原始的 `Message[]`（入参是
 * 一段 JSON 字符串），而「哪个字段最要紧」「这次碰哪个文件」「交付了哪几件」只有工具自己知道。
 * 少了它就会出现「刚跑完显示命令原文，刷新一次变成 JSON」——那种不一致用实时事件断言看不出来。
 */
export interface ToolCardInfo {
	/**
	 * 折叠视图里那一行摘要，由**服务端按工具自陈下发**（core 的 `summarize(input)`）。
	 *
	 * 界面不再按工具名猜字段：从前这里硬编码着 bash→command、read/write/edit→path、grep/glob→pattern、
	 * todo_write→todos，加一个工具就要改一次前端，而 `job_*` / `subagent_*` / `goal_*` 因为没人记得改，
	 * 一直显示成一坨 JSON。现在「哪个字段最要紧」只有工具自己知道，也就只有一处定义。
	 */
	summary: string;
	/** 这次调用碰的路径；不碰文件系统（或工具没声明）时为 null，界面据此决定要不要给「预览文件」 */
	path: string | null;
	/** 这次交付的东西；没有就是空数组，界面据此决定要不要铺交付物卡片 */
	deliverables: PresentFile[];
}

/** 工具卡片在界面上的状态 */
export interface ToolCard extends ToolCardInfo {
	id: string;
	name: string;
	input: unknown;
	status: "running" | "ok" | "error";
	content: string;
	/** 耗时毫秒数 */
	ms: number;
}

/**
 * 会话里发生过的状态提示：上下文压缩、超窗救援、这一轮失败。
 *
 * 与工具卡片不同，它不是「消息」而是「运行日志」，所以不放进会话文件；但它必须能随快照重发——
 * 只在事件流里发一次的提示，刷新页面就没了，而「刚刚为什么把上下文压了」「刚才为什么失败」
 * 恰恰是用户回头要看的东西。有上限，只留最近若干条。
 */
export interface RunNotice {
	id: number;
	/** info 是普通状态，error 是这一轮没跑成（界面会给「重试」） */
	kind: "info" | "error";
	text: string;
	/** 失败时的机器可读分类，来自 ai 层的错误事件 */
	code?: string;
	status?: number;
	/** 重发一次是否可能成功；界面据此决定要不要显示「重试」 */
	retryable?: boolean;
	retryAfterMs?: number;
}

/**
 * 一次待用户确认的工具调用。
 *
 * 它是**进行中一轮的一部分**，所以必须进快照：用户在等待确认时刷新页面，服务端仍在等答复，
 * 卡片要是没重建回来，这一轮就只能等到超时被拒——看起来就是「卡住了」。
 */
export interface PendingApproval {
	tool: string;
	input: unknown;
	reason: string;
	/**
	 * 卡片正文（可多行），由**工具自陈**（core 的 `describeApproval`）。
	 *
	 * 界面从前按工具名读入参字段来拼这段字（bash 读 `command`、write 读 `content`、edit 读
	 * `edits`），于是同一份「哪个字段最要紧」的知识在服务端与浏览器各有一份。现在只有一处。
	 */
	detail: string;
	/** 这次调用是否看起来不可逆；只用来把这行标醒目 */
	destructive: boolean;
	/**
	 * 这次调用会把某个文件整份替换掉时，这里是**算好的前后对比**（工具自陈 `fileReplacement`，
	 * 差异由服务端按 `diff.ts` 那一份算法算成「编好行号、切好段」的行）。
	 *
	 * 卡片照着画就行：哪个字段是路径、哪个是正文它一概不知道，从前它认 `write` 这个名字并读
	 * `input.path` / `input.content`，还自己实现了一遍「去掉首尾相同的行」。不是整份替换就是 null。
	 */
	change: ReplacementDiff | null;
	/**
	 * 「本会话总是允许」能记下的前缀；没有就是这次不能记（越界写入、危险命令等）。
	 *
	 * 前缀由内核给出，界面只负责显示与回传，不要自己拼——它是审批层能安全放宽的边界。
	 */
	suggestedPrefix?: string;
}

/**
 * 一次等待评审的方案（计划模式下模型调用 `exit_plan_mode`）。
 *
 * 与待确认的调用一样属于「进行中一轮的一部分」，所以也要进快照：用户刷新页面时服务端仍在等
 * 评审结论，卡片要是没重建回来，模型就只能一直等到超时被退回。
 */
export interface PendingPlanReview {
	/** 方案全文，原样给用户看 */
	plan: string;
}

/** 正在进行中的一轮，用于连接建立或断线重连时恢复现场 */
export interface PendingTurn {
	text: string;
	reasoning: string;
	tools: ToolCard[];
	/** 正在等用户确认的调用；没有则为 null */
	approval: PendingApproval | null;
	/** 正在等用户评审的方案；没有则为 null */
	planReview: PendingPlanReview | null;
}

/**
 * 会话事实：输入框上方那两行 dock 要显示的东西。
 *
 * 它由**工具层的状态**直接转手（内核的 `TodoList` / `GoalList`），不是从历史里那条
 * `todo_write` 的入参反推出来的。反推有两个毛病：一是「哪些工具会改这两样」的知识会跑到
 * 界面这边（工具改名或新增一个，界面就漏了——`job_*` 当年就是这么一直显示成一坨 JSON 的），
 * 二是**上下文压缩会把那条工具调用折进摘要**，界面再也找不到清单，正在跑的任务中途
 * 底下那行「还剩几项」会凭空消失。状态在内存里，压缩与刷新都不影响它。
 *
 * 空清单与 null 都是正常值（还没有待办 / 还没设目标），界面据此把那一行收起来。
 */
export interface SessionFacts {
	/** 当前待办清单，整表 */
	todos: TodoItem[];
	/** 当前目标；还没设过是 null */
	goal: Goal | null;
}

/**
 * 服务端会推送的全部事件类型。
 *
 * 运行时值而不是纯类型：客户端连 SSE 时按名字逐个 `addEventListener`，漏一个那类事件就永远收不到
 * （`approval` 曾漏过一次，表现是确认卡片只在刷新页面后才出现）。`compat.test.ts` 拿它和
 * `public/state.js` 里的 `EVENT_TYPES` 对账。
 */
export const WEB_EVENT_TYPES = [
	"status",
	"text",
	"reasoning",
	"tool_start",
	"tool_end",
	"approval",
	"approval_result",
	"plan_review",
	"plan_review_result",
	"done",
	"usage",
	"error",
	"notices",
	"facts",
	"history",
	"pending",
	"modes",
] as const;

/**
 * SSE 事件。
 *
 * `history` 与 `pending` 是状态快照而非增量：客户端收到后整体重绘，因此不需要
 * 自己维护增量与权威状态的一致性，断线重连也不会出现错位。
 */
export type WebEvent =
	/** 生成状态变化 */
	| { type: "status"; running: boolean }
	/** 正文增量 */
	| { type: "text"; delta: string }
	/** 思维链增量 */
	| { type: "reasoning"; delta: string }
	/** 工具开始执行 */
	| {
			type: "tool_start";
			id: string;
			name: string;
			input: unknown;
			summary: string;
			path: string | null;
			deliverables: PresentFile[];
	  }
	/** 工具执行结束 */
	| {
			type: "tool_end";
			id: string;
			name: string;
			content: string;
			isError: boolean;
			ms: number;
			summary: string;
			path: string | null;
			deliverables: PresentFile[];
	  }
	/** 有工具需要用户确认，界面据此弹出确认卡片 */
	| {
			type: "approval";
			tool: string;
			input: unknown;
			reason: string;
			/** 卡片正文，工具自陈 */
			detail: string;
			/** 是否看起来不可逆 */
			destructive: boolean;
			/** 整份替换的前后对比（服务端算好的行）；不是整份替换为 null（工具自陈） */
			change: ReplacementDiff | null;
			suggestedPrefix: string | null;
	  }
	/** 确认结果，用于把卡片收尾 */
	| { type: "approval_result"; tool: string; approved: boolean }
	/** 有方案等待评审（计划模式下模型提交了方案），界面据此弹出评审卡片 */
	| { type: "plan_review"; plan: string }
	/** 评审结论，用于把卡片收尾 */
	| { type: "plan_review_result"; approved: boolean }
	/**
	 * 一轮对话结束，带上这一轮花了多少。
	 *
	 * 三个字段都是「已发生的事实」，服务端没拿到就传 null，界面据此隐藏而不是编一个 0 出来：
	 * `usage` 是本轮累计（一轮里跑了 5 次模型就是 5 份之和），`contextTokens` 是**最后一次**请求
	 * 实际发出去的 prompt token 数（它才是上下文占用，拿 usage.promptTokens 去比窗口会算出好几倍），
	 * `contextWindow` 是这一轮所用模型的窗口大小——放在事件里，前端就不必再维护一份模型表。
	 */
	| { type: "done"; turns: number; usage: Usage | null; contextTokens: number | null; contextWindow: number }
	/**
	 * 本会话的**累计**用量（跨轮，不是某一轮）。
	 *
	 * 它既是快照成员也是增量：连上就先发一遍（刷新页面、断线重连、切标签页都能看到这个会话到底花了
	 * 多少），之后每轮结束再发一次。谁累计由服务端说了算——浏览器自己攒会在刷新时归零，两个标签页
	 * 看同一个会话也会各攒一份。
	 */
	| { type: "usage"; turns: number; usage: Usage }
	/** 出错：分类字段来自 ai 层，界面据此决定要不要给「重试」 */
	| {
			type: "error";
			message: string;
			code?: string;
			status?: number;
			retryable?: boolean;
			retryAfterMs?: number;
	  }
	/**
	 * 会话的状态提示（压缩、救援、失败）的**全量**列表。
	 *
	 * 发全量而不是增量：它会随快照一起重发，客户端整体重绘，不需要自己维护增量与权威状态的一致性。
	 */
	| { type: "notices"; items: RunNotice[] }
	/**
	 * 待办与目标的**全量**事实，变了才发（工具跑完比对一次指纹），并随连接快照重发。
	 *
	 * 与 `notices` 一样发全量：界面整体重绘那两行，不必自己跟着工具调用做增量。
	 */
	| ({ type: "facts" } & SessionFacts)
	/**
	 * 权威历史快照，连接建立时与每轮结束后各发一次。
	 *
	 * `cards` 是「工具调用 id → 这一次调用在界面上要用的东西」的表（摘要、路径、交付物）：历史里
	 * 只有原始的 `Message[]`，重新跑一遍工具自陈既没必要（同一个 id 的入参不会变）也不该在前端做。
	 * 带上这张表，刷新页面后工具行与实时跑出来的长得一样。
	 */
	| { type: "history"; messages: Message[]; cards: Record<string, ToolCardInfo> }
	/** 当前进行中的一轮 */
	| { type: "pending"; turn: PendingTurn }
	/**
	 * 会话当前的审批与计划模式。
	 *
	 * 只在切换时发，不进连接快照：初值由 `GET /api/sessions/:id/modes` 提供，这条事件是给
	 * 「另一个标签页改了模式」这种本页收不到通知的变化用的。
	 */
	| { type: "modes"; approval: ApprovalMode; planMode: PlanMode; style: OutputStyle; compaction: boolean };

/** 单个会话的审批模式与计划模式 */
export interface ModesResponse {
	/** auto / ask / readonly */
	approval: ApprovalMode;
	/** off / strict / guide */
	planMode: PlanMode;
	/** default / concise / explanatory：只影响怎么讲，不影响怎么做 */
	style: OutputStyle;
	/** 上下文压缩开关：关掉之后上下文只会一直变长，通常只在排查压缩问题时关 */
	compaction: boolean;
}

/** `GET /api/state` 的响应 */
export interface StateResponse {
	cwd: string;
	model: string;
	/** 可选模型列表 */
	models: ModelOption[];
	sessions: SessionSummary[];
	/**
	 * 静态资源的版本号（资源目录里最新的 mtime）。
	 * 客户端记下来、之后与 `GET /api/build` 比对：不一致说明服务端换了构建，空闲时自动刷新。
	 */
	build: string;
	/**
	 * 上次所在的会话 id（空串表示还没有）。
	 *
	 * 存在 agent 目录的 `web-state.json` 里，**不是 localStorage**：浏览器存储以 origin 为作用域，
	 * 换一个端口重新打开 `limkenion web` 就丢了（DSH 从 localStorage 迁到宿主配置也是这个理由）。
	 * 服务端在浏览器连上某个会话的事件流时记一笔，首屏据此落回上次那个会话。
	 */
	lastSessionId: string;
}

/** `GET /api/build` 的响应 */
export interface BuildResponse {
	build: string;
}

/**
 * `POST /api/cwd` 的请求。
 *
 * 有没有 `session` 是两种语义，不是一个可选的小花样：带了就是「只给这一个会话换目录」（改会话头，
 * 全局 cwd 与其它会话一概不动），没带才是原来那句「把服务端的工作目录切过去」——后者按目录分开
 * 存放的会话整套换掉，正在生成的一律拒绝。
 *
 * 响应两种情况都是 `StateResponse`；带 session 时它的 `cwd` 指的是那个会话现在的工作目录。
 */
export interface CwdRequest {
	/** 目标目录，绝对路径或相对当前工作目录 */
	path: string;
	/** 只给这个会话换目录；不填表示切换服务端的全局工作目录 */
	session?: string;
}

/** `GET /api/file` 的响应 */
export interface FileResponse {
	/** 相对工作目录或绝对路径，原样回显请求值 */
	path: string;
	content: string;
	/** 是否因超出上限被截断 */
	truncated: boolean;
	/** 是否为二进制文件（此时 content 为空） */
	binary: boolean;
}

/** 目录选择器里的一项 */
export interface DirEntry {
	name: string;
	/** 子目录的绝对路径 */
	path: string;
}

/** `GET /api/dirs` 的响应 */
export interface DirListResponse {
	/** 被列出的目录，绝对路径 */
	path: string;
	/** 上一级目录；已经在根目录时为 null */
	parent: string | null;
	/** 子目录，按名称排序；超量时截断 */
	dirs: DirEntry[];
}

/** `POST /api/dirs` 的响应：新建文件夹的结果 */
export interface DirCreateResponse {
	/** 新建文件夹的绝对路径 */
	path: string;
}

/** `GET /api/credentials` 的响应：只暴露密钥的存在与来源，不含明文 */
export interface CredentialsResponse {
	/** 当前是否有一把可用的密钥 */
	configured: boolean;
	/** 打码后的预览，例如 `sk-abc…9f2c` */
	masked: string;
	/** 生效密钥的来源，决定网页里保存的那把会不会被采用 */
	source: ApiKeySource;
	/** 本地凭据文件里是否存着一把（可能与生效的那把不是同一把） */
	stored: boolean;
	/** 密钥在本机是怎么存的，如实告诉用户有没有加密 */
	storage: string;
}

/** 可选模型的展示信息 */
export interface ModelOption {
	/** 传给 API 的 model 字段 */
	id: string;
	/** 人类可读名称 */
	name: string;
	/** 上下文窗口 token 数，用于算占用比例 */
	contextWindow: number;
}

/** `POST /api/sessions/:id/rename` 的响应 */
export interface RenameResponse {
	id: string;
	/** 生效后的名字；空串表示取消了命名（界面退回显示首条用户消息） */
	title: string;
}

/** `POST /api/sessions/order` 的请求：整份列表的 id，自上而下 */
export interface ReorderRequest {
	ids: string[];
}

/** `POST /api/sessions/order` 的响应 */
export interface ReorderResponse {
	/** 真正写进文件头的会话数 */
	ordered: number;
	/** 正在生成、这次没动的会话数（重写头与追加消息会撞车，见改名那条） */
	skipped: number;
}

/** 统一的错误响应体 */
export interface ErrorResponse {
	error: string;
}

/** 创建空的进行中一轮 */
export function emptyTurn(): PendingTurn {
	return { text: "", reasoning: "", tools: [], approval: null, planReview: null };
}
