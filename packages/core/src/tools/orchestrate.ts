/**
 * 工具调度的切批。
 *
 * 一批调用是并排跑还是
 * 排队跑，**不由调度器猜**，而是看每个工具对自己这次入参的自陈（`isConcurrencySafe`）。
 * 调度器只做一件极小的事——把连续的「可并发」调用拼成一批，其余每个自占一批。
 *
 * 从前 `turn.ts` 里写着一句「工具顺序执行而不是并发执行」，理由是「四个系统工具里有三个会改文件」。
 * 那个理由对会写的工具成立，但把只读的那些也一起拖下水了：一轮里读五个文件要排五次队，而它们
 * 之间没有任何冲突。现在改文件、跑命令的仍然串行（默认值就是不可并发），只读的可以并排。
 *
 * 三条保守规则：
 * 1. **解析失败或不认识的工具**不并发，独占一批；
 * 2. 自陈函数**抛异常**时按不可并发处理（判定发生在 `defineTool` 里，见 contract.ts）；
 * 3. 批次**按原顺序切**、不重排，所以批内无序、批间严格有序——回灌给模型的工具结果因此仍是
 *    原始顺序，模型看到的和它发出来的对得上。
 */

import type { AgentTool } from "./contract.ts";

/** 同时最多跑几个并发安全的工具 */
export const MAX_TOOL_CONCURRENCY = 6;

/** 一次准备就绪的调用 */
export interface PreparedCall {
	/** 模型给的调用 id */
	id: string;
	/** 工具名 */
	name: string;
	/** 模型给的原始参数字符串（重复调用检测要按它比） */
	arguments: string;
	/** 解析后的入参；不是合法 JSON 时是 null */
	input: Record<string, unknown> | null;
	/** 找到的工具；名字对不上时是 undefined */
	tool: AgentTool | undefined;
}

/** 把模型给的调用与工具表对上 */
export function prepareCalls(
	calls: readonly { id: string; name: string; arguments: string }[],
	tools: readonly AgentTool[],
	parse: (raw: string) => Record<string, unknown> | null,
): PreparedCall[] {
	return calls.map((call) => ({
		id: call.id,
		name: call.name,
		arguments: call.arguments,
		input: parse(call.arguments),
		tool: tools.find((candidate) => candidate.name === call.name),
	}));
}

/**
 * 切批。
 *
 * 只有「工具找得到、参数解析得了、且工具自己说这次可以并发」的调用才会和**紧挨着的**同类拼批。
 * 任何一条不满足就自己开一批，于是它前后都成了天然的顺序屏障。
 */
export function partitionCalls(calls: readonly PreparedCall[]): PreparedCall[][] {
	const batches: PreparedCall[][] = [];
	for (const call of calls) {
		const safe = call.tool !== undefined && call.input !== null && call.tool.isConcurrencySafe(call.input);
		const last = batches.at(-1);
		if (safe && last !== undefined && last.length > 0 && isBatchSafe(last)) {
			last.push(call);
			continue;
		}
		batches.push([call]);
	}
	return batches;
}

/** 一批是不是全由可并发的调用组成 */
function isBatchSafe(batch: readonly PreparedCall[]): boolean {
	const first = batch[0];
	return (
		first !== undefined &&
		first.tool !== undefined &&
		first.input !== null &&
		first.tool.isConcurrencySafe(first.input)
	);
}

/**
 * 并排跑一批，返回顺序与传入顺序一致。
 *
 * 用「固定几个工人轮流取下一个」而不是一次 `Promise.all` 全部发出去：并发上限必须真的生效，
 * 否则模型一条消息里发二十个 `read` 就会同时开二十个文件句柄。工人数取 `min(limit, tasks.length)`。
 *
 * 单个任务抛错由调用方自己转成失败结果（工具执行不会抛到这里，见 pipeline.ts）。
 */
export async function runConcurrently<T, R>(
	tasks: readonly T[],
	run: (task: T) => Promise<R>,
	limit: number = MAX_TOOL_CONCURRENCY,
): Promise<R[]> {
	const results = new Array<R>(tasks.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			const task = tasks[index];
			if (task === undefined) {
				return;
			}
			results[index] = await run(task);
		}
	};
	const workers = Array.from({ length: Math.min(Math.max(1, Math.floor(limit)), tasks.length) }, worker);
	await Promise.all(workers);
	return results;
}
