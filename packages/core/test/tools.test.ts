/** 系统工具的单元测试。全部在临时目录里操作，不触碰仓库文件。 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPresentTools, PresentList } from "../src/present.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { defineTool } from "../src/tools/contract.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { truncateHead } from "../src/tools/path.ts";
import { createReadTool } from "../src/tools/read.ts";
import { createGlobTool, createGrepTool } from "../src/tools/search.ts";
import { createWriteTool } from "../src/tools/write.ts";

let cwd = "";

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "limkenion-tools-"));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

/** 工具执行用的取消信号，测试里从不触发 */
const signal = new AbortController().signal;

describe("bash 工具", () => {
	it("执行命令并返回输出", async () => {
		const tool = createBashTool({ cwd });
		const outcome = await tool.execute({ command: "echo hello" }, signal);
		expect(outcome.isError).toBe(false);
		expect(outcome.content).toContain("hello");
	});

	it("非零退出码标记为失败并带出退出码", async () => {
		const tool = createBashTool({ cwd });
		const outcome = await tool.execute({ command: "exit 3" }, signal);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).toContain("退出码 3");
	});

	it("缺少 command 时报错", () => {
		const tool = createBashTool({ cwd });
		// 参数缺失的判定搬到了契约的 `validate` 上（先于审批与执行跑，见 tool-pipeline.ts）。
		expect(tool.validate({})).toEqual({ ok: false, message: "缺少必填参数 command" });
		expect(tool.validate({ command: "   " })).toEqual({ ok: false, message: "缺少必填参数 command" });
		expect(tool.validate({ command: "echo hi" })).toEqual({ ok: true });
	});

	it("超时后终止命令", async () => {
		const tool = createBashTool({ cwd, timeoutMs: 500 });
		const command = process.platform === "win32" ? "ping -n 6 127.0.0.1" : "sleep 5";
		const outcome = await tool.execute({ command }, signal);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).toContain("已终止");
	});

	it("系统代码页的输出不会变成乱码", async () => {
		// Windows 的 cmd.exe 内建命令按控制台代码页（中文系统是 GBK）写错误信息。
		// 用一条不存在的命令触发它，断言输出里**没有替换字符**——这是跨语言环境都成立的不变量
		// （英文系统下这句话是英文，也不该有 U+FFFD）。POSIX 上本来就是 UTF-8，同样不该有。
		const tool = createBashTool({ cwd });
		const outcome = await tool.execute({ command: "cat package.json" }, signal);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).not.toContain("\uFFFD");
		expect(outcome.content).toContain("[stderr]");
	});
});

