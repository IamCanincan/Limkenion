import { describeError } from "limkenion-ai";
import { defineTool } from "./tools/contract.ts";
import type { AgentTool } from "./types.ts";
/**
 * 子代理并行执行。
 *
 * 一次评审之所以要拆成几个互不通气的代理，是因为一个上下文里同时想「找缺陷」「看安全」
 * 「看测试」时注意力会互相稀释：先发现的问题会主导后面的判断。各自独立跑、只回传结论，
 * 主上下文既不用背它们的中间过程，也不会被第一个结论带偏。
 *
 * 这里只做「并行 + 限制并发 + 失败隔离」：怎么造 agent、用哪个模型、给哪些工具都由调用方决定，
 * 内核不替它拍板。
 */

/** 一个待执行的子任务 */
export interface SubagentTask {
	/** 报告里用的标签，也是失败时唯一的线索 */
	label: string;
	/** 交给这个代理的任务描述 */
	prompt: string;
}

/** 子任务的结论 */
export interface SubagentResult {
	label: string;
	/** 代理的最终回答；失败时为空串 */
	text: string;
	/** 失败原因；成功时为 undefined */
	error?: string;
}

/** 默认同时跑几个：再多也不会更快，只会更容易撞上限速 */
export const DEFAULT_FANOUT_LIMIT = 3;

/** 一条子任务的进度：谁开始了、谁结束了、谁挂了 */
export interface SubagentEvent {
	label: string;
	phase: "start" | "done" | "failed" | "aborted";
}

/**
 * 并行跑一组任务，最多同时 `limit` 个。
 *
 * 单个任务抛错只会变成这一条的 `error`，不影响其他任务——评审里「一个评审者挂了」
 * 不该让整轮结果作废。返回顺序与传入顺序一致，方便调用方按 label 对齐。
 *
 * `onEvent` 是给「看得见进度」用的（界面上的子代理谱系）：这一步仍然只做并行与隔离，
 * 状态归属于谁由调用方决定——想记在会话里就传一个往注册表里写的回调。
 */
export async function runSubagents(
	tasks: SubagentTask[],
	run: (task: SubagentTask, signal: AbortSignal) => Promise<string>,
	options: { limit?: number; signal?: AbortSignal; onEvent?: (event: SubagentEvent) => void } = {},
): Promise<SubagentResult[]> {
	const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_FANOUT_LIMIT));
	const results: SubagentResult[] = new Array<SubagentResult>(tasks.length);
	const fallback = new AbortController().signal;
	let cursor = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			const task = tasks[index];
			if (task === undefined) {
				return;
			}
			if (options.signal?.aborted) {
				results[index] = { label: task.label, text: "", error: "已中断" };
				options.onEvent?.({ label: task.label, phase: "aborted" });
				continue;
			}
			options.onEvent?.({ label: task.label, phase: "start" });
			try {
				const text = await run(task, options.signal ?? fallback);
				results[index] = { label: task.label, text };
				options.onEvent?.({ label: task.label, phase: "done" });
			} catch (error) {
				results[index] = {
					label: task.label,
					text: "",
					error: describeError(error),
				};
				options.onEvent?.({ label: task.label, phase: "failed" });
			}
		}
	};

	const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
	await Promise.all(workers);
	return results;
}

/** 一条子代理的进度（界面看的就是它：谁在跑、跑了多久、结论还是错误） */
export interface SubagentProgress {
	label: string;
	status: "running" | "done" | "failed" | "aborted";
	startedAt: number;
	endedAt: number | null;
	/** 成功时的结论；没结束时为空串 */
	text: string;
	/** 失败原因；没失败时为空串 */
	error: string;
}

/**
 * 把 `onEvent` 收成一份「谁在跑」的进度表。
 *
 * 这是**调用方拿得走的状态**：把它的 `onEvent` 直接传给 `runSubagents`，跑的过程中表就一直是新的——
 * 界面按它画谱系，会话关闭时 `clear()`。状态仍然属于调用方（内核只提供收集器，不持有会话）。
 */
export class SubagentProgressTable {
	private readonly rows = new Map<string, SubagentProgress>();
	/**
	 * 每条在跑的子代理各自的取消开关。
	 *
	 * 放在表里而不是调用方：**谁持有一份状态，谁就该能收掉它**——界面那颗「停止」按钮、会话收尾、
	 * 工具层的 `subagent_stop` 走的都是这一条路，不必各自再存一份。
	 */
	private readonly stops = new Map<string, AbortController>();

