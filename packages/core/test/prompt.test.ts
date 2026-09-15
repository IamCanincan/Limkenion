/**
 * 系统提示词的段落注册表。
 *
 * 这里钉的是**结构**而不是措辞：措辞会改，而「哪一段会不会变」「工具描述不许重复」这两条一旦破了
 * 是看不见的——前者让上下文缓存白作废，后者让每个工具的 description 每次请求发两遍。
 */

import { describe, expect, it } from "vitest";
import { buildSystemPrompt, PROMPT_SECTIONS, type PromptContext, resolvePromptSections } from "../src/prompt.ts";
import { defineTool } from "../src/tools/contract.ts";
import type { AgentTool } from "../src/types.ts";

/** 描述写得足够独特，好在正文里搜得到——它本来就不该出现 */
const bash = defineTool({
	name: "bash",
	description: "这段描述只该出现在接口的 tools 字段里",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: "", isError: false };
	},
});
const read = defineTool({
	name: "read",
	description: "同样是只发给接口的描述",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: "", isError: false };
	},
});

const tools: AgentTool[] = [bash, read];

const baseContext: PromptContext = {
	cwd: "/tmp/项目",
	tools,
	instructions: [],
	plan: "off",
	style: "default",
	today: "2026-02-14",
};

describe("段落注册表的不变量", () => {
	it("段落名不重复", () => {
		const names = PROMPT_SECTIONS.map((section) => section.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("每一段都声明了 static 或 dynamic", () => {
		for (const section of PROMPT_SECTIONS) {
			expect(["static", "dynamic"], section.name).toContain(section.kind);
			expect(typeof section.compute, section.name).toBe("function");
		}
	});

	it("正文里 static 段全部排在 dynamic 段之前", () => {
		// 这条就是「分界线」：服务端按前缀命中缓存，前面动一个字节、后面全部作废。
		// 注册表里的先后顺序不做要求（分组会重排），但**拼出来的正文**必须分得开。
		const prompt = resolvePromptSections(baseContext);
		const positions = PROMPT_SECTIONS.map((section) => ({
			name: section.name,
			kind: section.kind,
			text: section.compute(baseContext),
		}))
			.filter((entry) => entry.text !== "")
			.map((entry) => ({ ...entry, at: prompt.indexOf(entry.text) }));

		expect(positions.every((entry) => entry.at >= 0)).toBe(true);
		const lastStatic = Math.max(...positions.filter((e) => e.kind === "static").map((e) => e.at));
		const firstDynamic = Math.min(...positions.filter((e) => e.kind === "dynamic").map((e) => e.at));
		expect(lastStatic).toBeLessThan(firstDynamic);
	});

	it("把一段 dynamic 插到 static 之前，分组依旧把它排到后面", () => {
		// 分界线由分组保证，不由「作者记得别插错位置」保证。
		const order: string[] = [];
		const probe = (name: string): { name: string; kind: "static" | "dynamic"; compute: () => string } => ({
			name,
			kind: name.startsWith("d") ? "dynamic" : "static",
			compute: () => {
				order.push(name);
				return name;
			},
		});
		const text = resolvePromptSections(baseContext, [probe("d1"), probe("s1"), probe("d2"), probe("s2")]);
		expect(text).toBe("s1\n\ns2\n\nd1\n\nd2");
	});

	it("不适用的段落不出现，也不留空行", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/x", tools, today: "2026-02-14", instructions: [] });
		expect(prompt).not.toContain("以下是本仓库自带的说明文件");
		expect(prompt).not.toContain("计划模式");
		expect(prompt).not.toMatch(/\n{3,}/);
	});

	it("没有工具时整段不出现", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/x", tools: [], today: "2026-02-14" });
		expect(prompt).not.toContain("可用工具");
	});
});

describe("工具描述不重复", () => {
	it("提示词里有工具名，但没有工具描述", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/x", tools, today: "2026-02-14" });
		expect(prompt).toContain("bash");
		expect(prompt).toContain("read");
		// 描述只发一次：作为接口的 tools[] 字段（`toToolSpec` 会带上它）。
		expect(prompt).not.toContain(bash.description);
		expect(prompt).not.toContain(read.description);
	});
});

describe("动态段落", () => {
	it("说明文件永远排在最后", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp/x",
			tools,
			today: "2026-02-14",
			instructions: [{ path: "/tmp/x/AGENTS.md", content: "用中文写提交信息" }],
		});
		// 它讲的是「这个项目怎么做」，是最贴近当前任务的一段，让模型最后读到。
		expect(prompt.trimEnd().endsWith("用中文写提交信息")).toBe(true);
	});

	it("档位与风格各带一段，切了就变", () => {
		const base = buildSystemPrompt({ cwd: "/tmp/x", tools, today: "2026-02-14" });
		const planned = buildSystemPrompt({ cwd: "/tmp/x", tools, today: "2026-02-14", plan: "strict" });
		expect(planned).not.toBe(base);
		expect(planned).toContain("计划模式（严格）");

		const stylistic = buildSystemPrompt({ cwd: "/tmp/x", tools, today: "2026-02-14", style: "concise" });
		expect(stylistic).not.toBe(base);
	});

	it("static 前缀与档位无关：切档位不动正文开头", () => {
		// 这一条是缓存能不能省下来的关键：**正文的开头**必须与档位无关，否则前缀缓存白搭。
		// 别用「搜某个字样」找分界——第一个 dynamic 段是哪一段会随档位变（计划段为空时就是风格段）。
		const staticPrefix = PROMPT_SECTIONS.filter((section) => section.kind === "static")
			.map((section) => section.compute(baseContext))
			.filter((text) => text !== "")
			.join("\n\n");
		expect(staticPrefix).not.toBe("");

		const a = buildSystemPrompt({ cwd: "/tmp/x", tools, today: "2026-02-14", style: "concise" });
		const b = buildSystemPrompt({ cwd: "/tmp/x", tools, today: "2026-02-14", style: "explanatory" });
		expect(a.startsWith(staticPrefix)).toBe(true);
		expect(b.startsWith(staticPrefix)).toBe(true);
		// 档位确实改了正文（否则上面两条是废话）
		expect(a).not.toBe(b);
	});

	it("今天用注入的值，不读真实时钟", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/x", tools, today: "1999-12-31" });
		expect(prompt).toContain("今天：1999-12-31");
	});
});
