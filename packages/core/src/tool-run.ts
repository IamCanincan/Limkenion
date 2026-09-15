/**
 * 工具执行的细节：参数解析、单次执行与用量累加。
 *
 * 审批搬去了 `permissions/chain.ts`——它现在要读工具自己的自陈（只读性、目标路径），
 * 而这里只管「把一次已经放行的调用跑起来」。
 *
 * 跨调用的状态（重复提醒、落盘目录、事件出口）仍在会话状态里，由调用方传进来。
 */

import { describeError, type Usage } from "limkenion-ai";
import { withToolTimeout } from "./guard.ts";
import type { AgentTool, ToolOutcome } from "./tools/contract.ts";

/** 解析工具参数，失败返回 null */
export function parseArguments(raw: string): Record<string, unknown> | null {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return {};
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * 执行单个工具并把异常转成失败结果。
 *
 * 超时只在工具自己声明了 `timeoutMs` 时生效：超时给模型一个明确的错误，而不是让会话干挂着。
 *
 * 任何失败都转成 `isError` 的结果而不是抛出：模型需要知道「这条路走不通」才能换一条，
 * 抛出则会把整轮打断。
 */
export async function runTool(
	tool: AgentTool,
	input: Record<string, unknown>,
	signal: AbortSignal,
): Promise<ToolOutcome> {
	try {
		return await withToolTimeout(tool.name, tool.timeoutMs, () => tool.execute(input, signal));
	} catch (error) {
		const message = describeError(error);
		return { content: `${tool.name} 执行失败：${message}`, isError: true };
	}
}

/**
 * 累加用量。
 *
 * `cachedTokens` 也要累加：缓存命中是最省钱的那一项，漏掉它整轮的命中率就算不出来——
 * 而这个比例正是「系统提示词有没有稳定（服务端按前缀命中缓存）」的体检指标。
 */
export function addUsage(total: Usage | null, next: Usage | null): Usage | null {
	if (!next) {
		return total;
	}
	if (!total) {
		return next;
	}
	return {
		promptTokens: total.promptTokens + next.promptTokens,
		completionTokens: total.completionTokens + next.completionTokens,
		totalTokens: total.totalTokens + next.totalTokens,
		cachedTokens: (total.cachedTokens ?? 0) + (next.cachedTokens ?? 0),
	};
}
