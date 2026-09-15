/**
 * 子命令注册表与帮助文本的契约测试。
 *
 * 这套东西的价值全在「一处定义、多处使用」：元信息住在命令自己的模块里，帮助与派发都从注册表读。
 * 所以这里钉三件事——**清单/实现/帮助不许走散**、**帮助的列要对齐**、以及**命令模块不许值 import
 * `args.ts`**（那正是循环依赖的来源；这条边是这一轮才解开的，所以要有人守着）。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOptions } from "../src/args.ts";
import { commandUsageLines, displayWidth } from "../src/commands/command.ts";
import { COMMANDS, findCommand } from "../src/commands/registry.ts";

/** 抓一次 stdout 的输出（帮助走 stdout，进度与错误走 stderr） */
function captureStdout(run: () => void): string {
	const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	try {
		run();
		return spy.mock.calls.map((call) => String(call[0])).join("");
	} finally {
		spy.mockRestore();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("注册表", () => {
	it("每条命令都带着自己的元信息与实现", () => {
		// 这就是这一轮改掉的东西：从前元信息是另一份数据（`catalog.ts`），与实现分在两个文件里，
		// 漏掉一处不报错。现在两者是同一个对象上的字段，漏不掉。
		expect(COMMANDS.length).toBeGreaterThan(0);
		for (const command of COMMANDS) {
			expect(command.name, command.name).toMatch(/^[a-z][a-z0-9-]*$/);
			expect(command.synopsis.trim(), command.name).not.toBe("");
			expect(command.summary.trim(), command.name).not.toBe("");
			expect(typeof command.run, command.name).toBe("function");
		}
	});

	it("命令名唯一", () => {
		const names = COMMANDS.map((command) => command.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("按名字查到的是清单里那一个", () => {
		for (const command of COMMANDS) {
			expect(findCommand(command.name)).toBe(command);
		}
	});

	it("不知道的名字返回 undefined，而不是抛错", () => {
		expect(findCommand("nope")).toBeUndefined();
		expect(findCommand("")).toBeUndefined();
		expect(findCommand(undefined)).toBeUndefined();
	});

	it("原型链上的名字不算命中", () => {
		// `argv[0]` 是用户给的任意字符串：拿它去索引对象会让 `constructor`、`toString` 顺着原型链
		// 命中，把一次打错当成一次正常调用。注册表用数组查找，天然没有这个问题——但这条得有人守着。
		for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
			expect(findCommand(name), name).toBeUndefined();
		}
	});
});

describe("命令模块与 args.ts 之间不能有值 import", () => {
	it("只允许 import type（那是被擦除的，不会成环）", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const dir = join(here, "..", "src", "commands");
		const offenders: string[] = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".ts")) {
				continue;
			}
			const source = readFileSync(join(dir, name), "utf8");
			// 按 import 语句切：每条语句的正文里出现 `../args.ts` 且不是以 `type` 开头，就是值依赖。
			// 多行写法也拦得住——它的正文以 `{` 开头。
			for (const statement of source.split(/\nimport\s/).slice(1)) {
				if (!statement.includes('"../args.ts"')) {
					continue;
				}
				if (!statement.startsWith("type")) {
					offenders.push(`${name}：${statement.split("\n")[0]?.trim() ?? ""}`);
				}
			}
		}
		// 值依赖会让 `args.ts` →（拿帮助文本）→ 注册表 → 命令模块 → `args.ts` 成环。
		// 参数语法归宿主（`CommandHost`），命令只声明它要什么。
		expect(offenders).toEqual([]);
	});
});

describe("帮助里的子命令行", () => {
	it("一条命令一行，且摘要不漏", () => {
		const lines = commandUsageLines(COMMANDS, "limkenion");
		expect(lines).toHaveLength(COMMANDS.length);
		for (const [index, command] of COMMANDS.entries()) {
			expect(lines[index]).toContain(command.synopsis);
			expect(lines[index]).toContain(command.summary);
		}
	});

	it("摘要列是对齐的：每行摘要都从同一**显示列**开始", () => {
		// 手填空格的时代，改一个 synopsis 就得重数一遍空格，数错了只有眼睛看得出来。
		// 而且必须按显示列宽量：`search <关键词>` 里的 CJK 是双列宽，用码元下标量会对齐得好好的，
		// 终端里却歪三列——第一版就是这么过的测试。
		const lines = commandUsageLines(COMMANDS, "limkenion");
		const starts = lines.map((line) => {
			const command = COMMANDS.find((candidate) => line.includes(candidate.synopsis));
			return displayWidth(line.slice(0, line.indexOf(command?.summary ?? "")));
		});
		expect(starts.every((column) => column > 0)).toBe(true);
		expect(new Set(starts).size).toBe(1);
		// 最长的那条（按显示列宽）之后留两个空格，其余靠补空格对齐
		const longest = Math.max(...COMMANDS.map((command) => displayWidth(`limkenion ${command.synopsis}`)));
		expect(starts[0]).toBe(2 + longest + 2);
	});

	it("`--help` 打印的正文里带着注册表那份清单", () => {
		const output = captureStdout(() => {
			expect(parseOptions(["--help"])).toBeNull();
		});
		for (const command of COMMANDS) {
			expect(output, command.name).toContain(command.synopsis);
			expect(output, command.name).toContain(command.summary);
		}
		// 交互模式与一次性模式这两条不是子命令，仍由 args.ts 自己写
		expect(output).toContain("进入交互模式");
	});
});
