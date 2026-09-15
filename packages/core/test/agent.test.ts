/** Agent 主循环的单元测试：用假 fetch 驱动，工具用桩实现，结果完全确定。 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
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

/** 按顺序返回预设响应流的 fetch */
function queuedFetch(responses: string[][]): typeof fetch {
	let index = 0;
	return (async () => {
		const lines = responses[index] ?? ["data: [DONE]\n\n"];
		index += 1;
		return new Response(sseStream(lines));
	}) as unknown as typeof fetch;
}

/** 一个回显参数的桩工具 */
function echoTool(): AgentTool {
	// 桩工具一律经 `defineTool` 造：契约的默认值（会写、不可并发、结果 12KB 上限）由它补上。
	return defineTool({
		name: "echo",
		description: "回显输入",
		parameters: { type: "object", properties: { value: { type: "string" } } },
		async execute(input) {
			return { content: `回显：${String(input.value)}`, isError: false };
		},
	});
}

/** 收集事件 */
function collector(): { events: AgentEvent[]; onEvent: (event: AgentEvent) => void } {
	const events: AgentEvent[] = [];
	return { events, onEvent: (event) => events.push(event) };
}

/** 构造一个使用桩工具的 Agent */
function makeAgent(responseLines: string[][], tools: AgentTool[] = [echoTool()]) {
	const { events, onEvent } = collector();
	const agent = new Agent({
		apiKey: "test",
		cwd: process.cwd(),
		tools,
		onEvent,
		fetchImpl: queuedFetch(responseLines),
	});
	return { agent, events };
}

