/**
 * 权限层与工具契约的测试。
 *
 * 盯的是这次重构新引入的几件东西，每一件都对应一个真实漏洞：
 * - `looksReadOnlyCommand`：bash 的只读性按**命令**判定（从前按工具名，只读档下连 `ls` 都跑不了）；
 * - 计划模式（严格）的判据是「工具不是只读的」（从前是 `{ write, edit, bash }` 那张名字表，
 *   于是 `job_start` / `subagent_start` 能整个绕开计划模式）；
 * - `subagent_start` 的并发上限真的按进度表卡住（从前 `DEFAULT_FANOUT_LIMIT` 只管一次调度）；
 * - `applyResultBudget` 的三步（空结果兜底 / 超阈值落盘 / `Infinity` 硬退出）；
 * - `partitionCalls` 的切批（连续的只读合成一批，解析失败的自占一批）；
 * - `defineTool` 的 fail-closed 默认值。
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobTools, JobRegistry } from "../src/jobs.ts";
import { judgeToolUse } from "../src/permissions/chain.ts";
import { looksReadOnlyCommand } from "../src/permissions/readonly-command.ts";
import { applyResultBudget, emptyResultPlaceholder } from "../src/results/budget.ts";
import { createSubagentTools, DEFAULT_FANOUT_LIMIT, SubagentProgressTable } from "../src/subagent.ts";
import { parseArguments } from "../src/tool-run.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { DEFAULT_MAX_RESULT_BYTES, defineTool, type ToolDefinition } from "../src/tools/contract.ts";
import { partitionCalls, prepareCalls } from "../src/tools/orchestrate.ts";
import { createWriteTool } from "../src/tools/write.ts";
import type { AgentTool } from "../src/types.ts";

const cwd = process.platform === "win32" ? "D:\\work\\proj" : "/work/proj";

/** 按需造一个最小桩工具；只声明这次测试关心的那一两项自陈 */
function stubTool(name: string, definition: Partial<ToolDefinition> = {}): AgentTool {
	return defineTool({
		name,
		description: `${name} 桩工具`,
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: "", isError: false };
		},
		...definition,
	});
}

describe("looksReadOnlyCommand", () => {
	const readOnly = ["ls -la", "cat a.txt", "git status", "grep -rn x ."];
	for (const command of readOnly) {
		it(`只读：${command}`, () => {
			expect(looksReadOnlyCommand(command)).toBe(true);
		});
	}

	const mutating = [
		// 一次就不可逆，或不在白名单里
		"rm x",
		"echo a > b",
		"npm test",
		// 改命令结构：分号、管道、命令替换都算
		"ls; rm x",
		"cat a | rm b",
		'node -e "1"',
		// 白名单内但带会写盘的开关
		"find . -delete",
		// git 只认只读子命令，commit 不是
		"git commit -m x",
		// 空命令没有意义，一律当会写
		"",
		"   ",
	];
	for (const command of mutating) {
		it(`不算只读：${JSON.stringify(command)}`, () => {
			expect(looksReadOnlyCommand(command)).toBe(false);
		});
	}

	it("只读判定只往「不算只读」那边倒：白名单之外的命令一律 false", () => {
		// 拿不准就返回 false 是刻意的（见 readonly-command.ts 的模块头）。
		expect(looksReadOnlyCommand("make build")).toBe(false);
		expect(looksReadOnlyCommand("./scripts/deploy.sh")).toBe(false);
		// 解释器只在「一个查询开关、别的什么都没有」时算只读
		expect(looksReadOnlyCommand("node --version")).toBe(true);
		expect(looksReadOnlyCommand("node script.mjs")).toBe(false);
		// 带目录与 Windows 扩展名时取的是命令头
		expect(looksReadOnlyCommand("/usr/bin/ls -la")).toBe(true);
		expect(looksReadOnlyCommand("C:/tools/ls.exe -la")).toBe(true);
		// 反斜杠本身算「改命令结构」（`find . -exec rm {} \;` 就是靠它绕开分号），所以
		// Windows 风格的反斜杠路径一律判「不算只读」——漏判只是退化成旧行为，误判会当场失效。
		expect(looksReadOnlyCommand("C:\\tools\\ls.exe -la")).toBe(false);
	});
});

