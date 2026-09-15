/** 逐轮快照与回滚的单元测试。全部在临时目录里操作。 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, MAX_SNAPSHOT_BYTES } from "../src/checkpoints.ts";
import { createSystemTools } from "../src/tools/index.ts";

let dir = "";
let store: CheckpointStore;
const signal = new AbortController().signal;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "limkenion-checkpoint-"));
	store = new CheckpointStore(join(dir, "session.jsonl"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 模拟一轮：开轮 → 记快照 → 提交 */
function turn(files: Array<{ path: string; before: string | null }>): void {
	store.begin();
	for (const file of files) {
		store.capture(join(dir, file.path), file.before);
	}
	store.commit();
}

describe("CheckpointStore", () => {
	it("没有改动时提交不写文件", () => {
		store.begin();
		expect(store.commit()).toBe(0);
		expect(existsSync(store.file)).toBe(false);
		expect(store.depth()).toBe(0);
	});

	it("回滚把改过的文件写回去、把新建的文件删掉", async () => {
		await writeFile(join(dir, "a.txt"), "原始\n", "utf-8");
		turn([
			{ path: "a.txt", before: "原始\n" },
			{ path: "new.txt", before: null },
		]);
		// 模拟模型这一轮做了什么
		await writeFile(join(dir, "a.txt"), "被改过\n", "utf-8");
		await writeFile(join(dir, "new.txt"), "新建的\n", "utf-8");

		const result = store.rewind();
		expect(result?.restored).toHaveLength(1);
		expect(result?.removed).toHaveLength(1);
		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("原始\n");
		expect(existsSync(join(dir, "new.txt"))).toBe(false);
	});

	it("同一个文件在一轮里只记第一次（回到轮次开始前）", async () => {
		store.begin();
		store.capture(join(dir, "a.txt"), "第一版\n");
		store.capture(join(dir, "a.txt"), "第二版\n");
		store.commit();
		await writeFile(join(dir, "a.txt"), "第三版\n", "utf-8");
		store.rewind();
		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("第一版\n");
	});

	it("多轮回滚一次退一轮", async () => {
		await writeFile(join(dir, "a.txt"), "v1\n", "utf-8");
		turn([{ path: "a.txt", before: "v1\n" }]);
		await writeFile(join(dir, "a.txt"), "v2\n", "utf-8");
		turn([{ path: "a.txt", before: "v2\n" }]);
		await writeFile(join(dir, "a.txt"), "v3\n", "utf-8");

		expect(store.depth()).toBe(2);
		store.rewind();
		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("v2\n");
		expect(store.depth()).toBe(1);
		store.rewind();
		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("v1\n");
		expect(store.depth()).toBe(0);
		expect(store.rewind()).toBeNull();
	});

	it("没提交的轮次不会进入回滚链", async () => {
		store.begin();
		store.capture(join(dir, "a.txt"), "内容\n");
		// 这一轮失败/被打断：不 commit，下一次 begin 直接丢弃
		store.begin();
		store.commit();
		expect(store.depth()).toBe(0);
	});

	it("超过上限的大文件不记录，并在结果里说明", async () => {
		const big = "x".repeat(MAX_SNAPSHOT_BYTES + 1);
		store.begin();
		store.capture(join(dir, "big.txt"), big);
		store.commit();
		const result = store.rewind();
		expect(result?.skipped).toContain(join(dir, "big.txt"));
		expect(result?.restored).toHaveLength(0);
	});

	it("快照文件带损坏行也能读出其余轮次", async () => {
		turn([{ path: "a.txt", before: "内容\n" }]);
		await writeFile(store.file, `${await readFile(store.file, "utf-8")}这不是 JSON\n`, "utf-8");
		expect(store.depth()).toBe(1);
	});
});

describe("工具与快照配合", () => {
	it("edit 与 write 会先记下旧内容，回滚能还原", async () => {
		await writeFile(join(dir, "a.txt"), "原始内容\n", "utf-8");
		const tools = createSystemTools({ cwd: dir, checkpoints: store });
		const run = (name: string, input: Record<string, unknown>) => {
			const tool = tools.find((candidate) => candidate.name === name);
			if (!tool) {
				throw new Error(`没有 ${name} 工具`);
			}
			return tool.execute(input, signal);
		};

		store.begin();
		await run("read", { path: "a.txt" });
		await run("edit", { path: "a.txt", edits: [{ oldText: "原始内容", newText: "改过的内容" }] });
		await run("write", { path: "brand-new.txt", content: "新文件\n" });
		store.commit();

		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("改过的内容\n");
		expect(existsSync(join(dir, "brand-new.txt"))).toBe(true);

		store.rewind();
		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe("原始内容\n");
		expect(existsSync(join(dir, "brand-new.txt"))).toBe(false);
	});
});
