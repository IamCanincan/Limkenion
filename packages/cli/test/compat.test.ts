/**
 * CLI 层的兼容性契约。
 *
 * 与 core 的 compat.test.ts 互补：那份钉库的导出面，这份钉**命令行契约**——退出码，
 * 以及旧版本写下的会话文件能否照常读、多出未知字段时不要炸。
 *
 * 这些是脚本与使用者真正依赖的东西，也是自改时最容易顺手弄坏的东西。
 */

import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { AGENT_DIR_ENV, SESSION_DIR_ENV } from "../src/config.ts";
import { Session } from "../src/session.ts";
import { WEB_EVENT_TYPES } from "../src/web/protocol.ts";

const originalAgentDir = process.env[AGENT_DIR_ENV];
const originalSessionDir = process.env[SESSION_DIR_ENV];
let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "limkenion-cli-compat-"));
	process.env[AGENT_DIR_ENV] = dir;
	process.env[SESSION_DIR_ENV] = dir;
});

afterEach(async () => {
	for (const [key, value] of [
		[AGENT_DIR_ENV, originalAgentDir],
		[SESSION_DIR_ENV, originalSessionDir],
	] as const) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	await rm(dir, { recursive: true, force: true });
});

/** 跑一次 CLI 并把输出吞掉：这里只关心退出码 */
async function exitCodeOf(argv: string[]): Promise<number> {
	const stdout = process.stdout.write.bind(process.stdout);
	const stderr = process.stderr.write.bind(process.stderr);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	process.stderr.write = (() => true) as typeof process.stderr.write;
	try {
		return await runCli(argv);
	} finally {
		process.stdout.write = stdout;
		process.stderr.write = stderr;
	}
}

