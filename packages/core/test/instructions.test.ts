/** 指令文件发现与注入的单元测试。 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "../src/agent.ts";
import { discoverInstructions, findGitRoot, isGitRepo } from "../src/instructions.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { defineTool } from "../src/tools/contract.ts";
import type { AgentTool } from "../src/types.ts";

let root = "";

/** 一个最小的 bash 桩工具：只看系统提示词里的工具清单，不真的执行 */
function bashStub(): AgentTool {
	return defineTool({
		name: "bash",
		description: "执行命令",
		parameters: {},
		execute: async () => ({ content: "", isError: false }),
	});
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "limkenion-instructions-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** 在仓库里建一个 .git 目录，作为向上查找的边界 */
async function makeRepo(name: string): Promise<string> {
	const dir = join(root, name);
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

/** 写一个指令文件 */
async function writeInstruction(dir: string, name: string, content: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	const file = join(dir, name);
	await writeFile(file, content, "utf-8");
	return file;
}

describe("discoverInstructions", () => {
	it("没有指令文件时返回空数组", async () => {
		const repo = await makeRepo("empty");
		expect(discoverInstructions({ cwd: repo })).toEqual([]);
	});

	it("读取仓库根的 AGENTS.md", async () => {
		const repo = await makeRepo("basic");
		const file = await writeInstruction(repo, "AGENTS.md", "使用制表符缩进");
		const found = discoverInstructions({ cwd: repo });
		expect(found).toHaveLength(1);
		expect(found[0]?.path).toBe(file);
		expect(found[0]?.content).toContain("使用制表符缩进");
	});

	it("子目录里的 AGENTS.md 与仓库根的一起注入，近的在前", async () => {
		const repo = await makeRepo("nested");
		const outer = await writeInstruction(repo, "AGENTS.md", "全局约定");
		const inner = await writeInstruction(join(repo, "packages", "a"), "AGENTS.md", "子包约定");
		const found = discoverInstructions({ cwd: join(repo, "packages", "a") });
		expect(found.map((f) => f.path)).toEqual([inner, outer]);
	});

	it("AGENTS.md 存在时不读同目录的 CONTEXT.md", async () => {
		const repo = await makeRepo("precedence");
		await writeInstruction(repo, "AGENTS.md", "首选");
		await writeInstruction(repo, "CONTEXT.md", "备选");
		const found = discoverInstructions({ cwd: repo });
		expect(found).toHaveLength(1);
		expect(found[0]?.content).toContain("首选");
	});

	it("没有 AGENTS.md 时退回 CONTEXT.md", async () => {
		const repo = await makeRepo("fallback");
		await writeInstruction(repo, "CONTEXT.md", "备选");
		const found = discoverInstructions({ cwd: repo });
		expect(found).toHaveLength(1);
		expect(found[0]?.content).toContain("备选");
	});

	it("根目录的 AGENTS.md 与子目录的 CONTEXT.md 都会注入（逐目录解析）", async () => {
		const repo = await makeRepo("per-dir-mixed");
		const outer = await writeInstruction(repo, "AGENTS.md", "仓库根约定");
		const inner = await writeInstruction(join(repo, "packages", "a"), "CONTEXT.md", "子目录备选");
		const found = discoverInstructions({ cwd: join(repo, "packages", "a") });
		expect(found.map((f) => f.path)).toEqual([inner, outer]);
	});

	it("AGENTS.override.md 顶掉同目录的 AGENTS.md，但不影响父目录", async () => {
		const repo = await makeRepo("override");
		const outer = await writeInstruction(repo, "AGENTS.md", "父目录约定");
		const sub = join(repo, "packages", "a");
		await writeInstruction(sub, "AGENTS.md", "子目录常规说明");
		const override = await writeInstruction(sub, "AGENTS.override.md", "子目录临时覆盖");
		const found = discoverInstructions({ cwd: sub });
		expect(found.map((f) => f.path)).toEqual([override, outer]);
		expect(found.map((f) => f.content)).toEqual(["子目录临时覆盖", "父目录约定"]);
	});

	it("不同目录各贡献不同文件名时，按由近到远给出精确路径顺序", async () => {
		const repo = await makeRepo("per-dir-names");
		const rootFile = await writeInstruction(repo, "CONTEXT.md", "根说明");
		const midFile = await writeInstruction(join(repo, "packages"), "AGENTS.md", "包说明");
		const nearFile = await writeInstruction(join(repo, "packages", "a"), "CONTEXT.md", "子包说明");
		const found = discoverInstructions({ cwd: join(repo, "packages", "a") });
		expect(found.map((f) => f.path)).toEqual([nearFile, midFile, rootFile]);
		expect(found.map((f) => f.content)).toEqual(["子包说明", "包说明", "根说明"]);
	});

	it("同一目录内按 override > AGENTS.md > CONTEXT.md 取第一个存在的", async () => {
		const all = await makeRepo("priority-all");
		await writeInstruction(all, "CONTEXT.md", "备选");
		await writeInstruction(all, "AGENTS.md", "次选");
		const override = await writeInstruction(all, "AGENTS.override.md", "首选");
		expect(discoverInstructions({ cwd: all }).map((f) => f.path)).toEqual([override]);

		const noOverride = await makeRepo("priority-no-override");
		await writeInstruction(noOverride, "CONTEXT.md", "备选");
		const agents = await writeInstruction(noOverride, "AGENTS.md", "次选");
		expect(discoverInstructions({ cwd: noOverride }).map((f) => f.path)).toEqual([agents]);

		const onlyContext = await makeRepo("priority-only-context");
		const context = await writeInstruction(onlyContext, "CONTEXT.md", "备选");
		expect(discoverInstructions({ cwd: onlyContext }).map((f) => f.path)).toEqual([context]);
	});

	it("不越过 git 仓库根", async () => {
		const outer = await makeRepo("outer");
		await writeInstruction(outer, "AGENTS.md", "外层仓库的说明");
		const inner = join(outer, "inner");
		await mkdir(join(inner, ".git"), { recursive: true });

		const found = discoverInstructions({ cwd: inner });
		expect(found).toEqual([]);
	});

	it("全局说明与项目说明一起注入，全局在前", async () => {
		const repo = await makeRepo("with-global");
		const project = await writeInstruction(repo, "AGENTS.md", "项目说明");
		const globalDir = join(root, "global-config");
		const global = await writeInstruction(globalDir, "AGENTS.md", "全局偏好");

		const found = discoverInstructions({ cwd: repo, globalConfigDir: globalDir });
		expect(found.map((f) => f.path)).toEqual([global, project]);
	});

	it("单文件超限时截断并加标记", async () => {
		const repo = await makeRepo("truncate");
		await writeInstruction(repo, "AGENTS.md", "甲".repeat(2000));
		const found = discoverInstructions({ cwd: repo, maxFileBytes: 100 });
		expect(found[0]?.content).toContain("已截断");
		expect(Buffer.byteLength(found[0]?.content ?? "", "utf-8")).toBeLessThan(200);
	});

	it("合计超限时停止追加后续文件", async () => {
		const repo = await makeRepo("total-cap");
		await writeInstruction(repo, "AGENTS.md", "a".repeat(500));
		await writeInstruction(join(repo, "sub"), "AGENTS.md", "b".repeat(500));
		const found = discoverInstructions({
			cwd: join(repo, "sub"),
			maxFileBytes: 1000,
			maxTotalBytes: 600,
		});
		expect(found).toHaveLength(1);
	});

	it("目录不能当指令文件读", async () => {
		const repo = await makeRepo("dir-name");
		await mkdir(join(repo, "AGENTS.md"), { recursive: true });
		expect(discoverInstructions({ cwd: repo })).toEqual([]);
	});
});

describe("findGitRoot / isGitRepo", () => {
	it("找到最近的 git 根", async () => {
		const repo = await makeRepo("git-root");
		const deep = join(repo, "a", "b", "c");
		await mkdir(deep, { recursive: true });
		expect(findGitRoot(deep)).toBe(repo);
		expect(isGitRepo(deep)).toBe(true);
	});

	it("非仓库返回 false", async () => {
		const plain = join(root, "plain");
		await mkdir(plain, { recursive: true });
		expect(isGitRepo(plain)).toBe(false);
	});
});

describe("buildSystemPrompt", () => {
	const tools: AgentTool[] = [bashStub()];

	it("包含环境信息，并列出工具名", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/x", tools, today: "2026-02-14" });
		expect(prompt).toContain("工作目录：/tmp/x");
		expect(prompt).toContain("今天：2026-02-14");
		expect(prompt).toContain("bash");
		// 工具**描述**不写进提示词：它已经作为接口的 tools[] 字段发过一次了，再抄一遍等于每次请求
		// 都把每个工具的 description 发两遍。这一段从前是 `- bash：执行命令`。
		expect(prompt).not.toContain("执行命令");
	});

	it("没有说明文件时不出现说明段落", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/x", tools, instructions: [] });
		expect(prompt).not.toContain("以下是本仓库自带的说明文件");
	});

	it("有说明文件时标出来源路径", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp/x",
			tools,
			instructions: [{ path: "/tmp/x/AGENTS.md", content: "用中文写提交信息" }],
		});
		expect(prompt).toContain("来自 /tmp/x/AGENTS.md");
		expect(prompt).toContain("用中文写提交信息");
	});
});

