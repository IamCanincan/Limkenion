/**
 * 审批模式。
 *
 * 三档，语义是「谁在替用户点头」：
 * - `auto`：信任模型，只读之外的操作也放行。安全边界只剩「与档位无关的那几条」（越界、危险命令）。
 * - `ask`：读写类操作（write / edit / bash）每次都要用户确认。
 * - `readonly`：只读。只读工具与只读命令放行，其余一律拒绝。
 *
 * 从 `approval.ts` 里搬出来的：那份文件同时住着模式定义、判定链、只读工具名表与空补丁判定，
 * 而模式是唯一「宿主也要解析」的东西（命令行参数、配置文件、网页请求都拿它做校验）。
 */

/** 审批模式 */
export type ApprovalMode = "auto" | "ask" | "readonly";

/** 全部取值，供参数解析与界面展示 */
export const APPROVAL_MODES: readonly ApprovalMode[] = ["auto", "ask", "readonly"];

/** 缺省档位：与历史行为一致 */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto";

/**
 * 把任意输入解析成审批模式，非法值返回 fallback。
 *
 * 认不出来的字符串**静默回落**而不是
 * 报错——配置里写错一个词不该让整个程序起不来，而回落到哪个档位必须是有意的（这里是 `auto`，
 * 与不传这个参数的历史行为一致）。要严格校验的调用方自己比对返回值。
 */
export function parseApprovalMode(raw: unknown, fallback: ApprovalMode = DEFAULT_APPROVAL_MODE): ApprovalMode {
	return typeof raw === "string" && (APPROVAL_MODES as readonly string[]).includes(raw)
		? (raw as ApprovalMode)
		: fallback;
}
