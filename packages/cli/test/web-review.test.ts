/**
 * Web 代码评审接口：POST /api/review。
 *
 * 跑的是真实服务器、真实 git 仓库与真实 worktree 改动，只有模型调用换成假的：
 * 「有没有可评审的改动」这件事只能由 git 回答，用假 git 测等于把要验的那一环换成桩。
 * 临时目录里没有仓库级的用户配置，所以每次 commit 都显式带上作者信息，免得测试依赖
 * 跑测试那台机器的 git 配置（CI 上经常是空的）。
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_DIR_ENV } from "../src/config.ts";
import type { ReviewResponse } from "../src/web/feature-review.ts";
import type { ErrorResponse } from "../src/web/protocol.ts";
import { startWebServer, type WebServerHandle } from "../src/web/server.ts";

let sessionRoot = "";
let cwd = "";
let server: WebServerHandle | null = null;
const originalSessionDir = process.env[SESSION_DIR_ENV];

beforeEach(async () => {
	sessionRoot = await mkdtemp(join(tmpdir(), "limkenion-review-sessions-"));
	cwd = await mkdtemp(join(tmpdir(), "limkenion-review-repo-"));
	process.env[SESSION_DIR_ENV] = sessionRoot;
});

afterEach(async () => {
	await server?.close();
	server = null;
	if (originalSessionDir === undefined) {
		delete process.env[SESSION_DIR_ENV];
	} else {
		process.env[SESSION_DIR_ENV] = originalSessionDir;
	}
	await rm(sessionRoot, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

/** 在临时工作目录里执行一条 git 命令 */
function git(...args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{
				cwd,
				windowsHide: true,
				env: {
					...process.env,
					// 临时目录里没有用户配置，显式给一份身份，免得 commit 因为缺身份而失败
					GIT_AUTHOR_NAME: "测试",
					GIT_AUTHOR_EMAIL: "test@example.invalid",
					GIT_COMMITTER_NAME: "测试",
					GIT_COMMITTER_EMAIL: "test@example.invalid",
				},
			},
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

/** 建一个只有一个提交的仓库；入口文件随后由各测试自己改 */
async function initRepo(): Promise<void> {
	await git("init", "-q");
	await writeFile(join(cwd, "sum.ts"), "export function sum(a: number, b: number) {\n\treturn a + b;\n}\n", "utf-8");
	await git("add", "sum.ts");
	await git("commit", "-q", "-m", "先提交一个干净版本");
}

/** 把字符串包成 SSE 字节流；格式与服务端推送的一致 */
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

/** 一个只回一段正文的模型响应 */
function reply(content: string): Response {
	return new Response(
		sseStream([
			`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
			"data: [DONE]\n\n",
		]),
	);
}

/**
 * 假模型：汇总者那一次请求（提示词里有「汇总」）回一份带结论行的报告，其余回评审者的报告。
 *
 * 只按提示词分流，不按调用顺序：几个评审者是并行的，顺序本来就不该被断言。
 * 用 `_input` 而不是省略第一个形参：fetch 的签名里它是第一个参数，省略会让类型对不上。
 */
function fakeReviewer(): typeof fetch {
	return (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const body = typeof init?.body === "string" ? init.body : "";
		if (body.includes("汇总")) {
			return reply("汇总：核心逻辑缺少边界检查。\n\nVERDICT: block");
		}
		return reply(`评审意见：${body.includes("安全") ? "未发现越权写入。" : "sum 没有校验入参。"}`);
	}) as unknown as typeof fetch;
}

/**
 * 卡住第一次模型调用的假模型：用它造出「一轮评审正在进行中」这个时刻，好让第二个请求撞上 409。
 *
 * 卡的是**第一次**调用而不是全部：release 兑现之后其余调用照常返回，第一轮评审仍能正常跑完——
 * 这样 409 那条用例不必靠「把请求丢掉」来收场，服务端也就能按正常路径收尾。
 */
function gatedReviewer(): { fetch: typeof fetch; release: () => void } {
	const real = fakeReviewer();
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let first = true;
	const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		if (first) {
			first = false;
			await gate;
		}
		return real(input, init);
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, release };
}

/** 启动服务器；密钥固定一把，不走凭据文件 */
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

/** 发一轮评审请求 */
function review(handle: WebServerHandle, body: Record<string, unknown> = {}): Promise<Response> {
	return fetch(`${handle.url}/api/review`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/review", () => {
	it("有未提交的改动时返回报告、结论与改动文件", { timeout: 30_000 }, async () => {
		await initRepo();
		// 改一行不提交：这就是默认要比的东西（未提交的改动）
		await writeFile(
			join(cwd, "sum.ts"),
			"export function sum(a: number, b: number) {\n\treturn a - b;\n}\n",
			"utf-8",
		);
		const handle = await start(fakeReviewer());

		const response = await review(handle);
		expect(response.status).toBe(200);
		const data = (await response.json()) as ReviewResponse;
		expect(data.ok).toBe(true);
		expect(data.verdict).toBe("block");
		expect(data.report).toContain("VERDICT: block");
		expect(data.files).toEqual(["sum.ts"]);
		expect(data.failed).toEqual([]);
	});

	it("已有一轮评审在跑时第二个请求回 409", { timeout: 30_000 }, async () => {
		await initRepo();
		await writeFile(join(cwd, "sum.ts"), "export const sum = 0;\n", "utf-8");
		const gated = gatedReviewer();
		const handle = await start(gated.fetch);

		// 第一轮卡在第一次模型调用上（假 fetch 还没放行），拿到它「进行中」的那一刻
		const first = review(handle);
		const second = await review(handle);
		expect(second.status).toBe(409);
		const data = (await second.json()) as ErrorResponse;
		expect(data.error).toContain("已有一轮评审在跑");

		// 放行之后第一轮仍要正常跑完：409 只是「忙」，不是把先前那轮作废
		gated.release();
		const finished = await first;
		expect(finished.status).toBe(200);
		expect(((await finished.json()) as ReviewResponse).verdict).toBe("block");
	});

	it("没有可评审的改动时回 400，并说明原因", { timeout: 30_000 }, async () => {
		await initRepo();
		const handle = await start(fakeReviewer());

		const response = await review(handle);
		expect(response.status).toBe(400);
		const data = (await response.json()) as ErrorResponse;
		expect(data.error).toBe("没有可评审的改动（工作区相对基线是干净的）");
	});
});
