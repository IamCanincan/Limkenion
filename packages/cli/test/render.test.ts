/**
 * 终端渲染器的测试。
 *
 * 钉住两件事：**正文走 stdout、其余走 stderr**（`limkenion -p "..." > out.txt` 要拿到干净的答案），
 * 以及一轮结束时那一行用量的口径——网页那边是常驻药丸，终端只能按行打，但算的是同一件事：
 * `contextTokens`（最后那次请求实际发出去的 prompt token）比**当前模型**的窗口。
 */

import { resolveModel } from "limkenion-ai";
import { describe, expect, it } from "vitest";
import { createRenderer, type RenderOptions } from "../src/render.ts";

/** 一个只收集文本的假流；同步可读，不必等事件循环 */
function sink(): { text: () => string; stream: NodeJS.WriteStream } {
	const chunks: string[] = [];
	return {
		text: () => chunks.join(""),
		stream: {
			write: (chunk: string) => {
				chunks.push(String(chunk));
				return true;
			},
		} as unknown as NodeJS.WriteStream,
	};
}

/** 跑一个事件，收两股输出 */
function render(event: Parameters<ReturnType<typeof createRenderer>>[0], options: Partial<RenderOptions> = {}) {
	const out = sink();
	const err = sink();
	createRenderer({ verbose: false, out: out.stream, err: err.stream, ...options })(event);
	return { out: out.text(), err: err.text() };
}

describe("终端渲染", () => {
	it("正文走 stdout，其余走 stderr", () => {
		const text = render({ type: "text", delta: "答案在这" });
		expect(text.out).toBe("答案在这");
		expect(text.err).toBe("");
		const tool = render({ type: "tool_start", id: "1", name: "bash", input: { command: "echo hi" } });
		expect(tool.out).toBe("");
		expect(tool.err).toContain("bash");
	});

	it("工具行用工具自陈的那一句；没有自陈才退回压平的 JSON", () => {
		// 与网页同一套口径：从前终端只会打 `> bash {"command":"echo hi"}`，与网页显示的不一致
		const declared = render(
			{ type: "tool_start", id: "1", name: "bash", input: { command: "echo hi" } },
			{ summarize: () => "echo hi" },
		);
		expect(declared.err).toContain("> bash echo hi");
		expect(declared.err).not.toContain("{");

		// 工具没自陈（或名字对不上，比如历史里删掉的工具）：退回一行 JSON，至少有信息
		const fallback = render({ type: "tool_start", id: "1", name: "bash", input: { command: "echo hi" } });
		expect(fallback.err).toContain('{"command":"echo hi"}');
	});

	it("一轮结束打一行用量，非 verbose 也打", () => {
		const result = render({
			type: "done",
			turns: 3,
			usage: { promptTokens: 1200, completionTokens: 340, totalTokens: 1540 },
		});
		expect(result.err).toContain("[3 轮，用量 1200 输入 / 340 输出]");
	});

	it("有 contextTokens 与模型时补上上下文占用（比值按当前模型的窗口算）", () => {
		const window = resolveModel("deepseek-flash").contextWindow;
		const result = render(
			{ type: "done", turns: 1, usage: null, contextTokens: 10_000 },
			{ getModel: () => "deepseek-flash" },
		);
		expect(result.err).toContain(`上下文 1.0 万/${Math.round(window / 10_000)} 万（1%）`);
	});

	it("拿不到窗口或 token 时整段不出现，而不是编一个 0%", () => {
		// 没有 getModel：不猜模型
		expect(render({ type: "done", turns: 1, usage: null, contextTokens: 5000 }).err).not.toContain("上下文");
		// 没有 contextTokens：这一轮没回报 prompt token
		expect(render({ type: "done", turns: 1, usage: null }, { getModel: () => "deepseek-flash" }).err).not.toContain(
			"上下文",
		);
	});

	it("用量那一行在 verbose 下也在（两档只差思维链与工具输出）", () => {
		const result = render(
			{ type: "done", turns: 2, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
			{ verbose: true },
		);
		expect(result.err).toContain("[2 轮，用量 10 输入 / 2 输出]");
	});
});
