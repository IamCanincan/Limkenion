/**
 * `limkenion sessions` 的测试。
 *
 * 会话按工作目录分子目录存放在会话根目录下，所以这里把根目录指到临时目录，再用 `Session.create`
 * 造几个真会话（`create` 收一个 `now`，用来把时间错开）。
 *
 * 删除那条特别值得测：它是**移到 `.trash/`** 而不是硬删（会话是这个工具里唯一不可再生的东西），
 * 断言里既要看它从列表里消失，也要看它真的躺在回收目录里。
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionsCommand } from "../src/commands/sessions.ts";
import { SESSION_DIR_ENV } from "../src/config.ts";
import { Session } from "../src/session.ts";

let root = "";
let dir = "";
let other = "";
const originalSessionDir = process.env[SESSION_DIR_ENV];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "limkenion-sessions-root-"));
	dir = await mkdtemp(join(tmpdir(), "limkenion-sessions-a-"));
	other = await mkdtemp(join(tmpdir(), "limkenion-sessions-b-"));
	process.env[SESSION_DIR_ENV] = root;
});

afterEach(async () => {
	if (originalSessionDir === undefined) {
		delete process.env[SESSION_DIR_ENV];
	} else {
		process.env[SESSION_DIR_ENV] = originalSessionDir;
	}
	for (const target of [root, dir, other]) {
		await rm(target, { recursive: true, force: true });
	}
});

/** 跑一遍命令，收 stdout（列表与回执都走它） */
function run(argv: string[], cwd = dir): { code: number; out: string; err: string } {
	const out: string[] = [];
	const err: string[] = [];
	const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	});
	const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		err.push(String(chunk));
		return true;
	});
	try {
		const code = runSessionsCommand(argv, cwd);
		return { code, out: out.join(""), err: err.join("") };
	} finally {
		outSpy.mockRestore();
		errSpy.mockRestore();
	}
}

/** 造一个会话：`at` 用来把创建时间错开（文件名就是时间戳） */
function makeSession(target: string, at: string, messages: string[], title = ""): Session {
	const session = Session.create(target, new Date(at));
	for (const content of messages) {
		session.append({ role: "user", content });
	}
	if (title !== "") {
		session.setTitle(title);
	}
	return session;
}

/** id 前 8 位：与列表里显示的那一列同口径 */
function shortOf(session: Session): string {
	return session.header.id.replaceAll("-", "").slice(0, 8);
}

