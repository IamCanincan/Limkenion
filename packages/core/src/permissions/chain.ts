/**
 * 工具调用的判定链。
 *
 * 判定的**顺序**
 * 就是它的全部内容，所以这里把它写成一条平铺的、从上到下的路，而不是几层嵌套的条件。
 *
 * 一条不变量贯穿全篇：**新增的判定只能让结果更严**。每条都可能把 allow 抬成 ask 或 deny，
 * 没有一条会把 deny / ask 降回去。由此「自动放行」不会退化成「无条件放行」——与档位无关的那几条
 * （空补丁、危险命令、越界）排在**档位变换之前**，任何档位都绕不过。
 *
 * 这里只保留顺序本身，不引入额外的概念词。
 *
 * 两处刻意的差别：
 * - **没有 LLM 分类器**。`auto` 就是放行，不引入「再调一次模型决定要不要跑这次调用」——那需要
 *   远程开关与额外的推理开销，对本地单机 agent 是纯负担。
 * - **判据来自工具自陈**，不是按工具名查表。只读性、目标路径都问工具（见 `tools/contract.ts`）。
 *   从前这两件事分别是 `READ_ONLY_TOOLS` 与 `toolPathOf` 里两张写死的名字表，后果有两个：
 *   `bash` 无论跑 `ls` 还是 `rm` 都算会写（只读档下连查看都被拒），而 `job_start` /
 *   `subagent_start` 又都算「无法归类」，于是**计划模式（严格）能被它们整个绕过**——
 *   跑任意命令、甚至改文件。按名字列举的安全属性永远追不上工具集。
 */

import { isOutsideWorkspaceReal } from "../paths.ts";
import { EXIT_PLAN_MODE_TOOL, type PlanMode } from "../plan.ts";
import type { AgentTool } from "../tools/contract.ts";
import { looksDangerousCommand } from "./danger.ts";
import { type ApprovalAnswer, type ApprovalRequest, isRememberable, type PermissionDecision } from "./decision.ts";
import { type ApprovalMemory, suggestApprovalPrefix } from "./memory.ts";
import type { ApprovalMode } from "./modes.ts";

/** 一次判定的输入 */
export interface PermissionQuery {
	/** 被调用的工具 */
	tool: AgentTool;
	/** 模型给的入参，已解析但未校验 */
	input: Record<string, unknown>;
	/** 当前审批档位 */
	mode: ApprovalMode;
	/** 当前计划模式档位 */
	planMode: PlanMode;
	/** 工作目录：越界判定的基准 */
	cwd: string;
}

/** 计划模式（严格）下拒绝改动的说明 */
function planRefusal(): string {
	return (
		"当前是计划模式（严格）：只能读，不能改。请先把方案写出来（目标、改哪些文件、风险、验证方式），" +
		`用 ${EXIT_PLAN_MODE_TOOL} 提交，等用户批准后再动手。`
	);
}

/**
 * 判定一次调用，返回结论。
 *
 * 纯函数：不读会话状态、不问用户、不碰事件。宿主怎么问用户由 `guardToolUse` 负责，这样判定规则
 * 能单独测，不用把 Agent、CLI、网页都拉进来。
 *
 * **顺序是「只拒绝的判定」在前、「只升档的判定」在后**，这不是随手排的：
 * - 只拒绝：计划模式（严格）、只读档、空补丁——它们把 allow 变成 deny；
 * - 只升档：危险命令、越界、ask 档——它们把 allow 变成 ask。
 *
 * 反过来排的话，`readonly` 档下 `bash: rm -rf /` 会先被「疑似危险命令」接住变成**询问**，
 * 而只读档的本意是**拒绝**——用户点了同意就真跑起来了。更严的那条必须赢。
 */
