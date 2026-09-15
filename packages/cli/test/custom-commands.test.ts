/** 自定义斜杠命令的单元测试：发现、解析与参数展开。全部在临时目录里操作。 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCommandPrompt,
	describeCommand,
	describeCustomCommands,
	expandCommand,
	findCustomCommand,
	isValidCommandName,
	listCustomCommands,
} from "../src/custom-commands.ts";

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "limkenion-commands-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 写一个命令文件 */
async function put(name: string, body: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, name), body, "utf-8");
}

describe("命令名校验", () => {
	it("只接受小写字母、数字、短横线与下划线", () => {
		expect(isValidCommandName("commit")).toBe(true);
		expect(isValidCommandName("code-review_2")).toBe(true);
		expect(isValidCommandName("Commit")).toBe(false);
		expect(isValidCommandName("my command")).toBe(false);
		expect(isValidCommandName("-lead")).toBe(false);
		expect(isValidCommandName("")).toBe(false);
	});
});

describe("发现命令", () => {
	it("文件名即命令名，描述取首个非空行的正文", async () => {
		await put("commit.md", "# 按规范写一条提交\n\n先看 diff，再写信息。");
		const list = listCustomCommands(dir);
		expect(list).toHaveLength(1);
		expect(list[0]?.name).toBe("commit");
		expect(list[0]?.description).toBe("按规范写一条提交");
		expect(list[0]?.body).toContain("先看 diff");
	});

	it("跳过不合规的文件名、非 .md 与空文件", async () => {
		await put("Commit.md", "# 大写不算");
		await put("has space.md", "# 空格不算");
		await put("notes.txt", "不是 Markdown");
		await put("empty.md", "   \n\n");
		await put("ok.md", "# 正常");
		expect(listCustomCommands(dir).map((command) => command.name)).toEqual(["ok"]);
	});

	it("按名称排序，目录不存在时返回空数组", async () => {
		await put("zeta.md", "# z");
		await put("alpha.md", "# a");
		expect(listCustomCommands(dir).map((command) => command.name)).toEqual(["alpha", "zeta"]);
		expect(listCustomCommands(join(dir, "不存在"))).toEqual([]);
	});
});

describe("参数展开", () => {
	it("替换 $ARGUMENTS", () => {
		expect(expandCommand("问候：$ARGUMENTS", "世界")).toBe("问候：世界");
		expect(expandCommand("$ARGUMENTS 与 $ARGUMENTS", "x")).toBe("x 与 x");
		expect(expandCommand("占位符留空：$ARGUMENTS", "   ")).toBe("占位符留空：");
	});

	it("正文没有占位符时，把参数附在末尾；没有参数则原样", () => {
		expect(expandCommand("看看 diff", "只改前端")).toBe("看看 diff\n\n参数：只改前端");
		expect(expandCommand("看看 diff", "")).toBe("看看 diff");
	});

	it("拼给模型的提示词带命令名前缀", async () => {
		await put("greet.md", "打个招呼：$ARGUMENTS");
		const command = listCustomCommands(dir)[0];
		expect(command).toBeDefined();
		const prompt = buildCommandPrompt(command!, "你好");
		expect(prompt.startsWith("[自定义命令 /greet]")).toBe(true);
		expect(prompt).toContain("打个招呼：你好");
	});
});

