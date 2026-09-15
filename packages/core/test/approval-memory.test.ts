/** 「本会话总是允许」的记忆：前缀建议、匹配规则，以及它在审批里的接线。 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type GuardContext, guardToolUse, judgeToolUse } from "../src/permissions/chain.ts";
import type { ApprovalRequest } from "../src/permissions/decision.ts";
import { ApprovalMemory, describeApprovalPrefix, suggestApprovalPrefix } from "../src/permissions/memory.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { createReadTool } from "../src/tools/read.ts";
import { createWriteTool } from "../src/tools/write.ts";

const root = mkdtempSync(join(tmpdir(), "limkenion-approval-memory-"));
mkdirSync(join(root, "src"), { recursive: true });
/** 真的在工作目录之外：用来验证「链接指到外面」这一类每次都要问 */
const outsideRoot = mkdtempSync(join(tmpdir(), "limkenion-approval-outside-"));
writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outsideRoot, { recursive: true, force: true });
});

// 判定链读工具自陈，所以测试里的调用要带真实工具。
const bash = createBashTool({ cwd: root });
const write = createWriteTool({ cwd: root });
const read = createReadTool({ cwd: root });

/** bash 的前缀建议 */
function bashPrefix(command: string): string | null {
	return suggestApprovalPrefix("bash", { command }, root);
}

describe("前缀建议", () => {
	it("取「命令 + 第一个操作数」", () => {
		expect(bashPrefix("npm test")).toBe("npm test");
		expect(bashPrefix("git status")).toBe("git status");
		expect(bashPrefix("ls -la src")).toBe("ls src");
		// 泛动词后面那个词才是真正要跑的东西
		expect(bashPrefix("npm run build")).toBe("npm run build");
		expect(bashPrefix("npm run build --silent")).toBe("npm run build");
		// 解释器要看到具体脚本才给建议
		expect(bashPrefix("node scripts/build.mjs")).toBe("node scripts/build.mjs");
	});

	it("不可逆动词、壳与包装器一律不给建议", () => {
		for (const command of [
			"rm -rf build",
			"rm build.txt",
			"mv a b",
			"chmod 777 a",
			"dd if=a of=b",
			"sudo npm test",
			"env FOO=1 npm test",
			"xargs rm",
			"bash -lc 'npm test'",
			"sh -c 'npm test'",
			"cmd /c dir",
			"powershell -Command ls",
			"mkfs.ext4 /dev/sda",
			"node -e 'console.log(1)'",
			"node .",
			"python -c 'print(1)'",
			"npm",
		]) {
			expect(bashPrefix(command), command).toBeNull();
		}
	});

	it("带元字符的命令不给建议：那是好几条命令，不是一个前缀", () => {
		for (const command of [
			"npm test && rm -rf /",
			"npm test; rm x",
			"npm test | tee out.txt",
			"npm test > out.txt",
			"echo $(date)",
			"echo `date`",
			"npm test &",
			"tar -xf *.tar",
			"cd ~/x",
		]) {
			expect(bashPrefix(command), command).toBeNull();
		}
	});

	it("write / edit 记所在目录；越界与空路径不给建议", () => {
		expect(suggestApprovalPrefix("write", { path: "src/a.ts" }, root)).toBe("src");
		expect(suggestApprovalPrefix("edit", { path: join("src", "deep", "b.ts") }, root)).toBe("src/deep");
		// 直接放在工作目录下的文件：根目录
		expect(suggestApprovalPrefix("write", { path: "a.ts" }, root)).toBe("");
		// 越界：不给建议（那类调用本来就该每次单独判断）
		expect(suggestApprovalPrefix("write", { path: join("..", "escape.ts") }, root)).toBeNull();
		expect(suggestApprovalPrefix("write", { path: "" }, root)).toBeNull();
		// 其它工具没有可记的前缀
		expect(suggestApprovalPrefix("read", { path: "src/a.ts" }, root)).toBeNull();
	});

	it("前缀的说明写清了它到底放行什么", () => {
		expect(describeApprovalPrefix("bash", "npm test")).toBe("执行以「npm test」开头的单条命令");
		expect(describeApprovalPrefix("write", "src")).toBe("写入 src/ 及其子目录");
		expect(describeApprovalPrefix("write", "")).toBe("写入工作目录内任何位置");
	});
});

