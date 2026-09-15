/** 会话持久化的单元测试。全部写在临时目录里。 */

import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_DIR_ENV } from "../src/config.ts";
import { Session } from "../src/session.ts";

let root = "";
const originalSessionDir = process.env[SESSION_DIR_ENV];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "limkenion-session-"));
	process.env[SESSION_DIR_ENV] = root;
});

afterEach(async () => {
	if (originalSessionDir === undefined) {
		delete process.env[SESSION_DIR_ENV];
	} else {
		process.env[SESSION_DIR_ENV] = originalSessionDir;
	}
	await rm(root, { recursive: true, force: true });
});

describe("Session", () => {
	it("新建会话时写入会话头", async () => {
		const session = Session.create(process.cwd());
		const firstLine = (await readFile(session.file, "utf-8")).split("\n")[0] ?? "";
		const header = JSON.parse(firstLine);

		expect(header).toMatchObject({ type: "session", cwd: process.cwd() });
		expect(typeof header.id).toBe("string");
		expect(session.header.id).toBe(header.id);
	});

	it("追加消息后可以原样读回", () => {
		const session = Session.create(process.cwd());
		session.append({ role: "user", content: "你好" });
		session.append({ role: "assistant", content: "在", reasoning: "想", toolCalls: [] });

		expect(session.load()).toEqual([
			{ role: "user", content: "你好" },
			{ role: "assistant", content: "在", reasoning: "想", toolCalls: [] },
		]);
	});

	it("读取时跳过系统消息", () => {
		const session = Session.create(process.cwd());
		session.append({ role: "system", content: "旧提示词" });
		session.append({ role: "user", content: "正文" });

		expect(session.load()).toEqual([{ role: "user", content: "正文" }]);
	});

	it("latest 返回时间上最近的会话", () => {
		const older = Session.create(process.cwd(), new Date("2026-01-01T00:00:00.000Z"));
		const newer = Session.create(process.cwd(), new Date("2026-02-01T00:00:00.000Z"));

		expect(Session.latest(process.cwd())?.file).toBe(newer.file);
		expect(Session.latest(process.cwd())?.file).not.toBe(older.file);
	});

	it("没有会话时 latest 返回 null", () => {
		expect(Session.latest(process.cwd())).toBeNull();
	});

	it("不同工作目录互不干扰", () => {
		const first = join(root, "proj-a");
		const second = join(root, "proj-b");
		const inFirst = Session.create(first);
		const inSecond = Session.create(second);

		expect(Session.latest(first)?.file).toBe(inFirst.file);
		expect(Session.latest(second)?.file).toBe(inSecond.file);
		expect(Session.latest(first)?.file).not.toBe(inSecond.file);
	});

	it("跳过被截断的半行", async () => {
		const session = Session.create(process.cwd());
		session.append({ role: "user", content: "完整" });
		// 模拟进程被杀导致的半行写入
		const { appendFileSync } = await import("node:fs");
		appendFileSync(session.file, '{"role":"assistant","cont', "utf-8");

		expect(session.load()).toEqual([{ role: "user", content: "完整" }]);
	});

	it("清空标记之后只读回之后的消息，文件本身不删", async () => {
		const session = Session.create(process.cwd());
		session.append({ role: "user", content: "清空前的指令" });
		session.append({ role: "assistant", content: "清空前的回答", reasoning: "", toolCalls: [] });
		session.markCleared();
		session.append({ role: "user", content: "清空后的指令" });

		// 重开会话（模拟重启）：旧对话不该回来
		expect(session.load()).toEqual([{ role: "user", content: "清空后的指令" }]);
		// 文件是追加式的：旧行仍在，grep 得到
		const text = await readFile(session.file, "utf-8");
		expect(text).toContain("清空前的指令");
		expect(text).toContain('"type":"clear"');
	});

	it("多次清空以最后一次为准", () => {
		const session = Session.create(process.cwd());
		session.append({ role: "user", content: "第一段" });
		session.markCleared();
		session.append({ role: "user", content: "第二段" });
		session.markCleared();
		session.append({ role: "user", content: "第三段" });

		expect(session.load()).toEqual([{ role: "user", content: "第三段" }]);
	});

	it("列表元信息只数清空之后的消息，预览也跟着重置", () => {
		const session = Session.create(process.cwd());
		session.append({ role: "user", content: "旧的预览" });
		session.append({ role: "assistant", content: "旧的回答", reasoning: "", toolCalls: [] });
		expect(session.describe()).toMatchObject({ messageCount: 2, preview: "旧的预览" });

		session.markCleared();
		expect(session.describe()).toMatchObject({ messageCount: 0, preview: "" });

		session.append({ role: "user", content: "新的预览" });
		expect(session.describe()).toMatchObject({ messageCount: 1, preview: "新的预览" });
	});

	it("updatedAt 跟着最后一次写入走（侧栏的相对时间用它）", () => {
		const session = Session.create(process.cwd());
		const before = session.updatedAt();
		expect(before).toBeGreaterThan(0);
		session.append({ role: "user", content: "写一条" });
		expect(session.updatedAt()).toBeGreaterThanOrEqual(before);
	});

	it("读历史时跳过所有带 type 的记录，不只 session 与 clear", async () => {
		const session = Session.create(process.cwd());
		session.append({ role: "user", content: "真消息" });
		// 手写一条将来才可能有的记录：它不该被当成消息混进历史，也不该算进条数
		await appendFile(session.file, `${JSON.stringify({ type: "将来才有的记录", at: "2026-09-14T00:00:00.000Z" })}\n`);
		expect(session.load()).toEqual([{ role: "user", content: "真消息" }]);
		expect(session.describe()).toMatchObject({ messageCount: 1, preview: "真消息" });
	});
});
