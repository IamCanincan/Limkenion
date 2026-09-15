/**
 * 运行时装配的测试。
 *
 * 这一份是**命令行与浏览器界面共用的**（`createRunRuntime`），而它存在的直接理由就是两边各写一份
 * 时掉过东西：命令行自己拼工具集时忘了传 `subagents`，于是**终端里根本没有子代理工具**
 * （`createSystemTools` 只在收到它时才注册那四个），网页却有。这里把「两边的工具集一样」钉住。
 *
 * 另一条钉的是补上来的安全口径：子代理从前一律按 `auto` 起，于是「ask 档下动手前要问一句」
 * 对子代理不成立——父被拦住的事，子代理能直接做。现在档位、计划模式、钩子都跟着父走。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Options, parseOptions } from "../src/args.ts";
import { createCliRuntime } from "../src/cli.ts";
import { AGENT_DIR_ENV } from "../src/config.ts";
import { createRunRuntime } from "../src/run-agent.ts";
import { Session } from "../src/session.ts";

let cwd = "";
let agentDir = "";
const originalAgentDir = process.env[AGENT_DIR_ENV];

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "limkenion-runtime-"));
	agentDir = await mkdtemp(join(tmpdir(), "limkenion-runtime-agent-"));
	// 指向空目录，免得读到开发机上真实的 config.json / commands
	process.env[AGENT_DIR_ENV] = agentDir;
});

afterEach(async () => {
	if (originalAgentDir === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = originalAgentDir;
	}
	await rm(cwd, { recursive: true, force: true });
	await rm(agentDir, { recursive: true, force: true });
});

/** 造一份最小可用的命令行参数 */
function parse(argv: string[] = []): Options {
	const options = parseOptions(argv);
	if (options === null || options === "usage-error") {
		throw new Error(`参数没解析成功：${argv.join(" ")}`);
	}
	return { ...options, apiKey: options.apiKey === "" ? "sk-test" : options.apiKey };
}

/** 造一个不落盘的运行时（历史只活在内存里，够断言工具集了） */
function makeRuntime() {
	return createRunRuntime({
		session: null,
		cwd,
		host: { resolveApiKey: () => "sk-test", modelId: "deepseek-flash", fetchImpl: fetchThatFails() },
		modes: { approval: "auto", plan: "off", style: "default", compaction: true },
		getCompaction: () => true,
		onEvent: () => {},
		onApproval: async () => true,
		onPlanReview: async () => ({ approved: true, feedback: "" }),
	});
}

/** 真被调用就抛：这些用例都不该走到模型那一步 */
function fetchThatFails(): typeof fetch {
	return (() => {
		throw new Error("不该调用模型");
	}) as unknown as typeof fetch;
}