describe("计划模式（严格）的工具判定", () => {
	it("job_start 与 subagent_start 被拒绝：它们会改东西，不再能绕开计划模式", () => {
		const jobs = createJobTools(new JobRegistry({ cwd }));
		const subagents = createSubagentTools({ run: async () => "结论", table: new SubagentProgressTable() });
		const jobStart = jobs.find((tool) => tool.name === "job_start");
		const subagentStart = subagents.find((tool) => tool.name === "subagent_start");
		if (jobStart === undefined || subagentStart === undefined) {
			throw new Error("没有 job_start / subagent_start");
		}

		for (const [tool, input] of [
			[jobStart, { command: "npm run build" }],
			[subagentStart, { task: "把 utils 里的老接口列出来" }],
		] as const) {
			expect(tool.isReadOnly(input), tool.name).toBe(false);
			const verdict = judgeToolUse({ tool, input, mode: "auto", planMode: "strict", cwd });
			expect(verdict.behavior, tool.name).toBe("deny");
			expect(verdict.reason, tool.name).toEqual({ type: "plan" });
		}
	});

	it("只碰内存的那几个照旧放行：看/收子代理、看/收后台任务", () => {
		const jobs = createJobTools(new JobRegistry({ cwd }));
		const subagents = createSubagentTools({ run: async () => "结论", table: new SubagentProgressTable() });
		const allowed = [
			[jobs.find((tool) => tool.name === "job_list"), {}],
			[jobs.find((tool) => tool.name === "job_kill"), { id: "job-1" }],
			[subagents.find((tool) => tool.name === "subagent_list"), {}],
			[subagents.find((tool) => tool.name === "subagent_read"), { label: "A" }],
			[subagents.find((tool) => tool.name === "subagent_stop"), { label: "A" }],
		] as const;
		for (const [tool, input] of allowed) {
			if (tool === undefined) {
				throw new Error("缺少工具");
			}
			expect(judgeToolUse({ tool, input, mode: "readonly", planMode: "strict", cwd }).behavior, tool.name).toBe(
				"allow",
			);
		}
	});
});

describe("subagent_start 的并发上限", () => {
	it("起满 DEFAULT_FANOUT_LIMIT 个之后，再起一个返回失败", async () => {
		// run 永远不 resolve：子代理就挂在「运行中」，正好把上限顶满。
		const never = new Promise<string>(() => {});
		const table = new SubagentProgressTable();
		const tools = createSubagentTools({ run: () => never, table });
		const start = tools.find((tool) => tool.name === "subagent_start");
		if (start === undefined) {
			throw new Error("没有 subagent_start");
		}

		for (let index = 0; index < DEFAULT_FANOUT_LIMIT; index += 1) {
			const started = await start.execute({ task: `第 ${index} 件事`, label: `s${index}` }, {} as never);
			expect(started.isError, `第 ${index} 个`).toBe(false);
		}
		expect(table.runningCount()).toBe(DEFAULT_FANOUT_LIMIT);

		const overflow = await start.execute({ task: "再来一件", label: "s-overflow" }, {} as never);
		expect(overflow.isError).toBe(true);
		expect(overflow.content).toContain(`同时最多 ${DEFAULT_FANOUT_LIMIT} 个`);

		// 收掉一个之后又有额度了：上限卡的是「同时在跑」，不是「一共起过几个」。
		const stop = tools.find((tool) => tool.name === "subagent_stop");
		expect(stop).toBeDefined();
		await stop?.execute({ label: "s0" }, {} as never);
		expect(table.runningCount()).toBe(DEFAULT_FANOUT_LIMIT - 1);
		expect((await start.execute({ task: "续上一件", label: "s-again" }, {} as never)).isError).toBe(false);
	});
});

