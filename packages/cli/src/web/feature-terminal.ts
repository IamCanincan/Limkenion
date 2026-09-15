/*
 * 终端：POST /api/terminal/exec，用 SSE 把命令输出推给浏览器。
 *
 * 安全姿态：这里的命令以启动本服务器的用户身份、在本机 shell 里执行，权限与 CLI 的 bash 工具
 * 完全同级——能读写整台机器上的文件、能联网、能启动任何进程。网页默认只监听回环地址，
 * 也校验 Host / Origin（见 http.ts 的 isRequestAllowed），但使用者应当清楚它的含义：
 * 任何能打开这个页面的人都可以在这台机器上执行任意命令，因此不要把端口暴露到回环之外。
 *
 * 流式方案选择 POST 上直接回 `text/event-stream`，而不是「GET 单独一条 SSE + POST 提交」：
 * 1. 一次命令一个事件流，浏览器收完即连接结束，没有需要长期维护、要心跳、要断线重连的
 *    全局订阅状态（那条路的复杂度全在「重连后怎么补齐断掉的那段输出」上）；
 * 2. 请求本身只有一个响应体，同一条命令的输出不可能被写进另一条连接的顺序里；
 * 3. 代价是「连接断了就看不到这次输出」，对本地终端面板可以接受：POST 的响应体断了，
 *    前端会说明命令仍在后台跑（120 秒超时或超限会把它收掉），而不是假装它被取消了。
 *
 * 进程收尾必须用 core 的 killProcessTree：`child.kill()` 只杀得掉 shell 本身，Windows 上
 * cmd.exe 死了之后它启动的孙进程仍然攥着 stdout 管道，`close` 事件迟迟不来（实测一个 0.5 秒
 * 超时拖成了 28 秒），超时与输出上限这两道保证就都失效了。
 */

import { spawn } from "node:child_process";
// killProcessTree / DETACH_FOR_KILL 目前没有从 limkenion-core 的入口转出，只能直接引它的模块。
// 不在这里重抄一份实现：进程树收尾只有一种正确做法，两处各写一遍迟早会分叉。
import { DETACH_FOR_KILL, decodeProcessOutput, killProcessTree } from "limkenion-core";
import type { FeatureRoute } from "./features.ts";
import { readJsonBody, sendJson } from "./http.ts";
import type { ErrorResponse } from "./protocol.ts";

/*
 * 三道硬上限。都写成常量是因为它们同时出现在实现与给使用者的提示文案里，
 * 散在代码里改一处漏一处就会出现「提示说 30 秒、实际 120 秒」这种谎报。
 */

/** 单条命令最长执行时间；到点连同进程树一起杀掉 */
export const TERMINAL_TIMEOUT_MS = 120_000;

/** 单条命令允许回给浏览器多少字节的原始输出（stdout + stderr 合计） */
export const TERMINAL_MAX_OUTPUT_BYTES = 1024 * 1024;

/** SSE 心跳间隔，避免中间代理掐掉长时间没有输出的连接（`ping` 这类命令会安静很久） */
const HEARTBEAT_MS = 20_000;

/**
 * 同一时刻只允许一条命令在跑。
 *
 * 放模块级而不是挂在请求上：终端面板是「这台机器的一个 shell」，两条命令并行输出会互相插队，
 * 分不清哪一行属于哪条；而且它跑在服务进程里，天然是全局资源。冲突的请求回 409。
 */
let running = false;

/** 取系统的可执行文件后缀，Windows 上 `cmd.exe` / `COMSPEC` 带不带都认 */
function exeName(base: string): string {
	return process.platform === "win32" ? `${base}.exe` : base;
}

/**
 * 选择执行命令的 shell。
 *
 * Windows 用 cmd.exe（`/d` 跳过 AutoRun 脚本、`/s` 只在整串被引号包住时才剥掉外层引号、
 * `/c` 执行完就退），其它平台用 `$SHELL`，没有就退回 /bin/sh。与 core 的 bash 工具同一套规则，
 * 这样「网页终端里能跑的命令」和「agent 能跑的命令」一致，不会一边行一边不行。
 */
function resolveShell(): { command: string; args: (input: string) => string[] } {
	if (process.env.LIMKENION_SHELL) {
		return { command: process.env.LIMKENION_SHELL, args: (input) => ["-c", input] };
	}
	if (process.platform === "win32") {
		return {
			command: process.env.ComSpec || exeName("cmd"),
			args: (input) => ["/d", "/s", "/c", input],
		};
	}
	return { command: process.env.SHELL || "/bin/sh", args: (input) => ["-c", input] };
}

/**
 * 处理终端请求。
 *
 * 只认 `POST /api/terminal/exec`；命中就整条请求归这里管（包括返回 JSON 错误），
 * 因此总是返回 true，不必让后面的路由再判断一次路径。
 */
export const route: FeatureRoute = async (request, response, url, method, context) => {
	if (url.pathname !== "/api/terminal/exec") {
		return false;
	}
	if (method !== "POST") {
		sendJson(response, 405, { error: "终端只支持 POST /api/terminal/exec" } satisfies ErrorResponse);
		return true;
	}
	await handleExec(request, response, context.getCwd());
	return true;
};