export function judgeToolUse(query: PermissionQuery): PermissionDecision {
	const { tool, input, mode, planMode, cwd } = query;

	// —— 放行：静态只读的工具（read / grep / glob / 待办 / 目标 / 交付物 / 查看与停止后台任务…）。
	//    它们无论怎么调都不动手，任何档位都不必问。 ——
	if (tool.alwaysReadOnly) {
		return { behavior: "allow", reason: { type: "read-only" }, message: "只读操作", outsideWorkspace: false };
	}

	// 越界先算出来：后面几条都要带上这个事实，`outsideWorkspace` 是给界面看的。
	const path = tool.pathOf(input);
	const outside = path !== null && isOutsideWorkspaceReal(path, cwd);
	// 这一次调用是不是只读。`bash` 靠它区分 `ls` 与 `rm`——**只用来决定「能不能放行」，
	// 不用来决定「要不要问」**：ask 档的语义是「跑任何命令前让我看一眼」，`ls` 也要问。
	const readOnly = tool.isReadOnly(input);

	// ———— 以下三条只拒绝 ————

	// 1. 计划模式（严格）：会改动的拒绝；只读的命令（`ls`）照常放行。
	if (planMode === "strict" && !readOnly) {
		return { behavior: "deny", reason: { type: "plan" }, message: planRefusal(), outsideWorkspace: outside };
	}

	// 2. 只读档：同上。
	if (mode === "readonly" && !readOnly) {
		return {
			behavior: "deny",
			reason: { type: "mode", mode },
			message:
				tool.name === "bash"
					? "当前是只读模式，不能执行会改动东西的命令。查看内容可以用 read / grep / glob，或者只读的 bash 命令。"
					: "当前是只读模式，不能修改文件。需要查看内容请用 read / grep / glob。",
			outsideWorkspace: outside,
		};
	}

	// 3. 空补丁：说要改文件却没有任何内容。直接拒绝，不给审批机会——它不可能产生改动，
	//    放它进审批只会白打扰用户一次。
	const empty = emptyPatchReason(tool.name, input);
	if (empty !== null) {
		return { behavior: "deny", reason: { type: "empty-patch" }, message: empty, outsideWorkspace: outside };
	}

	// ———— 以下三条只升档，任何档位（含 auto）都拦得住 ————

	// 4. 疑似危险命令。启发式只能用来升档，见 danger.ts。
	const command = tool.name === "bash" && typeof input.command === "string" ? input.command : "";
	if (command !== "" && looksDangerousCommand(command)) {
		const shown = command.length > 120 ? `${command.slice(0, 120)}…` : command;
		return {
			behavior: "ask",
			reason: { type: "dangerous", command },
			message: `疑似危险命令，需要人工确认：${shown}`,
			outsideWorkspace: outside,
		};
	}

	// 5. 越界：按**真实路径**判定（符号链接能骗过字符串前缀比较）。
	//    只读的调用不升档——它不改东西，读哪儿都一样，与 `read` 可以读工作目录之外保持一致。
	//    `outsideWorkspace` 照实报（给界面显示「这次动的是目录外的路径」），只是不据此拦。
	if (outside && !readOnly) {
		return {
			behavior: "ask",
			reason: { type: "outside", path: path ?? "" },
			message: `目标路径在工作目录之外：${path ?? ""}`,
			outsideWorkspace: true,
		};
	}

	// 6. 档位本身要确认。走到这里的一定是「可能改动东西」的工具（静态只读的在最上面就返回了），
	//    所以 ask 档下不必再看这次调用是不是只读——跑任何命令都该问。
	if (mode === "ask") {
		return {
			behavior: "ask",
			reason: { type: "mode", mode },
			message: tool.name === "bash" ? "即将执行命令" : "即将修改文件",
			outsideWorkspace: false,
		};
	}

	// 放行。只读的调用单独给一个原因：界面与日志要说得清「为什么放它过」，
	// 而「档位放行」与「这次调用不动手」是两回事。
	if (readOnly) {
		return { behavior: "allow", reason: { type: "read-only" }, message: "只读操作", outsideWorkspace: outside };
	}
	return {
		behavior: "allow",
		reason: { type: "mode", mode },
		message: "当前模式无需确认",
		outsideWorkspace: false,
	};
}

/**
 * 空补丁判定：调用方说要改文件，却没有任何实际内容。
 *
 * 只认「字段存在、但内容是空的」：字段整个缺失属于参数写错，交给工具自己报参数错误
 * （那条路径本来也不会写坏东西），不在这里拦。
 */
