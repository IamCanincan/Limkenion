/**
 * 一轮的驱动。
 *
 * 一次 prompt 的流程：
 *   用户消息 -> 调用模型 -> 若模型要求调用工具则依次执行 -> 把结果回灌 -> 再次调用
 * 直到模型不再要求调用工具，或达到 maxTurns 上限。
 *
 * 每轮循环做三件事，顺序固定：
 *   1. 判一次上下文（先裁剪，必要时摘要）——轮与轮之间要压，一轮之内跑了几十个工具同样要压；
 *   2. 做一份这一轮的快照（模型、工具表、上限），照着它发起调用；
 *   3. 把这一轮的产出（正文、思维链、工具调用）收进历史，工具调用交给 tool-pipeline 逐条跑完。
 *
 * 工具**按批**执行：连续的只读调用并排跑，会改东西的独占一批（见 tools/orchestrate.ts）。
 * 从前这里是一律串行，理由是「系统工具里有三个会改文件」——那个理由对写工具成立，但把只读的
 * 也一起拖下水了：一轮里读五个文件要排五次队，而它们之间没有任何冲突。并发安全性由每个工具
 * 对自己入参的自陈决定，默认值是「不可并发」，所以会写的一定还是独占。
 */

import { DEFAULT_RETRIES, streamChat, type ToolResult, type Usage } from "limkenion-ai";
import { countChars, looksContextOverflow, rescueOverflow } from "./compaction.ts";
import { compressContext, recordUsage } from "./context-manager.ts";
import type { SessionState } from "./session.ts";
import { runPreparedCall } from "./tool-pipeline.ts";
import { addUsage, parseArguments } from "./tool-run.ts";
import { partitionCalls, prepareCalls, runConcurrently } from "./tools/orchestrate.ts";
import { buildTurnContext, type TurnContext } from "./turn-context.ts";
import type { AgentEvent } from "./types.ts";

/** 模型要求的一次工具调用 */
interface ToolCallRequest {
	id: string;
	name: string;
	arguments: string;
}

