/**
 * 内核的对外事件。
 *
 * 这里只保留「主循环往外说什么」：正文与思维链增量、工具起止、一轮结束、上下文压缩、审批、
 * 错误。工具本身的形状在 `tools/contract.ts`，会话持久化、遥测等策略都不在这一层。
 */

import type { ToolSpec, Usage } from "limkenion-ai";
import type { AgentTool, ToolOutcome } from "./tools/contract.ts";

// 工具的类型定义在契约模块里；这里转出去，既有的 `from "./types.ts"` 导入路径不必改。
export type { AgentTool, ToolDefinition, ToolOutcome, ToolValidation } from "./tools/contract.ts";
export { DEFAULT_MAX_RESULT_BYTES, defineTool } from "./tools/contract.ts";

/** Agent 在执行过程中对外抛出的事件 */
export type AgentEvent =
	/** 思维链增量 */
	| { type: "reasoning"; delta: string }
	/** 正文增量 */
	| { type: "text"; delta: string }
	/** 开始执行某个工具 */
	| { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
	/** 工具执行结束 */
	| { type: "tool_end"; id: string; name: string; outcome: ToolOutcome }
	/**
	 * 一次 prompt 全部结束。
	 *
	 * `contextTokens` 是**最后一次**请求实际发出去的 prompt token 数——它才是「上下文占了窗口多少」；
	 * `usage.promptTokens` 是本轮所有请求的累计（一轮里跑了 5 次模型就是 5 份之和），拿它去比上下文
	 * 窗口会算出好几倍。服务端没回报用量时两个字段都可能缺，界面据此隐藏而不是编一个 0。
	 */
	| { type: "done"; turns: number; usage: Usage | null; contextTokens?: number }
	/**
	 * 上下文压缩：裁剪了旧工具输出，和/或做了摘要；rescued 表示这是超窗后丢历史重发的救援，
	 * midTurn 表示这是一轮跑动中触发的（而不是轮与轮之间）——只影响给用户看的说法。
	 */
	| {
			type: "compaction";
			pruned: number;
			savedTokens: number;
			summarized: boolean;
			rescued?: boolean;
			midTurn?: true;
	  }
	/**
	 * 有工具需要用户确认。
	 *
	 * `detail` 与 `destructive` 由**工具自己**给出（`describeApproval` / `isDestructive`）：
	 * 确认卡片上「这一次究竟要做什么」的知识住在工具里，宿主的界面不必按工具名去猜字段。
	 */
	| {
			type: "approval";
			tool: string;
			input: Record<string, unknown>;
			reason: string;
			/** 卡片正文（可多行）：命令原文、要写入的内容、改哪几处 */
			detail: string;
			/** 这次调用是否看起来不可逆；只用来把这行标醒目，不是判决 */
			destructive: boolean;
	  }
	/** 用户给出的结论 */
	| { type: "approval_result"; tool: string; approved: boolean }
	/**
	 * 无法继续，通常是模型接口出错。
	 *
	 * `code` / `status` / `retryable` / `retryAfterMs` 是 ai 层给出的机器可读分类（可选，因为宿主
	 * 自己也可能发这条事件）：界面据此决定要不要给「重试」，不必去猜中文错误文案。
	 */
	| {
			type: "error";
			message: string;
			code?: string;
			status?: number;
			retryable?: boolean;
			retryAfterMs?: number;
	  };

/** 把工具转成模型需要的描述 */
export function toToolSpec(tool: AgentTool): ToolSpec {
	return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
