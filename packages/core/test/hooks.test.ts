/** PreToolUse 钩子的单元测试：匹配、三种退出码语义、改写与异常处理。执行器全部注入，不起真实进程。 */

import { describe, expect, it } from "vitest";
import { type HookRunner, matchesTool, runPreToolUseHooks } from "../src/hooks.ts";

const event = { tool: "bash", input: { command: "ls" }, cwd: "/work" };

/** 造一个按脚本返回值作答的执行器，并记录收到的 payload */
function runnerOf(results: Array<{ exitCode: number; stdout?: string; stderr?: string }>): {
	run: HookRunner;
	seen: Array<{ command: string; payload: string }>;
} {
	const seen: Array<{ command: string; payload: string }> = [];
	let index = 0;
	const run: HookRunner = async (command, payload) => {
		seen.push({ command, payload });
		const result = results[index] ?? results[results.length - 1] ?? { exitCode: 0 };
		index += 1;
		return { exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
	return { run, seen };
}

describe("工具名匹配", () => {
	it("支持 *、单个名字与逗号分隔列表", () => {
		expect(matchesTool("*", "bash")).toBe(true);
		expect(matchesTool("", "bash")).toBe(true);
		expect(matchesTool("bash", "bash")).toBe(true);
		expect(matchesTool("bash", "read")).toBe(false);
		expect(matchesTool("write, edit", "edit")).toBe(true);
		expect(matchesTool("write, edit", "bash")).toBe(false);
	});
});

describe("钩子结论", () => {
	it("默认放行：退出 0 且没有输出", async () => {
		const { run, seen } = runnerOf([{ exitCode: 0 }]);
		const outcome = await runPreToolUseHooks([{ matcher: "*", command: "check" }], event, run);
		expect(outcome.allowed).toBe(true);
		expect(outcome.reason).toBe("");
		expect(outcome.input).toEqual(event.input);
		expect(JSON.parse(seen[0]?.payload ?? "{}")).toMatchObject({ tool: "bash", cwd: "/work" });
	});

	it("stdout 返回 deny 即拒绝，理由回给模型", async () => {
		const { run } = runnerOf([{ exitCode: 0, stdout: '{"decision":"deny","reason":"不许 rm"}' }]);
		const outcome = await runPreToolUseHooks([{ matcher: "bash", command: "policy" }], event, run);
		expect(outcome.allowed).toBe(false);
		expect(outcome.reason).toBe("不许 rm");
	});

	it("退出码 2 表示按规则拦截，stderr 作为理由", async () => {
		const { run } = runnerOf([{ exitCode: 2, stderr: "这条命令在禁用清单里" }]);
		const outcome = await runPreToolUseHooks([{ matcher: "*", command: "guard" }], event, run);
		expect(outcome.allowed).toBe(false);
		expect(outcome.reason).toContain("禁用清单");
	});

	it("钩子自己出错（退出码非 0/2）时放行，只附警告", async () => {
		const { run } = runnerOf([{ exitCode: 1, stderr: "脚本炸了" }]);
		const outcome = await runPreToolUseHooks([{ matcher: "*", command: "broken" }], event, run);
		expect(outcome.allowed).toBe(true);
		expect(outcome.reason).toContain("钩子执行异常");
		expect(outcome.reason).toContain("脚本炸了");
	});

	it("输出不是合法 JSON 时放行并提示", async () => {
		const { run } = runnerOf([{ exitCode: 0, stdout: "这不是 JSON" }]);
		const outcome = await runPreToolUseHooks([{ matcher: "*", command: "weird" }], event, run);
		expect(outcome.allowed).toBe(true);
		expect(outcome.reason).toContain("不是合法 JSON");
	});

	it("modify 可以改写入参，后续钩子看到改写后的内容", async () => {
		const { run, seen } = runnerOf([
			{ exitCode: 0, stdout: '{"decision":"modify","input":{"command":"rg"}}' },
			{ exitCode: 0 },
		]);
		const outcome = await runPreToolUseHooks(
			[
				{ matcher: "bash", command: "rewrite" },
				{ matcher: "bash", command: "second" },
			],
			event,
			run,
		);
		expect(outcome.allowed).toBe(true);
		expect(outcome.input).toEqual({ command: "rg" });
		expect(JSON.parse(seen[1]?.payload ?? "{}").input).toEqual({ command: "rg" });
	});

	it("只跑匹配的钩子；拒绝后不再执行后面的钩子", async () => {
		const { run, seen } = runnerOf([{ exitCode: 0, stdout: '{"decision":"deny","reason":"停"}' }, { exitCode: 0 }]);
		const outcome = await runPreToolUseHooks(
			[
				{ matcher: "read", command: "不匹配" },
				{ matcher: "bash", command: "拦" },
				{ matcher: "*", command: "后面不该跑" },
			],
			event,
			run,
		);
		expect(outcome.allowed).toBe(false);
		expect(seen.map((item) => item.command)).toEqual(["拦"]);
		expect(outcome.ran).toEqual(["拦"]);
	});

	it("没有钩子时原样放行", async () => {
		const outcome = await runPreToolUseHooks([], event, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
		expect(outcome).toMatchObject({ allowed: true, reason: "", ran: [] });
	});
});
