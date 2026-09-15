/*
 * 前端模块里的 CSS 花括号。
 *
 * 每个功能模块都把自己的样式写成模板串，交给 style.textContent。**模板串里的 CSS 少一个花括号不是
 * 语法错误**：浏览器会把那一条规则整条丢掉，功能照常、断言照绿，只有样式没了——真发生过（jobs.js 里
 * 六条规则丢了左花括号，失败行的危险色与单行省略全都没生效，而当时的探针只查「有没有这个类名」和
 * 交互，全绿）。这条测试就是那次事故的回归网。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** 前端模块目录 */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");

/**
 * 找「看着像样式的声明行，却没有左花括号」的行。
 *
 * 判据刻意收窄以免误报：以点号加类名开头（选择器）、带「属性: 值」的形状、整行不含左花括号，
 * 也不含左括号（JS 里以点开头的行多是方法链）。
 */
function braceLessRules(source: string): { line: number; text: string }[] {
	const found: { line: number; text: string }[] = [];
	const lines = source.split(/\r?\n/);
	for (const [index, raw] of lines.entries()) {
		const line = raw.trim();
		if (!line.startsWith(".") || line.includes("{") || line.includes("(")) {
			continue;
		}
		if (/^\.[A-Za-z][^;{}]*\s[a-z-]+:\s/.test(line)) {
			found.push({ line: index + 1, text: line });
		}
	}
	return found;
}

describe("前端模块的 CSS 花括号", () => {
	it("public 下每个模块里的样式规则都带左花括号", () => {
		const offenders: string[] = [];
		for (const name of readdirSync(PUBLIC_DIR)) {
			if (!name.endsWith(".js")) {
				continue;
			}
			const source = readFileSync(join(PUBLIC_DIR, name), "utf8");
			for (const hit of braceLessRules(source)) {
				offenders.push(`${name}:${hit.line} ${hit.text}`);
			}
		}
		// 报出具体文件与行号：失败时不用再猜是哪一条
		expect(offenders).toEqual([]);
	});

	it("判据本身认得出来（免得这条测试变成永远绿）", () => {
		// 反例：丢花括号的那一行要被判出来；正常的一行不能误报。
		// 判据会跳过带括号的行（`var(--text)` 这类带函数的声明也跳过），所以反例用一个纯字面量。
		expect(braceLessRules(".foo color: red;")).toHaveLength(1);
		expect(braceLessRules(".foo { color: red; }")).toHaveLength(0);
		// 方法链不是样式
		expect(braceLessRules(".map((item) => item.id)")).toHaveLength(0);
	});
});