describe("Agent 主循环", () => {
	it("没有工具调用时跑一轮就结束", async () => {
		const { agent, events } = makeAgent([sse({ choices: [{ delta: { content: "你好" }, finish_reason: "stop" }] })]);

		await agent.prompt("打个招呼");

		expect(events).toEqual([
			{ type: "text", delta: "你好" },
			// 服务端没给用量时 usage 为 null，不编数字
			{ type: "done", turns: 1, usage: null },
		]);
		expect(agent.messages).toHaveLength(3);
		expect(agent.messages[2]).toMatchObject({ role: "assistant", content: "你好" });
	});

	it("执行工具后把结果回灌并继续下一轮", async () => {
		const { agent, events } = makeAgent([
			sse({
				choices: [
					{
						delta: {
							reasoning_content: "先调用工具",
							tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"value":"hi"}' } }],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
			sse({ choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] }),
		]);

		await agent.prompt("调用工具");

		const kinds = events.map((event) => event.type);
		expect(kinds).toEqual(["reasoning", "tool_start", "tool_end", "text", "done"]);

		const toolEnd = events.find((event) => event.type === "tool_end");
		expect(toolEnd).toMatchObject({ name: "echo", outcome: { content: "回显：hi", isError: false } });

		// 系统消息 + 用户 + 助理(带工具调用) + 工具结果 + 助理(最终回答)
		expect(agent.messages).toHaveLength(5);
		expect(agent.messages[2]).toMatchObject({
			role: "assistant",
			reasoning: "先调用工具",
			toolCalls: [{ id: "c1", name: "echo", arguments: '{"value":"hi"}' }],
		});
		expect(agent.messages[3]).toMatchObject({
			role: "tool",
			results: [{ toolCallId: "c1", content: "回显：hi", isError: false }],
		});
	});

	it("未知工具返回失败结果而不是抛错", async () => {
		const { agent, events } = makeAgent([
			sse({
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "不存在", arguments: "{}" } }] },
						finish_reason: "tool_calls",
					},
				],
			}),
			sse({ choices: [{ delta: { content: "知道了" }, finish_reason: "stop" }] }),
		]);

		await agent.prompt("调用不存在的工具");

		const toolEnd = events.find((event) => event.type === "tool_end");
		expect(toolEnd).toMatchObject({ outcome: { isError: true } });
		expect(agent.messages[3]).toMatchObject({ role: "tool", results: [{ isError: true }] });
	});

	it("工具参数不是合法 JSON 时返回失败结果", async () => {
		const { agent, events } = makeAgent([
			sse({
				choices: [
					{
						delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: "不是 JSON" } }] },
						finish_reason: "tool_calls",
					},
				],
			}),
			sse({ choices: [{ delta: { content: "好的" }, finish_reason: "stop" }] }),
		]);

		await agent.prompt("传坏参数");

		const toolEnd = events.find((event) => event.type === "tool_end");
		expect(toolEnd).toMatchObject({ outcome: { isError: true } });
	});

	it("工具抛出的异常转成失败结果", async () => {
		const failing: AgentTool = defineTool({
			name: "boom",
			description: "总是失败",
			parameters: { type: "object", properties: {} },
			async execute() {
				throw new Error("内部错误");
			},
		});
		const { agent, events } = makeAgent(
			[
				sse({
					choices: [
						{
							delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "boom", arguments: "{}" } }] },
							finish_reason: "tool_calls",
						},
					],
				}),
				sse({ choices: [{ delta: { content: "收到" }, finish_reason: "stop" }] }),
			],
			[failing],
		);

		await agent.prompt("触发异常");

		const toolEnd = events.find((event) => event.type === "tool_end");
		expect(toolEnd).toMatchObject({ outcome: { isError: true, content: "boom 执行失败：内部错误" } });
	});

	it("接口出错时发出 error 且不留下残缺的助理消息", async () => {
		const { agent, events } = makeAgent([]);
		const broken = new Agent({
			apiKey: "test",
			cwd: process.cwd(),
			tools: [echoTool()],
			onEvent: events.push.bind(events),
			fetchImpl: (async () => {
				// fetch 的网络失败就是 TypeError，这里照实抛同一种
				throw new TypeError("网络不通");
			}) as unknown as typeof fetch,
		});

		await broken.prompt("试试");

		// 分类字段跟着一起出来：宿主据此判断「重试有没有意义」
		expect(events).toEqual([{ type: "error", message: "请求失败：网络不通", code: "network", retryable: true }]);
		// 只有系统消息和用户消息，没有残缺的助理回合
		expect(broken.messages).toHaveLength(2);
		expect(agent.messages).toHaveLength(1);
	});

	it("超过 maxTurns 时以 error 结束", async () => {
		const alwaysTool = sse({
			choices: [
				{
					delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: "{}" } }] },
					finish_reason: "tool_calls",
				},
			],
		});
		const { agent, events } = makeAgent([alwaysTool, alwaysTool, alwaysTool]);
		const bounded = new Agent({
			apiKey: "test",
			cwd: process.cwd(),
			tools: [echoTool()],
			maxTurns: 2,
			onEvent: events.push.bind(events),
			fetchImpl: queuedFetch([alwaysTool, alwaysTool, alwaysTool]),
		});

		await bounded.prompt("一直调工具");

		expect(events.at(-1)).toMatchObject({ type: "error" });
		expect(agent.messages).toHaveLength(1);
	});

	it("reset 保留系统消息并清空历史", async () => {
		const { agent } = makeAgent([sse({ choices: [{ delta: { content: "回答" }, finish_reason: "stop" }] })]);

		await agent.prompt("问题");
		expect(agent.messages).toHaveLength(3);

		agent.reset();
		expect(agent.messages).toHaveLength(1);
		expect(agent.messages[0]?.role).toBe("system");
	});
});