describe("applyResultBudget", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function spillDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "limkenion-budget-"));
		dirs.push(dir);
		return dir;
	}

	it("空内容被换成占位文案，失败标记原样保留", () => {
		for (const content of ["", "   ", "\n\t "]) {
			const outcome = applyResultBudget(stubTool("weird"), { content, isError: false }, undefined);
			expect(outcome.content, JSON.stringify(content)).toBe(emptyResultPlaceholder("weird"));
			expect(outcome.content).toContain("weird");
		}
		expect(applyResultBudget(stubTool("bash"), { content: "", isError: true }, undefined)).toEqual({
			content: emptyResultPlaceholder("bash"),
			isError: true,
		});
	});

	it("maxResultBytes 是 Infinity 时即使内容很大也不落盘", () => {
		const dir = spillDir();
		const big = "x".repeat(200_000);
		const outcome = applyResultBudget(
			stubTool("read", { maxResultBytes: Number.POSITIVE_INFINITY }),
			{ content: big, isError: false },
			dir,
		);
		expect(outcome.content).toBe(big);
		// 一个字节都不该写下去：读类工具自己已经截断了，再落盘会让模型原地打转。
		expect(readdirSync(dir)).toEqual([]);
	});

	it("超过阈值时落盘，正文换成预览与路径，完整内容一个字节不少", () => {
		const dir = spillDir();
		const big = "很长的一行\n".repeat(1000);
		const outcome = applyResultBudget(
			stubTool("dump", { maxResultBytes: 100 }),
			{ content: big, isError: false },
			dir,
		);
		expect(outcome.content).toContain("完整输出已写入");
		const path = /完整输出已写入 (.+)/.exec(outcome.content)?.[1];
		expect(path).toBeDefined();
		expect(existsSync(path as string)).toBe(true);
		expect(readFileSync(path as string, "utf-8")).toBe(big);
	});

	it("没到阈值就原样交给模型，也不落盘", () => {
		const dir = spillDir();
		const outcome = applyResultBudget(
			stubTool("dump", { maxResultBytes: 100 }),
			{ content: "短", isError: false },
			dir,
		);
		expect(outcome.content).toBe("短");
		expect(readdirSync(dir)).toEqual([]);
	});

	it("阈值按字节算而不是按字符：同样长度的中文会先落盘", () => {
		const dir = spillDir();
		// 40 个汉字 = 120 字节，字符数只有 40。
		const chinese = "中".repeat(40);
		expect(chinese.length).toBeLessThanOrEqual(100);
		expect(
			applyResultBudget(stubTool("dump", { maxResultBytes: 100 }), { content: chinese, isError: false }, dir)
				.content,
		).toContain("完整输出已写入");
	});

	it("没有落盘目录时只做空结果兜底", () => {
		const big = "很长的一行\n".repeat(1000);
		const outcome = applyResultBudget(
			stubTool("dump", { maxResultBytes: 100 }),
			{ content: big, isError: false },
			undefined,
		);
		expect(outcome.content).toBe(big);
	});
});

