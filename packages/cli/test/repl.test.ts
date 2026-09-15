/**
 * 交互模式的命令处理。
 *
 * 用可读流喂指令，不需要真开终端：这里的价值在于「命令确实接对了」，模型一次都不会被调用。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Agent, CheckpointStore, GoalList, JobRegistry, SubagentProgressTable, TodoList } from "limkenion-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_DIR_ENV } from "../src/config.ts";
import { type ReplOptions, startRepl } from "../src/repl.ts";
import { Session } from "../src/session.ts";

let dir = "";
/** 测试期间起的后台任务，收尾时一并停掉 */
let registry: JobRegistry | null = null;
const originalSessionDir = process.env[SESSION_DIR_ENV];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "limkenion-repl-"));
	// 会话写到临时目录：`/diff` 那几条要用真会话（它提供工作目录），别写进开发机上真实的会话目录
	process.env[SESSION_DIR_ENV] = join(dir, "sessions");
});

afterEach(async () => {
	registry?.killAll();
	registry = null;
	if (originalSessionDir === undefined) {
		delete process.env[SESSION_DIR_ENV];
	} else {
		process.env[SESSION_DIR_ENV] = originalSessionDir;
	}
	await rm(dir, { recursive: true, force: true });
});

/**
 * 跑一遍 REPL：喂进这些指令，返回输出全文（stderr 在前、stdout 在后）。
 *
 * 一行一行喂，且只在看到提示符之后才喂下一行：readline 在没有等待提问时收到的行会直接丢掉，
 * 一次性灌进去只有第一行会被处理。按提示符推进是确定的，不依赖 sleep。
 * 两股输出都收：回执走 stderr，而 `/diff`、`/search` 这类「命令的产出」走 stdout。
 */
async function runRepl(agent: Agent, lines: string[], extra: Partial<ReplOptions> = {}): Promise<string> {
	const errors: string[] = [];
	const outputs: string[] = [];
	const input = new PassThrough();
	let index = 0;
	const originalErr = process.stderr.write.bind(process.stderr);
	const originalOut = process.stdout.write.bind(process.stdout);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
		errors.push(text);
		if (text.includes("limkenion> ")) {
			const next = lines[index];
			index += 1;
			if (next === undefined) {
				input.end();
			} else {
				input.write(`${next}\n`);
			}
		}
		return true;
	}) as typeof process.stderr.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		outputs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
		return true;
	}) as typeof process.stdout.write;
	try {
		await startRepl({
			agent,
			// /help 与 /approvals 都不会碰会话文件，给个最小的替身就够
			session: { file: join(dir, "s.jsonl"), append: () => {} } as unknown as Session,
			commandsDir: join(dir, "commands"),
			input,
			...extra,
		});
	} finally {
		process.stderr.write = originalErr;
		process.stdout.write = originalOut;
	}
	return `${errors.join("")}\n--- stdout ---\n${outputs.join("")}`;
}

function makeAgent(): Agent {
	return new Agent({
		apiKey: "sk-test",
		cwd: dir,
		tools: [],
		// 真被调用就会抛：这一组用例根本不该走到模型那一步
		fetchImpl: (() => {
			throw new Error("不该调用模型");
		}) as unknown as typeof fetch,
	});
}

