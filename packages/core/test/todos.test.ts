/**
 * 待办清单测试。
 *
 * 重点在两处：模型给的入参必须先校验再进清单（否则脏数据会一路带进上下文），
 * 以及清单渲染出来的计数要能直接当进度看。
 */

import { describe, expect, it } from "vitest";
import { judgeToolUse } from "../src/permissions/chain.ts";
import { createTodoTools, MAX_TODO_ITEMS, parseTodos, renderTodos, TodoList } from "../src/todos.ts";
import { createSystemTools } from "../src/tools/index.ts";
import { createWriteTool } from "../src/tools/write.ts";

describe("parseTodos", () => {
	it("接受合法的清单，缺 status 时按 pending 处理", () => {
		const parsed = parseTodos([{ content: " 先读代码 " }, { content: "改文件", status: "in_progress" }]);
		expect(parsed).toEqual({
			items: [
				{ content: "先读代码", status: "pending" },
				{ content: "改文件", status: "in_progress" },
			],
		});
	});

	it("拒绝不是数组的入参", () => {
		expect(parseTodos("做点事")).toEqual({ error: expect.stringContaining("必须是数组") });
	});

	it("拒绝缺 content 或 content 为空的项", () => {
		expect(parseTodos([{ status: "pending" }])).toEqual({ error: expect.stringContaining("第 1 项缺少 content") });
		expect(parseTodos([{ content: "  " }])).toEqual({ error: expect.stringContaining("缺少 content") });
	});

	it("拒绝非法 status 与非对象项，并指出位置", () => {
		expect(parseTodos([{ content: "a" }, { content: "b", status: "done" }])).toEqual({
			error: expect.stringContaining("第 2 项"),
		});
		expect(parseTodos([{ content: "a" }, 42])).toEqual({ error: expect.stringContaining("第 2 项不是对象") });
	});

	it("拒绝超长清单", () => {
		const many = Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, index) => ({ content: `第 ${index} 项` }));
		expect(parseTodos(many)).toEqual({ error: expect.stringContaining(`最多 ${MAX_TODO_ITEMS} 项`) });
	});
});

describe("renderTodos", () => {
	it("用三种记号区分状态并统计进度", () => {
		const text = renderTodos([
			{ content: "读代码", status: "completed" },
			{ content: "改文件", status: "in_progress" },
			{ content: "跑测试", status: "pending" },
		]);
		expect(text).toBe("1. [x] 读代码\n2. [~] 改文件\n3. [ ] 跑测试\n\n3 项：1 完成 / 1 进行中 / 1 待办");
	});

	it("空清单有明确说法", () => {
		expect(renderTodos([])).toBe("（清单为空）");
	});
});

describe("TodoList", () => {
	it("替换后 list() 给出副本，外部改动不会污染清单", () => {
		const todos = new TodoList();
		todos.replace([{ content: "读代码", status: "pending" }]);
		const copy = todos.list();
		copy[0].content = "改掉了";
		expect(todos.list()[0].content).toBe("读代码");
		expect(todos.size).toBe(1);
	});
});

describe("待办工具", () => {
	it("todo_write 整表替换并把清单回灌给模型", async () => {
		const todos = new TodoList();
		const tool = createTodoTools(todos).find((candidate) => candidate.name === "todo_write");
		const outcome = await tool?.execute(
			{ todos: [{ content: "读代码" }, { content: "改文件" }] },
			new AbortController().signal,
		);
		expect(outcome?.isError).toBe(false);
		expect(outcome?.content).toContain("1. [ ] 读代码");
		expect(outcome?.content).toContain("2 项：0 完成");
		expect(todos.list()).toHaveLength(2);
	});

	it("入参不合法时返回错误而不是抛异常，且不动原清单", async () => {
		const todos = new TodoList();
		todos.replace([{ content: "原有的一项", status: "pending" }]);
		const tool = createTodoTools(todos).find((candidate) => candidate.name === "todo_write");
		const outcome = await tool?.execute({ todos: [{ content: "" }] }, new AbortController().signal);
		expect(outcome?.isError).toBe(true);
		expect(todos.list().map((item) => item.content)).toEqual(["原有的一项"]);
	});

	it("todo_read 读回当前清单", async () => {
		const todos = new TodoList();
		todos.replace([{ content: "跑测试", status: "completed" }]);
		const tool = createTodoTools(todos).find((candidate) => candidate.name === "todo_read");
		const outcome = await tool?.execute({}, new AbortController().signal);
		expect(outcome?.content).toContain("1. [x] 跑测试");
	});

	it("createSystemTools 默认带出两个待办工具，并能复用外部清单", async () => {
		const names = createSystemTools({ cwd: process.cwd() }).map((tool) => tool.name);
		expect(names).toContain("todo_write");
		expect(names).toContain("todo_read");

		const shared = new TodoList();
		const tools = createSystemTools({ cwd: process.cwd(), todos: shared });
		const write = tools.find((tool) => tool.name === "todo_write");
		await write?.execute({ todos: [{ content: "复用同一份清单" }] }, new AbortController().signal);
		expect(shared.size).toBe(1);
	});

	it("只读与计划模式都放行待办工具（它不碰文件）", () => {
		// 按名字取工具，不按下标：加一个工具就会把位置解构错开。
		const todoTools = createTodoTools(new TodoList());
		const todoWrite = todoTools.find((candidate) => candidate.name === "todo_write");
		if (todoWrite === undefined) {
			throw new Error("没有 todo_write");
		}
		const write = createWriteTool({ cwd: process.cwd() });
		expect(
			judgeToolUse({ tool: todoWrite, input: {}, mode: "readonly", planMode: "off", cwd: process.cwd() }).behavior,
		).toBe("allow");
		expect(
			judgeToolUse({ tool: todoWrite, input: {}, mode: "ask", planMode: "strict", cwd: process.cwd() }).behavior,
		).toBe("allow");
		expect(
			judgeToolUse({ tool: write, input: { path: "a.txt" }, mode: "readonly", planMode: "off", cwd: process.cwd() })
				.behavior,
		).toBe("deny");
	});
});
