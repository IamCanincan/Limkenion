/**
 * 网页里的自定义斜杠命令：服务端的展开规则 + `GET /api/commands` + 一次完整的提交流程。
 *
 * 展开规则是纯函数（`expandSlashCommand`），不起服务器就能测；命令清单与「模型到底收到了什么」
 * 走真实的服务端，模型调用用假的 `fetch` 顶着——与 web-server.test.ts 同一套路，不碰真实接口。
 *
 * 命令目录用 `LIMKENION_CODING_AGENT_DIR` 指到临时目录：网页与命令行读的是同一处
 * （getAgentDir() + /commands），测试里没有第二条注入路径，也就不会验出一个只在测试里成立的目录。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_DIR_ENV, SESSION_DIR_ENV } from "../src/config.ts";
import { Session } from "../src/session.ts";
import { expandSlashCommand } from "../src/web/runs.ts";
import { startWebServer, type WebServerHandle } from "../src/web/server.ts";

/** 命令目录：<临时配置目录>/commands */
let commandsDir = "";
/** 会话根目录：单独指一处，免得写进真实的会话目录 */
let sessionRoot = "";
let cwd = "";
let agentDir = "";
let server: WebServerHandle | null = null;
const originalAgentDir = process.env[AGENT_DIR_ENV];
const originalSessionDir = process.env[SESSION_DIR_ENV];

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "limkenion-cmd-agent-"));
	commandsDir = join(agentDir, "commands");
	sessionRoot = await mkdtemp(join(tmpdir(), "limkenion-cmd-sessions-"));
	cwd = await mkdtemp(join(tmpdir(), "limkenion-cmd-cwd-"));
	process.env[AGENT_DIR_ENV] = agentDir;
	process.env[SESSION_DIR_ENV] = sessionRoot;
});

afterEach(async () => {
	await server?.close();
	server = null;
	// 环境变量是进程级的：不还原的话，同一个 worker 里后面的测试会连着用这个临时目录。
	if (originalAgentDir === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = originalAgentDir;
	}
	if (originalSessionDir === undefined) {
		delete process.env[SESSION_DIR_ENV];
	} else {
		process.env[SESSION_DIR_ENV] = originalSessionDir;
	}
	await rm(agentDir, { recursive: true, force: true });
	await rm(sessionRoot, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

/** 往命令目录里放一个命令文件 */
async function put(name: string, body: string): Promise<void> {
	await mkdir(commandsDir, { recursive: true });
	await writeFile(join(commandsDir, name), body, "utf-8");
}

/** 把字符串包成 SSE 字节流 */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		},
	});
}