describe("sessions 子命令", () => {
	it("列出当前目录下的会话：最近的在前，带条数、相对时间与名字", () => {
		const older = makeSession(dir, "2026-09-13T10:00:00Z", ["旧的"], "旧的会话");
		const newer = makeSession(dir, "2026-09-15T10:00:00Z", ["新的", "再来一句"], "新的会话");
		// 另一个工作目录里的会话不该出现在「当前目录」这一份里
		makeSession(other, "2026-09-15T11:00:00Z", ["别处"]);

		const result = run([]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("当前目录下 2 个会话");
		expect(result.out).toContain("新的会话");
		expect(result.out).toContain("旧的会话");
		expect(result.out).toContain(shortOf(newer));
		expect(result.out).toContain(shortOf(older));
		// 最近的排在前面
		expect(result.out.indexOf(shortOf(newer))).toBeLessThan(result.out.indexOf(shortOf(older)));
		// 条数与「怎么改名/删除」的提示
		expect(result.out).toMatch(/2 条/);
		expect(result.out).toContain("sessions rename <id> <名字>");
		expect(result.out).not.toContain("别处");
	});

	it("--all 跨工作目录，并标出每个会话属于哪个目录", () => {
		makeSession(dir, "2026-09-15T10:00:00Z", ["这边的"]);
		makeSession(other, "2026-09-15T11:00:00Z", ["那边的"]);
		const result = run(["--all"]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("全部工作目录下 2 个会话");
		expect(result.out).toContain("这边的");
		expect(result.out).toContain("那边的");
		expect(result.out).toContain(dir);
		expect(result.out).toContain(other);
	});

	it("没有名字时退回首条消息当标题；一条都没有时说清怎么才会有", () => {
		makeSession(dir, "2026-09-15T10:00:00Z", ["帮我看看这个报错"]);
		expect(run([]).out).toContain("帮我看看这个报错");

		const empty = run([], other);
		expect(empty.code).toBe(0);
		expect(empty.err).toContain("当前目录还没有会话");
	});

	it("rename 改文件头里的名字；空名字取消命名；认不出的 id 回 1", async () => {
		const session = makeSession(dir, "2026-09-15T10:00:00Z", ["一句话"], "旧名字");
		const short = shortOf(session);

		const renamed = run(["rename", short, "布局重构"]);
		expect(renamed.code).toBe(0);
		expect(renamed.out).toContain("已改名");
		expect(Session.open(session.file)?.header.title).toBe("布局重构");
		// 真的落在文件里（不是只改了内存）
		expect(await readFile(session.file, "utf-8")).toContain("布局重构");

		// 名字给空串 = 取消命名，界面退回显示首条消息
		expect(run(["rename", short, ""]).code).toBe(0);
		// 存储上这个键是被删掉的（不是留一个空串），所以看对外的那份（`describe()`）
		expect(Session.open(session.file)?.describe().title).toBe("");

		const missing = run(["rename", "ffffffff", "随便"]);
		expect(missing.code).toBe(1);
		expect(missing.err).toContain("找不到会话");
	});

	it("latest 指当前目录下最近那个", () => {
		makeSession(dir, "2026-09-13T10:00:00Z", ["旧的"]);
		const newer = makeSession(dir, "2026-09-15T10:00:00Z", ["新的"]);
		expect(run(["rename", "latest", "最近这个"]).code).toBe(0);
		expect(Session.open(newer.file)?.header.title).toBe("最近这个");
	});

	it("rm 移出列表，但文件躺在 .trash/ 里（不是硬删）", () => {
		const session = makeSession(dir, "2026-09-15T10:00:00Z", ["要删掉的"]);
		const short = shortOf(session);
		const result = run(["rm", short]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("已删除会话");
		expect(result.out).toContain("sessions trash");

		expect(run([]).out).not.toContain("要删掉的");
		// 会话文件本身没了，但回收目录里有一份（想找回来去那儿拿）
		expect(existsSync(session.file)).toBe(false);
		const trash = join(dirname(session.file), ".trash");
		expect(existsSync(trash)).toBe(true);
		expect(readdirSync(trash).some((name) => name.endsWith(".jsonl"))).toBe(true);
	});

	it("sessions trash 列出回收目录；--empty 才真删；空时说清是空的", () => {
		// 先空着：说清是空的，而不是打一个空标题
		const empty = run(["trash"]);
		expect(empty.code).toBe(0);
		expect(empty.err).toContain("回收目录里没有东西");

		const session = makeSession(dir, "2026-09-15T10:00:00Z", ["要删掉的"]);
		run(["rm", shortOf(session)]);
		const trashDir = join(dirname(session.file), ".trash");
		const listed = run(["trash"]);
		expect(listed.code).toBe(0);
		expect(listed.out).toContain("回收目录里 1 个文件");
		expect(listed.out).toContain(trashDir);
		// 只列不删：文件还在
		expect(readdirSync(trashDir)).toHaveLength(1);

		const emptied = run(["trash", "--empty"]);
		expect(emptied.code).toBe(0);
		expect(emptied.out).toContain("已清空回收目录：删除 1 个文件");
		expect(readdirSync(trashDir)).toHaveLength(0);

		// 参数不认识时回 2（`trash` 只认 --empty）
		expect(run(["trash", "随便"]).code).toBe(2);
	});

	it("sessions trash --all 扫所有工作目录的回收目录", () => {
		const here = makeSession(dir, "2026-09-15T10:00:00Z", ["这边的"]);
		const there = makeSession(other, "2026-09-15T11:00:00Z", ["那边的"]);
		run(["rm", shortOf(here)]);
		run(["rm", shortOf(there)], other);

		// 默认只看当前目录：另一处的那个不在里面
		expect(run(["trash"]).out).toContain("回收目录里 1 个文件");
		const all = run(["trash", "--all"]);
		expect(all.out).toContain("回收目录里 2 个文件");
		expect(all.out).toContain(dirname(here.file));
		expect(all.out).toContain(dirname(there.file));

		expect(run(["trash", "--all", "--empty"]).out).toContain("删除 2 个文件");
		expect(readdirSync(join(dirname(here.file), ".trash"))).toHaveLength(0);
		expect(readdirSync(join(dirname(there.file), ".trash"))).toHaveLength(0);
	});

	it("参数不对时回 2 并给出用法", () => {
		expect(run(["rename"]).code).toBe(2);
		expect(run(["rm"]).code).toBe(2);
		expect(run(["rm", "aa", "bb"]).code).toBe(2);
		expect(run(["list", "多余的"]).code).toBe(2);
		const unknown = run(["nope"]);
		expect(unknown.code).toBe(2);
		expect(unknown.err).toContain("未知的子命令");
		expect(run(["--help"]).out).toContain("sessions - 管理历史会话");
	});
});