describe("write 与 read 工具", () => {
	it("write 自动创建父目录", async () => {
		const tool = createWriteTool({ cwd });
		const outcome = await tool.execute({ path: "a/b/c.txt", content: "第一行\n第二行" }, signal);
		expect(outcome.isError).toBe(false);
		expect(await readFile(join(cwd, "a/b/c.txt"), "utf-8")).toBe("第一行\n第二行");
	});

	it("read 返回文件内容", async () => {
		await writeFile(join(cwd, "x.txt"), "l1\nl2\nl3", "utf-8");
		const tool = createReadTool({ cwd });
		const outcome = await tool.execute({ path: "x.txt" }, signal);
		expect(outcome.content).toBe("l1\nl2\nl3");
	});

	it("read 支持 offset 与 limit", async () => {
		await writeFile(join(cwd, "x.txt"), "l1\nl2\nl3\nl4", "utf-8");
		const tool = createReadTool({ cwd });
		const outcome = await tool.execute({ path: "x.txt", offset: 2, limit: 2 }, signal);
		expect(outcome.content).toContain("l2\nl3");
		expect(outcome.content).toContain("offset=4");
	});

	it("read 对不存在的文件报错", async () => {
		const tool = createReadTool({ cwd });
		const outcome = await tool.execute({ path: "nope.txt" }, signal);
		expect(outcome.isError).toBe(true);
	});

	it("read 拒绝二进制文件", async () => {
		await writeFile(join(cwd, "bin"), Buffer.from([0x01, 0x00, 0x02]));
		const tool = createReadTool({ cwd });
		const outcome = await tool.execute({ path: "bin" }, signal);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).toContain("二进制");
	});

	it("read 对目录报错", async () => {
		const tool = createReadTool({ cwd });
		const outcome = await tool.execute({ path: "." }, signal);
		expect(outcome.isError).toBe(true);
	});

	/*
	 * 折叠行那一行摘要由工具自己说（界面上只显示 `summarize()`），所以「写入多少行」「改了几处」
	 * 这类体量信号归工具，不归前端——从前它们硬编码在网页的 render.js 里，加一个工具就要改一次那儿。
	 */
	it("write 的摘要带上路径与行数", () => {
		const tool = createWriteTool({ cwd });
		expect(tool.summarize({ path: "a.ts", content: "一\n二\n三" })).toBe("a.ts（3 行）");
		// 少一个字段也要给得出话来，不能抛
		expect(tool.summarize({ path: "a.ts" })).toBe("a.ts");
		expect(tool.summarize({ content: "一" })).toBe("1 行");
		expect(tool.summarize({})).toBe("");
	});

	it("edit 的摘要带上路径与处数", () => {
		const tool = createEditTool({ cwd });
		expect(tool.summarize({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] })).toBe("a.ts（1 处）");
		// 模型偶尔把 edits 发成 JSON 字符串，摘要要跟着内核那套归一化走
		expect(
			tool.summarize({
				path: "a.ts",
				edits: JSON.stringify([
					{ oldText: "a", newText: "b" },
					{ oldText: "c", newText: "d" },
				]),
			}),
		).toBe("a.ts（2 处）");
		expect(tool.summarize({ path: "a.ts", edits: [] })).toBe("a.ts");
		expect(tool.summarize({})).toBe("");
	});
});

/*
 * 确认卡片的正文由**工具自己**写（这个字段就是「给权限弹窗用的一句人话」）。从前这段按工具名住在网页前端，于是同一份「哪个字段最要紧」的知识
 * 在服务端与浏览器各有一份；`edit` 那处读的还是两个不存在的字段名，卡片上一直是一坨 JSON。
 */
