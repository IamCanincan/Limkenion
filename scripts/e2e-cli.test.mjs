/**
 * 端到端冒烟测试：假接口 + **构建后的真 CLI**。
 *
 * 为什么单测不够：这个仓库里踩过的坑有几类只有「真跑一次」才暴露——非交互终端下的审批、
 * 退出码、AGENTS.md 的逐目录解析、流被掐断。单测把 `streamChat` 与 `judgeToolUse` 都覆盖了，
 * 但「它们接起来是不是这样」没人验。这里用最小的假 OpenAI 兼容接口把整条链路跑一遍。
 *
 * 需要先构建（CI 的顺序是 build → check → test，所以那边一定有）：
 *   没找到 packages/cli/dist/cli.js 时整组跳过，并写明原因，而不是报一个看不懂的失败。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "packages/cli/dist/cli.js");
// 注意：node:test 的 skip 只认布尔或字符串，**字符串为真值就等于永远跳过**——这里必须是 false 才跑。
const skipReason = existsSync(cliPath)
	? false
	: "未找到 packages/cli/dist/cli.js：先跑 npm run build（CI 里 build 在 test 之前）";

/** SSE 行 */
function sse(...payloads) {
	return [...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`), "data: [DONE]\n\n"].join("");
}

/** 起一个假的 /chat/completions；handler 收到 (请求体, 调用序号, 响应) */
function startStub(handler) {
	const calls = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			let parsed = { messages: [] };
			try {
				parsed = JSON.parse(body);
			} catch {}
			calls.push(parsed);
			response.writeHead(200, { "content-type": "text/event-stream" });
			handler(parsed, calls.length, response);
		});
	});
	return new Promise((resolvePromise) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolvePromise({
				url: `http://127.0.0.1:${address.port}`,
				calls,
				close: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

/**
 * 跑一次真 CLI。
 *
 * 输出走文件描述符而不是管道：一来不必和管道缓冲打交道，二来这个测试在受限沙箱里也要能跑。
 */
function runCli(args, options = {}) {
	const dir = join(tmpdir(), `limkenion-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const outPath = join(dir, "out.txt");
	const errPath = join(dir, "err.txt");
	const outFd = openSync(outPath, "w");
	const errFd = openSync(errPath, "w");

	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd: options.cwd ?? repoRoot,
			stdio: ["ignore", outFd, errFd],
			env: {
				...process.env,
				// 隔离真实凭据与配置目录，避免测试读到开发机上的东西
				LIMKENION_CODING_AGENT_DIR: join(dir, "agent"),
				LIMKENION_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
				DEEPSEEK_API_KEY: "",
				DEEPSEEK_BASE_URL: "",
			},
		});
		child.on("exit", (code) => {
			closeSync(outFd);
			closeSync(errFd);
			resolvePromise({ code, out: readFileSync(outPath, "utf-8"), err: readFileSync(errPath, "utf-8") });
		});
	});
}

/** 公共参数：不重试，接口指向假服务 */
function baseArgs(stub) {
	return ["--api-key", "sk-e2e", "--base-url", stub.url, "--retries", "0"];
}

test("危险命令在 auto 档也会被拦下，并把理由回传给模型", { skip: skipReason }, async () => {
	const stub = await startStub((body, call, response) => {
		if (call === 1) {
			response.write(
				sse(
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_danger",
											function: { name: "bash", arguments: '{"command":"rm -rf /"}' },
										},
									],
								},
							},
						],
					},
					{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				),
			);
			// 必须 end()：不关的话客户端的 socket 一直挂着，CLI 只能等到空闲看门狗（实测整组慢 300 秒）
			response.end();
			return;
		}
		const toolResult = (body.messages ?? []).find((message) => message.role === "tool")?.content ?? "";
		response.write(sse({ choices: [{ delta: { content: toolResult } }] }));
		response.end();
	});
	try {
		const result = await runCli(["-p", "清理一下系统", "--approval", "auto", ...baseArgs(stub)]);
		assert.equal(result.code, 0, `这一轮答完了，退出码应为 0：${result.err}`);
		// 工具结果里带着拒绝理由，模型据此知道要换个做法
		assert.match(result.out, /疑似危险命令/, `stdout 应回传出拒绝理由：${result.out}`);
		// 非交互终端要说清「为什么没做成」
		assert.match(result.err, /不是交互终端/, `stderr 应说明没有确认入口：${result.err}`);
	} finally {
		await stub.close();
	}
});

test("响应流被提前掐断时报错并给出退出码 1，而不是当成答完了", { skip: skipReason }, async () => {
	const stub = await startStub((_body, _call, response) => {
		response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "这是半句话" } }] })}\n\n`);
		// 既没有 finish_reason 也没有 [DONE]，直接断线。
		// 隔一拍再 end：立刻 write 完就关，在 Windows 环回上偶尔会变成 RST 而不是干净的 EOF，
		// 那样 CLI 报的是「请求失败」（网络层）而不是「中断」——这两者都算没答成，措辞不该被钉死。
		setTimeout(() => response.end(), 30);
	});
	try {
		const result = await runCli(["-p", "说点什么", ...baseArgs(stub)]);
		// 产品要求是「不能当成答完了」：退出码必须是 1，且要在 stderr 上说清失败。
		assert.equal(result.code, 1, `这一轮没答成，退出码应为 1：${result.err}`);
		assert.match(result.err, /中断|请求失败/, `stderr 应报出这次失败：${result.err}`);
	} finally {
		await stub.close();
	}
});

test("接口连不上时退出码为 1", { skip: skipReason }, async () => {
	const result = await runCli([
		"-p",
		"hi",
		"--api-key",
		"sk-e2e",
		"--base-url",
		"http://127.0.0.1:9",
		"--retries",
		"0",
	]);
	assert.equal(result.code, 1, `连不上应算运行失败：${result.err}`);
	assert.match(result.err, /请求失败/, `stderr 应给出失败原因：${result.err}`);
});

test("项目说明逐目录解析：同目录的 AGENTS.override.md 顶掉 AGENTS.md，父目录照旧注入", { skip: skipReason }, async () => {
	// 假接口把系统提示词原样回显，测试按标记词判断哪几份说明被注入
	const stub = await startStub((body, _call, response) => {
		const system = (body.messages ?? []).find((message) => message.role === "system")?.content ?? "";
		response.write(sse({ choices: [{ delta: { content: system } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }));
		response.end();
	});
	const root = join(tmpdir(), `limkenion-e2e-agents-${Date.now()}`);
	const sub = join(root, "packages", "demo");
	mkdirSync(sub, { recursive: true });
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "MARKER-ROOT-AGENTS\n");
	writeFileSync(join(sub, "CONTEXT.md"), "MARKER-SUB-CONTEXT\n");
	writeFileSync(join(sub, "AGENTS.override.md"), "MARKER-SUB-OVERRIDE\n");

	try {
		const result = await runCli(["-p", "回报一下你的规矩", ...baseArgs(stub)], { cwd: sub });
		assert.equal(result.code, 0, result.err);
		assert.match(result.out, /MARKER-ROOT-AGENTS/, "父目录的 AGENTS.md 仍应注入");
		assert.match(result.out, /MARKER-SUB-OVERRIDE/, "同目录的 AGENTS.override.md 应生效");
		assert.doesNotMatch(result.out, /MARKER-SUB-CONTEXT/, "被 override 顶掉的 CONTEXT.md 不该注入");
	} finally {
		await stub.close();
	}
});
