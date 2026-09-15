/**
 * 代码评审的提示词与结论解析。
 *
 * 评审最容易失效的方式不是漏看，而是**说得像那么回事**：没有证据、无法复现、全是风格偏好。
 * 所以这里的规则都指向同一件事——每条问题必须能落到具体的文件与行，并且说清触发条件；
 * 没把握的放进「待确认」，宁可少报。
 *
 * 单遍评审的另一个问题是「发现问题就收手」，于是分成几个各管一摊的评审者各跑一遍，
 * 再由一个汇总者去重、砍掉没有证据的、按严重级别排序（见 `buildSynthesisPrompt`）。
 */

import type { SubagentResult } from "./subagent.ts";

/** 评审角度 */
export type ReviewFocus = "correctness" | "security" | "tests";

/** 全部角度，也是默认顺序 */
export const REVIEW_FOCUSES: readonly ReviewFocus[] = ["correctness", "security", "tests"];

/** 角度的中文名与关注点 */
export const FOCUS_GUIDE: Record<ReviewFocus, string> = {
	correctness: "缺陷与正确性：边界条件、空值、并发与竞态、错误路径、资源释放、状态不一致、与调用方的契约是否被破坏",
	security:
		"安全：注入（命令、路径、SQL）、越权与权限判断、密钥与敏感信息泄漏、不可信输入的反序列化、路径穿越、依赖与配置里的危险默认值",
	tests: "测试与可验证性：改动是否让现有测试失效、缺少覆盖分支、断言过弱、难以测试的结构、以及这次改动能不能被验证（构建、类型、运行）",
};

/** 每个评审者最多报几条，多了说明没在排序 */
export const MAX_FINDINGS = 8;

/**
 * 每个评审者最多用几次工具。
 *
 * 不设这个上限时，评审者会把所有轮数花在翻代码上，最后一句话都没写——实测就是这么翻车的。
 * 评审的主输入是 diff，工具只用来核实一两处上下文。
 */
export const MAX_TOOL_CALLS = 6;

/** 解析档位：认不出来时返回 null，交给调用方决定当作没问题还是报错 */
export function parseReviewVerdict(text: string): "block" | "ok" | null {
	const matches = [...text.matchAll(/^\s*VERDICT:\s*(block|ok)\s*$/gim)];
	const last = matches.at(-1)?.[1]?.toLowerCase();
	return last === "block" || last === "ok" ? last : null;
}

/** 判断一个字符串是不是合法的评审角度 */
export function parseReviewFocus(raw: string): ReviewFocus | undefined {
	const value = raw.trim().toLowerCase();
	return (REVIEW_FOCUSES as readonly string[]).includes(value) ? (value as ReviewFocus) : undefined;
}

/** 单个评审者的任务描述 */
export function buildReviewPrompt(options: {
	focus: ReviewFocus;
	diff: string;
	/** diff 之外还需要知道的文件（例如未跟踪的新文件），只给路径让它自己去读 */
	extraFiles?: string[];
}): string {
	const { focus, diff, extraFiles = [] } = options;
	return [
		`你是一名只做「${FOCUS_GUIDE[focus]}」这一件事的代码评审者。`,
		"",
		"规则：",
		"1. 下面这份 diff 就是你评审的主输入；diff 里没有的代码不要凭印象评价。需要核实上下文时可以用 read / grep，但最多用 " +
			`${MAX_TOOL_CALLS} 次工具调用，之后必须停下来直接给出报告——把轮数全花在翻代码上等于没有评审。`,
		"2. 每条问题必须写清 `文件:行号`、为什么是问题、什么条件下会触发。给不出行号的不要写。",
		"3. 只报你有把握的问题；不确定但值得看一眼的放进「待确认」，不要为了凑数把它们当成结论。",
		"4. 不要提命名、格式、注释这类纯风格偏好，除非它会造成真实缺陷。",
		"5. 严重级别只有三种：`blocker`（会出错、会不安全）、`major`（明显缺陷但影响有限）、`minor`（可改可不改）。",
		`6. 最多 ${MAX_FINDINGS} 条，按严重级别排序。真的没问题就写「未发现该角度的问题」，不要编。`,
		"",
		"输出格式：",
		"```",
		"## 结论",
		"未发现 / 发现 N 个问题",
		"## 问题",
		"- [blocker] 路径/文件.ts:123 标题 —— 为什么、触发条件、怎么改",
		"## 待确认",
		"- 路径/文件.ts:456 一句话说明疑虑",
		"```",
		...(extraFiles.length > 0
			? [
					"",
					"以下文件是新增但未被 diff 覆盖的（未跟踪或已忽略），需要时自己去读：",
					...extraFiles.map((file) => `- ${file}`),
				]
			: []),
		"",
		"diff：",
		"```diff",
		diff,
		"```",
	].join("\n");
}

/** 汇总者的任务描述 */
export function buildSynthesisPrompt(options: {
	diff: string;
	reports: SubagentResult[];
	extraFiles?: string[];
}): string {
	const sections = options.reports.map((report) =>
		report.error === undefined
			? `### 评审者「${report.label}」的报告\n${report.text.trim()}`
			: `### 评审者「${report.label}」未能完成\n原因：${report.error}`,
	);
	const failed = options.reports.filter((report) => report.error !== undefined).map((report) => report.label);
	return [
		"你是代码评审的汇总者。几位互不通气的评审者各自交了一份报告，你的任务是把它变成一份能直接看的结论。",
		"",
		"规则：",
		"1. 合并重复的问题（同一处、同一原因）。",
		"2. 砍掉没有具体位置、无法复现、或只是风格偏好的条目——宁少勿滥。",
		`3. 保留严重级别，按 blocker → major → minor 排序，最多 ${MAX_FINDINGS} 条。`,
		"4. 不要引入报告里没有的新问题；你只做合并与排序。",
		"5. 每条格式：`- [级别] 文件:行 标题 —— 为什么、怎么改`。",
		"6. 最后单独一行输出结论，必须是 `VERDICT: block`（存在 blocker）或 `VERDICT: ok`（没有 blocker）。",
		"",
		"输出格式：",
		"```",
		"## 评审结论",
		"一句话总体判断",
		"## 问题",
		"- [blocker] 路径/文件.ts:123 标题 —— 为什么、怎么改",
		"## 待确认",
		"- ...（没有就省略这一节）",
		"## 说明",
		"哪些报告缺失或不确定",
		"VERDICT: ok",
		"```",
		...(failed.length > 0 ? ["", `注意：这些评审者没有完成，请在「说明」里点出来：${failed.join("、")}`] : []),
		...(options.extraFiles && options.extraFiles.length > 0
			? ["", "diff 未覆盖的文件（新增但未跟踪）：", ...options.extraFiles.map((file) => `- ${file}`)]
			: []),
		"",
		"评审者的报告：",
		"",
		...sections,
		"",
		"原始 diff（供你核对位置）：",
		"```diff",
		options.diff,
		"```",
	].join("\n");
}