describe("确认卡片的正文（describeApproval）", () => {
	it("bash 给命令原文，不做摘要那种截断", () => {
		const tool = createBashTool({ cwd });
		expect(tool.describeApproval({ command: "ls -la src" })).toBe("将要执行：\n$ ls -la src");
		// 长命令也要给全：用户是照着它自己核一遍的
		const long = `echo ${"x".repeat(300)}`;
		expect(tool.describeApproval({ command: long })).toContain(long);
		expect(tool.describeApproval({})).toBe("");
	});

	it("write 摊开要写入的内容，并说清还有多少行没显示", () => {
		const tool = createWriteTool({ cwd });
		const short = tool.describeApproval({ path: "a.ts", content: "一\n二\n三" });
		expect(short).toContain("将要写入：a.ts");
		expect(short).toContain("共 3 行");
		expect(short).toContain("三");

		const many = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 行`).join("\n");
		const long = tool.describeApproval({ path: "a.ts", content: many });
		expect(long).toContain("共 40 行");
		// 看不见的那部分至少要知道自己没看见
		expect(long).toContain("还有 28 行");
		expect(long).not.toContain("第 40 行");
	});

	it("edit 逐处列出原来与改成（这正是前端从前写成空的那一段）", () => {
		const tool = createEditTool({ cwd });
		const one = tool.describeApproval({
			path: "a.ts",
			edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
		});
		expect(one).toContain("将要修改：a.ts");
		expect(one).toContain("原来：\nconst a = 1;");
		expect(one).toContain("改成：\nconst a = 2;");

		const two = tool.describeApproval({
			path: "a.ts",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
		expect(two).toContain("第 1 处");
		expect(two).toContain("第 2 处");
	});

	it("bash 的「看起来不可逆」复用内核那条危险命令启发式", () => {
		const tool = createBashTool({ cwd });
		// 与审批链用的是同一份判断，不再让界面另抄一份正则清单
		expect(tool.isDestructive({ command: "rm -rf /" })).toBe(true);
		expect(tool.isDestructive({ command: "git reset --hard HEAD~1" })).toBe(true);
		expect(tool.isDestructive({ command: "ls -la" })).toBe(false);
		expect(tool.isDestructive({})).toBe(false);
	});

	it("没自陈正文的工具退回一行摘要，而不是空着", () => {
		const stub = defineTool({
			name: "stub",
			description: "桩",
			parameters: {},
			summarize: () => "一句话摘要",
			async execute() {
				return { content: "", isError: false };
			},
		});
		expect(stub.describeApproval({})).toBe("一句话摘要");
	});
});

/*
 * 「这次碰哪个文件」「这次交付了哪几件」「是不是整份替换」也归工具自己说：
 * 界面据此给预览入口、铺交付物卡片、补前后对比，都不必认任何字段名。
 */
describe("界面要用的信息（pathOf / deliverables / fileReplacement）", () => {
	it("write 自陈路径与整份替换的内容", () => {
		const tool = createWriteTool({ cwd });
		expect(tool.pathOf({ path: "src/a.ts" })).toBe("src/a.ts");
		expect(tool.pathOf({ path: "   " })).toBeNull();

		expect(tool.fileReplacement({ path: "src/a.ts", content: "一\n二" })).toEqual({
			path: "src/a.ts",
			content: "一\n二",
		});
		// 缺字段时不给对比：宁可那一节不出现，也不画一份错的
		expect(tool.fileReplacement({ path: "src/a.ts" })).toBeNull();
		expect(tool.fileReplacement({})).toBeNull();
	});

	it("present 自陈交付物清单；没声明这些的工具一律回落到空", () => {
		const present = createPresentTools(new PresentList())[0];
		expect(present.deliverables({ files: [{ path: "a.ts", note: "改好的" }] })).toEqual([
			{ path: "a.ts", note: "改好的" },
		]);
		// 清单为空是模型那边的用法错误（工具结果会告诉它），这里不该编出东西来
		expect(present.deliverables({ files: [] })).toEqual([]);

		const stub = defineTool({
			name: "stub",
			description: "桩",
			parameters: {},
			async execute() {
				return { content: "", isError: false };
			},
		});
		expect(stub.pathOf({ path: "a.ts" })).toBeNull();
		expect(stub.deliverables({ files: [{ path: "a.ts" }] })).toEqual([]);
		expect(stub.fileReplacement({ path: "a.ts", content: "x" })).toBeNull();
	});

	it("read 也自陈路径：只读的一行同样要有「预览文件」入口", () => {
		// 这一条是回归测试：把前端「有 path 就给预览入口」换成工具自陈之后，read 漏了声明，
		// 于是读文件那一行的预览入口整排消失（看截图才发现的）。
		const read = createReadTool({ cwd });
		expect(read.pathOf({ path: "src/a.ts" })).toBe("src/a.ts");
		expect(read.pathOf({})).toBeNull();

		// 搜索工具的 path 是**搜索起点**（一个目录），不是「要看的那个文件」，所以刻意不声明：
		// 从前界面会给它一个「预览文件」按钮，点开预览的是一个目录。
		expect(createGlobTool({ cwd }).pathOf({ pattern: "**/*.ts", path: "src" })).toBeNull();
		expect(createGrepTool({ cwd }).pathOf({ pattern: "TODO", path: "src" })).toBeNull();
	});

	it("自陈函数抛异常时回落到空，不把事件流带崩", () => {
		const bomb = defineTool({
			name: "bomb",
			description: "桩",
			parameters: {},
			deliverables: () => {
				throw new Error("炸了");
			},
			fileReplacement: () => {
				throw new Error("炸了");
			},
			async execute() {
				return { content: "", isError: false };
			},
		});
		expect(bomb.deliverables({})).toEqual([]);
		expect(bomb.fileReplacement({})).toBeNull();
	});
});

describe("edit 工具", () => {
	it("替换唯一匹配的文本", async () => {
		await writeFile(join(cwd, "e.txt"), "const a = 1;\nconst b = 2;\n", "utf-8");
		const tool = createEditTool({ cwd });
		const outcome = await tool.execute(
			{ path: "e.txt", edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }] },
			signal,
		);
		expect(outcome.isError).toBe(false);
		expect(await readFile(join(cwd, "e.txt"), "utf-8")).toBe("const a = 1;\nconst b = 3;\n");
	});

	it("一次调用完成多处互不重叠的替换", async () => {
		await writeFile(join(cwd, "e.txt"), "a\nb\nc\nd\n", "utf-8");
		const tool = createEditTool({ cwd });
		const outcome = await tool.execute(
			{
				path: "e.txt",
				edits: [
					{ oldText: "a", newText: "A" },
					{ oldText: "d", newText: "D" },
				],
			},
			signal,
		);
		expect(outcome.isError).toBe(false);
		expect(await readFile(join(cwd, "e.txt"), "utf-8")).toBe("A\nb\nc\nD\n");
	});

	it("匹配不唯一时拒绝修改，并列出出现的位置", async () => {
		await writeFile(join(cwd, "e.txt"), "same\nsame\n", "utf-8");
		const tool = createEditTool({ cwd });
		const outcome = await tool.execute({ path: "e.txt", edits: [{ oldText: "same", newText: "x" }] }, signal);
		expect(outcome.isError).toBe(true);
		// 报错直接给出出现次数与行号：模型据此补上下文，比整份重读便宜
		expect(outcome.content).toContain("出现 2 次");
		expect(outcome.content).toContain("第 1、2 行");
		expect(await readFile(join(cwd, "e.txt"), "utf-8")).toBe("same\nsame\n");
	});

	it("找不到原文时拒绝修改", async () => {
		await writeFile(join(cwd, "e.txt"), "abc", "utf-8");
		const tool = createEditTool({ cwd });
		const outcome = await tool.execute({ path: "e.txt", edits: [{ oldText: "zzz", newText: "x" }] }, signal);
		expect(outcome.isError).toBe(true);
	});

	it("拒绝重叠的替换", async () => {
		await writeFile(join(cwd, "e.txt"), "abcdef", "utf-8");
		const tool = createEditTool({ cwd });
		const outcome = await tool.execute(
			{
				path: "e.txt",
				edits: [
					{ oldText: "abc", newText: "X" },
					{ oldText: "bcd", newText: "Y" },
				],
			},
			signal,
		);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).toContain("重叠");
	});

	it("接受单个 oldText/newText 形式", async () => {
		await writeFile(join(cwd, "e.txt"), "old", "utf-8");
		const tool = createEditTool({ cwd });
		const outcome = await tool.execute({ path: "e.txt", oldText: "old", newText: "new" }, signal);
		expect(outcome.isError).toBe(false);
		expect(await readFile(join(cwd, "e.txt"), "utf-8")).toBe("new");
	});

	it("保留 CRLF 换行与 BOM", async () => {
		await writeFile(join(cwd, "e.txt"), "\uFEFFa\r\nb\r\n", "utf-8");
		const tool = createEditTool({ cwd });
		const outcome = await tool.execute({ path: "e.txt", edits: [{ oldText: "b", newText: "B" }] }, signal);
		expect(outcome.isError).toBe(false);
		expect(await readFile(join(cwd, "e.txt"), "utf-8")).toBe("\uFEFFa\r\nB\r\n");
	});
});

describe("truncateHead", () => {
	it("按行数截断", () => {
		const result = truncateHead("1\n2\n3\n4\n5", 3, 1024);
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("lines");
		expect(result.content).toBe("1\n2\n3");
		expect(result.totalLines).toBe(5);
	});

	it("按字节截断且不切断多字节字符", () => {
		const result = truncateHead("中文中文中文", 100, 7);
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.content).toBe("中文");
	});

	it("未超限时原样返回", () => {
		const result = truncateHead("abc", 10, 100);
		expect(result.truncated).toBe(false);
		expect(result.content).toBe("abc");
	});
});