describe("说明文件变化时的告知", () => {
	/** 造一个只含 AGENTS.md 的临时仓库 */
	function workspace(): string {
		const dir = mkdtempSync(join(tmpdir(), "limkenion-notice-"));
		mkdirSync(join(dir, ".git"), { recursive: true });
		writeFileSync(join(dir, "AGENTS.md"), "规则一：用中文回答\n");
		return dir;
	}

	/** 按顺序给几轮回答；每一轮都是一次「没有工具调用就结束」 */
	function answeringAgent(cwd: string, rounds: number): Agent {
		const answer = sse({ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] });
		return new Agent({
			apiKey: "test",
			cwd,
			tools: [],
			fetchImpl: queuedFetch(Array.from({ length: rounds }, () => answer)),
		});
	}

	/** 取出所有「说明文件已更新」告知的正文（没有就是空数组） */
	const notices = (agent: Agent): string[] =>
		agent.messages.flatMap((message) =>
			message.role === "user" && message.content.startsWith("[项目说明已更新]") ? [message.content] : [],
		);

	/** 系统提示词正文（messages[0] 恒为系统消息） */
	const systemPrompt = (agent: Agent): string => {
		const first = agent.messages[0];
		return first !== undefined && first.role === "system" ? first.content : "";
	};

	it("改过 AGENTS.md 之后追加一条告知，只说一次", async () => {
		const dir = workspace();
		try {
			const agent = answeringAgent(dir, 4);
			// 构造时读到的第一版不算「变化」，第一轮也不该有告知
			await agent.prompt("一");
			expect(notices(agent)).toHaveLength(0);

			writeFileSync(join(dir, "AGENTS.md"), "规则二：一律用英文回答\n");
			await agent.prompt("二");
			const notice = notices(agent);
			expect(notice).toHaveLength(1);
			expect(notice[0]).toContain("以它为准");
			expect(notice[0]).toContain(join(dir, "AGENTS.md"));
			// 系统提示词里已经是新内容，模型不必靠这条告知去猜新规则
			expect(systemPrompt(agent)).toContain("规则二：一律用英文回答");

			// 内容没再变：不该重复告知
			await agent.prompt("三");
			expect(notices(agent)).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("说明文件被删掉时说清旧指令作废", async () => {
		const dir = workspace();
		try {
			const agent = answeringAgent(dir, 3);
			await agent.prompt("一");
			rmSync(join(dir, "AGENTS.md"));
			await agent.prompt("二");
			const notice = notices(agent);
			expect(notice).toHaveLength(1);
			expect(notice[0]).toContain("已被移除");
			expect(systemPrompt(agent)).not.toContain("规则一");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("只切输出风格或计划模式不会触发告知", async () => {
		const dir = workspace();
		try {
			const agent = answeringAgent(dir, 2);
			await agent.prompt("一");
			agent.setStyle("concise");
			agent.setPlanMode("guide");
			await agent.prompt("二");
			expect(notices(agent)).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resume：接着失败的那一轮继续", () => {
	it("不追加用户消息，直接把最后那条指令重发一次", async () => {
		const failure = sseStream(['data: {"choices":[{"delta":{"content":"半句"}}]}\n\n']);
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) {
				// 只吐半句就断线：既没有 finish_reason 也没有 [DONE]
				return new Response(failure);
			}
			return new Response(
				sseStream(sse({ choices: [{ delta: { content: "这次答完了" }, finish_reason: "stop" }] })),
			);
		}) as unknown as typeof fetch;
		const { events, onEvent } = collector();
		const agent = new Agent({ apiKey: "test", cwd: process.cwd(), tools: [], onEvent, fetchImpl });

		await agent.prompt("跑一下");
		expect(events.at(-1)).toMatchObject({ type: "error" });
		const afterFailure = agent.messages.length;
		// 历史停在「用户消息在、助理消息不在」的位置：这正是可以重发的位置
		expect(agent.messages.at(-1)).toMatchObject({ role: "user", content: "跑一下" });

		await agent.resume();

		expect(agent.messages).toHaveLength(afterFailure + 1);
		expect(agent.messages.at(-1)).toMatchObject({ role: "assistant", content: "这次答完了" });
		// 重试没有把同一条指令又写进历史
		expect(agent.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});
});
