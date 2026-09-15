/**
 * 大输出落盘测试。
 *
 * 关键契约：落盘之后上下文里只剩开头一段加路径，完整内容一个字节都不能少；
 * 清理只删旧的，别把刚写的那份删掉。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { pruneSpillDir, SPILL_PREVIEW_LINES, spillText, spillToolOutput } from "../src/spill.ts";
import { DEFAULT_MAX_RESULT_BYTES, defineTool } from "../src/tools/contract.ts";
import type { AgentEvent, AgentTool } from "../src/types.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "limkenion-spill-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("spillText", () => {
	it("把完整内容写进目录，并给出字节数与行数", () => {
		const dir = join(tempDir(), "nested", "spill");
		const text = `${"行\n".repeat(100)}末尾`;
		const file = spillText(dir, "bash", text);

		expect(existsSync(file.path)).toBe(true);
		expect(readFileSync(file.path, "utf-8")).toBe(text);
		expect(file.lines).toBe(text.split("\n").length);
		expect(file.bytes).toBe(Buffer.byteLength(text, "utf-8"));
	});

	it("工具名里的路径字符会被压平，不会写到目录之外", () => {
		const dir = tempDir();
		const file = spillText(dir, "../../evil name", "内容");
		expect(file.path.startsWith(dir)).toBe(true);
		expect(file.path).toContain("evil_name");
	});
});

describe("pruneSpillDir", () => {
	it("只留最近的若干份，旧的删掉", () => {
		const dir = tempDir();
		const files: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			const path = join(dir, `old-${index}.txt`);
			writeFileSync(path, "内容", "utf-8");
			// 手工把时间拉开，避免同一毫秒内排序不稳定。
			const stamp = 1_700_000_000 + index;
			utimesSync(path, stamp, stamp);
			files.push(path);
		}

		expect(pruneSpillDir(dir, 2)).toBe(3);
		expect(existsSync(files[4])).toBe(true);
		expect(existsSync(files[3])).toBe(true);
		expect(existsSync(files[0])).toBe(false);
	});

	it("数量没超上限时不动手，目录不存在也不报错", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "a.txt"), "内容", "utf-8");
		expect(pruneSpillDir(dir, 50)).toBe(0);
		expect(pruneSpillDir(join(dir, "不存在"), 50)).toBe(0);
	});
});

describe("spillToolOutput", () => {
	it("正文只保留前若干行，并给出落盘路径与可直接照抄的 read 调用", () => {
		const dir = tempDir();
		const lines = Array.from({ length: 200 }, (_, index) => `第 ${index + 1} 行`);
		const text = spillToolOutput(dir, "grep", lines.join("\n"));

		expect(text).toContain("第 1 行");
		expect(text).toContain(`第 ${SPILL_PREVIEW_LINES} 行`);
		expect(text).not.toContain(`第 ${SPILL_PREVIEW_LINES + 1} 行`);
		expect(text).toContain("共 200 行");
		expect(text).toContain(`"offset": ${SPILL_PREVIEW_LINES + 1}`);

		const path = /完整输出已写入 (.+)/.exec(text)?.[1];
		expect(path).toBeDefined();
		expect(readFileSync(path as string, "utf-8")).toBe(lines.join("\n"));
	});
});

/** 把字符串包成 SSE 字节流 */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		},
	});
}

/** 两轮响应：先调工具，再收尾 */
function toolThenStopFetch(): typeof fetch {
	let index = 0;
	const responses = [
		[
			`data: ${JSON.stringify({
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "dump", arguments: "{}" } }] },
						finish_reason: "tool_calls",
					},
				],
			})}\n\n`,
		],
		[`data: ${JSON.stringify({ choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] })}\n\n`],
	];
	return (async () => {
		const lines = responses[index] ?? ["data: [DONE]\n\n"];
		index += 1;
		return new Response(sseStream([...lines, "data: [DONE]\n\n"]));
	}) as unknown as typeof fetch;
}

describe("Agent 落盘", () => {
	it("超过阈值的工具输出被换成预览，完整内容留在磁盘上", async () => {
		const dir = tempDir();
		const full = "很长的一行\n".repeat(4000);
		const dump: AgentTool = defineTool({
			name: "dump",
			description: "吐一大堆输出",
			parameters: { type: "object", properties: {} },
			async execute() {
				return { content: full, isError: false };
			},
		});
		const events: AgentEvent[] = [];
		const agent = new Agent({
			apiKey: "test",
			cwd: process.cwd(),
			tools: [dump],
			spillDir: dir,
			fetchImpl: toolThenStopFetch(),
			onEvent: (event) => events.push(event),
		});

		await agent.prompt("给我看看");

		const toolEnd = events.find((event) => event.type === "tool_end");
		const content = toolEnd?.type === "tool_end" ? toolEnd.outcome.content : "";
		expect(content.length).toBeLessThan(DEFAULT_MAX_RESULT_BYTES);
		expect(content).toContain("完整输出已写入");

		const path = /完整输出已写入 (.+)/.exec(content)?.[1];
		expect(readFileSync(path as string, "utf-8")).toBe(full);
		// 进上下文的是预览，不是原文。
		const toolMessage = agent.messages.find((message) => message.role === "tool");
		expect(JSON.stringify(toolMessage)).toContain("完整输出已写入");
	});

	it("没有配 spillDir 时原样交给模型", async () => {
		const full = "很长的一行\n".repeat(4000);
		const dump: AgentTool = defineTool({
			name: "dump",
			description: "吐一大堆输出",
			parameters: { type: "object", properties: {} },
			async execute() {
				return { content: full, isError: false };
			},
		});
		const events: AgentEvent[] = [];
		const agent = new Agent({
			apiKey: "test",
			cwd: process.cwd(),
			tools: [dump],
			fetchImpl: toolThenStopFetch(),
			onEvent: (event) => events.push(event),
		});

		await agent.prompt("给我看看");

		const toolEnd = events.find((event) => event.type === "tool_end");
		expect(toolEnd?.type === "tool_end" ? toolEnd.outcome.content : "").toBe(full);
	});
});
