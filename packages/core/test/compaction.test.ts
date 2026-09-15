/** 上下文压缩的单元测试：纯函数 + 一条走 Agent 的端到端用例（假 fetch）。 */

import type { Message } from "limkenion-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import {
	applySummary,
	buildSummaryRequest,
	calibrate,
	countChars,
	dropOldestTurn,
	estimateContextTokens,
	estimateMessages,
	estimateTokens,
	HANDOFF_PREFIX,
	looksContextOverflow,
	needsCompaction,
	prunePlaceholder,
	pruneToolOutputs,
	rescueOverflow,
	truncateToTokenBudget,
} from "../src/compaction.ts";
import type { AgentEvent } from "../src/types.ts";

const signal = new AbortController().signal;

/** 造一段旧工具输出 */
function toolMessage(size: number, id = "c1"): Message {
	return { role: "tool", results: [{ toolCallId: id, content: "x".repeat(size), isError: false }] };
}

/** 造一条助手消息 */
function assistantMessage(text: string): Message {
	return { role: "assistant", content: text, reasoning: "", toolCalls: [] };
}

/**
 * 塞一段「跑久了」的会话。
 *
 * 折叠区要真的有东西可折，摘要才值得发：`applySummary` 会原样留下最近 6 条与用户原话，
 * 历史短于这个窗口时折叠区是 0，压缩是赔本的（内核会直接跳过，见「压缩不赔本」契约）。
 * 这里放 6 条够大的助手消息，让折叠区落在几百 token 以上。
 */
function pushLongHistory(agent: Agent): void {
	agent.messages.push({ role: "user", content: "旧指令" });
	for (let index = 0; index < 6; index += 1) {
		agent.messages.push({ role: "assistant", content: "旧回答".repeat(200), reasoning: "", toolCalls: [] });
	}
}

describe("token 估算", () => {
	it("中文按字、英文按 4 字符粗算", () => {
		expect(estimateTokens("你好")).toBe(2);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcdefgh")).toBe(2);
		// 中英混排：英文段与中文各自结算
		expect(estimateTokens("abc你好")).toBe(1 + 2);
		expect(estimateTokens("")).toBe(0);
	});

	it("整段消息的估算覆盖正文、思维链与工具结果", () => {
		const messages: Message[] = [{ role: "system", content: "系统" }, assistantMessage("回答"), toolMessage(400)];
		expect(estimateMessages(messages)).toBeGreaterThan(100);
	});
});

describe("裁剪旧工具输出", () => {
	it("只裁最近的窗口之外、且体积超标的工具输出", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			toolMessage(8000, "old"),
			assistantMessage("中间"),
			toolMessage(8000, "new"),
		];
		const result = pruneToolOutputs(messages, { keepRecentMessages: 2, minBytes: 4096 });
		expect(result.pruned).toBe(1);
		expect(result.savedTokens).toBeGreaterThan(0);
		const first = result.messages[1];
		expect(first.role === "tool" ? first.results[0]?.content : "").toBe(prunePlaceholder(8000));
		// 最近的那条不动
		const last = result.messages[3];
		expect(last.role === "tool" ? last.results[0]?.content.length : 0).toBe(8000);
	});

	it("体积不够大就不裁（小输出留着更划算）", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			toolMessage(100, "small"),
			assistantMessage("x"),
		];
		const result = pruneToolOutputs(messages, { keepRecentMessages: 1, minBytes: 4096 });
		expect(result.pruned).toBe(0);
		expect(result.messages).toBe(messages);
	});

	it("不动 assistant 的正文与思维链", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "assistant", content: "y".repeat(9000), reasoning: "z".repeat(9000), toolCalls: [] },
			assistantMessage("尾"),
		];
		const result = pruneToolOutputs(messages, { keepRecentMessages: 1 });
		expect(result.pruned).toBe(0);
		expect(result.messages[1]).toMatchObject({ role: "assistant" });
	});
});