describe("元数据（frontmatter）", () => {
	it("解析 description 与 argument-hint，并把整块元数据从正文里剥掉", async () => {
		await put(
			"review.md",
			"---\ndescription: 审查代码\nargument-hint: [范围]\nwhen-to-use: 需要挑毛病时\n---\n先看 diff，再给结论。",
		);
		const list = listCustomCommands(dir);
		expect(list).toHaveLength(1);
		expect(list[0]?.name).toBe("review");
		expect(list[0]?.description).toBe("审查代码");
		expect(list[0]?.argumentHint).toBe("[范围]");
		expect(list[0]?.whenToUse).toBe("需要挑毛病时");
		expect(list[0]?.body).toBe("先看 diff，再给结论。");
		expect(list[0]?.body.includes("---")).toBe(false);
		expect(list[0]?.body.includes("description:")).toBe(false);
		expect(list[0]?.warning).toBeUndefined();
	});

	it("没有元数据时与以前一样：描述取正文首个非空行", async () => {
		await put("commit.md", "# 按规范写一条提交\n\n先看 diff，再写信息。");
		const command = listCustomCommands(dir)[0];
		expect(command?.description).toBe("按规范写一条提交");
		expect(command?.body).toBe("# 按规范写一条提交\n\n先看 diff，再写信息。");
		expect(command?.argumentHint).toBeUndefined();
		expect(command?.whenToUse).toBeUndefined();
		expect(command?.warning).toBeUndefined();
	});

	it("值可以带引号，键名不区分大小写与 -/_", async () => {
		await put("quoted.md", "---\ndescription: \"带双引号的说明\"\nargument_hint: '[文件]'\n---\n正文");
		await put("spelled.md", "---\nDescription: 大写键\nArgumentHint: <路径>\nWHEN_TO_USE: 备用\n---\n正文");
		const list = listCustomCommands(dir);
		expect(list.map((command) => command.name)).toEqual(["quoted", "spelled"]);
		expect(list[0]?.description).toBe("带双引号的说明");
		expect(list[0]?.argumentHint).toBe("[文件]");
		expect(list[0]?.body).toBe("正文");
		expect(list[1]?.description).toBe("大写键");
		expect(list[1]?.argumentHint).toBe("<路径>");
		expect(list[1]?.whenToUse).toBe("备用");
	});

	it("块内的未知键、注释与空行都忽略", async () => {
		await put("noisy.md", "---\n# 这是注释\n\ndescription: 说明\nmodel: gpt\nallowed-tools: Read\n---\n正文第一行");
		const command = listCustomCommands(dir)[0];
		expect(command?.description).toBe("说明");
		expect(command?.body).toBe("正文第一行");
		expect(command?.warning).toBeUndefined();
	});

	it("块没闭合：命令照常注册，正文仍可用，另记一条提示", async () => {
		await put("unclosed.md", "---\ndescription: 漏了结尾\n这一步仍然要发给模型。");
		const command = listCustomCommands(dir)[0];
		expect(command?.name).toBe("unclosed");
		expect(command?.description).toBe("漏了结尾");
		expect(command?.body).toBe("这一步仍然要发给模型。");
		expect(command?.warning).toBe("元数据块缺少结尾的 ---，只解析了开头认得出的几行");
	});

	it("已知键写空：记提示，其他键照旧生效，描述退回正文首行", async () => {
		await put("bare.md", "---\ndescription:\nargument_hint: [目标]\n---\n照常工作的正文");
		await put("quoted-empty.md", '---\ndescription: ""\n---\n正文首行');
		const list = listCustomCommands(dir);
		expect(list.map((command) => command.name)).toEqual(["bare", "quoted-empty"]);
		expect(list[0]?.description).toBe("照常工作的正文");
		expect(list[0]?.argumentHint).toBe("[目标]");
		expect(list[0]?.body).toBe("照常工作的正文");
		expect(list[0]?.warning).toBe("元数据 description 的值为空，已忽略");
		expect(list[1]?.description).toBe("正文首行");
		expect(list[1]?.warning).toBe("元数据 description 的值为空，已忽略");
	});

	it("剥掉元数据后 $ARGUMENTS 照常展开，没占位符时参数仍附在末尾", async () => {
		await put("greet.md", "---\ndescription: 打招呼\n---\n问候：$ARGUMENTS");
		await put("note.md", "---\ndescription: 记录\n---\n看看 diff");
		const list = listCustomCommands(dir);
		const greet = findCustomCommand(list, "greet");
		const note = findCustomCommand(list, "note");
		expect(greet?.body).toBe("问候：$ARGUMENTS");
		expect(expandCommand(greet!.body, "世界")).toBe("问候：世界");
		expect(expandCommand(greet!.body, "   ")).toBe("问候：");
		expect(expandCommand(note!.body, "只改前端")).toBe("看看 diff\n\n参数：只改前端");
		expect(expandCommand(note!.body, "")).toBe("看看 diff");
		expect(buildCommandPrompt(greet!, "你好")).toBe("[自定义命令 /greet]\n\n问候：你好");
	});
});

describe("/help 里的呈现", () => {
	it("没有命令时提示目录", () => {
		const text = describeCustomCommands([], "/tmp/commands");
		expect(text).toContain("/tmp/commands");
		expect(text).toContain("commit.md");
		expect(text).toContain("---");
	});

	it("有命令时逐条列出", async () => {
		await put("commit.md", "# 写提交");
		const text = describeCustomCommands(listCustomCommands(dir), dir);
		expect(text).toContain("/commit");
		expect(text).toContain("写提交");
	});

	it("argument-hint 跟在命令名后面，坏元数据多一行提示且不影响正常行", async () => {
		await put("review.md", "---\ndescription: 审查代码\nargument-hint: [范围]\n---\n正文");
		await put("plain.md", "# 普通说明\n正文");
		await put("broken.md", "---\ndescription: 坏掉的\n正文");
		const text = describeCustomCommands(listCustomCommands(dir), dir);
		const lines = text.trim().split("\n");
		expect(lines[0]).toBe(`自定义命令（${dir}）：`);
		expect(lines[1]).toBe("  /broken        坏掉的");
		expect(lines[2]).toBe("    提示：元数据块缺少结尾的 ---，只解析了开头认得出的几行");
		expect(lines[3]).toBe("  /plain         普通说明");
		expect(lines[4]).toBe("  /review [范围]   审查代码");
	});

	it("when-to-use 单独印一行，只对写了它的命令多印", async () => {
		await put("review.md", "---\ndescription: 审查代码\nwhen-to-use: 提交前想找人挑毛病时\n---\n正文");
		await put("plain.md", "# 普通说明\n正文");
		const lines = describeCustomCommands(listCustomCommands(dir), dir).trim().split("\n");
		expect(lines[1]).toBe("  /plain         普通说明");
		expect(lines[2]).toBe("  /review        审查代码");
		expect(lines[3]).toBe("    何时用：提交前想找人挑毛病时");
	});

	it("描述过长会截断，取不到正文时退回命令名", () => {
		expect(describeCommand(`# ${"长".repeat(80)}`, "x").length).toBeLessThanOrEqual(61);
		expect(describeCommand("", "fallback")).toBe("fallback");
	});

	it("按名字查找", async () => {
		await put("commit.md", "# 写提交");
		const list = listCustomCommands(dir);
		expect(findCustomCommand(list, "commit")?.name).toBe("commit");
		expect(findCustomCommand(list, "missing")).toBeNull();
	});
});