describe("交互模式的命令", () => {
	it("/help 列出内置命令与 /approvals", async () => {
		const output = await runRepl(makeAgent(), ["/help", "/quit"]);
		expect(output).toContain("/approvals");
		expect(output).toContain("/rewind");
		expect(output).toContain("/search <词>");
		// 终端与网页后来补齐的三样：后台任务、子代理、待办与目标
		expect(output).toContain("/jobs");
		expect(output).toContain("/subagents");
		expect(output).toContain("/todos");
	});

	it("没有接运行时那几样时，命令明确说没有这个入口（而不是装作空）", async () => {
		const output = await runRepl(makeAgent(), ["/jobs", "/subagents", "/quit"]);
		expect(output).toContain("当前模式没有后台任务入口");
		expect(output).toContain("当前模式没有子代理入口");
	});

	it("/jobs 列出后台任务、能停掉；/jobs log 给出输出", async () => {
		registry = new JobRegistry({ cwd: dir, outputDir: join(dir, "jobs") });
		const job = registry.start('node -e "setTimeout(() => {}, 4000)"', dir);
		const output = await runRepl(makeAgent(), ["/jobs", `/jobs log ${job.id}`, `/jobs kill ${job.id}`, "/quit"], {
			jobs: registry,
		});
		expect(output).toContain(job.id);
		expect(output).toContain("setTimeout");
		expect(output).toContain("已停止");
		// 停掉之后再列一次就不该说「在跑」
		const after = registry.list()[0];
		expect(after?.status).not.toBe("running");
	});

	it("/subagents 报进度、能整体停下", async () => {
		const table = new SubagentProgressTable();
		table.onEvent({ label: "看看 README", phase: "start" });
		const output = await runRepl(makeAgent(), ["/subagents", "/subagents stop", "/quit"], { subagents: table });
		expect(output).toContain("看看 README");
		expect(output).toContain("运行中");
		expect(output).toContain("已请求停止");
	});

	it("/diff 先看这一轮改了什么（只看不动），并提示要撤几轮", async () => {
		const session = Session.create(dir);
		const store = new CheckpointStore(session.file);
		const file = join(dir, "note.txt");
		await writeFile(file, "旧的一行\n", "utf-8");
		store.begin();
		store.capture(file, "旧的一行\n");
		await writeFile(file, "新的一行\n", "utf-8");
		store.commit();

		const output = await runRepl(makeAgent(), ["/diff", "/quit"], { session, checkpoints: store });
		expect(output).toContain("第 1 轮");
		expect(output).toContain("note.txt +1 −1");
		expect(output).toContain("@@ -1,1 +1,1 @@");
		expect(output).toContain("− 旧的一行");
		expect(output).toContain("+ 新的一行");
		// 撤之前先看得见要撤什么：这里只提示，不动文件
		expect(output).toContain("/rewind");
		expect(await readFile(file, "utf-8")).toBe("新的一行\n");
	});

	it("/diff 能看更早的轮次；轮次不存在与参数非法都给可照做的提示", async () => {
		const session = Session.create(dir);
		const store = new CheckpointStore(session.file);
		const file = join(dir, "note.txt");
		await writeFile(file, "一\n", "utf-8");
		// 第一轮：一 → 二
		store.begin();
		store.capture(file, "一\n");
		await writeFile(file, "二\n", "utf-8");
		store.commit();
		// 第二轮：二 → 三
		store.begin();
		store.capture(file, "二\n");
		await writeFile(file, "三\n", "utf-8");
		store.commit();

		// 第 1 轮的差异是「一 → 现在（三）」
		const first = await runRepl(makeAgent(), ["/diff 1", "/quit"], { session, checkpoints: store });
		expect(first).toContain("第 1 轮");
		expect(first).toContain("− 一");
		// 第 1 轮离最近一轮有两轮，提示里要能照着敲
		expect(first).toContain("/rewind 2");

		const bad = await runRepl(makeAgent(), ["/diff 9", "/diff 零", "/quit"], { session, checkpoints: store });
		expect(bad).toContain("第 9 轮没有快照");
		expect(bad).toContain("现在有第 1、2 轮");
		expect(bad).toContain("用法：/diff");
	});

	it("/rewind 能从最近一轮往回撤多轮（与 limkenion rewind <n> 同一套语义）", async () => {
		const session = Session.create(dir);
		const store = new CheckpointStore(session.file);
		const file = join(dir, "note.txt");
		await writeFile(file, "一\n", "utf-8");
		store.begin();
		store.capture(file, "一\n");
		await writeFile(file, "二\n", "utf-8");
		store.commit();
		store.begin();
		store.capture(file, "二\n");
		await writeFile(file, "三\n", "utf-8");
		store.commit();

		const output = await runRepl(makeAgent(), ["/rewind 2", "/quit"], { session, checkpoints: store });
		expect(output).toContain("已回滚 2 轮");
		// 两轮都撤掉：文件回到第 1 轮之前
		expect(await readFile(file, "utf-8")).toBe("一\n");
	});

	it("没有快照时 /diff 说清「跑完一轮才有」，非法轮数不进回滚循环", async () => {
		const output = await runRepl(makeAgent(), ["/diff", "/rewind 0", "/quit"]);
		expect(output).toContain("还没有可看的轮次");
		expect(output).toContain("用法：/rewind");
	});

	it("/approval 报当前档位、能切、认不出的档位给出可选项", async () => {
		const agent = makeAgent();
		const output = await runRepl(agent, ["/approval", "/approval readonly", "/approval", "/approval 严格", "/quit"]);
		// 不带参数只报，不动它
		expect(output).toContain("当前审批档位：auto");
		expect(output).toContain("常规放行");
		// 切换立刻生效（内核每次调用前重新读这个值）
		expect(agent.approvalMode).toBe("readonly");
		expect(output).toContain("已切换审批档位：readonly");
		expect(output).toContain("只放行只读操作");
		expect(output).toContain("未知的审批档位「严格」");
	});

	it("/compact 报状态、能开关、认不出的参数给出用法", async () => {
		const agent = makeAgent();
		const output = await runRepl(agent, ["/compact", "/compact off", "/compact", "/compact 关", "/quit"]);
		expect(output).toContain("上下文压缩：开");
		expect(agent.compactionEnabled).toBe(false);
		expect(output).toContain("已关掉上下文压缩");
		expect(output).toContain("上下文压缩：关");
		expect(output).toContain("用法：/compact on|off");
	});

	it("/rename 给当前会话起名、报名字、用 `-` 取消命名", async () => {
		const session = Session.create(dir);
		const output = await runRepl(makeAgent(), ["/rename", "/rename 布局重构", "/rename", "/rename -", "/quit"], {
			session,
		});
		// 没名字时说清列表里显示的是什么，而不是给一个空行
		expect(output).toContain("这个会话还没有名字");
		expect(output).toContain("已命名为：布局重构");
		expect(output).toContain("这个会话的名字：布局重构");
		expect(output).toContain("已取消命名");
		expect(session.header.title).toBeUndefined();
	});

	it("/todos 报待办与目标；两样都没有时说清是空的", async () => {
		const todos = new TodoList();
		const goals = new GoalList();
		const empty = await runRepl(makeAgent(), ["/todos", "/quit"], { todos, goals });
		expect(empty).toContain("现在没有待办，也没有设目标");

		todos.replace([{ content: "补齐终端", status: "in_progress" }]);
		goals.replace({ content: "两边功能对齐", status: "active" });
		const filled = await runRepl(makeAgent(), ["/todos", "/quit"], { todos, goals });
		expect(filled).toContain("补齐终端");
		expect(filled).toContain("两边功能对齐");
	});

	it("一轮跑完待办变了就自动打一遍，没变就不重复打", async () => {
		const todos = new TodoList();
		let turn = 0;
		const output = await runRepl(makeAgent(), ["第一轮", "第二轮", "/quit"], {
			todos,
			runTurn: async () => {
				turn += 1;
				// 只有第一轮改清单：第二轮不该再打一遍（否则每轮刷屏，把刚看的东西顶跑）
				if (turn === 1) {
					todos.replace([{ content: "只报一次", status: "pending" }]);
				}
			},
		});
		expect(output).toContain("只报一次");
		expect(output.split("只报一次").length - 1).toBe(1);
	});

	it("/approvals 在空表时说明怎么记规则", async () => {
		const output = await runRepl(makeAgent(), ["/approvals", "/quit"]);
		expect(output).toContain("本会话还没有「总是允许」的规则");
		expect(output).toContain("答 a");
	});

	it("/approvals 把记下的规则翻译成人话", async () => {
		const agent = makeAgent();
		agent.approvals.remember({ tool: "bash", prefix: "npm test" });
		agent.approvals.remember({ tool: "write", prefix: "src" });
		const output = await runRepl(agent, ["/approvals", "/quit"]);
		expect(output).toContain("本会话已放行（2 条");
		expect(output).toContain("bash：执行以「npm test」开头的单条命令");
		expect(output).toContain("write：写入 src/ 及其子目录");
	});

	it("/approvals clear 清空并回执；未知命令给出可照做的提示", async () => {
		const agent = makeAgent();
		agent.approvals.remember({ tool: "bash", prefix: "npm test" });
		const output = await runRepl(agent, ["/approvals clear", "/approvals", "/nope", "/quit"]);
		expect(output).toContain("已忘掉 1 条放行规则");
		expect(agent.approvals.size).toBe(0);
		expect(output).toContain("本会话还没有「总是允许」的规则");
		expect(output).toContain("未知命令 /nope");
	});
});