/** 一轮的驱动：调用模型 -> 跑工具 -> 回灌，直到模型不再要工具或轮数用尽 */
export async function runTurn(state: SessionState, signal: AbortSignal): Promise<void> {
	let turns = 0;
	let totalUsage: Usage | null = null;
	// 超窗救援每次只做一次：压不动还反复删历史，只会把任务目标也删光。
	let rescued = false;

	while (turns < state.maxTurns) {
		turns += 1;

		/*
		 * 每次调模型前都判一次上下文。只在 prompt 开头压过一次的话，一次跑几十个工具的长提问
		 * 中间没人管，只能等接口报「上下文超长」，再走丢历史的救援——而那时候用户原话已经在
		 * 被丢掉的边缘了。轮内触发时事件带 midTurn，让用户看得出这不是轮与轮之间的常规压缩。
		 */
		await compressContext(state, signal, turns > 1);

		const context = buildTurnContext(state);
		const contentParts: string[] = [];
		const reasoningParts: string[] = [];
		const toolCalls: ToolCallRequest[] = [];
		/** 这一轮接口报的错（含分类字段），null 表示这一轮拿到了模型回应 */
		let failed: Extract<AgentEvent, { type: "error" }> | null = null;
		// 发出去多少字符，接口就会回报这批内容的真实 token 数，两者一起用来校准估算。
		const sentChars = countChars(state.messages);
		let promptTokens: number | undefined;

		for await (const event of streamChat({
			model: context.model,
			messages: state.messages,
			tools: context.toolSpecs,
			apiKey: state.apiKey,
			baseUrl: state.baseUrl,
			temperature: context.temperature,
			signal,
			fetchImpl: state.fetchImpl,
			retry: { retries: state.retries ?? DEFAULT_RETRIES },
			onRetry: state.onRetry,
		})) {
			if (event.type === "reasoning") {
				reasoningParts.push(event.delta);
				state.emit({ type: "reasoning", delta: event.delta });
			} else if (event.type === "text") {
				contentParts.push(event.delta);
				state.emit({ type: "text", delta: event.delta });
			} else if (event.type === "tool_call") {
				toolCalls.push(event.call);
			} else if (event.type === "done") {
				totalUsage = addUsage(totalUsage, event.usage);
				promptTokens = event.usage?.promptTokens;
			} else {
				// 整条错误事件留着：分类字段（code / retryable / Retry-After）要原样传给宿主，
				// 界面才不用去猜中文错误文案。
				failed = event;
			}
		}

		// 真实用量优先：它描述的是「这批内容在这个模型上值多少 token」。
		recordUsage(state, promptTokens, sentChars);

		if (failed !== null) {
			// 上下文超窗（而不是密钥错、参数错）时删掉最旧的几轮就能接着跑，比让用户重开会话好。
			// 只在「这一轮什么都没发出去」时救援：已经吐给了用户的正文重发会变成双份。
			const emitted = contentParts.length > 0 || reasoningParts.length > 0 || toolCalls.length > 0;
			if (!rescued && !emitted && looksContextOverflow(failed.message)) {
				const rescue = rescueOverflow(state.messages, context.model.contextWindow);
				if (rescue.dropped > 0) {
					state.messages.splice(0, state.messages.length, ...rescue.messages);
					rescued = true;
					state.emit({
						type: "compaction",
						pruned: rescue.dropped,
						savedTokens: 0,
						summarized: false,
						rescued: true,
					});
					// 救援重发不算一轮：它花的是接口的一次拒绝，不是用户的一次提问机会。
					turns -= 1;
					continue;
				}
			}
			// 分类字段原样带出去：宿主（网页、脚本）靠它决定要不要重试，而不是去猜错误文案。
			state.emit(failed);
			return;
		}

		// 助理消息先入历史，工具结果才能和 tool_calls 对上号。
		state.messages.push({
			role: "assistant",
			content: contentParts.join(""),
			reasoning: reasoningParts.join(""),
			toolCalls,
		});

		if (toolCalls.length === 0) {
			// `promptTokens` 是这一次请求的（不是本轮累计），界面用它算上下文占用比例。
			state.emit({
				type: "done",
				turns,
				usage: totalUsage,
				...(promptTokens === undefined ? {} : { contextTokens: promptTokens }),
			});
			return;
		}

		state.messages.push({ role: "tool", results: await runTools(state, context, toolCalls, signal) });
	}

	// 轮数用尽：告知调用方，避免看起来像正常结束。`code` 是机器可读的分类，
	// 界面据此能和接口错误区别对待（这个不是接口故障，重试也没用，该做的是缩小任务）。
	state.emit({
		type: "error",
		message: `已达到最大轮数 ${state.maxTurns}，工具调用可能陷入循环`,
		code: "max-turns",
	});
}

/**
 * 按批执行模型要求的所有工具调用，任何失败都转成工具结果而不是抛出。
 *
 * 顺序有三条保证：
 * - 重复提醒按**原始顺序**预先算好（并发批里的完成顺序不定，现算会让计数随调度抖动）；
 * - `tool_start` 在整批开跑之前全部发出，界面上看到的是「这几个在同时跑」；
 * - 返回结果与模型给出的顺序逐条对应——模型看到的和它发出来的对得上。
 */
async function runTools(
	state: SessionState,
	context: TurnContext,
	calls: ToolCallRequest[],
	signal: AbortSignal,
): Promise<ToolResult[]> {
	const prepared = prepareCalls(calls, context.tools, parseArguments);
	const reminders = new Map(prepared.map((call) => [call.id, state.repeats.observe(call.name, call.arguments)]));
	const results: ToolResult[] = [];

	for (const batch of partitionCalls(prepared)) {
		for (const call of batch) {
			// 参数不合法时也要发出 tool_start，否则界面上会看到「没有开始的结束」。
			state.emit({ type: "tool_start", id: call.id, name: call.name, input: call.input ?? {} });
		}
		const done = await runConcurrently(batch, async (call) => {
			const outcome = await runPreparedCall(
				state,
				context,
				call.tool,
				call.name,
				call.arguments,
				call.input,
				reminders.get(call.id) ?? null,
				signal,
			);
			state.emit({ type: "tool_end", id: call.id, name: call.name, outcome });
			return { toolCallId: call.id, content: outcome.content, isError: outcome.isError };
		});
		results.push(...done);
	}
	return results;
}