describe("摘要压缩", () => {
	it("按阈值判断是否需要压缩", () => {
		const small: Message[] = [{ role: "system", content: "系统" }];
		expect(needsCompaction(small, 1000, { thresholdRatio: 0.5 })).toBe(false);
		const big: Message[] = [{ role: "user", content: "字".repeat(600) }];
		expect(needsCompaction(big, 1000, { thresholdRatio: 0.5 })).toBe(true);
		// 上下文窗口未知时不猜
		expect(needsCompaction(big, 0)).toBe(false);
	});

	it("摘要请求是带固定小标题的 user 消息", () => {
		const request = buildSummaryRequest();
		expect(request.role).toBe("user");
		expect(request.content).toContain("用户的目标");
		expect(request.content).toContain("不要编造");
	});

	it("套用摘要时保留系统提示词与最近消息，且尾巴不以工具结果开头", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "user", content: "旧指令" },
			toolMessage(100, "a"),
			{ role: "user", content: "新指令" },
		];
		const compacted = applySummary(messages, "摘要正文", { keepRecentMessages: 2 });
		expect(compacted[0]).toEqual({ role: "system", content: "系统" });
		expect(compacted[1]).toMatchObject({ role: "user" });
		const summaryEntry = compacted[1];
		expect(summaryEntry?.role === "user" ? summaryEntry.content : "").toContain(HANDOFF_PREFIX);
		// 尾巴里那条孤儿工具结果被丢掉，最后两条是「新指令」与它的前一条
		expect(compacted.at(-1)).toEqual({ role: "user", content: "新指令" });
		expect(compacted.some((message) => message.role === "tool")).toBe(false);
		// 被压缩掉的那一段里的用户原话仍然在
		expect(compacted.some((message) => message.role === "user" && message.content === "旧指令")).toBe(true);
	});
});

describe("用量校准", () => {
	it("拿不到有效用量时不校准", () => {
		expect(calibrate(undefined, 100)).toBeNull();
		expect(calibrate(0, 100)).toBeNull();
		expect(calibrate(120, 0)).toBeNull();
		expect(calibrate(120, 100)).toEqual({ promptTokens: 120, chars: 100 });
	});

	it("字符数统计覆盖正文、思维链、工具参数与工具输出", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "user", content: "指令" },
			{
				role: "assistant",
				content: "回答",
				reasoning: "想想",
				toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
			},
			{ role: "tool", results: [{ toolCallId: "c1", content: "输出", isError: false }] },
		];
		expect(countChars(messages)).toBe(
			"系统".length + "指令".length + "回答".length + "想想".length + 2 + "输出".length,
		);
	});

	it("有校准时按真实比例外推，且不低于已知的真实用量", () => {
		// 真实情况：100 字符 = 120 token，那么 200 字符约等于 240 token
		const calibration = { promptTokens: 120, chars: 100 };
		const messages: Message[] = [{ role: "user", content: "x".repeat(200) }];
		expect(estimateContextTokens(messages, calibration)).toBe(240);

		// 上下文被裁剪后字符数变少，但已知的真实用量就是下限：只会更长，不会更短
		const trimmed: Message[] = [{ role: "user", content: "x".repeat(10) }];
		expect(estimateContextTokens(trimmed, calibration)).toBe(120);
	});

	it("没有校准时退回字符估算", () => {
		const messages: Message[] = [{ role: "user", content: "字".repeat(50) }];
		expect(estimateContextTokens(messages, null)).toBe(estimateMessages(messages));
	});

	it("校准会改变压缩判定：估算偏乐观时提前压", () => {
		// 200 个 ASCII 字符按字符估算只有 50 token，真实却是 200 token，正好越过阈值
		const messages: Message[] = [{ role: "user", content: "x".repeat(200) }];
		expect(needsCompaction(messages, 400, { thresholdRatio: 0.5 })).toBe(false);
		expect(needsCompaction(messages, 400, { thresholdRatio: 0.5 }, { promptTokens: 200, chars: 200 })).toBe(true);
	});
});

