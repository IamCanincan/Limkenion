/**
 * 结果的预算：一条工具结果在回灌给模型之前要过什么。
 *
 * 三步，顺序不能换：
 *
 * 1. **空结果兜底**。空的 tool_result 会让某些模型误判回合边界、直接零输出结束（这条真实事故踩过）。它以前只在 bash 里兜住（`(命令没有输出)`），其余工具返回空串时
 *    就真的回一条空结果给模型。
 * 2. **按工具声明的阈值落盘**。超过 `maxResultBytes` 就把完整输出写进文件，上下文里只留开头
 *    一段与路径，模型需要细节时自己用 read / grep 去取。
 * 3. **`Infinity` 是硬退出**。读类工具声明它，意思是「我自己已经截断了，别再落盘」——否则会
 *    形成「读文件 → 拿到落盘路径 → 读落盘文件 → 又落盘」的原地打转。这条判断必须排在阈值
 *    比较之前，任何配置都不能把它翻过来。
 *
 * 落盘失败不改变结果：能写就写，写不了就把原样结果交出去——工具自己已经做过截断，
 * 因为存储问题丢掉整段输出反而更糟。
 */

import { spillToolOutput } from "../spill.ts";
import type { AgentTool, ToolOutcome } from "../tools/contract.ts";

/** 空结果的替身；说清「它跑完了但没有输出」，模型据此不会把空当成中断 */
export function emptyResultPlaceholder(toolName: string): string {
	return `（${toolName} 执行完成，没有输出）`;
}

/**
 * 按工具声明的预算处理一条结果。
 *
 * `spillDir` 没给（宿主没配落盘目录）时只做空结果兜底与落盘跳过。
 */
export function applyResultBudget(tool: AgentTool, outcome: ToolOutcome, spillDir: string | undefined): ToolOutcome {
	const content = outcome.content.trim() === "" ? emptyResultPlaceholder(tool.name) : outcome.content;
	const withContent = content === outcome.content ? outcome : { ...outcome, content };

	// Infinity 是硬退出：读类工具靠自身截断，落盘会让模型原地打转（见文件头第 3 条）。
	if (!Number.isFinite(tool.maxResultBytes)) {
		return withContent;
	}
	if (spillDir === undefined) {
		return withContent;
	}
	// 阈值是字节数，就得按字节比：中文一个字三字节，用 length 会晚落盘两倍有余。
	if (Buffer.byteLength(withContent.content, "utf-8") <= tool.maxResultBytes) {
		return withContent;
	}
	try {
		return { ...withContent, content: spillToolOutput(spillDir, tool.name, withContent.content) };
	} catch {
		return withContent;
	}
}
