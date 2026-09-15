/*
 * 被引用但没定义的 CSS 变量。
 *
 * 引用一个不存在的自定义属性**不是错误，也没有任何提示**：整条声明被浏览器丢掉，功能照常、断言照绿，
 * 只有样式没了。真踩过两次——`app.css` 里 diff / 终端 / 日志块引用 `--font-mono`，而这个名字从来没定义过；
 * `history.js` 里四处 `font-family: var(--mono)` 同理，历史面板的逐轮 diff 一直用的是界面无衬线。
 *
 * 三种「算已定义」的写法都要认：
 *   1. CSS 里的 `--x: 值`；
 *   2. JS 运行时设的 `setProperty("--x", …)`（侧栏/面板宽度、滚动条宽度这类就是），允许跨行；
 *   3. `var(--x, 兜底值)`——有兜底就等于有定义（`--lk-overlay-stack` 就是这种）。
 *
 * 还有一条自身的教训写进断言：**先确认扫描真的读到了文件**。第一版扫描用错了 PowerShell 参数，一个文件
 * 都没读到，却输出了「0 个未定义变量」——看着安心、其实什么都没查。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** 前端模块目录 */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");

/** 收集定义与引用；返回没定义的那些名字 */
function undefinedVariables(sources: string[]): { defined: Set<string>; missing: string[] } {
	const defined = new Set<string>();
	const used = new Set<string>();
	for (const source of sources) {
		// CSS 定义
		for (const match of source.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) {
			defined.add(match[1] ?? "");
		}
		// 运行时定义（允许跨行：setProperty(\n  "--x", …）
		for (const match of source.matchAll(/setProperty\(\s*["'](--[A-Za-z0-9-]+)["']/g)) {
			defined.add(match[1] ?? "");
		}
		// 引用（带兜底的一并算作已定义）
		for (const match of source.matchAll(/var\((--[A-Za-z0-9-]+)\s*(,)?/g)) {
			const name = match[1] ?? "";
			used.add(name);
			if (match[2] === ",") {
				defined.add(name);
			}
		}
	}
	return { defined, missing: [...used].filter((name) => !defined.has(name)).sort() };
}

/** 读 public 下所有 css / js */
function sources(): { name: string; text: string }[] {
	return readdirSync(PUBLIC_DIR)
		.filter((name) => name.endsWith(".css") || name.endsWith(".js"))
		.map((name) => ({ name, text: readFileSync(join(PUBLIC_DIR, name), "utf8") }));
}

describe("前端引用的 CSS 变量", () => {
	it("扫描确实读到了文件（免得又得出一个空结论）", () => {
		const files = sources();
		// 这些文件一直在，数量只会增；小于 10 说明扫描本身坏了
		expect(files.length).toBeGreaterThan(10);
		expect(files.some((file) => file.name === "app.css")).toBe(true);
	});

	it("每个 var(--…) 都能找到定义或兜底", () => {
		const files = sources();
		const { defined, missing } = undefinedVariables(files.map((file) => file.text));
		// 报出名字与定义总数：失败时不用再猜
		expect(missing, `已定义 ${defined.size} 个，缺定义的：${missing.join(", ")}`).toEqual([]);
	});

	it("判据本身认得出来（三种已定义写法、跨行 setProperty、兜底）", () => {
		expect(undefinedVariables([".a { color: var(--nope); }"]).missing).toEqual(["--nope"]);
		expect(undefinedVariables([":root { --yes: 1px; } .a { color: var(--yes); }"]).missing).toEqual([]);
		expect(
			undefinedVariables(['x.style.setProperty(\n\t"--rt",\n\t"1px",\n); .a { color: var(--rt); }']).missing,
		).toEqual([]);
		expect(undefinedVariables([".a { right: var(--maybe, 0px); }"]).missing).toEqual([]);
	});
});
