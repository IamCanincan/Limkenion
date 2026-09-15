/**
 * 一轮驱动的行为。
 *
 * 盯的是分层重构之后才成立的几件事：**一轮之内**也会压上下文（不再只在轮与轮之间压）、
 * 轮内换模型从下一次调用起生效（一轮不会半新半旧）、轮数用尽的错误带机器可读分类、
 * 清空历史会丢掉用量校准（否则空会话会被判成「该压缩了」）。
 *
 * 全部用桩 fetch 驱动，不发真实请求。
 */

import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { describeCompaction, HANDOFF_PREFIX } from "../src/compaction.ts";
import { defineTool } from "../src/tools/contract.ts";
import type { AgentEvent, AgentTool } from "../src/types.ts";

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

/** 一次「只说话」的响应，可带用量 */
function answerResponse(text: string, usage?: Record<string, number>): string[] {
	const chunk: Record<string, unknown> = { choices: [{ delta: { content: text }, finish_reason: "stop" }] };
	if (usage) {
		chunk.usage = usage;
	}
	return sse(chunk);
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

describe("轮内上下文压缩", () => {
	it("一轮跑动中折叠区够大就压缩，事件带 midTurn", async () => {
		/*
		 * 构造「值得摘要」的局面：阈值调到极低（未知模型 64k 窗口 × 0.001 = 64 token），
		 * 于是每轮都能压；但折叠区要等历史够长才真的有东西可折——applySummary 会原样留下最近
		 * 6 条与用户原话，前几轮时这两项就覆盖了全部历史，折叠区是 0（那种时候压缩是赔钱的，
		 * 由「折叠区太小就不摘要」那条契约拦下）。跑到第 5 轮，第 1 轮的工具结果才落进折叠区。
		 *
		 * 工具输出 4000 字符：单行、且不到裁剪阈值（4096 字节），所以只会被摘要，不会被裁剪。
		 */
		const dump: AgentTool = defineTool({
			name: "dump",
			description: "吐一段",
			parameters: { type: "object", properties: {} },
			async execute() {
				return { content: "x".repeat(4000), isError: false };
			},
		});
		const { events, onEvent } = collector();
		const { fetchImpl, bodies } = recordingFetch([
			toolCallResponse("dump", "{}", "c1"),
			toolCallResponse("dump", "{}", "c2"),
			toolCallResponse("dump", "{}", "c3"),
			toolCallResponse("dump", "{}", "c4"),
			answerResponse("摘要正文"),
			answerResponse("做完了"),
		]);
		const agent = new Agent({
			apiKey: "test",
			modelId: "unknown-model",
			cwd: process.cwd(),
			tools: [dump],
			maxTurns: 5,
			compactionThreshold: 0.001,
			onEvent,
			fetchImpl,
		});

		await agent.prompt("跑一下");

		const compaction = events.filter((event) => event.type === "compaction");
		expect(compaction).toEqual([{ type: "compaction", pruned: 0, savedTokens: 0, summarized: true, midTurn: true }]);
		// 说法里点明这是轮内触发的：网页上它出现在一轮的中途，不点明会看着像别的东西触发的
		const first = compaction[0];
		expect(first && describeCompaction(first)).toContain("一轮之内自动触发");
		// 摘要真的进了历史，模型拿到的是交接文档而不是被丢掉的一段
		const handoff = agent.messages.some(
			(message) => message.role === "user" && message.content.startsWith(HANDOFF_PREFIX),
		);
		expect(handoff).toBe(true);
		expect(agent.messages.at(-1)).toMatchObject({ role: "assistant", content: "做完了" });
		// 六次请求：四轮工具 + 写摘要那次 + 收尾那次
		expect(bodies).toHaveLength(6);
		// 摘要这次调用带着输出预算（折叠区约一千 token，八分之一取到下限 512）
		expect(bodies[4]?.max_tokens).toBe(512);
		/*
		 * 前缀原样复用：摘要请求的前 8 条正是上一次请求发出去的那 8 条，没有重排、没有裁剪、
		 * 系统消息也没被改写，只在尾部多了一条指令。服务端按前缀命中上下文缓存，这次压缩才便宜
		 * （命中价约为未命中的十分之一）——换掉前缀等于把压缩本身做贵了好几倍。
		 */
		const previous = bodies[3]?.messages as unknown[];
		const withInstruction = bodies[4]?.messages as unknown[];
		expect(withInstruction.slice(0, previous.length)).toEqual(previous);
		expect(withInstruction.at(-1)).toMatchObject({ role: "user" });
		expect((withInstruction.at(-1) as { content: string }).content).toContain("交接文档");
	});

	it("没超阈值时一轮之内不做任何压缩", async () => {
		const { events, onEvent } = collector();
		const { fetchImpl, bodies } = recordingFetch([answerResponse("好")]);
		const agent = new Agent({
			apiKey: "test",
			modelId: "unknown-model",
			cwd: process.cwd(),
			tools: [],
			onEvent,
			fetchImpl,
		});

		await agent.prompt("随便问问");

		expect(events.filter((event) => event.type === "compaction")).toEqual([]);
		expect(bodies).toHaveLength(1);
	});
});

describe("一轮的配置快照", () => {
	it("轮内换模型从下一次调用起生效，不会整轮都用旧模型", async () => {
		let agent: Agent;
		const switcher: AgentTool = defineTool({
			name: "switch",
			description: "换模型",
			parameters: { type: "object", properties: {} },
			async execute() {
				agent.setModel("deepseek-v4-pro");
				return { content: "换好了", isError: false };
			},
		});
		const { fetchImpl, bodies } = recordingFetch([toolCallResponse("switch"), answerResponse("好")]);
		agent = new Agent({
			apiKey: "test",
			modelId: "deepseek-flash",
			cwd: process.cwd(),
			tools: [switcher],
			fetchImpl,
		});

		await agent.prompt("换个模型再接着做");

		expect(bodies.map((body) => body.model)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
	});
});

describe("轮数用尽", () => {
	it("以 error 结束，并带上机器可读的 code", async () => {
		const { events, onEvent } = collector();
		const always = toolCallResponse("echo");
		const { fetchImpl } = recordingFetch([always, always, always]);
		const agent = new Agent({
			apiKey: "test",
			modelId: "unknown-model",
			cwd: process.cwd(),
			tools: [
				defineTool({
					name: "echo",
					description: "回显",
					parameters: { type: "object", properties: {} },
					async execute() {
						return { content: "ok", isError: false };
					},
				}),
			],
			maxTurns: 2,
			onEvent,
			fetchImpl,
		});

		await agent.prompt("一直调工具");

		expect(events.at(-1)).toMatchObject({ type: "error", code: "max-turns" });
	});
});

describe("用量校准的生命周期", () => {
	it("清空历史之后不再按旧上下文的真实 token 数判断压缩", async () => {
		const { events, onEvent } = collector();
		const { fetchImpl, bodies } = recordingFetch([
			// 第一次请求回报 5 万 prompt token：校准值带着这个下限，
			// 而未知模型的阈值是 48000，不丢校准的话空会话也会被判成该压缩。
			answerResponse("一", { prompt_tokens: 50_000, completion_tokens: 5, total_tokens: 50_005 }),
			answerResponse("二"),
		]);
		const agent = new Agent({
			apiKey: "test",
			modelId: "unknown-model",
			cwd: process.cwd(),
			tools: [],
			onEvent,
			fetchImpl,
		});

		await agent.prompt("一");
		agent.reset();
		await agent.prompt("二");

		expect(events.filter((event) => event.type === "compaction")).toEqual([]);
		// 两次提问就两次请求：中间没有多出来的摘要调用
		expect(bodies).toHaveLength(2);
		expect(agent.messages.at(-1)).toMatchObject({ role: "assistant", content: "二" });
	});
});
