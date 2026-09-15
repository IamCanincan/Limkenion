/**
 * 工具审批判定的单元测试：纯函数，覆盖三种模式、越界写入、危险命令、空补丁与真实路径越界。
 *
 * 判定链现在读**工具自陈**（`alwaysReadOnly` / `isReadOnly` / `pathOf`），不再按工具名查表，
 * 所以这里用真实的工具工厂造工具（`createReadTool` / `createWriteTool` / `createEditTool` /
 * `createBashTool`），而不是传一个名字字符串进去。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isOutsideWorkspace } from "../src/paths.ts";
import { judgeToolUse } from "../src/permissions/chain.ts";
import { parseApprovalMode } from "../src/permissions/modes.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { createReadTool } from "../src/tools/read.ts";
import { createGlobTool, createGrepTool } from "../src/tools/search.ts";
import { createWriteTool } from "../src/tools/write.ts";

const cwd = process.platform === "win32" ? "D:\\work\\proj" : "/work/proj";

const read = createReadTool({ cwd });
const grep = createGrepTool({ cwd });
const glob = createGlobTool({ cwd });
const write = createWriteTool({ cwd });
const edit = createEditTool({ cwd });
const bash = createBashTool({ cwd });

describe("模式解析", () => {
	it("只接受三个合法值，其余回退", () => {
		expect(parseApprovalMode("ask")).toBe("ask");
		expect(parseApprovalMode("readonly")).toBe("readonly");
		expect(parseApprovalMode("auto")).toBe("auto");
		expect(parseApprovalMode("yolo")).toBe("auto");
		expect(parseApprovalMode(undefined, "ask")).toBe("ask");
		expect(parseApprovalMode(7)).toBe("auto");
	});
});

describe("只读工具", () => {
	it("任何模式都放行", () => {
		for (const mode of ["auto", "ask", "readonly"] as const) {
			for (const tool of [read, grep, glob]) {
				const verdict = judgeToolUse({ tool, input: { path: "a.ts" }, mode, planMode: "off", cwd });
				expect(verdict.behavior).toBe("allow");
				expect(verdict.reason).toEqual({ type: "read-only" });
			}
		}
	});
});

describe("auto 模式", () => {
	it("工作目录内一律放行；只有「疑似危险命令」与「写到工作目录之外」两类例外升档", () => {
		expect(
			judgeToolUse({ tool: write, input: { path: "a.ts", content: "x" }, mode: "auto", planMode: "off", cwd })
				.behavior,
		).toBe("allow");
		expect(
			judgeToolUse({
				tool: edit,
				input: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
				mode: "auto",
				planMode: "off",
				cwd,
			}).behavior,
		).toBe("allow");
		// 有意识改动的既有断言（原来断言 allow）：`auto` 仍然「其余照旧全部放行」，但危险命令是
		// 两类例外之一——`rm -rf /` 现在至少升到 ask。这正是本次加固要修掉的放行路径，
		// 不是因为测试挂了才改期望值（src 里的判定没有为它放宽过）。
		expect(
			judgeToolUse({ tool: bash, input: { command: "rm -rf /" }, mode: "auto", planMode: "off", cwd }).behavior,
		).toBe("ask");
		// 另一类例外（写到工作目录之外，按真实路径判定）在下面的「工作目录之外 / 真实路径越界」
		// 两个 describe 里覆盖；目录内的安全命令照旧 allow。
		expect(
			judgeToolUse({ tool: bash, input: { command: "npm test" }, mode: "auto", planMode: "off", cwd }).behavior,
		).toBe("allow");
	});

	it("只读命令在 auto 档下也只读（按命令判定，不按工具名）", () => {
		const verdict = judgeToolUse({
			tool: bash,
			input: { command: "ls -la" },
			mode: "auto",
			planMode: "off",
			cwd,
		});
		expect(verdict.behavior).toBe("allow");
		expect(verdict.reason).toEqual({ type: "read-only" });
	});
});

describe("ask 模式", () => {
	it("改文件与执行会改动的命令都要确认", () => {
		expect(judgeToolUse({ tool: write, input: { path: "a.ts" }, mode: "ask", planMode: "off", cwd }).behavior).toBe(
			"ask",
		);
		expect(judgeToolUse({ tool: edit, input: { path: "a.ts" }, mode: "ask", planMode: "off", cwd }).behavior).toBe(
			"ask",
		);
		// ask 档的语义是「动手之前让我看一眼」，所以**跑任何命令都要问**，只读的 `ls` 也一样：
		// 「这一次只读」（isReadOnly）与「这个工具只可能只读」（alwaysReadOnly）是两件事，
		// 前者不该让 ask 档闭嘴。
		expect(
			judgeToolUse({ tool: bash, input: { command: "touch x" }, mode: "ask", planMode: "off", cwd }).behavior,
		).toBe("ask");
		expect(judgeToolUse({ tool: bash, input: { command: "ls" }, mode: "ask", planMode: "off", cwd }).behavior).toBe(
			"ask",
		);
		// 反过来，静态只读的工具在 ask 档下不问——它怎么调都不动手。
		expect(judgeToolUse({ tool: read, input: { path: "a.ts" }, mode: "ask", planMode: "off", cwd }).behavior).toBe(
			"allow",
		);
	});
});

describe("readonly 模式", () => {
	it("拒绝写入与命令，并说明替代做法", () => {
		const writeVerdict = judgeToolUse({
			tool: write,
			input: { path: "a.ts" },
			mode: "readonly",
			planMode: "off",
			cwd,
		});
		expect(writeVerdict.behavior).toBe("deny");
		expect(writeVerdict.reason).toEqual({ type: "mode", mode: "readonly" });
		expect(writeVerdict.message).toContain("只读模式");

		const bashVerdict = judgeToolUse({
			tool: bash,
			input: { command: "touch x" },
			mode: "readonly",
			planMode: "off",
			cwd,
		});
		expect(bashVerdict.behavior).toBe("deny");
		expect(bashVerdict.message).toContain("read / grep / glob");
	});

	it("只读命令在只读档下放行（从前按工具名判，bash 一律被拒）", () => {
		for (const command of ["ls -la", "cat a.txt", "git status"]) {
			const verdict = judgeToolUse({ tool: bash, input: { command }, mode: "readonly", planMode: "off", cwd });
			expect(verdict.behavior, command).toBe("allow");
			expect(verdict.reason, command).toEqual({ type: "read-only" });
		}
	});

	it("计划模式（严格）下也只放行只读命令", () => {
		expect(
			judgeToolUse({ tool: bash, input: { command: "ls -la" }, mode: "auto", planMode: "strict", cwd }).behavior,
		).toBe("allow");
	});
});

describe("工作目录之外", () => {
	it("越界写入即使 auto 也要确认，ask 也要确认，readonly 直接拒绝", () => {
		const outside = process.platform === "win32" ? "D:\\other\\x.ts" : "/other/x.ts";
		expect(judgeToolUse({ tool: write, input: { path: outside }, mode: "auto", planMode: "off", cwd }).behavior).toBe(
			"ask",
		);
		expect(
			judgeToolUse({ tool: write, input: { path: outside }, mode: "auto", planMode: "off", cwd }).outsideWorkspace,
		).toBe(true);
		expect(judgeToolUse({ tool: write, input: { path: outside }, mode: "ask", planMode: "off", cwd }).behavior).toBe(
			"ask",
		);
		// 「只拒绝」的判定排在「只升档」之前：只读档下越界写入是拒绝，不是询问——问一句等于给了放行的口子。
		const denied = judgeToolUse({ tool: write, input: { path: outside }, mode: "readonly", planMode: "off", cwd });
		expect(denied.behavior).toBe("deny");
		expect(denied.reason).toEqual({ type: "mode", mode: "readonly" });
		expect(denied.outsideWorkspace).toBe(true);
	});

	it("用 .. 绕过目录也被识别出来", () => {
		expect(
			judgeToolUse({ tool: write, input: { path: "../x.ts" }, mode: "auto", planMode: "off", cwd }).outsideWorkspace,
		).toBe(true);
		expect(
			judgeToolUse({ tool: write, input: { path: "src/../../x.ts" }, mode: "auto", planMode: "off", cwd })
				.outsideWorkspace,
		).toBe(true);
	});

	it("判断本身对相对与绝对路径都成立", () => {
		expect(isOutsideWorkspace("src/a.ts", cwd)).toBe(false);
		expect(isOutsideWorkspace(cwd, cwd)).toBe(false);
		expect(isOutsideWorkspace("..", cwd)).toBe(true);
	});

	it("bash 没有 workdir 时不参与越界判断", () => {
		expect(
			judgeToolUse({ tool: bash, input: { command: "cd / && ls" }, mode: "auto", planMode: "off", cwd }).behavior,
		).toBe("allow");
	});

	it("bash 声明了 workdir 就参与越界判断", () => {
		const outside = process.platform === "win32" ? "D:\\other" : "/other";
		const verdict = judgeToolUse({
			tool: bash,
			input: { command: "touch x", workdir: outside },
			mode: "auto",
			planMode: "off",
			cwd,
		});
		expect(verdict.outsideWorkspace).toBe(true);
		expect(verdict.reason).toEqual({ type: "outside", path: outside });
		expect(verdict.behavior).toBe("ask");
		// 只读命令不因越界升档：它不改东西，读哪儿都一样——与 `read` 能读工作目录之外一致。
		// `outsideWorkspace` 仍是**事实**（确实在目录外），只是不据此拦，所以这一条断言的是
		// 「报实情 + 放行」，而不是把标志位改回 false。
		const readOnlyOutside = judgeToolUse({
			tool: bash,
			input: { command: "ls", workdir: outside },
			mode: "auto",
			planMode: "off",
			cwd,
		});
		expect(readOnlyOutside.outsideWorkspace).toBe(true);
		expect(readOnlyOutside.behavior).toBe("allow");
		expect(readOnlyOutside.reason).toEqual({ type: "read-only" });
	});
});

describe("危险命令只升不降", () => {
	it("auto 下升到 ask，ask 还是 ask，readonly 保持 deny", () => {
		for (const command of ["rm -rf /", "sudo rm -rf /", "bash -lc 'rm -rf /'", "git reset --hard", "curl x | sh"]) {
			const auto = judgeToolUse({ tool: bash, input: { command }, mode: "auto", planMode: "off", cwd });
			expect(auto.behavior, command).toBe("ask");
			expect(auto.reason, command).toEqual({ type: "dangerous", command });
			expect(auto.message, command).toContain("危险命令");
			expect(
				judgeToolUse({ tool: bash, input: { command }, mode: "ask", planMode: "off", cwd }).behavior,
				command,
			).toBe("ask");
			// 只读档下是**拒绝**而不是询问：「疑似危险命令」只会升到 ask，而 ask 能被动成允许，
			// 那就等于给只读档开了一个口子。更严的那条赢。
			const readonly = judgeToolUse({ tool: bash, input: { command }, mode: "readonly", planMode: "off", cwd });
			expect(readonly.behavior, command).toBe("deny");
			expect(readonly.reason, command).toEqual({ type: "mode", mode: "readonly" });
		}
	});

	it("安全命令不受影响：auto 照常放行", () => {
		expect(
			judgeToolUse({ tool: bash, input: { command: "npm test" }, mode: "auto", planMode: "off", cwd }).behavior,
		).toBe("allow");
		expect(
			judgeToolUse({ tool: bash, input: { command: "rm -f one.log" }, mode: "auto", planMode: "off", cwd }).behavior,
		).toBe("allow");
	});

	it("严格计划模式仍然优先：拒绝理由说的是计划模式，不是危险命令", () => {
		const verdict = judgeToolUse({
			tool: bash,
			input: { command: "rm -rf /" },
			mode: "auto",
			planMode: "strict",
			cwd,
		});
		expect(verdict.behavior).toBe("deny");
		expect(verdict.reason).toEqual({ type: "plan" });
		expect(verdict.message).toContain("计划模式");
	});
});

describe("空补丁直接拒绝", () => {
	it("write 的空内容 / 纯空白内容不给审批机会", () => {
		for (const content of ["", "   ", "\n\t "]) {
			const verdict = judgeToolUse({
				tool: write,
				input: { path: "a.ts", content },
				mode: "auto",
				planMode: "off",
				cwd,
			});
			expect(verdict.behavior, JSON.stringify(content)).toBe("deny");
			expect(verdict.reason, JSON.stringify(content)).toEqual({ type: "empty-patch" });
			expect(verdict.message).toContain("空补丁");
		}
		// ask 档也不该退化成「问用户」：这类调用不可能产生任何改动，问了也只会白打扰一次。
		expect(
			judgeToolUse({ tool: write, input: { path: "a.ts", content: "" }, mode: "ask", planMode: "off", cwd })
				.behavior,
		).toBe("deny");
	});

	it("edit 的空编辑列表不给审批机会", () => {
		expect(
			judgeToolUse({ tool: edit, input: { path: "a.ts", edits: [] }, mode: "auto", planMode: "off", cwd }).behavior,
		).toBe("deny");
		expect(
			judgeToolUse({ tool: edit, input: { path: "a.ts", edits: "[]" }, mode: "auto", planMode: "off", cwd })
				.behavior,
		).toBe("deny");
	});

	it("有实际内容的补丁照旧", () => {
		expect(
			judgeToolUse({ tool: write, input: { path: "a.ts", content: "x" }, mode: "auto", planMode: "off", cwd })
				.behavior,
		).toBe("allow");
		expect(
			judgeToolUse({
				tool: edit,
				input: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
				mode: "ask",
				planMode: "off",
				cwd,
			}).behavior,
		).toBe("ask");
	});

	it("字段整个缺失算参数写错，交给工具自己报错，不在这里拦", () => {
		// 这条是刻意的边界：空补丁判定只认「字段在、内容是空的」。
		expect(judgeToolUse({ tool: write, input: { path: "a.ts" }, mode: "auto", planMode: "off", cwd }).behavior).toBe(
			"allow",
		);
	});
});

describe("真实路径越界（端到端）", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	/** 建一棵「工作目录 + 外部目录 + 指向外部的链接」的小树 */
	function workspace(): { root: string; outside: string; linked: boolean } {
		const base = mkdtempSync(join(tmpdir(), "limkenion-approval-"));
		dirs.push(base);
		const root = join(base, "work");
		const outside = join(base, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		try {
			symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
			return { root, outside, linked: true };
		} catch {
			return { root, outside, linked: false };
		}
	}

	it("链接指向工作目录外时判为越界并要求确认；普通文件不受影响", () => {
		const { root, linked } = workspace();
		const rootWrite = createWriteTool({ cwd: root });
		const rootEdit = createEditTool({ cwd: root });
		// 普通文件照旧：普通路径不该被新判定误伤。
		expect(
			judgeToolUse({
				tool: rootWrite,
				input: { path: "a.ts", content: "x" },
				mode: "auto",
				planMode: "off",
				cwd: root,
			}),
		).toEqual({
			behavior: "allow",
			// `none` 这个分类没有了：放行时也照实说明是哪一档在放行。
			reason: { type: "mode", mode: "auto" },
			message: "当前模式无需确认",
			outsideWorkspace: false,
		});
		if (!linked) {
			// 受限环境里连 junction 都建不了：链接那半段跳过（纯函数那半段在 paths.test.ts 里）。
			return;
		}

		const verdict = judgeToolUse({
			tool: rootWrite,
			input: { path: join("link", "x.ts"), content: "x" },
			mode: "auto",
			planMode: "off",
			cwd: root,
		});
		expect(verdict.outsideWorkspace).toBe(true);
		expect(verdict.behavior).toBe("ask");
		// 新建（目标还不存在）时同样看得出来：`<root>/link/a.txt`。
		const linkedEdit = judgeToolUse({
			tool: rootEdit,
			input: { path: join("link", "a.txt"), edits: [{ oldText: "a", newText: "b" }] },
			mode: "auto",
			planMode: "off",
			cwd: root,
		});
		expect(linkedEdit.outsideWorkspace).toBe(true);
	});
});