describe("放行记忆", () => {
	it("记下的前缀覆盖同一类调用，但不覆盖别的工具与别的命令", () => {
		const memory = new ApprovalMemory();
		memory.remember({ tool: "bash", prefix: "npm test" });
		expect(memory.matches("bash", { command: "npm test" }, root)).toBe(true);
		expect(memory.matches("bash", { command: "npm test -- --watch" }, root)).toBe(true);
		// 词前缀不等于字符串前缀
		expect(memory.matches("bash", { command: "npm testing" }, root)).toBe(false);
		expect(memory.matches("bash", { command: "npm run build" }, root)).toBe(false);
		expect(memory.matches("write", { path: "src/a.ts" }, root)).toBe(false);
	});

	it("目录规则覆盖子目录；根规则覆盖工作目录内任何位置", () => {
		const memory = new ApprovalMemory();
		memory.remember({ tool: "write", prefix: "src" });
		expect(memory.matches("write", { path: "src/a.ts" }, root)).toBe(true);
		expect(memory.matches("write", { path: join("src", "deep", "b.ts") }, root)).toBe(true);
		expect(memory.matches("write", { path: join("src2", "b.ts") }, root)).toBe(false);
		expect(memory.matches("write", { path: "other/b.ts" }, root)).toBe(false);

		const atRoot = new ApprovalMemory();
		atRoot.remember({ tool: "write", prefix: "" });
		expect(atRoot.matches("write", { path: "a.ts" }, root)).toBe(true);
		expect(atRoot.matches("write", { path: "src/a.ts" }, root)).toBe(true);
	});

	it("越界与危险命令永远不会被记忆放行", () => {
		const memory = new ApprovalMemory();
		// 用户甚至点过「总是允许」，但内核压根给不出前缀，也就无从记起
		memory.remember({ tool: "write", prefix: "" });
		expect(memory.matches("write", { path: join("..", "escape.ts") }, root)).toBe(false);
		memory.remember({ tool: "bash", prefix: "rm -rf" });
		expect(memory.matches("bash", { command: "rm -rf /" }, root)).toBe(false);
		// 带元字符的命令同样不参与匹配：不能被「npm test」这条规则顺手带过去
		memory.remember({ tool: "bash", prefix: "npm test" });
		expect(memory.matches("bash", { command: "npm test && rm x" }, root)).toBe(false);
	});

	it("重复记同一条不会叠加；list 给的是副本；clear 之后全部忘掉", () => {
		const memory = new ApprovalMemory();
		memory.remember({ tool: "bash", prefix: "npm test" });
		memory.remember({ tool: "bash", prefix: "npm test" });
		expect(memory.size).toBe(1);
		const listed = memory.list();
		listed.push({ tool: "bash", prefix: "假的" });
		expect(memory.size).toBe(1);
		memory.clear();
		expect(memory.size).toBe(0);
		expect(memory.matches("bash", { command: "npm test" }, root)).toBe(false);
	});
});

describe("审批里的接线", () => {
	/** 造一个审批上下文：记录问了什么、答什么，并记下发出的两类事件 */
	function context(options: {
		memory?: ApprovalMemory;
		answer?: boolean | { approved: boolean; remember?: boolean };
	}) {
		const asked: ApprovalRequest[] = [];
		const events: { type: string; tool: string; approved?: boolean }[] = [];
		const guard: GuardContext = {
			approval: "ask",
			cwd: root,
			planMode: "off",
			emit: (event) => events.push({ type: event.type, tool: event.tool }),
			// 新增的一道事件：宿主靠它把确认卡片收掉（从前只 emit 一发「要确认」，没有「答完了」）。
			emitResult: (event) => events.push({ type: event.type, tool: event.tool, approved: event.approved }),
			onApproval: async (request) => {
				asked.push(request);
				return options.answer ?? true;
			},
		};
		if (options.memory) {
			guard.memory = options.memory;
		}
		return { guard, asked, events };
	}

	it("ask 档平时照问；answered「总是允许」之后，同一类调用不再问", async () => {
		const memory = new ApprovalMemory();
		const first = context({ memory, answer: { approved: true, remember: true } });
		expect(await guardToolUse(first.guard, bash, { command: "npm test" }, new AbortController().signal)).toBeNull();
		expect(first.asked).toHaveLength(1);
		expect(first.asked[0]?.suggestedPrefix).toBe("npm test");
		expect(memory.list()).toEqual([{ tool: "bash", prefix: "npm test" }]);
		// 问之前发 approval，答完发 approval_result（界面按后一条把卡片收掉）
		expect(first.events).toEqual([
			{ type: "approval", tool: "bash" },
			{ type: "approval_result", tool: "bash", approved: true },
		]);

		const second = context({ memory });
		expect(
			await guardToolUse(second.guard, bash, { command: "npm test -- --watch" }, new AbortController().signal),
		).toBeNull();
		expect(second.asked).toHaveLength(0);
		// 另一条命令照旧要问
		expect(
			await guardToolUse(second.guard, bash, { command: "npm run build" }, new AbortController().signal),
		).toBeNull();
		expect(second.asked).toHaveLength(1);
	});

	it("只答「允许」不会记下任何东西", async () => {
		const memory = new ApprovalMemory();
		const { guard, asked } = context({ memory, answer: true });
		await guardToolUse(guard, bash, { command: "npm test" }, new AbortController().signal);
		await guardToolUse(guard, bash, { command: "npm test" }, new AbortController().signal);
		expect(asked).toHaveLength(2);
		expect(memory.size).toBe(0);
	});

	it("危险命令即使被「总是允许」过一次，下次仍然要问（内核不给前缀）", async () => {
		const memory = new ApprovalMemory();
		const first = context({ memory, answer: { approved: true, remember: true } });
		await guardToolUse(first.guard, bash, { command: "rm -rf /" }, new AbortController().signal);
		expect(first.asked[0]?.suggestedPrefix).toBeUndefined();
		expect(memory.size).toBe(0);

		const second = context({ memory, answer: false });
		const blocked = await guardToolUse(second.guard, bash, { command: "rm -rf /" }, new AbortController().signal);
		expect(second.asked).toHaveLength(1);
		expect(blocked?.isError).toBe(true);
		// 被拒也要发 approval_result：卡片不能一直挂在界面上等一个不会来的答复。
		expect(second.events).toEqual([
			{ type: "approval", tool: "bash" },
			{ type: "approval_result", tool: "bash", approved: false },
		]);
	});

	it("越界写入同样每次都要问", async () => {
		const memory = new ApprovalMemory();
		const first = context({ memory, answer: { approved: true, remember: true } });
		await guardToolUse(
			first.guard,
			write,
			{ path: join("..", "escape.ts"), content: "x" },
			new AbortController().signal,
		);
		expect(first.asked[0]?.suggestedPrefix).toBeUndefined();
		expect(memory.size).toBe(0);
	});

	it("需要确认却没有确认入口时按拒绝处理，记忆为空不会误放行", async () => {
		const guard: GuardContext = {
			approval: "ask",
			cwd: root,
			planMode: "off",
			emit: () => {},
			emitResult: () => {},
			onApproval: undefined,
		};
		const result = await guardToolUse(guard, bash, { command: "npm test" }, new AbortController().signal);
		expect(result?.isError).toBe(true);
		expect(result?.content).toContain("没有确认入口");
	});
});