	/** 直接传给 runSubagents 的 onEvent */
	readonly onEvent = (event: SubagentEvent): void => {
		const now = Date.now();
		if (event.phase === "start") {
			this.rows.set(event.label, {
				label: event.label,
				status: "running",
				startedAt: now,
				endedAt: null,
				text: "",
				error: "",
			});
			return;
		}
		const row = this.rows.get(event.label) ?? {
			label: event.label,
			status: "running" as const,
			startedAt: now,
			endedAt: null,
			text: "",
			error: "",
		};
		// 只有还在跑的那一行才允许被终态覆盖：重复的 done/failed 不该把已定的结论改回去
		if (row.status === "running") {
			row.status = event.phase === "done" ? "done" : event.phase === "failed" ? "failed" : "aborted";
			row.endedAt = now;
		}
		this.rows.set(event.label, row);
	};

	/** 结果回来了补齐结论与原因（onEvent 只知道成败，内容在 runSubagents 的返回值里） */
	noteResult(label: string, text: string, error: string): void {
		const row = this.rows.get(label);
		if (row !== undefined) {
			row.text = text;
			row.error = error;
		}
	}

	/** 所有行（先起的在前） */
	list(): SubagentProgress[] {
		return [...this.rows.values()].map((row) => ({ ...row }));
	}

	/** 还在跑的条数 */
	runningCount(): number {
		return [...this.rows.values()].filter((row) => row.status === "running").length;
	}

	/** 清掉（换会话、会话关闭时用） */
	clear(): void {
		this.rows.clear();
		this.stops.clear();
	}

	/** 登记一条子代理的取消开关（起它的时候调；它自己结束时会解绑） */
	bind(label: string, stop: AbortController): void {
		this.stops.set(label, stop);
	}

	/** 解绑（子代理自己跑完时调） */
	unbind(label: string): void {
		this.stops.delete(label);
	}

	/** 收掉一条；不在跑返回 false */
	stop(label: string): boolean {
		const controller = this.stops.get(label);
		if (controller === undefined) {
			return false;
		}
		this.stops.delete(label);
		// 立刻把这一行标成已中断：子代理的循环要过一会儿才察觉取消，界面不能在这个空档里继续说「运行中」
		// （onEvent 那边只允许覆盖 running 的行，所以迟到的 failed 不会把它改回去）
		const row = this.rows.get(label);
		if (row !== undefined && row.status === "running") {
			row.status = "aborted";
			row.endedAt = Date.now();
		}
		controller.abort();
		return true;
	}

	/** 收掉全部（使用者点停止、删会话、服务端关闭） */
	stopAll(): void {
		for (const label of [...this.stops.keys()]) {
			this.stop(label);
		}
	}
}

/**
 * 创建子代理工具：起一条、看谁在跑、拿某一条的结论、收掉一条。
 *
 * 与 `job_*` 同一形状（起 → 列 → 读），区别是**跑法由调用方注入**：内核不负责「怎么造一个子 agent」
 * （用哪个模型、给哪些工具、工作目录在哪，都是调用方的决定）。调用方要保证子代理的**工具集里不再有
 * 这三个工具**——套娃的代价是不可控的上下文与花费，深度上限 1 是硬规矩。
 */
