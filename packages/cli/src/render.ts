/**
 * 终端输出。
 *
 * 关键约定：模型正文走 stdout，其余一切（思维链、工具活动、状态、错误）走 stderr。
 * 这样 `limkenion -p "..." > out.txt` 拿到的就是干净的答案，可以直接管道给别的程序。
 */

import { resolveModel } from "limkenion-ai";
import { type AgentEvent, describeCompaction, summarizeInline } from "limkenion-core";

/** 渲染选项 */
export interface RenderOptions {
	/** 是否显示思维链与完整工具输出 */
	verbose: boolean;
	/**
	 * 当前模型 id 的取值函数。
	 *
	 * 是个函数而不是字符串：`/model` 能在会话中途换模型，上下文窗口是**当前这个模型**的属性，
	 * 捕获成一个字符串会让换过模型之后算出来的占用率一直是旧窗口的。
	 */
	getModel?: () => string;
	/**
	 * 工具自陈的一行摘要（core 的 `summarize(input)`）。
	 *
	 * 「哪个字段最要紧」只有工具自己知道：网页那一侧一直按它画工具行，终端从前却把入参整坨压成一行
	 * JSON 打出来（`> bash {"command":"echo hi"}`）。给了这个取值函数就与网页同一套口径
	 * （`> bash echo hi`、`> write src/a.ts（3 行）`）；不给就退回压平的 JSON。
	 */
	summarize?: (name: string, input: Record<string, unknown>) => string;
	/** 正文字符流，默认 process.stdout */
	out?: NodeJS.WriteStream;
	/** 状态字符流，默认 process.stderr */
	err?: NodeJS.WriteStream;
}

/** 创建事件渲染器 */
export function createRenderer(options: RenderOptions): (event: AgentEvent) => void {
	const out = options.out ?? process.stdout;
	const err = options.err ?? process.stderr;
	// 正文是否已经开始输出，用于在收尾时补一个换行。
	let wroteText = false;

	return (event: AgentEvent): void => {
		switch (event.type) {
			case "text":
				wroteText = true;
				out.write(event.delta);
				return;
			case "reasoning":
				if (options.verbose) {
					err.write(event.delta);
				}
				return;
			case "tool_start": {
				// 摘要优先用工具自陈的那一句（与网页同一套）；拿不到（老事件、工具已删）才退回 JSON。
				const declared = options.summarize?.(event.name, event.input) ?? "";
				err.write(`\n> ${event.name} ${declared !== "" ? declared : summarizeInline(event.input)}\n`);
				return;
			}
			case "tool_end":
				if (options.verbose) {
					err.write(`${event.outcome.content}\n`);
				} else {
					err.write(`  ${event.outcome.isError ? "失败" : "完成"}\n`);
				}
				return;
			case "done":
				if (wroteText) {
					out.write("\n");
				}
				/*
				 * 一轮结束报一次用量。
				 *
				 * 网页那边是输入框上方那颗常驻药丸（轮数、token、缓存命中、上下文占用），终端没有常驻
				 * 元素，所以按同样的口径打一行。**上下文占用**是这里最要紧的一项：它决定「还能聊多久」，
				 * 而 `usage.promptTokens` 是一轮里几次请求之和，拿去比窗口会算出好几倍——
				 * 该用 `contextTokens`（最后一次请求实际发出去的 prompt token 数）比当前模型的窗口。
				 * 从前这一行只在 `-v` 下打，且只有用量；现在每轮都打，并补上占用。
				 */
				err.write(`[${event.turns} 轮，用量 ${formatUsage(event)}${formatContext(event, options.getModel?.())}]\n`);
				return;
			case "compaction": {
				// 措辞由内核统一给出：网页端播的是同一个事件，两边各写一套迟早说法不一致。
				err.write(`[${describeCompaction(event)}]\n`);
				return;
			}
			case "error":
				if (wroteText) {
					out.write("\n");
				}
				err.write(`错误：${event.message}\n`);
				return;
		}
	};
}

/** 格式化用量 */
function formatUsage(event: Extract<AgentEvent, { type: "done" }>): string {
	if (!event.usage) {
		return "未知";
	}
	return `${event.usage.promptTokens} 输入 / ${event.usage.completionTokens} 输出`;
}

/**
 * 上下文占用：最后那次请求的 prompt token 数比当前模型的窗口。
 *
 * 拿不到（模型不认识、这次没回报 prompt token）就整段不出现——不编一个 0% 出来：
 * 「没有这条信息」与「几乎没占用」含义不同，网页那边也是这个口径。
 */
function formatContext(event: Extract<AgentEvent, { type: "done" }>, modelId: string | undefined): string {
	if (modelId === undefined || event.contextTokens === undefined) {
		return "";
	}
	const window = resolveModel(modelId).contextWindow;
	if (!Number.isFinite(window) || window <= 0) {
		return "";
	}
	// 一万以下给原数，超过就用「万」——一眼看得懂比精确到个位更要紧
	const used =
		event.contextTokens >= 10_000 ? `${(event.contextTokens / 10_000).toFixed(1)} 万` : `${event.contextTokens}`;
	const total = window >= 10_000 ? `${(window / 10_000).toFixed(0)} 万` : `${window}`;
	return `，上下文 ${used}/${total}（${Math.round((event.contextTokens / window) * 100)}%）`;
}
