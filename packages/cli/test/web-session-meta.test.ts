/**
 * 侧栏「会话元信息」的服务端测试。
 *
 * 侧栏改成按工作区分组之后，客户端依赖三件事：列表里每条摘要都带 `cwd`（分组用）、
 * `updatedAt` 是毫秒时间戳（组内排序与相对时间用）、摘要里没有标题这个字段（行上用首条用户
 * 消息的预览兜底）。这几条单独成文件，不塞进 web-server.test.ts。
 *
 * 全部在临时会话目录里跑，用假的 fetch 驱动模型调用，不碰真实接口。
 */

import { appendFile, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_DIR_ENV } from "../src/config.ts";
import type { SessionSummary } from "../src/web/protocol.ts";
import { startWebServer, type WebServerHandle } from "../src/web/server.ts";

let sessionRoot = "";
let cwdA = "";
let cwdB = "";
let server: WebServerHandle | null = null;
const originalSessionDir = process.env[SESSION_DIR_ENV];

beforeEach(async () => {
	sessionRoot = await mkdtemp(join(tmpdir(), "limkenion-web-meta-sessions-"));
	cwdA = await mkdtemp(join(tmpdir(), "limkenion-web-meta-a-"));
	cwdB = await mkdtemp(join(tmpdir(), "limkenion-web-meta-b-"));
	process.env[SESSION_DIR_ENV] = sessionRoot;
});

afterEach(async () => {
	await server?.close();
	server = null;
	if (originalSessionDir === undefined) {
		delete process.env[SESSION_DIR_ENV];
	} else {
		process.env[SESSION_DIR_ENV] = originalSessionDir;
	}
	await rm(sessionRoot, { recursive: true, force: true });
	await rm(cwdA, { recursive: true, force: true });
	await rm(cwdB, { recursive: true, force: true });
});

/** 启动服务器（初始工作目录是 cwdA） */
async function start(): Promise<WebServerHandle> {
	server = await startWebServer({
		cwd: cwdA,
		// 测试里不走凭据文件，直接固定一把密钥。
		resolveApiKey: () => "test-key",
		modelId: "deepseek-flash",
		host: "127.0.0.1",
		port: 0,
	});
	return server;
}

/** GET 一个 JSON 接口 */
async function getJson(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${base}${path}`);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** POST 一个 JSON 接口 */
async function postJson(
	base: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** 从响应里取会话列表 */
function sessionsOf(body: Record<string, unknown>): SessionSummary[] {
	return body.sessions as SessionSummary[];
}

/**
 * 新建一个会话并写一条用户消息，返回它的 id 与文件路径。
 *
 * 直接追加会话文件而不是走 /prompt：这里要的是「列表里有一条带预览的会话」，
 * 不需要真跑一轮模型（那会引入时间与假 fetch 的耦合）。
 */
async function seedSession(base: string, text: string): Promise<{ id: string; file: string }> {
	const created = await postJson(base, "/api/sessions");
	const file = String(created.body.file);
	await appendFile(file, `${JSON.stringify({ role: "user", content: text })}\n`, "utf-8");
	return { id: String(created.body.id), file };
}

describe("会话元信息", () => {
	it("每条摘要都带 cwd：两个工作区的会话能分成两组", async () => {
		const handle = await start();
		const first = await seedSession(handle.url, "第一个工作区里的会话");

		// 切到第二个工作目录再建一个：会话按工作目录分目录存放，列表要跨目录汇总。
		const switched = await postJson(handle.url, "/api/cwd", { path: cwdB });
		expect(switched.status).toBe(200);
		const second = await seedSession(handle.url, "第二个工作区里的会话");

		const listed = await getJson(handle.url, "/api/sessions");
		expect(listed.status).toBe(200);
		const sessions = sessionsOf(listed.body);
		expect(sessions).toHaveLength(2);

		const byId = new Map(sessions.map((session) => [session.id, session]));
		expect(byId.get(first.id)?.cwd).toBe(cwdA);
		expect(byId.get(second.id)?.cwd).toBe(cwdB);
		// 分组键必须是非空字符串，否则客户端会把两个工作区并成一组。
		for (const session of sessions) {
			expect(typeof session.cwd).toBe("string");
			expect(session.cwd).not.toBe("");
		}
	});

	it("摘要里没有标题：行上只能用首条用户消息的预览", async () => {
		const handle = await start();
		const { id } = await seedSession(handle.url, "把发布脚本拆成两步");

		const sessions = sessionsOf((await getJson(handle.url, "/api/sessions")).body);
		const summary = sessions.find((session) => session.id === id) as Record<string, unknown> | undefined;
		expect(summary?.preview).toContain("把发布脚本拆成两步");
		// 只断言「没有可用的标题」：空串与字段缺失都算，客户端两种都会退回 preview。
		expect(typeof summary?.title === "string" ? summary.title : "").toBe("");
		expect(summary?.archived ?? false).toBe(false);
	});

	it("updatedAt 是毫秒时间戳，且跟着最后一次写入走（组内排序靠它）", async () => {
		const handle = await start();
		const older = await seedSession(handle.url, "先写的会话");
		const newer = await seedSession(handle.url, "后写的会话");

		// 文件写入的毫秒可能相同，这里显式把旧的那个推到一小时前：排序看的是 updatedAt，不是创建顺序。
		const past = new Date(Date.now() - 3_600_000);
		await utimes(older.file, past, past);

		const sessions = sessionsOf((await getJson(handle.url, "/api/sessions")).body);
		const olderSummary = sessions.find((session) => session.id === older.id);
		const newerSummary = sessions.find((session) => session.id === newer.id);
		expect(olderSummary?.updatedAt).toBeGreaterThan(0);
		expect(newerSummary?.updatedAt).toBeGreaterThan(0);
		// 客户端把差值换算成「刚刚 / N 分钟前 / …」，所以这里必须是毫秒，不是秒。
		expect(newerSummary?.updatedAt).toBeGreaterThan(Date.now() - 60_000);
		expect(olderSummary?.updatedAt).toBeLessThan(newerSummary?.updatedAt ?? 0);

		const sorted = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
		expect(sorted[0]?.id).toBe(newer.id);
	});

	it("选中别的工作区的会话：切 cwd 之后能拿到一份带 cwd 的新列表", async () => {
		const handle = await start();
		await seedSession(handle.url, "A 目录的会话");
		await postJson(handle.url, "/api/cwd", { path: cwdB });
		const inB = await seedSession(handle.url, "B 目录的会话");

		// 前端 selectSession 的路径：先 POST /api/cwd，再拉一份列表确认目标还在。
		const switched = await postJson(handle.url, "/api/cwd", { path: cwdA });
		expect(switched.status).toBe(200);
		const state = switched.body;
		expect(state.cwd).toBe(cwdA);

		const sessions = sessionsOf((await getJson(handle.url, "/api/sessions")).body);
		// 列表本身是跨工作区的（侧栏按工作区分组），所以两个都还在，且都带自己的 cwd。
		expect(sessions.map((session) => session.id)).toContain(inB.id);
		expect(sessions.find((session) => session.id === inB.id)?.cwd).toBe(cwdB);
	});
});
