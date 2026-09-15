/** 评审提示词与结论解析：规则必须落进文本里，否则模型不会照做。 */

import { describe, expect, it } from "vitest";
import {
	buildReviewPrompt,
	buildSynthesisPrompt,
	MAX_FINDINGS,
	MAX_TOOL_CALLS,
	parseReviewFocus,
	parseReviewVerdict,
	REVIEW_FOCUSES,
} from "../src/review.ts";

const DIFF = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,4 @@", "+ const x = 1;"].join("\n");

describe("parseReviewFocus", () => {
	it("认三个角度，大小写与空格都容忍", () => {
		for (const focus of REVIEW_FOCUSES) {
			expect(parseReviewFocus(` ${focus.toUpperCase()} `)).toBe(focus);
		}
		expect(parseReviewFocus("性能")).toBeUndefined();
	});
});

describe("buildReviewPrompt", () => {
	it("带上角度、diff 与证据要求", () => {
		const prompt = buildReviewPrompt({ focus: "security", diff: DIFF });
		expect(prompt).toContain("安全");
		expect(prompt).toContain(DIFF);
		// 核心规矩：位置 + 触发条件 + 不许凑数
		expect(prompt).toContain("文件:行号");
		expect(prompt).toContain("触发");
		expect(prompt).toContain("待确认");
		expect(prompt).toContain(`最多 ${MAX_FINDINGS} 条`);
		expect(prompt).toContain("blocker");
		// 工具调用要有预算：不设上限时评审者会把轮数全花在翻代码上，最后一句报告都没写。
		expect(prompt).toContain(`最多用 ${MAX_TOOL_CALLS} 次工具调用`);
		expect(prompt).toContain("必须停下来直接给出报告");
	});

	it("三个角度给出不同的关注点", () => {
		const texts = REVIEW_FOCUSES.map((focus) => buildReviewPrompt({ focus, diff: DIFF }));
		expect(new Set(texts).size).toBe(REVIEW_FOCUSES.length);
		expect(texts[0]).toContain("边界条件");
		expect(texts[1]).toContain("注入");
		expect(texts[2]).toContain("测试");
	});

	it("未跟踪的新文件只给路径，让评审者自己去读", () => {
		const prompt = buildReviewPrompt({ focus: "correctness", diff: DIFF, extraFiles: ["src/new.ts"] });
		expect(prompt).toContain("src/new.ts");
		expect(prompt).toContain("自己去读");
	});
});

describe("buildSynthesisPrompt", () => {
	const reports = [
		{ label: "correctness", text: "发现 1 个问题" },
		{ label: "security", text: "", error: "接口 500" },
	];

	it("把每份报告带进去，并点出没完成的评审者", () => {
		const prompt = buildSynthesisPrompt({ diff: DIFF, reports });
		expect(prompt).toContain("发现 1 个问题");
		expect(prompt).toContain("接口 500");
		expect(prompt).toContain("security");
		expect(prompt).toContain("VERDICT: block");
		expect(prompt).toContain("VERDICT: ok");
		expect(prompt).toContain("不要引入报告里没有的新问题");
		expect(prompt).toContain(DIFF);
	});

	it("没有失败时不提失败", () => {
		const prompt = buildSynthesisPrompt({ diff: DIFF, reports: [{ label: "tests", text: "没问题" }] });
		expect(prompt).not.toContain("没有完成，请在");
	});
});

describe("parseReviewVerdict", () => {
	it("认得两种结论，取最后一次出现", () => {
		expect(parseReviewVerdict("## 结论\nVERDICT: block")).toBe("block");
		expect(parseReviewVerdict("VERDICT: OK")).toBe("ok");
		expect(parseReviewVerdict("先写 VERDICT: block\n再改口\nVERDICT: ok")).toBe("ok");
	});

	it("没有结论行时返回 null，交给调用方决定", () => {
		expect(parseReviewVerdict("看起来还行")).toBeNull();
		// 行内出现不算：必须是单独一行
		expect(parseReviewVerdict("我给的结论是 VERDICT: block 这样")).toBeNull();
	});
});