describe("判定给得出原因分类", () => {
	it("只有「档位要求确认」这一类可以被记忆放宽", () => {
		// `cause` 的那些字符串分类换成了可判别联合 `reason`：只有 `{ type: "mode" }` 能被记住。
		expect(
			judgeToolUse({ tool: bash, input: { command: "npm test" }, mode: "ask", planMode: "off", cwd: root }).reason,
		).toEqual({
			type: "mode",
			mode: "ask",
		});
		expect(
			judgeToolUse({ tool: bash, input: { command: "rm -rf /" }, mode: "auto", planMode: "off", cwd: root }).reason,
		).toEqual({ type: "dangerous", command: "rm -rf /" });
		expect(
			judgeToolUse({
				tool: write,
				input: { path: join("..", "x.ts"), content: "x" },
				mode: "auto",
				planMode: "off",
				cwd: root,
			}).reason,
		).toEqual({ type: "outside", path: join("..", "x.ts") });
		expect(
			judgeToolUse({ tool: write, input: { path: "a.ts", content: "" }, mode: "auto", planMode: "off", cwd: root })
				.reason,
		).toEqual({ type: "empty-patch" });
		expect(
			judgeToolUse({
				tool: write,
				input: { path: "a.ts", content: "x" },
				mode: "readonly",
				planMode: "off",
				cwd: root,
			}).reason,
		).toEqual({ type: "mode", mode: "readonly" });
		expect(
			judgeToolUse({ tool: read, input: { path: "a.ts" }, mode: "auto", planMode: "off", cwd: root }).reason,
		).toEqual({ type: "read-only" });
		// 原来这里是 `cause: "none"`：新分类里没有「无原因」，放行时照实说是哪一档在放行。
		expect(
			judgeToolUse({ tool: write, input: { path: "a.ts", content: "x" }, mode: "auto", planMode: "off", cwd: root })
				.reason,
		).toEqual({ type: "mode", mode: "auto" });
	});

	it("链接指向目录外时照样是「每次都要问」那一类", () => {
		try {
			symlinkSync(outsideRoot, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
		} catch {
			return;
		}
		// 前缀建议本身只看字符串，看不出链接——但它在这里根本用不上：判定把这条调用归到 outside，
		// 而记忆只在 reason 为 mode 时才被查询（见 guardToolUse 的顺序）。
		expect(
			judgeToolUse({
				tool: write,
				input: { path: join("link", "x.ts"), content: "x" },
				mode: "ask",
				planMode: "off",
				cwd: root,
			}).reason,
		).toEqual({ type: "outside", path: join("link", "x.ts") });
	});
});