describe("Agent 里的压缩", () => {
	/** 造一个 SSE 响应 */
	function sse(text: string): string {
		return [
			`data: {"choices":[{"delta":{"content":"${text}"},"index":0}]}`,
			"",
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}',
			"",
			"data: [DONE]",
			"",
		].join("\n");
	}

	it("超阈值时会额外发一次摘要请求，并把历史压短", async () => {
		const seen: string[][] = [];
		let calls = 0;
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			calls += 1;
			const body = JSON.parse(String(init.body)) as {
				messages: Array<{ role: string; content: string }>;
				tools?: unknown[];
			};
			seen.push(body.messages.map((message) => message.role));
			// 第二次调用（不带工具）就是摘要请求
			const isSummary = (body.tools ?? []).length === 0 && calls === 2;
			return new Response(sse(isSummary ? "这是摘要" : "回答"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const events: AgentEvent[] = [];
		const agent = new Agent({
			apiKey: "sk-test",
			cwd: process.cwd(),
			tools: [],
			fetchImpl,
			// 阈值压到极低，保证一定触发
			compactionThreshold: 0.0001,
			onEvent: (event) => events.push(event),
		});
		// 塞一段很大的历史，模拟跑久了的会话
		pushLongHistory(agent);

		await agent.prompt("新指令", signal);

		expect(calls).toBe(2);
		expect(seen[1]).toContain("user");
		const compaction = events.find((event) => event.type === "compaction");
		expect(compaction).toMatchObject({ summarized: true });
		// 摘要之后历史里只剩系统提示词、摘要与最近的消息
		const summaryMessage = agent.messages.find(
			(message) => message.role === "user" && message.content.startsWith(HANDOFF_PREFIX),
		);
		expect(summaryMessage).toBeDefined();
	});

	it("关掉压缩后不会发额外请求", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return new Response(sse("回答"), { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		const agent = new Agent({
			apiKey: "sk-test",
			cwd: process.cwd(),
			tools: [],
			fetchImpl,
			compaction: false,
			compactionThreshold: 0.0001,
		});
		await agent.prompt("指令", signal);
		expect(calls).toBe(1);
		expect(
			agent.messages.some((message) => message.role === "user" && message.content.startsWith(HANDOFF_PREFIX)),
		).toBe(false);
	});

	it("运行期可以关掉再打开压缩（网页侧栏那个开关走的就是这条路）", async () => {
		let calls = 0;
		// 上报一个很大的用量：校准之后估算会远超窗口，于是「开着压缩」一定触发摘要请求，
		// 这样这条用例断言的就不是阈值估算的细节，而是开关本身。
		const sseBig = [
			'data: {"choices":[{"delta":{"content":"回答"},"index":0}]}',
			"",
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":500000,"completion_tokens":1,"total_tokens":500001}}',
			"",
			"data: [DONE]",
			"",
		].join("\n");
		const fetchImpl = (async () => {
			calls += 1;
			return new Response(sseBig, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		const events: AgentEvent[] = [];
		const agent = new Agent({
			apiKey: "sk-test",
			cwd: process.cwd(),
			tools: [],
			fetchImpl,
			compactionThreshold: 0.0001,
			onEvent: (event) => events.push(event),
		});
		// 默认开着
		expect(agent.compactionEnabled).toBe(true);

		// 关掉之后：历史再长也不发摘要请求
		agent.setCompaction(false);
		expect(agent.compactionEnabled).toBe(false);
		pushLongHistory(agent);
		await agent.prompt("新指令", signal);
		expect(calls).toBe(1);
		expect(events.some((event) => event.type === "compaction")).toBe(false);

		// 再打开：下一轮继续按阈值压
		agent.setCompaction(true);
		await agent.prompt("再问一句", signal);
		expect(events.some((event) => event.type === "compaction")).toBe(true);
		expect(
			agent.messages.some((message) => message.role === "user" && message.content.startsWith(HANDOFF_PREFIX)),
		).toBe(true);
	});
});

describe("摘要保留用户原话", () => {
	it("被摘要替换掉的那一段里，用户原话按原文留下（顺序不变）", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "user", content: "最初的目标：只改 a.ts" },
			assistantMessage("好"),
			toolMessage(200, "c1"),
			{ role: "user", content: "补充：别动 b.ts" },
			assistantMessage("明白"),
			{ role: "user", content: "最近的追问" },
		];
		const result = applySummary(messages, "摘要正文", { keepRecentMessages: 1 });
		const contents = result.map((message) => (message.role === "user" ? message.content : message.role));
		// 系统、交接摘要、两条被压缩掉的用户原话、最近那条尾巴
		expect(contents).toEqual([
			"system",
			`${HANDOFF_PREFIX}\n摘要正文`,
			"最初的目标：只改 a.ts",
			"补充：别动 b.ts",
			"最近的追问",
		]);
	});

	it("预算装得下就按原顺序全留", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "user", content: "最早的目标" },
			{ role: "user", content: "中间补充" },
			assistantMessage("好"),
		];
		const result = applySummary(messages, "摘要", { keepRecentMessages: 1, keepUserTokens: 100 });
		const users = result.filter((message) => message.role === "user").map((message) => message.content);
		expect(users).toEqual([`${HANDOFF_PREFIX}\n摘要`, "最早的目标", "中间补充"]);
	});

	it("预算不够时从最旧的原话开始丢，最新的那条按剩余额度截断而不是整条丢", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "user", content: "最早的目标".repeat(200) },
			{ role: "user", content: "中间补充".repeat(200) },
			assistantMessage("好"),
		];
		const result = applySummary(messages, "摘要", { keepRecentMessages: 1, keepUserTokens: 100 });
		const users = result.filter((message) => message.role === "user");
		// 交接摘要 + 最新那条被截断的原话；更早的那条让位
		expect(users.length).toBe(2);
		expect(users[0]?.content.startsWith(HANDOFF_PREFIX)).toBe(true);
		expect(users[1]?.content.startsWith("中间补充")).toBe(true);
		expect(users[1]?.content).toContain("已按预算截断");
		expect(estimateTokens(users[1]?.content ?? "")).toBeLessThanOrEqual(140);
	});

	it("截断不会把代理对劈成半个字符", () => {
		const text = "😀".repeat(100);
		const truncated = truncateToTokenBudget(text, 10);
		expect(truncated).toContain("已按预算截断");
		// 劈开的代理对会留下落单的高位代理字符
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(truncated)).toBe(false);
	});

	it("摘要请求写明这是交接，并要求写清未完成事项", () => {
		const request = buildSummaryRequest();
		expect(request.content).toContain("交接文档");
		expect(request.content).toContain("未完成的事项与下一步");
		// 「已经做完的只写结论」——不这么写，接手方会把做完的事再做一遍
		expect(request.content).toContain("已经做完的事只写结论");
	});
});