/** 把字符串包成 SSE 字节流 */
function sseStream(text: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const lines = [
		`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
		`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
		"data: [DONE]\n\n",
	];
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		},
	});
}

describe("Agent 注入指令", () => {
	const tools: AgentTool[] = [bashStub()];

	function makeAgent(cwd: string, instructions?: AgentOptions["instructions"]) {
		return new Agent({
			apiKey: "test",
			cwd,
			tools,
			instructions,
			fetchImpl: (async () => new Response(sseStream("好"))) as unknown as typeof fetch,
		});
	}

	/** 取系统提示词。Message 是联合类型，工具结果消息没有 content，需要先排除。 */
	function systemPrompt(agent: Agent): string {
		const first = agent.messages[0];
		return first && first.role !== "tool" ? first.content : "";
	}

	it("自动注入工作目录里的 AGENTS.md", async () => {
		const repo = await makeRepo("agent-auto");
		await writeInstruction(repo, "AGENTS.md", "本仓库用 pnpm");
		const agent = makeAgent(repo);
		expect(systemPrompt(agent)).toContain("本仓库用 pnpm");
	});

	it("显式传空数组时不注入", async () => {
		const repo = await makeRepo("agent-none");
		await writeInstruction(repo, "AGENTS.md", "不该出现");
		const agent = makeAgent(repo, []);
		expect(systemPrompt(agent)).not.toContain("不该出现");
	});

	it("下一轮看到修改后的 AGENTS.md", async () => {
		const repo = await makeRepo("agent-refresh");
		await writeInstruction(repo, "AGENTS.md", "第一版");
		const agent = makeAgent(repo);
		await agent.prompt("你好");
		expect(systemPrompt(agent)).toContain("第一版");

		await writeInstruction(repo, "AGENTS.md", "第二版");
		await agent.prompt("再来");
		expect(systemPrompt(agent)).toContain("第二版");
		expect(systemPrompt(agent)).not.toContain("第一版");
	});

	it("文件没变时不改动系统消息（保住前缀缓存）", async () => {
		const repo = await makeRepo("agent-stable");
		await writeInstruction(repo, "AGENTS.md", "稳定内容");
		const agent = makeAgent(repo);
		const before = systemPrompt(agent);
		await agent.prompt("你好");
		expect(systemPrompt(agent)).toBe(before);
	});

	it("自定义 systemPrompt 时不注入 AGENTS.md", async () => {
		const repo = await makeRepo("agent-custom");
		await writeInstruction(repo, "AGENTS.md", "不该出现");
		const agent = new Agent({
			apiKey: "test",
			cwd: repo,
			tools,
			systemPrompt: "只有这一句",
			fetchImpl: (async () => new Response(sseStream("好"))) as unknown as typeof fetch,
		});
		expect(systemPrompt(agent)).toBe("只有这一句");
	});
});
