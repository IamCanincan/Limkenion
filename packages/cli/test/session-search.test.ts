/**
 * 跨会话搜索：跳过快照、还原「哪条会话哪一行谁说的」。
 *
 * 这里全部造真实文件来测——它读的就是磁盘上的 JSONL，用假实现测不出「快照文件会不会混进来」
 * 这类真问题。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSearchArgs } from "../src/commands/search.ts";
import { listAllSessionFiles } from "../src/session.ts";
import { searchSessions } from "../src/session-search.ts";

let root = "";

/** 造一个会话文件 */
async function writeSession(
	dirName: string,
	fileName: string,
	header: Record<string, unknown>,
	records: Record<string, unknown>[],
): Promise<string> {
	const dir = join(root, dirName);
	await mkdir(dir, { recursive: true });
	const file = join(dir, fileName);
	const lines = [JSON.stringify({ type: "session", ...header }), ...records.map((record) => JSON.stringify(record))];
	await writeFile(file, `${lines.join("\n")}\n`, "utf-8");
	return file;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "limkenion-search-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("listAllSessionFiles", () => {
	it("递归一层目录，并跳过逐轮快照", async () => {
		await writeSession("--a--", "2026-01-01.jsonl", { id: "s1" }, []);
		await writeSession("--a--", "2026-01-01.jsonl.checkpoints.jsonl", { id: "c1" }, []);
		await writeSession("--b--", "2026-02-01.jsonl", { id: "s2" }, []);

		const files = listAllSessionFiles(root).map((file) => file.replace(`${root}\\`, "").replace(`${root}/`, ""));
		expect(files).toHaveLength(2);
		expect(files.some((file) => file.includes("checkpoints"))).toBe(false);
	});

	it("目录不存在时返回空数组", () => {
		expect(listAllSessionFiles(join(root, "不存在"))).toEqual([]);
	});
});

describe("searchSessions", () => {
	it("找到用户消息，并带上角色与行号", async () => {
		await writeSession(
			"--a--",
			"2026-03-01T10-00-00.jsonl",
			{ id: "sess-1", cwd: "/work/proj", createdAt: "2026-03-01T10:00:00.000Z" },
			[
				{ role: "user", content: "帮我把 session.ts 里的 latest() 修好" },
				{ role: "assistant", content: "已经修好了" },
			],
		);

		const hits = searchSessions(root, "latest()");
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ sessionId: "sess-1", cwd: "/work/proj", role: "user", line: 2 });
		expect(hits[0]?.snippet).toContain("latest()");
	});

	it("大小写不敏感，也能搜到工具输出与工具参数", async () => {
		await writeSession("--a--", "2026-03-01T10-00-00.jsonl", { id: "sess-1" }, [
			{ role: "assistant", content: "", toolCalls: [{ name: "grep", arguments: '{"pattern":"RepeatGuard"}' }] },
			{ role: "tool", results: [{ toolCallId: "c1", content: "命中 repeatguard 三次" }] },
		]);

		expect(searchSessions(root, "repeatguard")).toHaveLength(2);
		expect(searchSessions(root, "REPEATGUARD")).toHaveLength(2);
	});

	it("快照文件里的内容不会被搜出来", async () => {
		await writeSession("--a--", "2026-03-01.jsonl", { id: "s1" }, [{ role: "user", content: "普通对话" }]);
		await writeSession("--a--", "2026-03-01.jsonl.checkpoints.jsonl", { id: "c1" }, [
			{ seq: 1, files: ["秘密的检查点内容"] },
		]);

		expect(searchSessions(root, "秘密")).toEqual([]);
	});

	it("最近的会话排在前面，并遵守条数上限", async () => {
		await writeSession("--a--", "2026-01-01.jsonl", { id: "旧" }, [{ role: "user", content: "同一个词" }]);
		await writeSession("--a--", "2026-02-01.jsonl", { id: "新" }, [{ role: "user", content: "同一个词" }]);

		const all = searchSessions(root, "同一个词");
		expect(all.map((hit) => hit.sessionId)).toEqual(["新", "旧"]);

		const limited = searchSessions(root, "同一个词", { limit: 1 });
		expect(limited).toHaveLength(1);
		expect(limited[0]?.sessionId).toBe("新");
	});

	it("空关键词与解析不了的行都不会炸", async () => {
		await mkdir(join(root, "--a--"), { recursive: true });
		await writeFile(join(root, "--a--", "2026-03-01.jsonl"), '{"type":"session","id":"s1"}\n不是 JSON\n', "utf-8");
		expect(searchSessions(root, "  ")).toEqual([]);
		expect(searchSessions(root, "不是")).toEqual([]);
	});
});

describe("parseSearchArgs", () => {
	it("多个词拼成关键词，支持 --limit", () => {
		expect(parseSearchArgs(["session", "latest"])).toEqual({ query: "session latest", limit: 20 });
		expect(parseSearchArgs(["x", "--limit", "5"])).toEqual({ query: "x", limit: 5 });
	});

	it("缺关键词或 --limit 不合法时报错", () => {
		expect(parseSearchArgs([])).toEqual({ error: expect.stringContaining("关键词") });
		expect(parseSearchArgs(["x", "--limit", "0"])).toEqual({ error: expect.stringContaining("正整数") });
		expect(parseSearchArgs(["x", "--limit"])).toEqual({ error: expect.stringContaining("正整数") });
		expect(parseSearchArgs(["x", "--wat"])).toEqual({ error: expect.stringContaining("未知参数") });
	});
});