describe("超窗救援", () => {
	it("只认上下文类报错，密钥、参数类不认", () => {
		expect(looksContextOverflow("This model's maximum context length is 65536 tokens")).toBe(true);
		expect(looksContextOverflow('{"code":"context_length_exceeded"}')).toBe(true);
		expect(looksContextOverflow("上下文长度超过上限")).toBe(true);
		expect(looksContextOverflow("HTTP 401 Unauthorized 密钥无效")).toBe(false);
		expect(looksContextOverflow("HTTP 400 invalid request: tools[0].type")).toBe(false);
	});

	it("丢最旧的一轮，用户原话与系统提示词永远不丢", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "user", content: "目标" },
			{
				role: "assistant",
				content: "调工具",
				reasoning: "",
				toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
			},
			toolMessage(100, "c1"),
			{ role: "user", content: "追问" },
			assistantMessage("回答"),
		];
		const step = dropOldestTurn(messages);
		// 带工具调用的 assistant 与它的结果必须一起走，否则留下对不上号的历史
		expect(step.dropped).toBe(2);
		expect(step.messages.map((message) => message.role)).toEqual(["system", "user", "user", "assistant"]);

		const nothingLeft: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "user", content: "目标" },
		];
		expect(dropOldestTurn(nothingLeft).dropped).toBe(0);
	});

	it("反复丢到估算用量回到目标线以下", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "user", content: "目标" },
		];
		for (let index = 0; index < 6; index += 1) {
			messages.push(assistantMessage("x".repeat(40_000)));
		}
		const target = 40_000;
		expect(estimateMessages(messages)).toBeGreaterThan(target);
		const rescued = rescueOverflow(messages, target / 0.6);
		expect(rescued.dropped).toBeGreaterThan(0);
		expect(estimateMessages(rescued.messages)).toBeLessThanOrEqual(target);
		// 用户原话与系统提示词都还在
		expect(rescued.messages[0]?.role).toBe("system");
		expect(rescued.messages[1]).toMatchObject({ role: "user", content: "目标" });
	});

	it("没有任何可丢的东西时返回原样，不做无谓改动", () => {
		const messages: Message[] = [
			{ role: "system", content: "系统" },
			{ role: "user", content: "目标" },
		];
		const rescued = rescueOverflow(messages, 1);
		expect(rescued.dropped).toBe(0);
		expect(rescued.messages).toBe(messages);
	});
});

describe("Agent 里的超窗救援", () => {
	/** 造一个超窗的 400 响应 */
	function overflow(): Response {
		return new Response('{"error":{"message":"maximum context length exceeded"}}', {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}

	it("接口报超窗时丢掉最旧的轮次重发，而不是直接把错误交给用户", async () => {
		let calls = 0;
		const sentCounts: number[] = [];
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			calls += 1;
			const body = JSON.parse(String(init.body)) as { messages: unknown[] };
			sentCounts.push(body.messages.length);
			if (calls === 1) {
				return overflow();
			}
			return new Response(
				[
					'data: {"choices":[{"delta":{"content":"接手完成"},"index":0}]}',
					"",
					'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}',
					"",
					"data: [DONE]",
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;

		const events: AgentEvent[] = [];
		const agent = new Agent({
			apiKey: "sk-test",
			// 未知模型按 64k 保守上限处理，救援目标线落在 38.4k 附近，测试不必造 1M 的历史
			modelId: "some-unknown-model",
			cwd: process.cwd(),
			tools: [],
			fetchImpl,
			compaction: false,
			onEvent: (event) => events.push(event),
		});
		agent.messages.push({ role: "user", content: "最初的目标" });
		for (let index = 0; index < 4; index += 1) {
			agent.messages.push(assistantMessage("x".repeat(50_000)));
		}

		await agent.prompt("接着做", signal);

		const rescue = events.find((event) => event.type === "compaction" && event.rescued === true);
		expect(rescue).toMatchObject({ type: "compaction", rescued: true, summarized: false });
		expect(events.some((event) => event.type === "error")).toBe(false);
		// 第一次发出去的历史更长，救援之后变短了
		expect(sentCounts[0]).toBeGreaterThan(sentCounts[1] ?? 0);
		// 用户原话一条都没丢
		expect(agent.messages.filter((message) => message.role === "user").map((message) => message.content)).toContain(
			"最初的目标",
		);
	});
});
