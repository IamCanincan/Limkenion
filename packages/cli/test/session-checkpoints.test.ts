/**
 * 会话目录里混着快照文件时的行为。
 *
 * 回归用例：逐轮快照叫 `<会话文件>.checkpoints.jsonl`，同样以 .jsonl 结尾，早期实现会把它
 * 当成会话文件——`latest()` 选中它却解析不出会话头，于是 `--continue` 与 `rewind` 都会
 * 报「没有会话」。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_DIR_ENV } from "../src/config.ts";
import { Session } from "../src/session.ts";

let root = "";
let cwd = "";
const original = process.env[SESSION_DIR_ENV];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "limkenion-sessions-"));
	cwd = join(root, "project");
	process.env[SESSION_DIR_ENV] = join(root, "sessions");
});

afterEach(async () => {
	if (original === undefined) {
		delete process.env[SESSION_DIR_ENV];
	} else {
		process.env[SESSION_DIR_ENV] = original;
	}
	await rm(root, { recursive: true, force: true });
});

describe("会话列表与快照文件", () => {
	it("快照文件不算会话：latest 仍返回真正的会话", async () => {
		const session = Session.create(cwd);
		// 名字排在会话文件之后，正是当初出问题的顺序
		await writeFile(`${session.file}.checkpoints.jsonl`, '{"seq":1,"files":[],"skipped":[]}\n', "utf-8");

		expect(Session.latest(cwd)?.file).toBe(session.file);
		expect(Session.list(cwd).map((item) => item.file)).toEqual([session.file]);
	});

	it("只有快照、没有会话时 latest 返回 null", async () => {
		const session = Session.create(cwd);
		await writeFile(`${session.file}.checkpoints.jsonl`, '{"seq":1,"files":[],"skipped":[]}\n', "utf-8");
		await rm(session.file, { force: true });

		expect(Session.latest(cwd)).toBeNull();
	});

	it("会话文件头部损坏时会往前找上一个可用会话", async () => {
		const first = Session.create(cwd);
		const second = Session.create(cwd);
		// 把更新那个写成坏文件：latest 应当退回更早那个好的
		await writeFile(second.file, "这不是 JSON\n", "utf-8");

		expect(Session.latest(cwd)?.file).toBe(first.file);
	});
});
