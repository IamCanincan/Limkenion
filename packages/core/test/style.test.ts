/** 输出风格：解析、提示词段落与 Agent 接线。 */

import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { OUTPUT_STYLES, parseOutputStyle, styleSection } from "../src/style.ts";

const cwd = process.cwd();

/** 取系统消息正文 */
function systemText(agent: Agent): string {
	const first = agent.messages[0];
	return first?.role === "system" ? first.content : "";
}

describe("parseOutputStyle", () => {
	it("认三种风格，别的一律不认", () => {
		for (const style of OUTPUT_STYLES) {
			expect(parseOutputStyle(style)).toBe(style);
		}
		expect(parseOutputStyle("verbose")).toBeUndefined();
		expect(parseOutputStyle(42)).toBeUndefined();
		expect(parseOutputStyle(undefined)).toBeUndefined();
	});
});

describe("styleSection", () => {
	it("默认风格不加任何内容", () => {
		expect(styleSection("default")).toBe("");
	});

	it("简洁与讲解各自给出不同要求", () => {
		const concise = styleSection("concise");
		const explanatory = styleSection("explanatory");
		expect(concise).toContain("先给结论");
		expect(concise).toContain("不要复述工具输出");
		expect(explanatory).toContain("为什么");
		expect(explanatory).toContain("取舍");
		expect(concise).not.toBe(explanatory);
	});
});

describe("Agent 的风格接线", () => {
	it("默认不往系统提示词里加风格段落", () => {
		const agent = new Agent({ apiKey: "sk-test", cwd, tools: [] });
		expect(agent.style).toBe("default");
		expect(systemText(agent)).not.toContain("回答风格");
	});

	it("构造时指定风格会写进系统提示词", () => {
		const agent = new Agent({ apiKey: "sk-test", cwd, tools: [], style: "explanatory" });
		expect(agent.style).toBe("explanatory");
		expect(systemText(agent)).toContain("回答风格（讲解）");
	});

	it("切风格会重算系统提示词，切回默认则段落消失", () => {
		const agent = new Agent({ apiKey: "sk-test", cwd, tools: [] });
		agent.setStyle("concise");
		expect(systemText(agent)).toContain("回答风格（简洁）");
		agent.setStyle("default");
		expect(systemText(agent)).not.toContain("回答风格");
	});

	it("风格与计划模式可以同时生效", () => {
		const agent = new Agent({ apiKey: "sk-test", cwd, tools: [], planMode: "guide", style: "concise" });
		const text = systemText(agent);
		expect(text).toContain("计划模式（引导）");
		expect(text).toContain("回答风格（简洁）");
	});
});
