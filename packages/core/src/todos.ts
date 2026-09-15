/**
 * 待办清单。
 *
 * 复杂任务最容易出的问题不是「不会做」，而是「做着做着忘了还剩什么」：中途被工具输出带跑、
 * 上下文压缩之后计划没了、收尾时漏掉验证。把计划写成一份清单落进工具结果里，比让模型记在
 * 「想」里可靠——清单是上下文的一部分，每次更新都会重新回灌给模型，用户也顺带看见进度。
 *
 * 只有两个动作：`todo_write` 整表替换，`todo_read` 读回。整表替换而不是做增量补丁，是因为
 * 模型每轮都能给出完整清单，再发明一套增删改协议只会多出出错的机会。
 */

import { defineTool } from "./tools/contract.ts";
import type { AgentTool } from "./types.ts";

/** 一项的状态 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 一项待办 */
export interface TodoItem {
	/** 要做什么，一句话 */
	content: string;
	status: TodoStatus;
}

/** 清单最多几项：再多也记不住，说明任务该拆了 */
export const MAX_TODO_ITEMS = 50;

/** 单项内容的字数上限 */
export const MAX_TODO_CONTENT = 200;

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

/**
 * 校验并规整模型给的清单。
 *
 * 工具入参的字段内容未经校验，模型少写一个 `status`、把 `todos` 写成字符串都很常见，
 * 所以这里逐项检查并返回可读的错误，让模型自己改。
 */
export function parseTodos(raw: unknown): { items: TodoItem[] } | { error: string } {
	if (!Array.isArray(raw)) {
		return { error: "todos 必须是数组，每一项形如 { content, status }" };
	}
	if (raw.length > MAX_TODO_ITEMS) {
		return { error: `一次最多 ${MAX_TODO_ITEMS} 项，先拆小一点再来` };
	}

	const items: TodoItem[] = [];
	for (const [index, entry] of raw.entries()) {
		const position = index + 1;
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			return { error: `第 ${position} 项不是对象` };
		}
		const record = entry as Record<string, unknown>;
		const content = typeof record.content === "string" ? record.content.trim() : "";
		if (content === "") {
			return { error: `第 ${position} 项缺少 content` };
		}
		if (content.length > MAX_TODO_CONTENT) {
			return { error: `第 ${position} 项的 content 超过 ${MAX_TODO_CONTENT} 字，改短一点` };
		}
		const status = record.status;
		if (status !== undefined && !STATUSES.includes(status as TodoStatus)) {
			return { error: `第 ${position} 项的 status 只能是 ${STATUSES.join(" / ")}` };
		}
		items.push({ content, status: (status as TodoStatus | undefined) ?? "pending" });
	}
	return { items };
}

/** 把清单渲染成模型和用户都能直接看的文本 */
export function renderTodos(items: readonly TodoItem[]): string {
	if (items.length === 0) {
		return "（清单为空）";
	}
	const lines = items.map((item, index) => {
		const mark = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
		return `${index + 1}. ${mark} ${item.content}`;
	});
	const done = items.filter((item) => item.status === "completed").length;
	const active = items.filter((item) => item.status === "in_progress").length;
	lines.push("", `${items.length} 项：${done} 完成 / ${active} 进行中 / ${items.length - done - active} 待办`);
	return lines.join("\n");
}

/** 一份清单；状态放在会话里，不落盘——它描述的是「这一轮做到哪了」 */
export class TodoList {
	private items: TodoItem[] = [];

	/** 当前项数 */
	get size(): number {
		return this.items.length;
	}

	/** 取一份副本，避免调用方拿到内部数组后随手改 */
	list(): TodoItem[] {
		return this.items.map((item) => ({ ...item }));
	}

	/** 整表替换 */
	replace(items: TodoItem[]): void {
		this.items = items.map((item) => ({ ...item }));
	}

	/** 渲染 */
	render(): string {
		return renderTodos(this.items);
	}
}

/** 创建待办清单工具 */
export function createTodoTools(todos: TodoList): AgentTool[] {
	return [
		defineTool({
			name: "todo_write",
			description:
				"整表替换待办清单。任务需要三步以上就先把它写出来，之后每完成一项立刻更新；" +
				"同一时间只留一项 in_progress，全部做完时把每项标成 completed。todos 是完整清单，不是增量。",
			parameters: {
				type: "object",
				properties: {
					todos: {
						type: "array",
						description: "完整清单，按执行顺序排列",
						items: {
							type: "object",
							properties: {
								content: { type: "string", description: "要做什么，一句话" },
								status: {
									type: "string",
									enum: [...STATUSES],
									description: "不填按 pending 处理",
								},
							},
							required: ["content"],
						},
					},
				},
				required: ["todos"],
			},
			// 只改会话内的清单，不碰文件系统。计划模式（严格）下正需要它把方案写成清单。
			alwaysReadOnly: true,
			summarize: (input) => {
				const todos = input.todos;
				return Array.isArray(todos) ? `${todos.length} 项` : "";
			},
			validate: (input) => {
				const parsed = parseTodos(input.todos);
				return "error" in parsed ? { ok: false, message: parsed.error } : { ok: true };
			},
			async execute(input) {
				const parsed = parseTodos(input.todos);
				if ("error" in parsed) {
					return { content: parsed.error, isError: true };
				}
				todos.replace(parsed.items);
				return { content: `清单已更新：\n${todos.render()}`, isError: false };
			},
		}),
		defineTool({
			name: "todo_read",
			description: "读回当前待办清单。上下文被压缩、或者中途接手一个任务时，用它确认还剩什么。",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			alwaysReadOnly: true,
			isConcurrencySafe: () => true,
			async execute() {
				return { content: todos.render(), isError: false };
			},
		}),
	];
}
