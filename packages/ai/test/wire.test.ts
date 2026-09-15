/**
 * 线上协议翻译的单元测试。
 *
 * `wire.ts` 与 `stream.ts` 的分工就是「翻译」与「驱动」：这里只测**纯翻译**——不造 Response 流、
 * 不打桩 fetch。翻译层出错的后果很隐蔽：字段名写错时流照跑、事件照发，只有模型那边会发现
 * 「上一轮的思维链没了」或者 token 统计少了一半。
 */

import { describe, expect, it } from "vitest";
import type { Message } from "../src/types.ts";
import {
	accumulateToolCalls,
	buildBody,
	joinUrl,
	type PendingCall,
	parseChunk,
	toUsage,
	toWireMessages,
} from "../src/wire.ts";

describe("toWireMessages", () => {
	it("助理消息带上 reasoning_content 与 tool_calls", () => {
		const wire = toWireMessages([
			{
				role: "assistant",
				content: "看一下",
				reasoning: "先读文件",
				toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"a.ts"}' }],
			},
		]) as Array<Record<string, unknown>>;
		expect(wire[0]).toEqual({
			role: "assistant",
			content: "看一下",
			// DeepSeek 在带工具调用的多轮里要求上一轮思维链原样回传，缺了会被拒。
			reasoning_content: "先读文件",
			tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
		});
	});

	it("没有工具调用时 tool_calls 是 undefined 而不是空数组", () => {
		const wire = toWireMessages([{ role: "assistant", content: "好了", reasoning: "", toolCalls: [] }]) as Array<
			Record<string, unknown>
		>;
		expect(wire[0]?.tool_calls).toBeUndefined();
	});

	it("一条工具消息里的多个结果摊平成多条线上消息", () => {
		const wire = toWireMessages([
			{
				role: "tool",
				results: [
					{ toolCallId: "c1", content: "甲", isError: false },
					{ toolCallId: "c2", content: "乙", isError: true },
				],
			},
		]) as Array<Record<string, unknown>>;
		expect(wire).toHaveLength(2);
		expect(wire[0]).toEqual({ role: "tool", tool_call_id: "c1", content: "甲" });
		expect(wire[1]).toEqual({ role: "tool", tool_call_id: "c2", content: "乙" });
	});

	it("系统与用户消息原样带过去", () => {
		const messages: Message[] = [
			{ role: "system", content: "你是助手" },
			{ role: "user", content: "你好" },
		];
		expect(toWireMessages(messages)).toEqual([
			{ role: "system", content: "你是助手" },
			{ role: "user", content: "你好" },
		]);
	});
});

describe("buildBody", () => {
	it("有工具时才发 tools 与 tool_choice", () => {
		const withoutTools = buildBody({ model: { id: "m" }, messages: [] });
		expect(withoutTools.tools).toBeUndefined();
		expect(withoutTools.tool_choice).toBeUndefined();

		const withTools = buildBody({
			model: { id: "m" },
			messages: [],
			tools: [{ name: "read", description: "读文件", parameters: { type: "object" } }],
		});
		expect(withTools.tool_choice).toBe("auto");
		expect(withTools.tools).toEqual([
			{ type: "function", function: { name: "read", description: "读文件", parameters: { type: "object" } } },
		]);
	});

	it("总是要 usage：流式模式下不显式要求就拿不到 token 统计", () => {
		expect(buildBody({ model: { id: "m" }, messages: [] }).stream_options).toEqual({ include_usage: true });
	});

	it("温度与最大 token 只在给了的时候出现", () => {
		const body = buildBody({ model: { id: "m" }, messages: [] });
		expect("temperature" in body).toBe(false);
		expect("max_tokens" in body).toBe(false);
		expect(buildBody({ model: { id: "m" }, messages: [], temperature: 0, maxTokens: 0 })).toMatchObject({
			temperature: 0,
			max_tokens: 0,
		});
	});
});

describe("toUsage", () => {
	it("把线上字段名翻成内部字段名", () => {
		expect(
			toUsage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 8 }),
		).toEqual({
			promptTokens: 10,
			completionTokens: 2,
			totalTokens: 12,
			cachedTokens: 8,
		});
	});

	it("没有 usage 时返回 null，而不是编一个全 0", () => {
		expect(toUsage(null)).toBeNull();
		expect(toUsage(undefined)).toBeNull();
	});

	it("缺失的字段补 0，但缓存命中缺席时是 undefined 而不是 0", () => {
		const usage = toUsage({ prompt_tokens: 7 });
		expect(usage?.promptTokens).toBe(7);
		expect(usage?.completionTokens).toBe(0);
		// 0 是「回报了，一个都没命中」，undefined 是「这条信息不存在」——界面据此决定显不显示命中率。
		expect(usage?.cachedTokens).toBeUndefined();
		expect(toUsage({ prompt_cache_hit_tokens: 0 })?.cachedTokens).toBe(0);
	});
});

describe("accumulateToolCalls", () => {
	it("按 index 拼接分片，参数是累加而不是覆盖", () => {
		const pending = new Map<number, PendingCall>();
		accumulateToolCalls(pending, [{ index: 0, id: "c1", function: { name: "edit", arguments: '{"pa' } }]);
		accumulateToolCalls(pending, [{ index: 0, function: { arguments: 'th":"a.ts"}' } }]);
		expect(pending.get(0)).toEqual({ id: "c1", name: "edit", args: '{"path":"a.ts"}' });
	});

	it("index 缺省时归到 0；多个 index 各占一条", () => {
		const pending = new Map<number, PendingCall>();
		accumulateToolCalls(pending, [
			{ function: { name: "read" } },
			{ index: 1, id: "c2", function: { name: "grep", arguments: "{}" } },
		]);
		expect(pending.size).toBe(2);
		expect(pending.get(0)?.name).toBe("read");
		expect(pending.get(1)).toEqual({ id: "c2", name: "grep", args: "{}" });
	});

	it("null / undefined 一律当没有，不抛错", () => {
		const pending = new Map<number, PendingCall>();
		accumulateToolCalls(pending, null);
		accumulateToolCalls(pending, undefined);
		expect(pending.size).toBe(0);
	});
});

describe("parseChunk 与 joinUrl", () => {
	it("坏 JSON 返回 null 而不是抛错（一行脏数据不该整轮作废）", () => {
		expect(parseChunk('{"a":1}')).toEqual({ a: 1 });
		expect(parseChunk("{半截")).toBeNull();
		expect(parseChunk("")).toBeNull();
	});

	it("拼地址时不留重复斜杠", () => {
		expect(joinUrl("https://api.example.com", "/chat/completions")).toBe("https://api.example.com/chat/completions");
		expect(joinUrl("https://api.example.com/", "/chat/completions")).toBe("https://api.example.com/chat/completions");
		expect(joinUrl("https://api.example.com///", "/chat/completions")).toBe(
			"https://api.example.com/chat/completions",
		);
	});
});