describe("运行时装配（命令行与网页共用）", () => {
	it("终端也有子代理工具：两边的工具集一样全", () => {
		const runtime = makeRuntime();
		const names = runtime.agent.listTools().map((tool) => tool.name);
		// 这一条是回归测试：命令行自己拼工具集时没传 subagents，终端里这四个工具根本不存在
		for (const name of ["subagent_start", "subagent_list"]) {
			expect(names).toContain(name);
		}
		// 其余几组能力也都要在（同一份装配，不该因为载体不同少一块）
		for (const name of ["bash", "read", "write", "edit", "grep", "glob", "todo_write", "goal_write", "present"]) {
			expect(names).toContain(name);
		}
		expect(names.some((name) => name.startsWith("job_"))).toBe(true);
	});

	it("待办与目标就是工具层在改的那两份，不是拷贝", async () => {
		const runtime = makeRuntime();
		const write = runtime.agent.listTools().find((tool) => tool.name === "todo_write");
		expect(write).toBeDefined();
		const signal = new AbortController().signal;
		await write?.execute({ todos: [{ content: "写内核", status: "in_progress" }] }, signal);
		expect(runtime.todos.list()).toEqual([{ content: "写内核", status: "in_progress" }]);

		const goal = runtime.agent.listTools().find((tool) => tool.name === "goal_write");
		await goal?.execute({ content: "把两边补齐", status: "active" }, signal);
		expect(runtime.goals.current).toEqual({ content: "把两边补齐", status: "active" });
	});

	it("命令行的运行时也走同一份装配（含子代理）", () => {
		const session = Session.create(cwd);
		const runtime = createCliRuntime(cwd, parse(), session);
		const names = runtime.agent.listTools().map((tool) => tool.name);
		expect(names).toContain("subagent_start");
		// 有会话就有逐轮快照（网页那一侧靠它回滚，终端靠 /rewind）
		expect(runtime.checkpoints).toBeDefined();
		// 续写：历史从会话文件接上
		expect(runtime.agent.messages[0]?.role).toBe("system");
	});

	it("不落盘的一次性模式：没有逐轮快照，历史只有系统提示词", () => {
		const runtime = createCliRuntime(cwd, parse(), null);
		expect(runtime.checkpoints).toBeUndefined();
		expect(runtime.agent.messages.map((message) => message.role)).toEqual(["system"]);
	});

	it("子代理跟着父的档位走：ask 档下它不能偷偷改文件", async () => {
		/*
		 * 父的 ask 档如果对子代理不生效，就等于「一次委派绕过审批」——子代理可以在没人点头的情况下
		 * 写文件。子代理不弹确认卡片（一次委派弹两次会把「等你点一下」变成常态），所以它继承 ask
		 * 之后按**拒绝**处理。
		 */
		const runtime = makeSubagentWritesRuntime("ask");
		await runtime.agent.prompt("让子代理去改文件");
		await waitForSubagents(runtime);
		// 子代理确实跑过且跑完了（否则这条用例什么都没测到）
		expect(runtime.subagents.list().map((row) => row.status)).toEqual(["done"]);
		expect(await readFile(join(cwd, "note.txt"), "utf-8").catch(() => "")).toBe("");
	});

	it("档位是运行期改的也算数：子代理读的是父**当下**的档位", async () => {
		// 与上一条的区别：这里父 agent 是按 auto 建起来的，起子代理之前才切成 ask。
		// 子代理要是只认构造时的初值，这次写入就会被放行。
		const runtime = makeSubagentWritesRuntime("auto");
		expect(runtime.agent.approvalMode).toBe("auto");
		runtime.agent.setApprovalMode("ask");
		await runtime.agent.prompt("让子代理去改文件");
		await waitForSubagents(runtime);
		expect(runtime.subagents.list().map((row) => row.status)).toEqual(["done"]);
		expect(await readFile(join(cwd, "note.txt"), "utf-8").catch(() => "")).toBe("");
	});
});

/**
 * 造一个运行时：模型第一次要求起子代理，子代理第一件事就是写文件。
 *
 * `subagent_start` 是**后台**的（起完立刻返回，结论靠 subagent_read 取），所以断言之前必须等它跑完
 * ——否则「文件没被写」在实现坏掉时也会通过。
 */
function makeSubagentWritesRuntime(approval: "auto" | "ask"): ReturnType<typeof createRunRuntime> {
	let calls = 0;
	return createRunRuntime({
		session: null,
		cwd,
		host: {
			resolveApiKey: () => "sk-test",
			modelId: "deepseek-flash",
			fetchImpl: (async () => {
				calls += 1;
				// 1：父要求起一个子代理；2：子代理第一件事就是写文件；3：子代理解释它干了什么
				const choice =
					calls === 1
						? { tool_calls: toolCall("subagent_start", { label: "改文件", task: "把 note.txt 写掉" }) }
						: calls === 2
							? { tool_calls: toolCall("write", { path: "note.txt", content: "偷偷写的" }) }
							: { content: "写不了" };
				return new Response(
					[
						`data: ${JSON.stringify({ choices: [{ delta: choice }] })}`,
						"",
						`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
						"",
						"data: [DONE]",
						"",
					].join("\n"),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}) as unknown as typeof fetch,
		},
		modes: { approval, plan: "off", style: "default", compaction: true },
		getCompaction: () => true,
		onEvent: () => {},
		// 父自己那一步是要问的：这里一律同意，好让用例专注在「子代理那一步」上
		onApproval: async () => true,
		onPlanReview: async () => ({ approved: true, feedback: "" }),
	});
}

/** 等子代理跑完（它不占主对话那一轮，prompt 返回时它可能还在跑） */
async function waitForSubagents(runtime: ReturnType<typeof createRunRuntime>): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const rows = runtime.subagents.list();
		if (rows.length > 0 && rows.every((row) => row.status !== "running")) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`子代理没跑完：${JSON.stringify(rows)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** 一次 tool_calls 的 delta */
function toolCall(name: string, args: unknown): unknown {
	return [{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }];
}