describe("命令行契约", () => {
	it("退出码：版本与帮助 0、用法错误 2", async () => {
		expect(await exitCodeOf(["--version"])).toBe(0);
		expect(await exitCodeOf(["--help"])).toBe(0);
		expect(await exitCodeOf(["--bogus"])).toBe(2);
		expect(await exitCodeOf(["review", "--bogus"])).toBe(2);
	});

	/** 换掉全局 fetch 跑一次，结束后还原 */
	async function withFetch(fake: typeof fetch, argv: string[]): Promise<number> {
		const original = globalThis.fetch;
		globalThis.fetch = fake;
		try {
			return await exitCodeOf(argv);
		} finally {
			globalThis.fetch = original;
		}
	}

	it("一次性模式：接口报错退出码为 1，正常答完为 0", async () => {
		const failing = (async () => {
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const ok = (async () =>
			new Response(
				[
					'data: {"choices":[{"delta":{"content":"好"}}]}',
					"",
					'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
					"",
					"data: [DONE]",
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			)) as unknown as typeof fetch;

		const base = ["-p", "你好", "--api-key", "sk-test", "--retries", "0"];
		// 失败要能被脚本发现：这条以前恒为 0，管道里根本看不出这一轮没答成
		expect(await withFetch(failing, base)).toBe(1);
		expect(await withFetch(ok, base)).toBe(0);
	});

	it("客户端注册的 SSE 事件类型与服务端推送的名单完全一致", async () => {
		// 少一个类型，那类事件在浏览器里就永远收不到（`approval` 曾漏过一次：确认卡片只在刷新
		// 页面之后才出现，因为快照里有它、实时事件没有）。多一个类型只是白注册，也一并盯住。
		const source = await readFile(new URL("../src/web/public/state.js", import.meta.url), "utf-8");
		const block = /export const EVENT_TYPES = \[([\s\S]*?)\]/.exec(source)?.[1] ?? "";
		const registered = [...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
		expect(registered.length).toBeGreaterThan(0);
		expect([...registered].sort()).toEqual([...WEB_EVENT_TYPES].sort());
	});
});

describe("会话文件的追加式兼容", () => {
	it("多出未知字段、末尾半行，仍能打开、加载与列出预览", async () => {
		const cwd = join(dir, "proj");
		// 用真实入口建会话，避免在测试里复刻目录编码规则。
		const created = Session.create(cwd);
		// 追加：第二行表头（历史文件里见过）、系统消息、两条正常消息、一行被截断的半行。
		await appendFile(
			created.file,
			[
				JSON.stringify({ type: "session", id: created.header.id, cwd }),
				JSON.stringify({ role: "system", content: "系统提示词" }),
				JSON.stringify({ role: "user", content: "第一条指令", extraFromFuture: { a: 1 } }),
				JSON.stringify({ role: "assistant", content: "好的" }),
				'{ role: "user", content: "半行被截',
				"",
			].join("\n"),
			"utf-8",
		);

		// 表头里塞一个本版本不认识的字段，模拟「新版本写的文件」——读的人必须忽略它而不是拒绝。
		const raw = await readFile(created.file, "utf-8");
		const lines = raw.split("\n");
		const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		await writeFile(
			created.file,
			`${JSON.stringify({ ...header, futureField: 1 })}\n${lines.slice(1).join("\n")}`,
			"utf-8",
		);

		const reopened = Session.open(created.file);
		expect(reopened).not.toBeNull();
		expect(reopened?.header.id).toBe(created.header.id);

		const messages = reopened?.load() ?? [];
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);

		const described = reopened?.describe();
		expect(described?.messageCount).toBe(2);
		expect(described?.preview).toBe("第一条指令");
	});

	it("排序也是文件头字段：写进去只动第一行，消息逐字节照搬", async () => {
		// 与 `title` 同一条约定：次序是这个文件的属性，写在头里、不追加记录；重写只换第一行。
		const cwd = join(dir, "proj-order");
		const created = Session.create(cwd);
		created.append({ role: "user", content: "第一条指令" });
		const before = (await readFile(created.file, "utf-8")).split("\n");

		created.setOrder(1234);
		expect(created.header.order).toBe(1234);

		const after = (await readFile(created.file, "utf-8")).split("\n");
		// 第一行换了，之后每一行（含空行）逐字节一样
		expect(after.slice(1)).toEqual(before.slice(1));
		expect(JSON.parse(after[0] ?? "{}")).toMatchObject({ type: "session", order: 1234 });

		const reopened = Session.open(created.file);
		expect(reopened?.describe().order).toBe(1234);
		expect(reopened?.load().map((message) => message.role)).toEqual(["user"]);

		// 传 null = 取消排序：字段从文件头里删掉，列表退回按修改时间排
		created.setOrder(null);
		expect(created.header.order).toBeUndefined();
		expect(JSON.parse((await readFile(created.file, "utf-8")).split("\n")[0] ?? "{}")).not.toHaveProperty("order");
	});

	it("清空标记是追加式的记录：写进去之后旧对话不再读回，文件本身照旧可读", async () => {
		// 这条钉的是兼容性约定：`{"type":"clear"}` 之后的历史才作数，而它前面的行不许删——
		// 删行会破坏「会话文件可 grep、可回溯」这个前提。
		const cwd = join(dir, "proj-clear");
		const created = Session.create(cwd);
		created.append({ role: "user", content: "清空前的指令" });
		created.markCleared();
		created.append({ role: "user", content: "清空后的指令" });

		const reopened = Session.open(created.file);
		expect(reopened?.load().map((message) => (message.role === "user" ? message.content : ""))).toEqual([
			"清空后的指令",
		]);
		// 老文件没有 `title` / `order` 字段：读到的是空串与 null，界面分别退回预览与按时间排
		expect(reopened?.describe()).toEqual({ messageCount: 1, preview: "清空后的指令", title: "", order: null });
		const raw = await readFile(created.file, "utf-8");
		expect(raw.split("\n").filter((line) => line.includes('"clear"'))).toHaveLength(1);
		expect(raw).toContain("清空前的指令");
	});
});
