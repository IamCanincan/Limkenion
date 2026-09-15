/**
 * 权限判定的结论。
 *
 * 「为什么被拦」建成一个**可判别联合**，而不是一句拼出来的中文。
 *
 * 为什么要类型而不是字符串：同一个原因同时被三处消费——给用户看的理由、给模型看的拒绝正文、
 * 以及**能不能被「本会话总是允许」记住**。从前第三件事靠调用方比对 `cause === "mode"` 这个
 * 字符串，于是「新增一条判定」和「这条判定能不能被记住」是两个必须手工同步的地方，忘一处就是
 * 一个后门。这里把它变成 `isRememberable()` 一个判断，新增原因时类型会逼着人回答。
 */

/** 判定结论 */
export type PermissionBehavior = "allow" | "ask" | "deny"; /**
 * 「为什么是这个结论」。
 *
 * 每个变体都必须是**机器可读**的：界面按它决定给不给「总是允许」、日志按它统计、测试按它断言。
 * 想给用户多说几句就放 `message`，不要往这里塞中文。
 */

import type { ApprovalMode } from "./modes.ts";

export type PermissionReason =
	/** 工具自陈这次调用是只读的 */
	| { type: "read-only" }
	/** 计划模式（严格）：未获批准的改动一律拒绝 */
	| { type: "plan" }
	/** 当前审批档位要求确认（或直接放行 / 拒绝） */
	| { type: "mode"; mode: ApprovalMode }
	/** 空补丁：说要改文件却没给任何内容 */
	| { type: "empty-patch" }
	/** 疑似危险命令：无论哪个档位都至少升到确认 */
	| { type: "dangerous"; command: string }
	/** 目标路径在工作目录之外（按真实路径判定） */
	| { type: "outside"; path: string }
	/** 本会话已被「总是允许」记下 */
	| { type: "remembered"; prefix: string };

/** 一次判定的完整结论 */
export interface PermissionDecision {
	behavior: PermissionBehavior;
	reason: PermissionReason;
	/** 给用户与模型看的一句话；拒绝时会作为工具结果回传 */
	message: string;
	/**
	 * 目标路径是否在工作目录之外；没有路径时恒为 false。
	 *
	 * 它是**事实**而不是结论：只读的调用可以既 `outsideWorkspace: true` 又 `behavior: "allow"`
	 * （读哪儿都一样，与 `read` 能读工作目录之外一致）。界面上说明「这次动的是目录外的路径」用它，
	 * 判断该不该拦请用 `behavior` 与 `reason`。
	 */
	outsideWorkspace: boolean;
}

/**
 * 这个原因能不能被「本会话总是允许」记住。
 *
 * 只有 `mode` 能：那是「这个档位要求确认所有改动」，属于同一类日常操作，用户值得只回答一次。
 * 越界（`outside`）与危险命令（`dangerous`）每次都该单独判断——把上一轮的加固记成一条规则，
 * 等于把这道防线整段作废，而这正是「总是允许」最容易变成后门的地方。
 */
export function isRememberable(reason: PermissionReason): boolean {
	return reason.type === "mode";
}

/** 用户对一次确认的回答；返回 `boolean` 视为「这一次允许」，要给「总是允许」就返回对象 */
export type ApprovalAnswer = { approved: boolean; remember?: boolean };

/** 一次待确认的工具调用：宿主拿它去问用户 */
export interface ApprovalRequest {
	/** 工具名 */
	tool: string;
	/** 工具入参，原样给用户看 */
	input: Record<string, unknown>;
	/** 为什么需要确认 */
	reason: string;
	/**
	 * 确认卡片正文（可多行）。
	 *
	 * 由**工具自己**给出（`describeApproval`）：命令原文、要写入的内容、改哪几处——「这一次究竟要
	 * 做什么」的知识住在工具里，宿主只负责把它画出来，不必按工具名去猜字段。
	 */
	detail: string;
	/** 这次调用是否看起来不可逆；只用来把这行标醒目，不是判决 */
	destructive: boolean;
	/** 取消信号：用户中途停止时，询问应当尽快结束 */
	signal: AbortSignal;
	/**
	 * 「本会话总是允许」可以记下的前缀；没有就是这次不能记（越界、危险命令、带元字符的命令等）。
	 *
	 * 只由内核给出，宿主不要自己拼：它是审批层能安全放宽的边界，拼错了就成了后门。
	 */
	suggestedPrefix?: string;
}