describe("partitionCalls", () => {
	const reader = stubTool("read", { isReadOnly: () => true, isConcurrencySafe: () => true });
	const writer = stubTool("write");

	/** 把「名字 + 参数字符串」的调用列表与工具表对上 */
	function prepared(calls: readonly { id: string; name: string; args: string }[], tools: AgentTool[]) {
		return prepareCalls(
			calls.map((call) => ({ id: call.id, name: call.name, arguments: call.args })),
			tools,
			parseArguments,
		);
	}

	it("连续的只读调用合成一批", () => {
		const batches = partitionCalls(
			prepared(
				[
					{ id: "1", name: "read", args: '{"path":"a"}' },
					{ id: "2", name: "read", args: '{"path":"b"}' },
					{ id: "3", name: "read", args: '{"path":"c"}' },
				],
				[reader, writer],
			),
		);
		expect(batches.map((batch) => batch.map((call) => call.id))).toEqual([["1", "2", "3"]]);
	});

	it("中间夹一个会写的工具就切成三批，顺序不重排", () => {
		const batches = partitionCalls(
			prepared(
				[
					{ id: "1", name: "read", args: '{"path":"a"}' },
					{ id: "2", name: "read", args: '{"path":"b"}' },
					{ id: "3", name: "write", args: '{"path":"c","content":"x"}' },
					{ id: "4", name: "read", args: '{"path":"d"}' },
					{ id: "5", name: "read", args: '{"path":"e"}' },
				],
				[reader, writer],
			),
		);
		expect(batches.map((batch) => batch.map((call) => call.id))).toEqual([["1", "2"], ["3"], ["4", "5"]]);
	});

	it("参数解析失败（input 为 null）的工具独占一批，前后都被它切断", () => {
		const calls = prepared(
			[
				{ id: "1", name: "read", args: '{"path":"a"}' },
				{ id: "2", name: "read", args: "不是 JSON" },
				{ id: "3", name: "read", args: '{"path":"c"}' },
			],
			[reader, writer],
		);
		expect(calls[1]?.input).toBeNull();
		expect(partitionCalls(calls).map((batch) => batch.map((call) => call.id))).toEqual([["1"], ["2"], ["3"]]);
	});

	it("工具名对不上、或不自陈并发安全的，也独占一批", () => {
		const unknown = prepared(
			[
				{ id: "1", name: "read", args: '{"path":"a"}' },
				{ id: "2", name: "不存在", args: "{}" },
				{ id: "3", name: "read", args: '{"path":"c"}' },
			],
			[reader],
		);
		expect(partitionCalls(unknown).map((batch) => batch.map((call) => call.id))).toEqual([["1"], ["2"], ["3"]]);

		// 默认值是不可并发（fail-closed），所以两个「会写」的调用各占一批。
		const mutating = prepared(
			[
				{ id: "1", name: "write", args: '{"path":"a","content":"x"}' },
				{ id: "2", name: "write", args: '{"path":"b","content":"y"}' },
			],
			[writer],
		);
		expect(partitionCalls(mutating).map((batch) => batch.map((call) => call.id))).toEqual([["1"], ["2"]]);
	});

	it("空列表切成零批", () => {
		expect(partitionCalls([])).toEqual([]);
	});
});

describe("判定链的顺序契约", () => {
	const bash = createBashTool({ cwd });
	const write = createWriteTool({ cwd });

	it("「只拒绝」的判定排在「只升档」之前：readonly 档下危险命令是拒绝而不是询问", () => {
		// 顺序反过来时这里会变成 ask——而 ask 能被用户点成允许，只读档就等于开了个口子。
		const denied = judgeToolUse({
			tool: bash,
			input: { command: "rm -rf /" },
			mode: "readonly",
			planMode: "off",
			cwd,
		});
		expect(denied.behavior).toBe("deny");
		expect(denied.reason).toEqual({ type: "mode", mode: "readonly" });

		// 同一个命令在 auto 档下只升到确认，理由说清是危险命令。
		const asked = judgeToolUse({ tool: bash, input: { command: "rm -rf /" }, mode: "auto", planMode: "off", cwd });
		expect(asked.behavior).toBe("ask");
		expect(asked.reason).toEqual({ type: "dangerous", command: "rm -rf /" });

		// 越界写入同理：只读档拒绝，auto 档确认。
		const outside = process.platform === "win32" ? "D:\\other\\x.ts" : "/other/x.ts";
		expect(
			judgeToolUse({ tool: write, input: { path: outside, content: "x" }, mode: "readonly", planMode: "off", cwd })
				.reason,
		).toEqual({ type: "mode", mode: "readonly" });
		expect(
			judgeToolUse({ tool: write, input: { path: outside, content: "x" }, mode: "auto", planMode: "off", cwd })
				.reason,
		).toEqual({ type: "outside", path: outside });
	});

	it("只读命令在只读档下放行；会改动的命令在 ask 档下要确认", () => {
		const readOnly = judgeToolUse({
			tool: bash,
			input: { command: "ls -la" },
			mode: "readonly",
			planMode: "off",
			cwd,
		});
		expect(readOnly.behavior).toBe("allow");
		expect(readOnly.reason).toEqual({ type: "read-only" });

		const confirming = judgeToolUse({ tool: bash, input: { command: "touch x" }, mode: "ask", planMode: "off", cwd });
		expect(confirming.behavior).toBe("ask");
		expect(confirming.reason).toEqual({ type: "mode", mode: "ask" });
	});

	it("计划模式（严格）优先于危险命令：理由说的是计划模式", () => {
		const verdict = judgeToolUse({
			tool: bash,
			input: { command: "rm -rf /" },
			mode: "auto",
			planMode: "strict",
			cwd,
		});
		expect(verdict.behavior).toBe("deny");
		expect(verdict.reason).toEqual({ type: "plan" });
	});

	it("档位无关的三条（计划严格 / 空补丁 / 只读档）在 auto 下也生效", () => {
		// 空补丁：auto 档也直接拒绝，不给审批机会
		expect(
			judgeToolUse({ tool: write, input: { path: "a.ts", content: "  " }, mode: "auto", planMode: "off", cwd })
				.reason,
		).toEqual({ type: "empty-patch" });
		// 危险命令与越界：auto 档也至少升到确认
		expect(
			judgeToolUse({ tool: bash, input: { command: "sudo rm -rf /" }, mode: "auto", planMode: "off", cwd }).behavior,
		).toBe("ask");
		expect(
			judgeToolUse({
				tool: write,
				input: { path: process.platform === "win32" ? "D:\\other\\x.ts" : "/other/x.ts", content: "x" },
				mode: "auto",
				planMode: "off",
				cwd,
			}).behavior,
		).toBe("ask");
	});
});