/** 读命令、占住并发位、开流、收尾 */
async function handleExec(
	request: Parameters<FeatureRoute>[0],
	response: Parameters<FeatureRoute>[1],
	cwd: string,
): Promise<void> {
	// 先检查再读请求体：读体是异步的，两条请求会在这里交错，谁都不会看到对方把 running 置上。
	if (running) {
		sendJson(response, 409, {
			error: "已有一条命令在跑；终端一次只跑一条，等它结束或超时再试",
		} satisfies ErrorResponse);
		return;
	}
	running = true;

	try {
		const body = await readJsonBody(request);
		const command = typeof body.command === "string" ? body.command.trim() : "";
		if (command === "") {
			sendJson(response, 400, { error: "缺少 command 字段" } satisfies ErrorResponse);
			return;
		}
		await runCommand(response, command, cwd);
	} finally {
		// 任何提前返回（缺字段、读体失败）都要把并发位放掉，否则终端会永久锁死。
		running = false;
	}
}

/**
 * 执行命令并把输出以 SSE 推给浏览器。
 *
 * 事件有三种：`ready`（带上工作目录，让界面知道命令跑在哪）、`out`（一段输出，带 channel）、
 * `done`（退出码、耗时、是否超时/被截断）。
 */
function runCommand(response: Parameters<FeatureRoute>[1], command: string, cwd: string): Promise<void> {
	return new Promise((settle) => {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			// SSE 响应流式到达的前提：不许任何一层缓存或缓冲攒着它。
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		// 先送一个注释行，让浏览器立刻认为连接已建立（之后才轮到命令慢慢出输出）。
		response.write(": connected\n\n");

		const send = (type: string, payload: Record<string, unknown>): void => {
			// 已经断开的连接再写会抛 ERR_STREAM_WRITE_AFTER_END，直接丢掉即可。
			if (response.writableEnded || response.destroyed) {
				return;
			}
			response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
		};

		const shell = resolveShell();
		const startedAt = Date.now();
		const child = spawn(shell.command, shell.args(command), {
			cwd,
			env: process.env,
			windowsHide: true,
			// POSIX 下让子进程成为进程组组长，killProcessTree 才能一次收掉整棵树；
			// Windows 不这么干（会多出一个控制台窗口），收尾交给 taskkill /T。
			detached: DETACH_FOR_KILL,
			// Windows 上必须原样把命令行交给 cmd.exe：不给这个标志时 Node 会自行给命令串
			// 套一层引号，cmd 再把里层的引号吃掉，于是 `node -e "..."` 这种带引号的命令
			// 会静默地什么都不执行（退出码还是 0，最难查的一类故障）。
			windowsVerbatimArguments: process.platform === "win32",
		});

		let bytes = 0;
		let truncated = false;
		let timedOut = false;
		let done = false;

		const finish = (code: number | null, failure?: string): void => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			clearInterval(heartbeat);
			send("done", {
				code,
				signal: child.signalCode ?? null,
				durationMs: Date.now() - startedAt,
				truncated,
				timedOut,
				bytes,
				...(failure === undefined ? {} : { failure }),
			});
			response.end();
			settle();
		};

		/*
		 * 时间一到就杀整棵树并立刻收尾，而不是等 `close`：被杀的子进程若还有孙进程攥着管道，
		 * `close` 可能迟迟不来，120 秒的保证就变成了「120 秒之后再看运气」。
		 * 已经收到的输出都已经发出去了，不会丢。
		 */
		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(child);
			finish(null);
		}, TERMINAL_TIMEOUT_MS);

		const heartbeat = setInterval(() => {
			if (!response.writableEnded && !response.destroyed) {
				response.write(": ping\n\n");
			}
		}, HEARTBEAT_MS);

		const onOutput = (chunk: Buffer, channel: "stdout" | "stderr"): void => {
			if (done || truncated) {
				return;
			}
			// 超限那一块一个字节都不发：边界之外的内容要么是半个字符，要么是这条消息的尾部，
			// 拼上去只会让界面显示一段来历不明的东西。发出去的总量因此正好是 1 MB。
			if (bytes + chunk.byteLength > TERMINAL_MAX_OUTPUT_BYTES) {
				truncated = true;
				// 与 bash 工具一致：超限立刻杀树，否则一个死循环命令会一直往管道和内存里写。
				killProcessTree(child);
				finish(null);
				return;
			}
			bytes += chunk.byteLength;
			send("out", { channel, text: decodeProcessOutput(chunk) });
		};

		child.stdout?.on("data", (chunk: Buffer) => onOutput(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => onOutput(chunk, "stderr"));
		child.on("error", (error: Error) => finish(null, `启动命令失败：${error.message}`));
		// close 而不是 exit：它保证 stdout / stderr 已经读完，不会把最后一段输出丢在管道里。
		child.on("close", (code: number | null) => finish(code));

		send("ready", { cwd, timeoutMs: TERMINAL_TIMEOUT_MS, maxBytes: TERMINAL_MAX_OUTPUT_BYTES });
	});
}