/** 一次就答完的假模型；把每次请求体记下来，供断言「模型收到了什么」 */
function recordingFetch(): { fetchImpl: typeof fetch; bodies: string[] } {
	const bodies: string[] = [];
	const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		bodies.push(typeof init?.body === "string" ? init.body : "");
		return new Response(
			sseStream([
				`data: ${JSON.stringify({ choices: [{ delta: { content: "收到" } }] })}\n\n`,
				`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
				"data: [DONE]\n\n",
			]),
		);
	}) as unknown as typeof fetch;
	return { fetchImpl, bodies };
}

/** 启动服务器；与 web-server.test.ts 一样固定一把假密钥 */
async function start(fetchImpl?: typeof fetch): Promise<WebServerHandle> {
	server = await startWebServer({
		cwd,
		resolveApiKey: () => "test-key",
		modelId: "deepseek-flash",
		host: "127.0.0.1",
		port: 0,
		fetchImpl,
	});
	return server;
}

/** 等一个条件成立 */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
	throw new Error("等待超时");
}

/** 发一条指令；不 await 生成结束，返回 202 的响应 */
function submit(handle: WebServerHandle, id: string, text: string): Promise<Response> {
	return fetch(`${handle.url}/api/sessions/${id}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
}

/** 取假 fetch 收到的第一次请求里那条用户消息 */
function userMessage(bodies: string[]): string {
	const sent = JSON.parse(bodies[0] ?? "{}") as { messages: { role: string; content: string }[] };
	return sent.messages.find((message) => message.role === "user")?.content ?? "";
}

describe("斜杠命令展开", () => {
	it("已知命令展开成带 [自定义命令 /名字] 包装的提示词，参数替换进 $ARGUMENTS", async () => {
		await put("commit.md", "---\ndescription: 按规范写一条提交\n---\n先看 diff，然后写提交信息：$ARGUMENTS");
		expect(expandSlashCommand("/commit 顺手改个错字", commandsDir)).toBe(
			"[自定义命令 /commit]\n\n先看 diff，然后写提交信息：顺手改个错字",
		);
	});

	it("正文里没有 $ARGUMENTS 时，参数按命令行那套附在末尾", async () => {
		await put("note.md", "把这次改动记下来。");
		expect(expandSlashCommand("/note 只记要点", commandsDir)).toBe(
			"[自定义命令 /note]\n\n把这次改动记下来。\n\n参数：只记要点",
		);
		// 没带参数时与正文一字不差，不会多出一行空的「参数：」。
		expect(expandSlashCommand("/note", commandsDir)).toBe("[自定义命令 /note]\n\n把这次改动记下来。");
	});

	it("路径与未知命令原样放过，交给模型", () => {
		// /etc/hosts 这类问题本来就该问得出口：不能当成命令，也不该报错。
		expect(expandSlashCommand("/etc/hosts 是什么", commandsDir)).toBe("/etc/hosts 是什么");
		expect(expandSlashCommand("/nope 帮我看看", commandsDir)).toBe("/nope 帮我看看");
		// 不以斜杠开头的普通文本一律不动。
		expect(expandSlashCommand("看看 /etc/hosts", commandsDir)).toBe("看看 /etc/hosts");
		// 目录不存在（还没建过命令）时同样原样返回。
		expect(expandSlashCommand("/commit 改错字", join(commandsDir, "不存在"))).toBe("/commit 改错字");
	});
});

describe("网页命令清单与提交", () => {
	it("GET /api/commands 列出命令目录里的命令，含参数提示；正文不出端点", async () => {
		await put("commit.md", "---\ndescription: 按规范写一条提交\nargument-hint: [范围]\n---\n写提交信息");
		await put("zeta.md", "# 最后一条\n正文");
		await put("empty.md", "   \n");

		const handle = await start();
		const response = await fetch(`${handle.url}/api/commands`);
		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			commands: { name: string; description: string; argumentHint?: string }[];
		};
		// 按名称排序；剥掉元数据后没正文的空文件不算命令；提示词正文与文件路径不发给浏览器。
		expect(data.commands).toEqual([
			{ name: "commit", description: "按规范写一条提交", argumentHint: "[范围]" },
			{ name: "zeta", description: "最后一条" },
		]);
		expect(JSON.stringify(data)).not.toContain("写提交信息");

		// 清单是只读的：别的动作要明确说不行，而不是静默 404。
		const posted = await fetch(`${handle.url}/api/commands`, { method: "POST" });
		expect(posted.status).toBe(405);
	});

	it("提交 /commit …，模型收到的是展开后的提示词，会话文件里也是同一条", async () => {
		await put("commit.md", "---\ndescription: 按规范写一条提交\n---\n先看 diff，然后写提交信息：$ARGUMENTS");
		const { fetchImpl, bodies } = recordingFetch();
		const handle = await start(fetchImpl);
		const created = await fetch(`${handle.url}/api/sessions`, { method: "POST" });
		const { id } = (await created.json()) as { id: string };

		const accepted = await submit(handle, id, "/commit 顺手改个错字");
		expect(accepted.status).toBe(202);
		await waitFor(() => bodies.length > 0);

		// 模型端看到的是展开后的用户消息：包装 + 替换过的参数，原来那行 `/commit …` 不再出现。
		expect(userMessage(bodies)).toBe("[自定义命令 /commit]\n\n先看 diff，然后写提交信息：顺手改个错字");
		expect(bodies[0]).not.toContain("/commit 顺手改个错字");

		// 落盘的会话文件里同样是展开后的那条：界面刷新出来的历史与命令行一致。
		await waitFor(() =>
			(Session.list(cwd).at(0)?.load() ?? []).some(
				(message) => message.role === "user" && message.content.includes("[自定义命令 /commit]"),
			),
		);
	});

	it("未知的 /nope 原样发给模型，不会被当成命令吃掉", async () => {
		const { fetchImpl, bodies } = recordingFetch();
		const handle = await start(fetchImpl);
		const created = await fetch(`${handle.url}/api/sessions`, { method: "POST" });
		const { id } = (await created.json()) as { id: string };

		await submit(handle, id, "/nope 帮我看看");
		await waitFor(() => bodies.length > 0);
		expect(userMessage(bodies)).toBe("/nope 帮我看看");
	});
});