describe("defineTool 的 fail-closed 默认值", () => {
	it("不声明 isReadOnly / isConcurrencySafe 的工具两者都是 false", () => {
		const tool = stubTool("mystery");
		expect(tool.isReadOnly({ anything: true })).toBe(false);
		expect(tool.isConcurrencySafe({ anything: true })).toBe(false);
		expect(tool.isDestructive({})).toBe(false);
		// 结果上限取默认的 12KB，别的自陈给出保守答案
		expect(tool.maxResultBytes).toBe(DEFAULT_MAX_RESULT_BYTES);
		expect(tool.validate({})).toEqual({ ok: true });
		expect(tool.summarize({})).toBe("");
		expect(tool.pathOf({ path: "a.ts" })).toBeNull();
		expect(tool.timeoutMs).toBeUndefined();
	});

	it("自陈函数抛异常时也回落到 false / 保守答案", () => {
		const tool = stubTool("explosive", {
			isReadOnly: () => {
				throw new Error("坏掉了");
			},
			isConcurrencySafe: () => {
				throw new Error("坏掉了");
			},
			isDestructive: () => {
				throw new Error("坏掉了");
			},
			validate: () => {
				throw new Error("坏掉了");
			},
			summarize: () => {
				throw new Error("坏掉了");
			},
			pathOf: () => {
				throw new Error("坏掉了");
			},
		});
		expect(tool.isReadOnly({})).toBe(false);
		expect(tool.isConcurrencySafe({})).toBe(false);
		expect(tool.isDestructive({})).toBe(false);
		expect(tool.validate({})).toEqual({ ok: true });
		expect(tool.summarize({})).toBe("");
		expect(tool.pathOf({})).toBeNull();
	});

	it("非布尔的自陈结果不算数（只认 true）", () => {
		const tool = stubTool("sloppy", {
			// 模型给的入参不可信，自陈函数也可能返回别的东西；`=== true` 才算数。
			isReadOnly: (() => "yes") as unknown as ToolDefinition["isReadOnly"],
		});
		expect(tool.isReadOnly({})).toBe(false);
	});

	it("显式声明的只读与并发如实生效", () => {
		const tool = stubTool("reader", { isReadOnly: () => true, isConcurrencySafe: () => true, maxResultBytes: 7 });
		expect(tool.isReadOnly({})).toBe(true);
		expect(tool.isConcurrencySafe({})).toBe(true);
		expect(tool.maxResultBytes).toBe(7);
	});
});