function emptyPatchReason(toolName: string, input: Record<string, unknown>): string | null {
	if (toolName === "write") {
		return typeof input.content === "string" && input.content.trim() === ""
			? "空补丁已拒绝：write 的 content 为空（或只有空白），不会产生任何改动。请给出要写入的内容；" +
					"确实要清空文件时，用 edit 明确删掉具体内容。"
			: null;
	}
	if (toolName === "edit") {
		const edits = typeof input.edits === "string" ? parseJsonArray(input.edits) : input.edits;
		return Array.isArray(edits) && edits.length === 0
			? "空补丁已拒绝：edit 的 edits 是空列表，不会产生任何改动。请给出至少一处 oldText/newText。"
			: null;
	}
	return null;
}

/** 解析模型偶尔发来的 JSON 字符串参数；不是数组就返回 null */
function parseJsonArray(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

/** 问用户、记规则需要的上下文 */
export interface GuardContext {
	approval: ApprovalMode;
	cwd: string;
	planMode: PlanMode;
	/**
	 * 怎么问用户；不给时按拒绝处理。
	 *
	 * 事件里带上 `detail` 与 `destructive`：前者是工具自陈的卡片正文，后者是它自陈的「看起来不可逆」。
	 * 宿主只负责把它们画出来，不必认识任何工具的字段名。
	 */
	onApproval: ((request: ApprovalRequest) => Promise<boolean | ApprovalAnswer>) | undefined;
	emit: (event: {
		type: "approval";
		tool: string;
		input: Record<string, unknown>;
		reason: string;
		detail: string;
		destructive: boolean;
	}) => void;
	emitResult: (event: { type: "approval_result"; tool: string; approved: boolean }) => void;
	/** 本会话已放行的前缀；不给就是每次都问 */
	memory?: ApprovalMemory;
}

/**
 * 执行前的审批。
 *
 * 返回 null 表示放行（调用方继续执行）；返回结果对象表示拦下，并把原因作为工具结果回传，
 * 模型据此能换个做法，而不是干等着。
 *
 * 三条放行路径，顺序不能换：
 * 1. 判定本身说放行；
 * 2. **本会话已放行过的同一类调用**——只有 `isRememberable` 的原因才查记忆。越界与疑似危险命令
 *    永远走不到这一步，只能一次次问（见 memory.ts）；
 * 3. 用户当场点了允许。
 *
 * 需要确认但没有提供 onApproval 时**默认拒绝**：宁可不做，也不该在没有人能回答的场景下
 * 悄悄把危险操作放过去。
 */
export async function guardToolUse(
	context: GuardContext,
	tool: AgentTool,
	input: Record<string, unknown>,
	signal: AbortSignal,
): Promise<{ content: string; isError: boolean } | null> {
	const verdict = judgeToolUse({
		tool,
		input,
		mode: context.approval,
		planMode: context.planMode,
		cwd: context.cwd,
	});
	if (verdict.behavior === "allow") {
		return null;
	}
	if (verdict.behavior === "deny") {
		return { content: `已拒绝执行 ${tool.name}：${verdict.message}`, isError: true };
	}

	const suggested = isRememberable(verdict.reason) ? suggestApprovalPrefix(tool.name, input, context.cwd) : null;
	if (suggested !== null && context.memory?.matches(tool.name, input, context.cwd) === true) {
		return null;
	}
	if (!context.onApproval) {
		return {
			content: `需要确认才能执行 ${tool.name}（${verdict.message}），但当前会话没有确认入口，已按拒绝处理。`,
			isError: true,
		};
	}

	const request: ApprovalRequest = {
		tool: tool.name,
		input,
		reason: verdict.message,
		// 卡片正文与「看起来不可逆」都问工具自己：界面上那一摊字是工具最清楚该写什么。
		detail: tool.describeApproval(input),
		destructive: tool.isDestructive(input),
		signal,
	};
	if (suggested !== null) {
		request.suggestedPrefix = suggested;
	}
	context.emit({
		type: "approval",
		tool: tool.name,
		input,
		reason: verdict.message,
		detail: request.detail,
		destructive: request.destructive,
	});
	const answer = await context.onApproval(request);
	const approved = typeof answer === "boolean" ? answer : answer.approved;
	const remember = typeof answer === "boolean" ? false : answer.remember === true;
	if (approved && remember && suggested !== null) {
		context.memory?.remember({ tool: tool.name, prefix: suggested });
	}
	context.emitResult({ type: "approval_result", tool: tool.name, approved });
	return approved ? null : { content: `用户拒绝执行 ${tool.name}：${verdict.message}`, isError: true };
}
