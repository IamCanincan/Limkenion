/**
 * 行为契约：省 token 的那些性质，靠测试钉住，而不是靠注释。
 *
 * 借自 Reasonix 的做法（`docs/AGENT_CORE_SIMPLIFICATION.zh-CN.md` 那张契约表）：它把「干净收尾
 * 恰好一次模型请求」「压缩默认单次摘要」这类**用词级别**的性质写成会失败的测试。理由是这些性质
 * 平时看不出来——多一次隐式请求、多一轮摘要，界面上完全正常，只有账单知道。
 *
 * 这里钉四件事：
 *   1. 干净收尾恰好一次模型请求（不追加隐式的续跑）；
 *   2. 一次工具调用恰好推进两步；
 *   3. 折叠区太小就不摘要（压缩不能赔本）；
 *   4. 裁剪旧工具输出时保留头尾。
 */

import type { Message } from "limkenion-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { estimateTokens, pruneToolOutputs } from "../src/compaction.ts";
import { defineTool } from "../src/tools/contract.ts";
import type { AgentEvent } from "../src/types.ts";

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

/** 把 chunk 列表序列化成 SSE 行 */
function sse(...payloads: unknown[]): string[] {
	return [...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`), "data: [DONE]\n\n"];
}

/** 一次「只说话」的响应 */
function answerResponse(text: string): string[] {
	return sse({ choices: [{ delta: { content: text }, finish_reason: "stop" }] });
}

/** 一次「调用工具」的响应 */
function toolCallResponse(name: string, args = "{}", id = "c1"): string[] {
	return sse({
		choices: [
			{
				delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] },
				finish_reason: "tool_calls",
			},
		],
	});
}

/** 按顺序返回预设响应流、并记下每次请求体的 fetch */
function recordingFetch(responses: string[][]): { fetchImpl: typeof fetch; bodies: Record<string, unknown>[] } {
	const bodies: Record<string, unknown>[] = [];
	let index = 0;
	const fetchImpl = (async (_url: string, init: { body?: string }) => {
		bodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
		const lines = responses[index] ?? ["data: [DONE]\n\n"];
		index += 1;
		return new Response(sseStream(lines));
	}) as unknown as typeof fetch;
	return { fetchImpl, bodies };
}

/** 收集事件 */
function collector(): { events: AgentEvent[]; onEvent: (event: AgentEvent) => void } {
	const events: AgentEvent[] = [];
	return { events, onEvent: (event) => events.push(event) };
}

/** 线上的消息数组 */
function wireMessages(body: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
	return (body?.messages ?? []) as Array<Record<string, unknown>>;
}

describe("模型请求次数", () => {
	it("干净收尾恰好一次请求：不追加隐式的续跑", async () => {
		const { fetchImpl, bodies } = recordingFetch([answerResponse("你好")]);
		const agent = new Agent({ apiKey: "test", cwd: process.cwd(), tools: [], fetchImpl });

		await agent.prompt("打个招呼");

		expect(bodies).toHaveLength(1);
		// 用量要一起要回来，否则上下文占用与压缩阈值全都只能靠猜
		expect(bodies[0]?.stream_options).toEqual({ include_usage: true });
	});

	it("一次工具调用恰好推进两步，且第二步带回了工具结果", async () => {
		const echo = defineTool({
			name: "echo",
			description: "回显",
			parameters: { type: "object", properties: {} },
			async execute() {
				return { content: "回显正文", isError: false };
			},
		});
		const { fetchImpl, bodies } = recordingFetch([toolCallResponse("echo"), answerResponse("完成")]);
		const agent = new Agent({ apiKey: "test", cwd: process.cwd(), tools: [echo], fetchImpl });

		await agent.prompt("调一次工具");

		expect(bodies).toHaveLength(2);
		expect(wireMessages(bodies[1]).at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1", content: "回显正文" });
	});
});

describe("压缩不赔本", () => {
	it("折叠区太小就不摘要：哪怕整段上下文早已超了阈值", async () => {
		/*
		 * 阈值调到 64k × 0.001 = 64 token，系统提示词一个人就顶过去了；但 applySummary 会原样
		 * 留下最近 6 条与用户原话，此刻折叠区是 0——摘要那次调用还得把整个历史再发一遍，
		 * 花掉的一定比省下的多。所以要一次请求都不多发。
		 */
		const { events, onEvent } = collector();
		const { fetchImpl, bodies } = recordingFetch([answerResponse("好")]);
		const agent = new Agent({
			apiKey: "test",
			modelId: "unknown-model",
			cwd: process.cwd(),
			tools: [],
			systemPrompt: "字".repeat(100_000),
			compactionThreshold: 0.001,
			onEvent,
			fetchImpl,
		});

		await agent.prompt("一");

		expect(bodies).toHaveLength(1);
		expect(events.filter((event) => event.type === "compaction")).toEqual([]);
	});
});

describe("裁剪旧工具输出", () => {
	it("保留头尾，只把中间那段换成说明", () => {
		const content = Array.from({ length: 300 }, (_, index) => `第 ${index} 行内容`).join("\n");
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "tool", results: [{ toolCallId: "c1", content, isError: false }] },
			{ role: "assistant", content: "尾", reasoning: "", toolCalls: [] },
		];

		const result = pruneToolOutputs(messages, { keepRecentMessages: 1, minBytes: 100 });

		expect(result.pruned).toBe(1);
		const pruned = result.messages[1];
		const text = pruned?.role === "tool" ? (pruned.results[0]?.content ?? "") : "";
		// 头看结构、尾看结论：模型不用为了知道「这是什么」而整段重读
		expect(text.startsWith("第 0 行内容")).toBe(true);
		expect(text.endsWith("第 299 行内容")).toBe(true);
		expect(text).toContain("工具输出已裁剪");
		expect(text).not.toContain("第 150 行内容");
		expect(estimateTokens(text)).toBeLessThan(estimateTokens(content));
	});
});
