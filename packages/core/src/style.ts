/**
 * 输出风格。
 *
 * 同一个 agent，在不同场合需要不同的说话方式：赶时间时只想看结论，学新东西时想听清为什么。
 * 把它做成一个可切换的档位，而不是让用户每次在提示词里补一段话——补的话经常被忘，
 * 而且每轮都要重新说一遍。
 *
 * 三种风格只影响**怎么讲**，不影响**怎么做**：工具、审批、计划模式一律照旧。
 */

/** 输出风格 */
export type OutputStyle = "default" | "concise" | "explanatory";

/** 全部取值，供参数解析与提示使用 */
export const OUTPUT_STYLES: readonly OutputStyle[] = ["default", "concise", "explanatory"];

/** 每种风格的一句话说明，命令行的用法与 `/style` 回执都用它 */
export const STYLE_GUIDE: Record<OutputStyle, string> = {
	default: "默认：正常说明改了什么、验证了什么",
	concise: "简洁：先给结论，不复述过程与工具输出",
	explanatory: "讲解：说清为什么这么做、有哪些取舍",
};

/** 解析一个风格取值，认不出来时返回 undefined 交给调用方报错 */
export function parseOutputStyle(raw: unknown): OutputStyle | undefined {
	return typeof raw === "string" && (OUTPUT_STYLES as readonly string[]).includes(raw)
		? (raw as OutputStyle)
		: undefined;
}

/** 注入系统提示词的风格段落；`default` 时不加任何内容（现有行为不变） */
export function styleSection(style: OutputStyle): string {
	if (style === "concise") {
		return [
			"回答风格（简洁）：",
			"- 先给结论，再给必要的细节；能一句话说清就别写两句。",
			"- 不要复述工具输出，不要预告你接下来要做什么，也不要解释显而易见的过程。",
			"- 用户没问背景就别铺垫，没问方案就别罗列备选。",
			"- 需要用户决策时才展开，其余时候直接给结果。",
		].join("\n");
	}
	if (style === "explanatory") {
		return [
			"回答风格（讲解）：",
			"- 说清楚为什么这么做：关键取舍、被否决的做法、以及这段改动会影响到哪些地方。",
			"- 涉及不常见的 API 或约定时，用一句话点明它的作用，但不要长篇科普。",
			"- 走错路又回头时，说明是什么让你改变判断——这比只报结果有用。",
			"- 仍然不要复述工具输出，简洁和讲清楚不冲突。",
		].join("\n");
	}
	return "";
}