export function createSubagentTools(options: {
	run: (task: SubagentTask, signal: AbortSignal) => Promise<string>;
	table: SubagentProgressTable;
	limit?: number;
}): AgentTool[] {
	const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_FANOUT_LIMIT));
	let counter = 0;
	return [
		defineTool({
			name: "subagent_start",
			description:
				"起一个子代理去干一件「过程很长、结论很短」的事（把一批文件看完再总结、大范围搜索与核对）。" +
				"它有自己的上下文，回来只给你一段结论，适合把细节挡在主对话之外；" +
				`立刻返回一个标签，之后用 subagent_read 拿结论。同时最多 ${limit} 个在跑。` +
				"**别拿它干一句话能说清的事**——它比直接做贵。",
			parameters: {
				type: "object",
				properties: {
					task: { type: "string", description: "一句话说清要它查什么、回来给什么" },
					label: { type: "string", description: "短标签（报告里用它指代）；不填按序号" },
				},
				required: ["task"],
			},
			// 子代理能改文件，所以不算只读——计划模式（严格）与只读档下会被判定链拦下。
			// 起多个可以并排跑（并发上限在下面按进度表卡住）。
			isConcurrencySafe: () => true,
			summarize: (input) => (typeof input.task === "string" ? input.task : ""),
			validate: (input) =>
				typeof input.task === "string" && input.task.trim() !== ""
					? { ok: true }
					: { ok: false, message: "任务不能为空：一句话说清要它查什么、回什么" },
			async execute(input) {
				const task = (input.task as string).trim();
				// 全局并发上限。`DEFAULT_FANOUT_LIMIT` 从前只管 `runSubagents` 内部那一次调度，
				// 而每个 subagent_start 都自己起一次 limit=1 的调度——模型在一轮里发 20 个 start
				// 就是 20 个并发子代理，上限形同虚设。这里按同一张进度表把它卡住。
				const running = options.table.runningCount();
				if (running >= limit) {
					return {
						content: `同时最多 ${limit} 个子代理在跑（现在 ${running} 个）：先等一个结束，或者用 subagent_stop 收掉一个。`,
						isError: true,
					};
				}
				counter += 1;
				const label =
					typeof input.label === "string" && input.label.trim() !== "" ? input.label.trim() : `sub-${counter}`;
				if (options.table.list().some((row) => row.label === label)) {
					return { content: `标签 ${label} 已经用过：换一个，或者用 subagent_read 看它`, isError: true };
				}
				// 不 await：这就是「后台」的含义——这一轮立刻继续，结论等 subagent_read 来取
				const stop = new AbortController();
				options.table.bind(label, stop);
				void runSubagents([{ label, prompt: task }], options.run, {
					limit: 1,
					signal: stop.signal,
					onEvent: options.table.onEvent,
				})
					.then((results) => {
						const result = results[0];
						if (result !== undefined) {
							options.table.noteResult(label, result.text, result.error ?? "");
						}
					})
					.finally(() => options.table.unbind(label));
				return { content: `已起「${label}」：${task}`, isError: false };
			},
		}),
		// 三个「看/收」的工具都只碰内存里的进度表，不改工作区：任何档位都放行，
		// 否则只读档下会攒一堆收不掉的子代理。
		defineTool({
			name: "subagent_stop",
			description: "收掉一条还在跑的子代理（它自己的模型循环会中断，进度行标成已中断）。已经结束的返回一句说明。",
			parameters: {
				type: "object",
				properties: { label: { type: "string", description: "subagent_start 给的标签" } },
				required: ["label"],
			},
			alwaysReadOnly: true,
			isConcurrencySafe: () => true,
			summarize: (input) => (typeof input.label === "string" ? input.label : ""),
			validate: (input) =>
				typeof input.label === "string" && input.label !== ""
					? { ok: true }
					: { ok: false, message: "缺少必填参数 label" },
			async execute(input) {
				const label = typeof input.label === "string" ? input.label : "";
				const stopped = options.table.stop(label);
				return stopped
					? { content: `已停止「${label}」`, isError: false }
					: { content: `「${label}」不在运行中（用 subagent_list 看现有的）`, isError: false };
			},
		}),
		defineTool({
			name: "subagent_list",
			description: "列出子代理（状态、耗时、任务）。看某个的结论用 subagent_read。",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			alwaysReadOnly: true,
			isConcurrencySafe: () => true,
			async execute() {
				return { content: renderSubagentProgress(options.table.list()), isError: false };
			},
		}),
		defineTool({
			name: "subagent_read",
			description: "读一个子代理的结论。还在跑时它会告诉你再等等。",
			parameters: {
				type: "object",
				properties: { label: { type: "string", description: "subagent_start 给的标签" } },
				required: ["label"],
			},
			alwaysReadOnly: true,
			isConcurrencySafe: () => true,
			summarize: (input) => (typeof input.label === "string" ? input.label : ""),
			validate: (input) =>
				typeof input.label === "string" && input.label !== ""
					? { ok: true }
					: { ok: false, message: "缺少必填参数 label" },
			async execute(input) {
				const label = typeof input.label === "string" ? input.label : "";
				const row = options.table.list().find((item) => item.label === label);
				if (row === undefined) {
					return { content: `没有「${label}」：用 subagent_list 看现有的`, isError: true };
				}
				if (row.status === "running") {
					return {
						content: `「${label}」还在跑（${Math.round((Date.now() - row.startedAt) / 1000)} 秒）。`,
						isError: false,
					};
				}
				if (row.status === "done") {
					return { content: row.text, isError: false };
				}
				return { content: `[${row.status === "aborted" ? "已中断" : "失败"}] ${row.error}`, isError: true };
			},
		}),
	];
}

/** 进度表的人话渲染（给 subagent_list，也给将来的界面复用同一份说法） */
export function renderSubagentProgress(rows: SubagentProgress[]): string {
	if (rows.length === 0) {
		return "没有子代理。";
	}
	return rows
		.map((row) => {
			const seconds = Math.max(0, Math.round(((row.endedAt ?? Date.now()) - row.startedAt) / 1000));
			const label =
				row.status === "running"
					? "运行中"
					: row.status === "done"
						? "已完成"
						: row.status === "aborted"
							? "已中断"
							: "失败";
			return `[${row.label}] ${label}（${seconds} 秒）${row.error === "" ? "" : `：${row.error}`}`;
		})
		.join("\n");
}
