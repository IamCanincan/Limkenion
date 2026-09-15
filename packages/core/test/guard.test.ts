/** guard 的单元测试：重复调用提醒与工具超时。 */

import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { callSignature, RepeatGuard, repeatReminder, timeoutMessage, withToolTimeout } from "../src/guard.ts";
import { defineTool } from "../src/tools/contract.ts";
import type { AgentTool } from "../src/types.ts";

const signal = new AbortController().signal;

describe("重复调用提醒", () => {
	it("连续相同调用达到阈值才提醒", () => {
		const guard = new RepeatGuard(3);
		expect(guard.observe("read", '{"path":"a"}')).toBeNull();
		expect(guard.observe("read", '{"path":"a"}')).toBeNull();
		const third = guard.observe("read", '{"path":"a"}');
		expect(third).toContain("第 3 次");
		expect(third).toContain("read");
		expect(guard.observe("read", '{"path":"a"}')).toContain("第 4 次");
	});

	it("换了参数或换了工具就重新计数", () => {
		const guard = new RepeatGuard(2);
		expect(guard.observe("read", '{"path":"a"}')).toBeNull();
		expect(guard.observe("read", '{"path":"b"}')).toBeNull();
		expect(guard.observe("read", '{"path":"b"}')).toContain("第 2 次");
		expect(guard.observe("grep", '{"path":"b"}')).toBeNull();
	});

	it("阈值下限是 2", () => {
		const guard = new RepeatGuard(1);
		expect(guard.observe("bash", "{}")).toBeNull();
		expect(guard.observe("bash", "{}")).toContain("第 2 次");
	});

	it("签名把工具名与参数分开，避免拼串歧义", () => {
		expect(callSignature("a", "b")).not.toBe(callSignature("ab", ""));
		expect(repeatReminder("bash", 3)).toContain("换一种做法");
	});
});

describe("工具超时", () => {
	it("没声明超时就一直等", async () => {
		const outcome = await withToolTimeout("slow", undefined, async () => ({ content: "ok", isError: false }));
		expect(outcome.content).toBe("ok");
	});

	it("超时返回明确错误，且不再等结果", async () => {
		const outcome = await withToolTimeout(
			"slow",
			30,
			() => new Promise((resolve) => setTimeout(() => resolve({ content: "太晚了", isError: false }), 200)),
		);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).toContain("超时");
		expect(outcome.content).toContain("slow");
	});

	it("按时返回时不触发超时", async () => {
		const outcome = await withToolTimeout("fast", 500, async () => ({ content: "及时", isError: false }));
		expect(outcome).toEqual({ content: "及时", isError: false });
	});

	it("非正数视为不设限", async () => {
		const outcome = await withToolTimeout("x", 0, async () => ({ content: "ok", isError: false }));
		expect(outcome.content).toBe("ok");
		expect(timeoutMessage("bash", 1000)).toContain("1000ms");
	});
});

describe("Agent 里的重复提醒", () => {
	/**
	 * 假模型：前三次都发同一个工具调用，第四次收尾。
	 *
	 * 用模型调用次数驱动，而不是数历史里的工具消息——一次工具轮里可能一次多出好几条，不好对齐。
	 */
	function fakeFetch(): typeof fetch {
		let calls = 0;
		return (async () => {
			calls += 1;
			const finish =
				'data: {"choices":[{"delta":{"content":"收尾"},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
			const toolCall =
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"echo","arguments":"{\\"v\\":1}"}}]},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
			const payload = calls > 3 ? finish : toolCall;
			return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
	}

	it("同一个调用连续出现时会附上提醒", async () => {
		let runs = 0;
		const tool: AgentTool = defineTool({
			name: "echo",
			description: "回声",
			parameters: { type: "object" },
			execute: async () => {
				runs += 1;
				return { content: "同样的结果", isError: false };
			},
		});
		const agent = new Agent({ apiKey: "sk-test", cwd: process.cwd(), tools: [tool], fetchImpl: fakeFetch() });
		await agent.prompt("反复调用同一个工具", signal);

		const reminded = agent.messages.some((message) =>
			message.role === "tool" ? message.results.some((result) => result.content.includes("[提示]")) : false,
		);
		expect(runs).toBeGreaterThanOrEqual(3);
		expect(reminded).toBe(true);
	});
});
