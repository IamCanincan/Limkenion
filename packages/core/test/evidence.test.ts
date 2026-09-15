/**
 * 读取证据的单元测试。
 *
 * 覆盖的契约：改文件前必须先读过、读过之后文件不能再变；新建文件不受限。
 * 最后一组走 createSystemTools，确认四个文件工具共用同一张证据表（不然机制形同虚设）。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadEvidence } from "../src/tools/evidence.ts";
import { createSystemTools } from "../src/tools/index.ts";

let cwd = "";
const signal = new AbortController().signal;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "limkenion-evidence-"));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

/** 取某个工具 */
function toolOf(name: string) {
	const tool = createSystemTools({ cwd }).find((candidate) => candidate.name === name);
	if (!tool) {
		throw new Error(`没有 ${name} 工具`);
	}
	return tool;
}

/** 用同一套工具连续操作，才能共享证据表 */
function tools() {
	const list = createSystemTools({ cwd });
	return {
		run: (name: string, input: Record<string, unknown>) => {
			const tool = list.find((candidate) => candidate.name === name);
			if (!tool) {
				throw new Error(`没有 ${name} 工具`);
			}
			return tool.execute(input, signal);
		},
	};
}

describe("ReadEvidence", () => {
	it("没读过就拒绝", () => {
		const evidence = new ReadEvidence();
		expect(evidence.check("/tmp/a.ts", "内容")).toContain("必须先读");
	});

	it("记过内容后放行；内容变了就拒绝", () => {
		const evidence = new ReadEvidence();
		evidence.record("/tmp/a.ts", "原始内容");
		expect(evidence.check("/tmp/a.ts", "原始内容")).toBeNull();
		expect(evidence.check("/tmp/a.ts", "被别人改过")).toContain("被改动过");
	});

	it("文件不存在时不算风险", () => {
		const evidence = new ReadEvidence();
		evidence.record("/tmp/a.ts", "原始内容");
		expect(evidence.check("/tmp/a.ts", null)).toBeNull();
	});
});

describe("edit 的读取证据", () => {
	it("没读过直接改会被拒绝", async () => {
		await writeFile(join(cwd, "a.txt"), "hello\n", "utf-8");
		const outcome = await toolOf("edit").execute(
			{ path: "a.txt", edits: [{ oldText: "hello", newText: "hi" }] },
			signal,
		);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).toContain("必须先读");
		expect(await readFile(join(cwd, "a.txt"), "utf-8")).toBe("hello\n");
	});

	it("同一套工具里先读后改可以成功", async () => {
		await writeFile(join(cwd, "a.txt"), "hello\n", "utf-8");
		const { run } = tools();
		expect((await run("read", { path: "a.txt" })).isError).toBe(false);
		const edited = await run("edit", { path: "a.txt", edits: [{ oldText: "hello", newText: "hi" }] });
		expect(edited.isError).toBe(false);
		expect(await readFile(join(cwd, "a.txt"), "utf-8")).toBe("hi\n");
	});

	it("读完之后又被外部改动就拒绝，要求重新读", async () => {
		await writeFile(join(cwd, "a.txt"), "hello\n", "utf-8");
		const { run } = tools();
		await run("read", { path: "a.txt" });
		// 模拟用户或别的进程改了文件
		await writeFile(join(cwd, "a.txt"), "hello\n外部加了一行\n", "utf-8");
		const edited = await run("edit", { path: "a.txt", edits: [{ oldText: "hello", newText: "hi" }] });
		expect(edited.isError).toBe(true);
		expect(edited.content).toContain("被改动过");
	});

	it("同一轮里连改两次不会被自己拦下", async () => {
		await writeFile(join(cwd, "a.txt"), "one\ntwo\n", "utf-8");
		const { run } = tools();
		await run("read", { path: "a.txt" });
		expect((await run("edit", { path: "a.txt", edits: [{ oldText: "one", newText: "1" }] })).isError).toBe(false);
		// 第二次改的是刚写入的内容，指纹已更新，应当继续放行
		expect((await run("edit", { path: "a.txt", edits: [{ oldText: "two", newText: "2" }] })).isError).toBe(false);
		expect(await readFile(join(cwd, "a.txt"), "utf-8")).toBe("1\n2\n");
	});
});

describe("write 的读取证据", () => {
	it("新建文件不需要先读", async () => {
		const outcome = await toolOf("write").execute({ path: "new.txt", content: "内容" }, signal);
		expect(outcome.isError).toBe(false);
		expect(await readFile(join(cwd, "new.txt"), "utf-8")).toBe("内容");
	});

	it("覆盖已存在的文件必须先读过", async () => {
		await writeFile(join(cwd, "a.txt"), "原内容\n", "utf-8");
		const blocked = await toolOf("write").execute({ path: "a.txt", content: "整篇替换" }, signal);
		expect(blocked.isError).toBe(true);
		expect(blocked.content).toContain("必须先读");
		expect(await readFile(join(cwd, "a.txt"), "utf-8")).toBe("原内容\n");
	});

	it("先读再覆盖就放行", async () => {
		await writeFile(join(cwd, "a.txt"), "原内容\n", "utf-8");
		const { run } = tools();
		await run("read", { path: "a.txt" });
		const written = await run("write", { path: "a.txt", content: "整篇替换" });
		expect(written.isError).toBe(false);
		expect(await readFile(join(cwd, "a.txt"), "utf-8")).toBe("整篇替换");
	});

	it("自己刚写的文件可以继续改（写入即记录证据）", async () => {
		const { run } = tools();
		await run("write", { path: "a.txt", content: "第一版\n" });
		const edited = await run("edit", { path: "a.txt", edits: [{ oldText: "第一版", newText: "第二版" }] });
		expect(edited.isError).toBe(false);
		expect(await readFile(join(cwd, "a.txt"), "utf-8")).toBe("第二版\n");
	});
});
