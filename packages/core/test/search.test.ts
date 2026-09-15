/** grep / glob 两个搜索工具的单元测试。全部在临时目录里操作，不碰仓库文件。 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGlobTool, createGrepTool } from "../src/tools/search.ts";

let cwd = "";
const signal = new AbortController().signal;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "limkenion-search-"));
	await mkdir(join(cwd, "src", "deep"), { recursive: true });
	await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
	await writeFile(join(cwd, "src", "a.ts"), "export const alpha = 1;\nconst beta = 2;\n", "utf-8");
	await writeFile(join(cwd, "src", "b.js"), "const alpha = 3;\n", "utf-8");
	await writeFile(join(cwd, "src", "deep", "c.ts"), "// alpha 在深层目录\n", "utf-8");
	await writeFile(join(cwd, "readme.md"), "# 说明\nalpha 出现在这里\n", "utf-8");
	await writeFile(join(cwd, "node_modules", "pkg", "index.ts"), "alpha 不该被搜到\n", "utf-8");
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("glob 工具", () => {
	it("按扩展名找文件，且结果用 / 分隔", async () => {
		const outcome = await createGlobTool({ cwd }).execute({ pattern: "**/*.ts" }, signal);
		expect(outcome.isError).toBe(false);
		expect(outcome.content).toContain("src/a.ts");
		expect(outcome.content).toContain("src/deep/c.ts");
		expect(outcome.content).not.toContain("src/b.js");
	});

	it("不含 / 的模式按文件名匹配", async () => {
		const outcome = await createGlobTool({ cwd }).execute({ pattern: "*.md" }, signal);
		expect(outcome.content).toContain("readme.md");
	});

	it("跳过 node_modules", async () => {
		const outcome = await createGlobTool({ cwd }).execute({ pattern: "**/*.ts" }, signal);
		expect(outcome.content).not.toContain("node_modules");
	});

	it("支持 {a,b} 花括号", async () => {
		const outcome = await createGlobTool({ cwd }).execute({ pattern: "src/*.{ts,js}" }, signal);
		expect(outcome.content).toContain("src/a.ts");
		expect(outcome.content).toContain("src/b.js");
	});

	it("没有匹配时明确说明", async () => {
		const outcome = await createGlobTool({ cwd }).execute({ pattern: "**/*.rs" }, signal);
		expect(outcome.content).toContain("没有匹配");
	});

	it("缺少 pattern 报错", async () => {
		const outcome = await createGlobTool({ cwd }).execute({}, signal);
		expect(outcome.isError).toBe(true);
	});
});

describe("grep 工具", () => {
	it("返回 路径:行号: 内容", async () => {
		const outcome = await createGrepTool({ cwd }).execute({ pattern: "beta" }, signal);
		expect(outcome.isError).toBe(false);
		expect(outcome.content).toContain("src/a.ts:2:");
		expect(outcome.content).toContain("beta");
	});

	it("用 include 限定文件类型", async () => {
		const outcome = await createGrepTool({ cwd }).execute({ pattern: "alpha", include: "*.md" }, signal);
		expect(outcome.content).toContain("readme.md");
		expect(outcome.content).not.toContain("src/a.ts");
	});

	it("默认不搜 node_modules", async () => {
		const outcome = await createGrepTool({ cwd }).execute({ pattern: "alpha" }, signal);
		expect(outcome.content).not.toContain("node_modules");
	});

	it("maxResults 生效并说明已到上限", async () => {
		const outcome = await createGrepTool({ cwd }).execute({ pattern: "alpha", maxResults: 1 }, signal);
		expect(outcome.content).toContain("已达上限");
	});

	it("正则不合法时明确报错", async () => {
		const outcome = await createGrepTool({ cwd }).execute({ pattern: "([" }, signal);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).toContain("正则不合法");
	});

	it("没有命中时明确说明", async () => {
		const outcome = await createGrepTool({ cwd }).execute({ pattern: "不存在的词" }, signal);
		expect(outcome.content).toContain("没有匹配");
	});

	it("搜索范围被夹在工作目录内", async () => {
		const outcome = await createGrepTool({ cwd }).execute({ pattern: "alpha", path: ".." }, signal);
		// 工作目录之外的路径会被忽略，退回工作目录本身，因此仍应命中仓库内的文件。
		expect(outcome.content).toContain("src/a.ts");
	});
});
