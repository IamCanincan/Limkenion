/**
 * 为「编码时少走弯路」而加的三条行为的测试。
 *
 * 都是效率改动，判定标准是**往返次数**，不是正确性兜底：
 * 1. `edit` 不再因为「文件被格式化器改过」就要求整份重读（唯一匹配本身就是锚点）；
 * 2. `read` 可以一次读多个文件（接口 + 实现 + 测试这种固定组合）；
 * 3. `bash` 输出超限时保留头尾、只有真正的输出洪流才终止命令（结论通常在尾部，重跑一遍很贵）。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash.ts";
import { createSystemTools } from "../src/tools/index.ts";

let cwd = "";
const signal = new AbortController().signal;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "limkenion-efficiency-"));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

/** 同一套工具连续操作，才共享证据表 */
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

describe("edit：格式化器改过别处，不该把这次编辑也挡回去", () => {
	it("整份指纹变了但目标片段仍唯一 → 照改，并只改匹配到的那一段", async () => {
		const { run } = tools();
		await writeFile(join(cwd, "a.ts"), "const a = 1;\nconst b = 2;\n", "utf-8");
		await run("read", { path: "a.ts" });
		// 模拟 npm run check 里的 biome --write：把别处的行重排了
		await writeFile(join(cwd, "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf-8");
		const edited = await run("edit", {
			path: "a.ts",
			edits: [{ oldText: "const a = 1;", newText: "const a = 10;" }],
		});
		expect(edited.isError).toBe(false);
		expect(edited.content).toContain("被别处改动过");
		expect(await readFile(join(cwd, "a.ts"), "utf-8")).toBe("const a = 10;\nconst b = 2;\nconst c = 3;\n");
	});

	it("连改三次同一个文件，中间不需要再读", async () => {
		const { run } = tools();
		await writeFile(join(cwd, "b.ts"), "one\ntwo\nthree\n", "utf-8");
		await run("read", { path: "b.ts" });
		expect((await run("edit", { path: "b.ts", edits: [{ oldText: "one", newText: "1" }] })).isError).toBe(false);
		expect((await run("edit", { path: "b.ts", edits: [{ oldText: "two", newText: "2" }] })).isError).toBe(false);
		expect((await run("edit", { path: "b.ts", edits: [{ oldText: "three", newText: "3" }] })).isError).toBe(false);
		expect(await readFile(join(cwd, "b.ts"), "utf-8")).toBe("1\n2\n3\n");
	});
});

describe("read：一次读多个文件", () => {
	it("path 与 paths 只能给一个，都缺都给时当场报错", async () => {
		const { run } = tools();
		expect((await run("read", {})).isError).toBe(true);
		expect((await run("read", { path: "x.ts", paths: ["y.ts"] })).isError).toBe(true);
	});

	it("paths 一次读完几个文件，各自带标题，且都能直接 edit（证据都记下了）", async () => {
		const { run } = tools();
		await writeFile(join(cwd, "iface.ts"), "export interface A { n: number }\n", "utf-8");
		await writeFile(join(cwd, "impl.ts"), "export const a: A = { n: 1 };\n", "utf-8");
		const read = await run("read", { paths: ["iface.ts", "impl.ts"] });
		expect(read.isError).toBe(false);
		expect(read.content).toContain("── iface.ts");
		expect(read.content).toContain("── impl.ts");
		expect(read.content).toContain("export const a: A = { n: 1 };");
		// 批量读过的文件，编辑时不该再要求「先 read」
		expect((await run("edit", { path: "impl.ts", edits: [{ oldText: "n: 1", newText: "n: 2" }] })).isError).toBe(
			false,
		);
	});

	it("其中一个不存在：其它照读，整体不算失败，错误行就在那一节里", async () => {
		const { run } = tools();
		await writeFile(join(cwd, "ok.ts"), "const ok = true;\n", "utf-8");
		const read = await run("read", { paths: ["ok.ts", "missing.ts"] });
		expect(read.isError).toBe(false);
		expect(read.content).toContain("const ok = true;");
		expect(read.content).toContain("文件不存在：missing.ts");
	});

	it("一个都没读成时才算失败", async () => {
		const { run } = tools();
		const read = await run("read", { paths: ["nope-a.ts", "nope-b.ts"] });
		expect(read.isError).toBe(true);
	});
});

describe("bash：输出超限保留头尾，只有输出洪流才终止", () => {
	it("中等超限：头尾都在、中间标出省略、命令正常跑完", async () => {
		const tool = createBashTool({ cwd, maxBytes: 200 });
		const outcome = await tool.execute(
			{
				command: `node -e "console.log('HEAD-MARK'); for (let i = 0; i < 200; i += 1) console.log('line ' + i); console.log('TAIL-MARK')"`,
			},
			signal,
		);
		expect(outcome.content).toContain("HEAD-MARK");
		expect(outcome.content).toContain("TAIL-MARK");
		expect(outcome.content).toContain("中间省略");
		expect(outcome.content).not.toContain("已终止命令");
		expect(outcome.isError).toBe(false);
		expect(outcome.content).toContain("[退出码 0]");
	});

	it("真的刷屏（超过上限 20 倍）：终止并说明", async () => {
		const tool = createBashTool({ cwd, maxBytes: 200 });
		const outcome = await tool.execute(
			{ command: `node -e "for (let i = 0; i < 20000; i += 1) console.log('flood ' + i)"` },
			signal,
		);
		expect(outcome.content).toContain("已终止命令");
		expect(outcome.content).toContain("中间省略");
	});
});
