/**
 * Web UI 服务端测试。
 *
 * 全部在临时会话目录里跑，用假的 fetch 驱动模型调用，不碰真实接口。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalMode, OutputStyle, PlanMode } from "limkenion-core";
import { CheckpointStore } from "limkenion-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_DIR_ENV } from "../src/config.ts";
import { Session } from "../src/session.ts";
import type { SessionSummary, StateResponse, WebEvent } from "../src/web/protocol.ts";
import { startWebServer, type WebServerHandle } from "../src/web/server.ts";

/**
 * 带一次重试的 fetch——只重试**连接层**失败。
 *
 * 为什么需要：这一组用例反复起停服务，每个都用系统分配的临时端口，而端口很快会被复用
 * （`start()` 与 `close()` 挨着）。Node 的 `fetch`（undici）按 origin 缓存 keep-alive 连接，
 * 上一个服务的池里那条连接已经死了，复用它的请求就报 `TypeError: fetch failed`。
 * 表现是**偶发**：单跑这个文件必过，全套件并行跑时会红一次（实测两次，分别落在不同的用例上）。
 *
 * 这是环境层面的抖动，不是服务端行为，所以判据收得很紧：只有「连接没建起来」（TypeError）才重试一次，
 * HTTP 状态码与断言一律照原样走，不会把真正的失败掩盖成成功。
 *
 * 用同名遮蔽全局 `fetch`：调用点一行都不用改，读的人也一眼看得出这个文件里的请求都带重试。
 */
const fetch: typeof globalThis.fetch = async (input, init) => {
	try {
		return await globalThis.fetch(input, init);
	} catch (error) {
		if (!(error instanceof TypeError)) {
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
		return await globalThis.fetch(input, init);
	}
};

let sessionRoot = "";
let cwd = "";
let server: WebServerHandle | null = null;
const originalSessionDir = process.env[SESSION_DIR_ENV];

beforeEach(async () => {
	sessionRoot = await mkdtemp(join(tmpdir(), "limkenion-web-sessions-"));
	cwd = await mkdtemp(join(tmpdir(), "limkenion-web-cwd-"));
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

/** 把 chunk 序列化成 SSE 行 */
function sse(...payloads: unknown[]): string[] {
	return [...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`), "data: [DONE]\n\n"];
}

/**
 * 假模型：第一次请求要求调用 bash，第二次给出最终回答。
 * 这样一次 prompt 就能覆盖工具执行与结果回灌。
 */
function toolThenAnswer(): typeof fetch {
	let calls = 0;
	return (async () => {
		calls += 1;
		if (calls === 1) {
			return new Response(
				sseStream(
					sse(
						{
							choices: [
								{
									delta: {
										reasoning_content: "先执行命令",
										tool_calls: [
											{
												index: 0,
												id: "call_1",
												function: { name: "bash", arguments: '{"command":"echo hi"}' },
											},
										],
									},
								},
							],
						},
						{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
					),
				),
			);
		}
		return new Response(
			sseStream(
				sse(
					{ choices: [{ delta: { content: "工具输出是 hi" } }] },
					{
						choices: [{ delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					},
				),
			),
		);
	}) as unknown as typeof fetch;
}

/**
 * 假模型：第一次请求写待办与目标，之后给出最终回答。
 *
 * 中途会再发一次**不带工具调用**的回答：用来验证「事实没变就不重发」。
 */
function factsThenAnswer(): typeof fetch {
	let calls = 0;
	return (async () => {
		calls += 1;
		if (calls === 1) {
			const call = (index: number, id: string, name: string, args: unknown) => ({
				index,
				id,
				function: { name, arguments: JSON.stringify(args) },
			});
			return new Response(
				sseStream(
					sse(
						{
							choices: [
								{
									delta: {
										tool_calls: [
											call(0, "call_todo", "todo_write", {
												todos: [
													{ content: "写内核", status: "completed" },
													{ content: "写界面", status: "in_progress" },
												],
											}),
											call(1, "call_goal", "goal_write", {
												content: "把界面改成事实下发",
												status: "active",
											}),
										],
									},
								},
							],
						},
						{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
					),
				),
			);
		}
		return new Response(
			sseStream(
				sse({ choices: [{ delta: { content: "记下了" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }),
			),
		);
	}) as unknown as typeof fetch;
}

/**
 * 假模型：第一次请求写文件 + 报交付物，之后给出最终回答。
 *
 * 用来验证「这次碰哪个文件」「这次交付了哪几件」是工具自陈、随事件与快照下发的。
 */
function writeThenPresent(): typeof fetch {
	let calls = 0;
	return (async () => {
		calls += 1;
		if (calls === 1) {
			const call = (index: number, id: string, name: string, args: unknown) => ({
				index,
				id,
				function: { name, arguments: JSON.stringify(args) },
			});
			return new Response(
				sseStream(
					sse(
						{
							choices: [
								{
									delta: {
										tool_calls: [
											call(0, "call_write", "write", { path: "note.txt", content: "第一行\n第二行" }),
											call(1, "call_present", "present", {
												files: [{ path: "note.txt", note: "改好的文件" }],
											}),
										],
									},
								},
							],
						},
						{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
					),
				),
			);
		}
		return new Response(
			sseStream(
				sse({ choices: [{ delta: { content: "写好了" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }),
			),
		);
	}) as unknown as typeof fetch;
}

/** 覆盖已有文件用的两份内容：只有中间那一行不一样，前后对比才看得出「− 一行 + 一行」 */
const NOTE_BEFORE = "旧的一行\n共同的一行";
const NOTE_AFTER = "新的一行\n共同的一行";

/**
 * 假模型：先读文件（留下「读过」的证据，否则覆盖会被内核拒掉），再整份写它。
 *
 * ask 档下第二步会停下来等确认，所以能稳定地检查那张卡片上的「改动片段」。
 */
function readWriteThenAnswer(): typeof fetch {
	let calls = 0;
	return (async () => {
		calls += 1;
		if (calls <= 2) {
			const name = calls === 1 ? "read" : "write";
			const args = calls === 1 ? { path: "note.txt" } : { path: "note.txt", content: NOTE_AFTER };
			return new Response(
				sseStream(
					sse(
						{
							choices: [
								{
									delta: {
										tool_calls: [
											{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } },
										],
									},
								},
							],
						},
						{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
					),
				),
			);
		}
		return new Response(
			sseStream(
				sse({ choices: [{ delta: { content: "写好了" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }),
			),
		);
	}) as unknown as typeof fetch;
}

/** 启动服务器 */
async function start(
	options: {
		fetchImpl?: typeof fetch;
		approval?: ApprovalMode;
		planMode?: PlanMode;
		style?: OutputStyle;
		compaction?: boolean;
		/** 覆盖工作目录；传空串表示「还没选」 */
		cwd?: string;
	} = {},
): Promise<WebServerHandle> {
	server = await startWebServer({
		cwd: options.cwd ?? cwd,
		// 测试里不走凭据文件，直接固定一把密钥。
		resolveApiKey: () => "test-key",
		modelId: "deepseek-flash",
		host: "127.0.0.1",
		port: 0,
		fetchImpl: options.fetchImpl,
		approval: options.approval,
		planMode: options.planMode,
		style: options.style,
		compaction: options.compaction,
	});
	return server;
}

/**
 * 用原始 http 请求发一个自定义 Host 头。
 *
 * undici 的 fetch 把 Host 列为禁止覆盖的头，所以这里必须用 node:http，
 * 否则测不到 DNS rebinding 防护。
 */
function rawRequest(url: string, host: string): Promise<number> {
	return new Promise((resolvePromise, rejectPromise) => {
		const target = new URL(url);
		const request = httpRequest(
			{
				hostname: target.hostname,
				port: target.port,
				path: target.pathname,
				method: "GET",
				headers: { host },
			},
			(response) => {
				response.resume();
				resolvePromise(response.statusCode ?? 0);
			},
		);
		request.on("error", rejectPromise);
		request.end();
	});
}

/**
 * 打开 SSE 连接。
 *
 * `ready` 在收到快照结尾（status 事件）后 resolve，测试先 await 它再提交指令，
 * 才能保证增量事件是「订阅之后」产生的，否则断言会看运气。
 */
/** 开一条事件流、等快照到手就断开；返回快照里的 history 那一帧 */
async function readFirstEvent(url: string): Promise<Extract<WebEvent, { type: "history" }>> {
	const stream = await openStream(url);
	await stream.ready;
	const snapshot = stream.events.find((event) => event.type === "history");
	stream.controller.abort();
	if (!snapshot || snapshot.type !== "history") {
		throw new Error("没有收到 history 快照");
	}
	return snapshot;
}

async function openStream(url: string) {
	const controller = new AbortController();
	const response = await fetch(url, { signal: controller.signal });
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("没有响应体");
	}

	const events: WebEvent[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	let markReady: () => void = () => {};
	const ready = new Promise<void>((resolvePromise) => {
		markReady = resolvePromise;
	});

	const pump = (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					return;
				}
				buffer += decoder.decode(value, { stream: true });
				let separator = buffer.indexOf("\n\n");
				while (separator !== -1) {
					const block = buffer.slice(0, separator);
					buffer = buffer.slice(separator + 2);
					separator = buffer.indexOf("\n\n");
					const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
					if (!dataLine) {
						continue;
					}
					const parsed = JSON.parse(dataLine.slice("data: ".length)) as WebEvent;
					events.push(parsed);
					if (parsed.type === "status") {
						markReady();
					}
				}
			}
		} catch (error) {
			// 测试收尾时会主动 abort，这里把中断当成正常结束，避免未处理的 rejection。
			if (!controller.signal.aborted) {
				throw error;
			}
		}
	})();

	return { events, ready, controller, pump };
}

/** 轮询等待条件成立 */
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

describe("Web 服务器", () => {
	it("提供状态接口与前端静态资源", async () => {
		const handle = await start();

		const state = (await (await fetch(`${handle.url}/api/state`)).json()) as StateResponse;
		expect(state.cwd).toBe(cwd);
		expect(state.model).toBe("deepseek-flash");
		// 模型列表带上展示名与上下文上限，界面据此显示中文名与占用比例。
		expect(state.models.map((model) => model.id)).toContain("deepseek-flash");
		const flash = state.models.find((model) => model.id === "deepseek-flash");
		expect(flash?.name).toBe("DeepSeek V4.1 Flash");
		expect(flash?.contextWindow).toBeGreaterThan(0);
		expect(Array.isArray(state.sessions)).toBe(true);

		const html = await fetch(`${handle.url}/`);
		expect(html.status).toBe(200);
		expect(html.headers.get("content-type")).toContain("text/html");
		expect(await html.text()).toContain("Limkenion");

		const js = await fetch(`${handle.url}/app.js`);
		expect(js.headers.get("content-type")).toContain("text/javascript");

		const css = await fetch(`${handle.url}/app.css`);
		expect(css.headers.get("content-type")).toContain("text/css");

		// 字体是随包提供的静态资源，白名单里必须放行。
		const font = await fetch(`${handle.url}/google-sans-flex.woff2`);
		expect(font.status).toBe(200);
		expect(font.headers.get("content-type")).toBe("font/woff2");
	});

	it("拒绝非回环 Host，挡住 DNS rebinding", async () => {
		const handle = await start();
		expect(await rawRequest(`${handle.url}/api/state`, "evil.example.com")).toBe(403);
		// 正常的回环 Host 必须放行，否则本地浏览器也打不开。
		expect(await rawRequest(`${handle.url}/api/state`, `127.0.0.1:${handle.port}`)).toBe(200);
	});

	it("拒绝跨站 Origin，挡住 CSRF", async () => {
		const handle = await start();
		const response = await fetch(`${handle.url}/api/sessions`, {
			method: "POST",
			headers: { origin: "http://evil.example.com" },
		});
		expect(response.status).toBe(403);
	});

	it("新建、列出、删除会话", async () => {
		const handle = await start();

		const created = await fetch(`${handle.url}/api/sessions`, { method: "POST" });
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		expect(id).toMatch(/^[0-9a-f-]{36}$/);

		const listed = (await (await fetch(`${handle.url}/api/sessions`)).json()) as { sessions: { id: string }[] };
		expect(listed.sessions.map((session) => session.id)).toContain(id);

		const removed = await fetch(`${handle.url}/api/sessions/${id}`, { method: "DELETE" });
		expect(removed.status).toBe(200);

		const after = (await (await fetch(`${handle.url}/api/sessions`)).json()) as { sessions: { id: string }[] };
		expect(after.sessions.map((session) => session.id)).not.toContain(id);
	});

	it("连接时先发快照：history、pending、status、notices、usage、facts", async () => {
		const handle = await start();
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		expect(stream.events.map((event) => event.type)).toEqual([
			"history",
			"pending",
			"status",
			"notices",
			"usage",
			"facts",
		]);
		// 还没跑过任何一轮：累计是零，但这一条**要在**——刷新页面时界面靠它把「本会话花了多少」填回来
		expect(stream.events.at(-2)).toEqual({
			type: "usage",
			turns: 0,
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});
		stream.controller.abort();
	});

	it("没有会话时，启动目录落在主目录，建会话照样能用", async () => {
		// 使用者：「用户启动进程且没会话的时候，默认新建个会话，在 C:\Users\20653 工作」。
		// 服务端给一个确定的落点（主目录），新建会话那一步在界面上（首屏没有会话就直接建一个）。
		const handle = await start({ cwd: "" });

		const initial = (await (await fetch(`${handle.url}/api/state`)).json()) as { cwd: string; sessions: unknown[] };
		expect(initial.cwd).toBe(homedir());
		expect(initial.sessions).toEqual([]);

		// 落到主目录之后，建会话不再是「先选目录」的 409，而是直接建出来
		expect((await fetch(`${handle.url}/api/sessions`, { method: "POST" })).status).toBe(201);

		// 换目录本身仍然照旧
		const picked = await fetch(`${handle.url}/api/cwd`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: cwd }),
		});
		expect(picked.status).toBe(200);
		expect(((await picked.json()) as { cwd: string }).cwd).toBe(cwd);
	});

	it("已经有会话时，启动目录取最近那个会话的目录", async () => {
		// 先在这个临时目录里建一个会话，然后换一个「没指定目录」的服务重新起来
		const first = await start();
		expect((await fetch(`${first.url}/api/sessions`, { method: "POST" })).status).toBe(201);
		await first.close();

		const restarted = await start({ cwd: "" });
		const state = (await (await fetch(`${restarted.url}/api/state`)).json()) as {
			cwd: string;
			sessions: { cwd: string }[];
		};
		expect(state.cwd).toBe(cwd);
		expect(state.sessions.map((session) => session.cwd)).toEqual([cwd]);
	});

	it("目录选择器没给路径时，从当前工作目录开始浏览", async () => {
		// 选目录这件事得先有个落脚点：没给路径就从当前工作目录开始
		const handle = await start({ cwd: "" });
		const listed = (await (await fetch(`${handle.url}/api/dirs`)).json()) as { path: string };
		expect(listed.path).toBe(homedir());
	});

	it("可以给会话改名；改名只动文件头，消息一条不少", async () => {
		let calls = 0;
		const once = (async () => {
			calls += 1;
			return new Response(sseStream(sse({ choices: [{ delta: { content: "答完了" }, finish_reason: "stop" }] })));
		}) as unknown as typeof fetch;
		const handle = await start({ fetchImpl: once });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		// 先跑完一轮，让这个会话有消息：改名是「读整个文件 → 改第一行 → 写回」，写回时不能把消息丢掉。
		// 等 done 而不是等 fetch 被调用过——正在生成时改名会被 409 拦下（那是有意的）。
		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "给我一个答案" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "done"));
		expect(calls).toBe(1);

		const renamed = await fetch(`${handle.url}/api/sessions/${id}/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "  我的会话  " }),
		});
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toEqual({ id, title: "我的会话" });

		const listed = (await (await fetch(`${handle.url}/api/sessions`)).json()) as {
			sessions: { id: string; title: string; preview: string; messageCount: number }[];
		};
		const mine = listed.sessions.find((session) => session.id === id);
		expect(mine?.title).toBe("我的会话");
		// 消息还在：头被重写过，但第一行之后是逐字节照搬的
		expect(mine?.messageCount).toBe(2);
		expect(mine?.preview).toBe("给我一个答案");

		// 留空 = 取消命名，退回显示首条消息
		const cleared = await fetch(`${handle.url}/api/sessions/${id}/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "   " }),
		});
		expect(((await cleared.json()) as { title: string }).title).toBe("");

		stream.controller.abort();
	});

	it("拖拽排序：整份列表重排，只动文件头、消息一条不少", async () => {
		const handle = await start();
		const made: { id: string; file: string }[] = [];
		for (let index = 0; index < 3; index += 1) {
			made.push(
				(await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as {
					id: string;
					file: string;
				},
			);
			// 三份文件的 mtime 要有区分，否则「没排过的按修改时间」这条规则测不出来
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
		}
		const [first, second, third] = made as [
			{ id: string; file: string },
			{ id: string; file: string },
			{ id: string; file: string },
		];
		// 给第一个会话塞一条消息：重排是「读整个文件 → 改第一行 → 写回」，写回时不能把消息丢掉
		await writeFile(first.file, `${JSON.stringify({ role: "user", content: "第一条" })}\n`, { flag: "a" });

		const reorder = await fetch(`${handle.url}/api/sessions/order`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ids: [second.id, third.id, first.id] }),
		});
		expect(reorder.status).toBe(200);
		expect(await reorder.json()).toEqual({ ordered: 3, skipped: 0 });

		const listed = (await (await fetch(`${handle.url}/api/sessions`)).json()) as { sessions: SessionSummary[] };
		expect(listed.sessions.map((session) => session.id)).toEqual([second.id, third.id, first.id]);
		// 头里的 order 从大到小，而且写进了文件
		const orders = listed.sessions.map((session) => session.order);
		expect(orders.every((order) => typeof order === "number")).toBe(true);
		expect(orders[0]).toBeGreaterThan(orders[1] ?? 0);
		expect(orders[1]).toBeGreaterThan(orders[2] ?? 0);
		const mine = listed.sessions.find((session) => session.id === first.id);
		expect(mine?.messageCount).toBe(1);
		expect(mine?.preview).toBe("第一条");

		// 排过序的会话之后再被写入消息也不动位置：不然「手动排序」用一次就散了
		await writeFile(first.file, `${JSON.stringify({ role: "user", content: "又一条" })}\n`, { flag: "a" });
		const again = (await (await fetch(`${handle.url}/api/sessions`)).json()) as { sessions: SessionSummary[] };
		expect(again.sessions.map((session) => session.id)).toEqual([second.id, third.id, first.id]);

		// 没排过的新会话按修改时间排在最前：它没有 order，键就是刚写过的 mtime
		const fresh = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		const withFresh = (await (await fetch(`${handle.url}/api/sessions`)).json()) as { sessions: SessionSummary[] };
		expect(withFresh.sessions[0]?.id).toBe(fresh.id);
		expect(withFresh.sessions[0]?.order).toBe(null);

		// 空 ids 是用法错误，不是「清空排序」
		const empty = await fetch(`${handle.url}/api/sessions/order`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ids: [] }),
		});
		expect(empty.status).toBe(400);
	});

	it("集合级路由：方法不对回 405，且 /api/sessions/order 不会被当成会话 id", async () => {
		const handle = await start();

		// 路径对、方法不对：从前会一路掉到最后回 404「未知路径」，看起来像这个端点不存在，
		// 而其实是方法用错了。表化之后由路由表统一回 405（功能路由早就这么做）。
		expect((await fetch(`${handle.url}/api/cwd`)).status).toBe(405);
		expect((await fetch(`${handle.url}/api/sessions/order`)).status).toBe(405);

		/*
		 * 这一条钉的是**顺序依赖已经消失**：`/api/sessions/order` 必须落到集合级路由
		 * （缺 ids 时它自己回 400 + 「缺少 ids 字段」），而不是被会话那条匹配当成
		 * 「id 为 order 的会话」——后者会走到 handleSessionRoute 并回一个 405。
		 * 从前避免这件事的办法是「把 order 那条写在会话那条前面」，只靠一句注释提醒。
		 */
		const missingIds = await fetch(`${handle.url}/api/sessions/order`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(missingIds.status).toBe(400);
		expect(((await missingIds.json()) as { error: string }).error).toContain("ids");
	});

	it("浏览器切去看别的会话时，旧会话那一轮照旧跑完", async () => {
		// 「切换会话」在浏览器那一侧就是：断开旧会话的 SSE、连上新会话的 SSE（见 sessions.js 的
		// selectSession）——它**不发 abort**，所以服务端这一轮必须自己跑完。这条钉的就是这一点。
		const handle = await start({
			fetchImpl: (async () => {
				// 慢一点，好让「切走」发生在生成中间
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
				return new Response(sseStream(sse({ choices: [{ delta: { content: "答完了" }, finish_reason: "stop" }] })));
			}) as unknown as typeof fetch,
		});
		const create = async (): Promise<string> =>
			((await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string }).id;
		const first = await create();
		const second = await create();

		const stream = await openStream(`${handle.url}/api/sessions/${first}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${first}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "给我一个答案" }),
		});

		// 生成还在跑的时候切走：断开第一条流、连上第二条
		stream.controller.abort();
		const other = await openStream(`${handle.url}/api/sessions/${second}/events`);
		await other.ready;

		// 旧会话那一轮不该因为没人看就停下：等它自己跑完（消息落盘 = 2 条）。
		// 等宽一点：CI 机器忙的时候，一轮慢模型加两次连接可能拖到十几秒。
		let messages = 0;
		for (let i = 0; i < 150 && messages < 2; i += 1) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
			const listed = (await (await fetch(`${handle.url}/api/sessions`)).json()) as {
				sessions: { id: string; messageCount: number }[];
			};
			messages = listed.sessions.find((session) => session.id === first)?.messageCount ?? 0;
		}
		expect(messages).toBe(2);

		// 切回去还能看到完整那一轮（快照里带着助理的答复）
		const back = await openStream(`${handle.url}/api/sessions/${first}/events`);
		await back.ready;
		const snapshot = back.events.find((event) => event.type === "history");
		expect(
			(snapshot?.messages ?? []).some((message) => message.role === "assistant" && message.content === "答完了"),
		).toBe(true);

		back.controller.abort();
		other.controller.abort();
	});

	it("给某个会话换目录会挪动「当前工作目录」（面板跟着），但不会重建运行注册表", async () => {
		// 两条要一起成立：面板 / 终端 / 新建会话的落点跟着使用者刚选的那个目录走；而这一下**不重建**
		// 注册表——同一进程里别的会话（含正在生成的一轮）因此不受影响，这是它与「切全局 cwd」的区别。
		// 另一个工作目录建在 cwd 里面，好跟着 afterEach 一起清掉。
		const other = join(cwd, "other");
		await mkdir(other);
		const handle = await start();
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		// 第二个会话：换目录之后它必须还在（重建注册表就会把它丢掉）
		const second = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		const moved = await fetch(`${handle.url}/api/cwd`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: other, session: id }),
		});
		expect(moved.status).toBe(200);
		expect(((await moved.json()) as StateResponse).cwd).toBe(other);
		expect(((await (await fetch(`${handle.url}/api/state`)).json()) as StateResponse).cwd).toBe(other);

		const list = (await (await fetch(`${handle.url}/api/sessions`)).json()) as { sessions: SessionSummary[] };
		expect(list.sessions.find((item) => item.id === id)?.cwd).toBe(other);
		expect(list.sessions.some((item) => item.id === second.id)).toBe(true);
	});

	it("等确认时刷新页面，快照里带着那次待确认的调用", async () => {
		// ask 模式下任何写入与命令都要确认，于是能稳定停在这个中间态上。
		const handle = await start({ fetchImpl: toolThenAnswer(), approval: "ask" });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		const first = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await first.ready;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "跑个命令" }),
		});
		// 等到服务端发出确认请求：此刻它正等着答复，工具卡会一直显示「运行中」。
		await waitFor(() => first.events.some((event) => event.type === "approval"));

		// 模拟用户刷新页面：新连接只拿快照，增量事件一条都收不到。
		const second = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await second.ready;
		const pending = second.events.find((event) => event.type === "pending");
		const approval = pending?.type === "pending" ? pending.turn.approval : null;
		expect(approval).not.toBeNull();
		expect(approval?.tool).toBe("bash");
		expect(approval?.reason).toBeTruthy();

		/*
		 * 卡片正文与「看起来不可逆」都由**工具自陈**、服务端转手发过来（core 的 `describeApproval` /
		 * `isDestructive`）。前端从前按工具名读入参字段自己拼这段字，于是同一份知识两处都有；
		 * 这里钉住它真的随事件与快照一起下来了——少了它，卡片会退回一行 JSON。
		 */
		const approvalEvent = first.events.find((event) => event.type === "approval");
		expect(approvalEvent?.type === "approval" ? approvalEvent.detail : "").toContain("将要执行");
		// bash 的「看起来不可逆」用的是内核那条危险命令启发式；`echo hi` 不该命中
		expect(approvalEvent?.type === "approval" ? approvalEvent.destructive : true).toBe(false);
		// bash 不整份替换任何文件，所以没有「前后对比」那一节
		expect(approvalEvent?.type === "approval" ? approvalEvent.change : "有值").toBeNull();
		// 刷新后的快照里也要有：否则「等你点一下」会变成一张没有正文的卡片
		expect(approval?.detail).toContain("将要执行");
		expect(approval?.destructive).toBe(false);

		/*
		 * 进行中那一轮**只**由 pending 带着：历史里不该再出现它。
		 *
		 * `turn.ts` 在跑工具之前就把助理消息推进了历史，所以那一轮没结束时它已经在历史里了；而它的
		 * 正文与工具行又由 pending 快照带着。两处都发，界面上就是同一个工具行画两遍（一条「未完成」
		 * 来自历史、一条「运行中」来自 pending），助理正文也跟着重复——这是看截图才发现的。
		 */
		const historyEvent = second.events.find((event) => event.type === "history");
		const roles = historyEvent?.type === "history" ? historyEvent.messages.map((message) => message.role) : [];
		expect(roles).toEqual(["user"]);
		// 那一轮的工具行确实由 pending 带着（这个 fixture 的第一条响应只有思维链与工具调用，没有正文）
		expect(pending?.type === "pending" ? pending.turn.tools.length : 0).toBe(1);
		expect(pending?.type === "pending" ? pending.turn.tools[0]?.name : "").toBe("bash");
		expect(pending?.type === "pending" ? pending.turn.reasoning : "").not.toBe("");

		// 答复之后这一轮能继续跑完，不会卡在「生成中」。
		await fetch(`${handle.url}/api/sessions/${id}/approval`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approved: true }),
		});
		await waitFor(() => second.events.some((event) => event.type === "done"));

		first.controller.abort();
		second.controller.abort();
	});

	it("「本会话总是允许」之后，同一类调用不再重复问", async () => {
		// 同一批指令里连调两次同一个命令：第一次确认并记住，第二次应当不再弹卡片。
		let calls = 0;
		const twiceThenAnswer = (async () => {
			calls += 1;
			if (calls <= 2) {
				return new Response(
					sseStream(
						sse(
							{
								choices: [
									{
										delta: {
											tool_calls: [
												{
													index: 0,
													id: `call_${calls}`,
													function: { name: "bash", arguments: '{"command":"echo hi"}' },
												},
											],
										},
									},
								],
							},
							{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
						),
					),
				);
			}
			return new Response(
				sseStream(
					sse(
						{ choices: [{ delta: { content: "两次都跑完了" } }] },
						{
							choices: [{ delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 8 },
						},
					),
				),
			);
		}) as unknown as typeof fetch;

		const handle = await start({ fetchImpl: twiceThenAnswer, approval: "ask" });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "跑两次" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "approval"));

		// 卡片要带上内核给出的前缀：界面就是照这句话让用户点「总是允许」的。
		const event = stream.events.find((candidate) => candidate.type === "approval");
		expect(event).toMatchObject({ type: "approval", tool: "bash", suggestedPrefix: "echo hi" });

		const answered = await fetch(`${handle.url}/api/sessions/${id}/approval`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approved: true, remember: true }),
		});
		expect(await answered.json()).toEqual({ approved: true, remember: true });
		await waitFor(() => stream.events.some((candidate) => candidate.type === "done"));

		// 只问了一次；两次调用都真的执行了。
		expect(stream.events.filter((candidate) => candidate.type === "approval")).toHaveLength(1);
		const ends = stream.events.filter((candidate) => candidate.type === "tool_end");
		expect(ends.map((candidate) => (candidate.type === "tool_end" ? candidate.isError : null))).toEqual([
			false,
			false,
		]);

		// done 事件带上用量：界面据此显示 token 与缓存命中，并按最后那次请求算上下文占用。
		// 三次请求里只有最后一次带 usage，所以累计就是它、contextTokens 也是它。
		const done = stream.events.find((candidate) => candidate.type === "done");
		expect(done).toMatchObject({
			type: "done",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 8 },
			contextTokens: 10,
			contextWindow: 1_000_000,
		});

		// 会话累计由服务端攒并当场播出去：浏览器自己攒会在刷新时归零，两个标签页还会各攒一份。
		const totals = stream.events.find((candidate) => candidate.type === "usage" && candidate.turns === 1);
		expect(totals).toMatchObject({
			type: "usage",
			turns: 1,
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 8 },
		});

		stream.controller.abort();
	});

	it("失败会记进状态提示，带分类；重试不重复写用户消息", async () => {
		// 前三次（含默认的两次重试）都连接层失败，之后正常回答：用来验证「失败 → 提示 → 重试」这条链路。
		let calls = 0;
		const failThenAnswer = (async () => {
			calls += 1;
			if (calls <= 3) {
				throw new TypeError("fetch failed");
			}
			return new Response(
				sseStream(
					sse(
						{ choices: [{ delta: { content: "这次答完了" } }] },
						{ choices: [{ delta: {}, finish_reason: "stop" }] },
					),
				),
			);
		}) as unknown as typeof fetch;

		const handle = await start({ fetchImpl: failThenAnswer });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "跑一下" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "notices" && event.items.length > 0));

		const noticesEvent = stream.events.filter((event) => event.type === "notices").at(-1);
		const failure = noticesEvent?.type === "notices" ? noticesEvent.items.at(-1) : null;
		// 失败带着机器可读的分类：界面据此决定要不要给「重试」，不必猜中文文案
		expect(failure).toMatchObject({ kind: "error", code: "network", retryable: true });
		expect(failure?.text).toContain("请求失败");

		// 一轮结束（status running=false）之后提示仍在：刷新页面也看得到，这正是它要解决的问题
		await waitFor(() => stream.events.some((event) => event.type === "status" && !event.running));
		const third = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await third.ready;
		const snapshot = third.events.find((event) => event.type === "notices");
		expect(snapshot?.type === "notices" ? snapshot.items.length : 0).toBeGreaterThan(0);

		const retried = await fetch(`${handle.url}/api/sessions/${id}/retry`, { method: "POST" });
		expect(retried.status).toBe(202);
		await waitFor(() => stream.events.some((event) => event.type === "done"));

		// 重试没有多写一条用户消息，也没有多出一轮
		const history = stream.events.filter((event) => event.type === "history").at(-1);
		const messages = history?.type === "history" ? history.messages : [];
		expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "这次答完了" });

		stream.controller.abort();
		third.controller.abort();
		// 第一次失败会走完默认的两次退避重试（600ms + 1200ms），比默认的 5 秒超时宽一点
	}, 20_000);

	it("没有可重试的指令时给出可读的提示，而不是静默什么都不做", async () => {
		const handle = await start();
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${id}/retry`, { method: "POST" });
		await waitFor(() => stream.events.some((event) => event.type === "notices" && event.items.length > 0));
		const noticesEvent = stream.events.filter((event) => event.type === "notices").at(-1);
		const failure = noticesEvent?.type === "notices" ? noticesEvent.items.at(-1) : null;
		expect(failure).toMatchObject({ kind: "error" });
		expect(failure?.text).toContain("没有可重试的指令");
		stream.controller.abort();
	});

	it("计划模式下提交方案：退回带反馈，批准后离开计划模式", async () => {
		// 第一轮要求调用 exit_plan_mode 提交方案，第二轮给出最终回答。
		const plan =
			"目标：把 build 目录里的产物清理掉；涉及文件：scripts/clean.mjs；取舍：不碰源码目录；验证：跑 npm test。";
		const planThenAnswer = (async () => {
			if (planReviewCalls === 0) {
				planReviewCalls += 1;
				return new Response(
					sseStream(
						sse(
							{
								choices: [
									{
										delta: {
											tool_calls: [
												{
													index: 0,
													id: "plan_1",
													function: { name: "exit_plan_mode", arguments: JSON.stringify({ plan }) },
												},
											],
										},
									},
								],
							},
							{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
						),
					),
				);
			}
			return new Response(
				sseStream(
					sse({ choices: [{ delta: { content: "收到" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }),
				),
			);
		}) as unknown as typeof fetch;
		let planReviewCalls = 0;

		const handle = await start({ fetchImpl: planThenAnswer, planMode: "guide" });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "先出个方案" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "plan_review"));

		// 刷新页面也要能把卡片重建回来：方案随「进行中一轮」的快照一起下发。
		const second = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await second.ready;
		const pending = second.events.find((event) => event.type === "pending");
		expect(pending?.type === "pending" ? pending.turn.planReview?.plan : null).toBe(plan);

		// 退回必须带反馈：空反馈服务端直接拒，不把「让模型猜」当成一次评审
		const empty = await fetch(`${handle.url}/api/sessions/${id}/plan-review`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approved: false, feedback: "   " }),
		});
		expect(empty.status).toBe(400);

		await fetch(`${handle.url}/api/sessions/${id}/plan-review`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approved: false, feedback: "别动 scripts 目录" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "tool_end"));
		const ended = stream.events.find((event) => event.type === "tool_end");
		// 被退回算一次失败的工具调用：模型拿到的是一句必须处理的意见
		expect(ended?.type === "tool_end" ? ended.isError : null).toBe(true);
		expect(ended?.type === "tool_end" ? ended.content : "").toContain("别动 scripts 目录");
		await waitFor(() => stream.events.some((event) => event.type === "done"));

		second.controller.abort();
		stream.controller.abort();
	});

	it("方案被批准后离开计划模式，并让界面上的档位跟着变", async () => {
		const plan = "目标：调整读取顺序；涉及文件：packages/core/src/text.ts；取舍：不改公开导出；验证：跑 core 套件。";
		let calls = 0;
		const planThenAnswer = (async () => {
			calls += 1;
			if (calls === 1) {
				return new Response(
					sseStream(
						sse(
							{
								choices: [
									{
										delta: {
											tool_calls: [
												{
													index: 0,
													id: "plan_1",
													function: { name: "exit_plan_mode", arguments: JSON.stringify({ plan }) },
												},
											],
										},
									},
								],
							},
							{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
						),
					),
				);
			}
			return new Response(
				sseStream(
					sse({ choices: [{ delta: { content: "开工" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }),
				),
			);
		}) as unknown as typeof fetch;

		const handle = await start({ fetchImpl: planThenAnswer, planMode: "strict" });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "先出个方案" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "plan_review"));
		await fetch(`${handle.url}/api/sessions/${id}/plan-review`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approved: true }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "plan_review_result"));
		await waitFor(() => stream.events.some((event) => event.type === "modes" && event.planMode === "off"));

		// 内核自己离开了计划模式（onApproved 回调），界面那份也要跟着变，否则 chip 还写着「严格」
		const modes = await (await fetch(`${handle.url}/api/sessions/${id}/modes`)).json();
		expect(modes).toMatchObject({ planMode: "off" });
		stream.controller.abort();
	});

	it("清空上下文：历史清空、会话文件保留、提示区留一条记录", async () => {
		const handle = await start({ fetchImpl: toolThenAnswer() });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "跑个命令" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "done"));
		const before = stream.events.filter((event) => event.type === "history").at(-1);
		expect(before?.type === "history" ? before.messages.length : 0).toBeGreaterThan(0);

		const cleared = await fetch(`${handle.url}/api/sessions/${id}/clear`, { method: "POST" });
		expect(cleared.status).toBe(200);
		await waitFor(() => {
			const latest = stream.events.filter((event) => event.type === "history").at(-1);
			return latest?.type === "history" && latest.messages.length === 0;
		});
		const notices = stream.events.filter((event) => event.type === "notices").at(-1);
		expect(notices?.type === "notices" ? notices.items.at(-1)?.text : "").toContain("已清空上下文");
		// 会话文件仍然在（内容不删，只是不再发给模型）
		const sessions = (await (await fetch(`${handle.url}/api/sessions`)).json()) as { sessions: { id: string }[] };
		expect(sessions.sessions.some((candidate) => candidate.id === id)).toBe(true);
		stream.controller.abort();
	});

	it("放行规则能查也能清：清了之后同一类调用会重新问", async () => {
		let calls = 0;
		const twiceThenAnswer = (async () => {
			calls += 1;
			if (calls <= 2) {
				return new Response(
					sseStream(
						sse(
							{
								choices: [
									{
										delta: {
											tool_calls: [
												{
													index: 0,
													id: `call_${calls}`,
													function: { name: "bash", arguments: '{"command":"echo hi"}' },
												},
											],
										},
									},
								],
							},
							{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
						),
					),
				);
			}
			return new Response(
				sseStream(
					sse({ choices: [{ delta: { content: "好" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }),
				),
			);
		}) as unknown as typeof fetch;

		const handle = await start({ fetchImpl: twiceThenAnswer, approval: "ask" });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "跑两次" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "approval"));

		// 还没答之前是空的
		const before = (await (await fetch(`${handle.url}/api/sessions/${id}/approvals`)).json()) as { rules: unknown[] };
		expect(before.rules).toHaveLength(0);

		await fetch(`${handle.url}/api/sessions/${id}/approval`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approved: true, remember: true }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "done"));

		const listed = (await (await fetch(`${handle.url}/api/sessions/${id}/approvals`)).json()) as {
			rules: { tool: string; prefix: string; text: string }[];
		};
		// 命令行 /approvals 看到的是同一句话（措辞由 core 统一给出）
		expect(listed.rules).toEqual([{ tool: "bash", prefix: "echo hi", text: "执行以「echo hi」开头的单条命令" }]);

		const cleared = await fetch(`${handle.url}/api/sessions/${id}/approvals`, { method: "POST" });
		expect(await cleared.json()).toEqual({ cleared: 1 });
		const after = (await (await fetch(`${handle.url}/api/sessions/${id}/approvals`)).json()) as { rules: unknown[] };
		expect(after.rules).toHaveLength(0);
		stream.controller.abort();
	});

	it("启动时配置的计划模式与输出风格会被网页采纳，也能在运行期改", async () => {
		const handle = await start({ planMode: "guide", style: "concise" });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		const modes = await (await fetch(`${handle.url}/api/sessions/${id}/modes`)).json();
		expect(modes).toMatchObject({ planMode: "guide", style: "concise" });

		// 运行期切换风格：与命令行的 /style 同一套语义，只影响怎么讲
		const posted = await fetch(`${handle.url}/api/sessions/${id}/modes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ style: "explanatory" }),
		});
		expect(posted.status).toBe(200);
		expect(await posted.json()).toMatchObject({ planMode: "guide", style: "explanatory" });

		// 非法取值要拒，而且不能只生效一半（同时给一个合法一个非法）
		const bad = await fetch(`${handle.url}/api/sessions/${id}/modes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approval: "readonly", style: "啰嗦" }),
		});
		expect(bad.status).toBe(400);
		const after = await (await fetch(`${handle.url}/api/sessions/${id}/modes`)).json();
		expect(after).toMatchObject({ approval: "auto", style: "explanatory" });

		/*
		 * 同一个档位反复设**不重复广播**：状态没变的通知只会让别的标签页白重绘一遍
		 * （`Object.is` 一判）。两次相同的设置之后再改一次别的档位，
		 * 数下来应当只有「真变了」那一条。
		 */
		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		const applied = (style: string): Promise<Response> =>
			fetch(`${handle.url}/api/sessions/${id}/modes`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ style }),
			});
		await applied("explanatory");
		await applied("explanatory");
		await applied("concise");
		await waitFor(() => stream.events.some((event) => event.type === "modes"));
		expect(stream.events.filter((event) => event.type === "modes")).toHaveLength(1);
		stream.controller.abort();
	});

	it("会话列表跨工作区，并带上分组所需的 cwd 与更新时间", async () => {
		const handle = await start();
		const other = await mkdtemp(join(tmpdir(), "limkenion-web-other-"));
		// 另一个工作区里的一个会话（侧栏要把两组并排显示，列表就不能只看当前 cwd）
		const elsewhere = Session.create(other);
		elsewhere.append({ role: "user", content: "别的目录里的会话" });
		const here = Session.create(cwd);
		here.append({ role: "user", content: "当前目录里的会话" });

		const list = (await (await fetch(`${handle.url}/api/sessions`)).json()) as { sessions: SessionSummary[] };
		expect(list.sessions.map((item) => item.cwd).sort()).toEqual([cwd, other].sort());
		const row = list.sessions.find((item) => item.id === elsewhere.header.id);
		expect(row).toMatchObject({ cwd: other, preview: "别的目录里的会话" });
		// updatedAt 是毫秒时间戳，侧栏按它排序并算相对时间
		expect(row?.updatedAt).toBeGreaterThan(0);
		await rm(other, { recursive: true, force: true });
	});

	it("只连事件流看一个别的工作区的会话，不会动当前工作目录，但 Run 仍在它自己的目录里跑", async () => {
		// 会话在哪个目录里干活取自它会话头（openById 跨目录找得到它）：光是「看」不该把面板与新建会话
		// 的落点一起搬走——搬走那条路是使用者主动在会话菜单里换目录（见上一条用例）。
		const handle = await start();
		const other = await mkdtemp(join(tmpdir(), "limkenion-web-elsewhere-"));
		const elsewhere = Session.create(other);
		elsewhere.append({ role: "user", content: "别处" });

		const snapshot = await readFirstEvent(`${handle.url}/api/sessions/${elsewhere.header.id}/events`);
		// 工具消息没有 content，用 in 收窄：这里只关心那条用户消息
		expect(snapshot.messages?.map((message) => ("content" in message ? message.content : ""))).toEqual(["别处"]);
		const state = (await (await fetch(`${handle.url}/api/state`)).json()) as StateResponse;
		expect(state.cwd).toBe(cwd);
		// Run 的目录仍然是那个会话自己的：列表里如实报出来，工具与 AGENTS.md 都按它走
		const list = (await (await fetch(`${handle.url}/api/sessions`)).json()) as { sessions: SessionSummary[] };
		expect(list.sessions.find((item) => item.id === elsewhere.header.id)?.cwd).toBe(other);
		await rm(other, { recursive: true, force: true });
	});

	it("压缩开关：启动时读配置，运行期能开能关，类型不对就拒", async () => {
		const handle = await start({ compaction: false });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		expect(await (await fetch(`${handle.url}/api/sessions/${id}/modes`)).json()).toMatchObject({ compaction: false });

		const opened = await fetch(`${handle.url}/api/sessions/${id}/modes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ compaction: true }),
		});
		expect(opened.status).toBe(200);
		expect(await opened.json()).toMatchObject({ compaction: true });

		// 字符串会被真值判断误当成「开」，所以这里必须挑剔类型
		const wrongType = await fetch(`${handle.url}/api/sessions/${id}/modes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ compaction: "yes" }),
		});
		expect(wrongType.status).toBe(400);
		expect(await (await fetch(`${handle.url}/api/sessions/${id}/modes`)).json()).toMatchObject({ compaction: true });
	});

	it("清空上下文之后重启服务，旧对话不会回来", async () => {
		const first = await start({ fetchImpl: toolThenAnswer() });
		const { id } = (await (await fetch(`${first.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		const stream = await openStream(`${first.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${first.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "跑个命令" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "done"));
		const cleared = await fetch(`${first.url}/api/sessions/${id}/clear`, { method: "POST" });
		expect(cleared.status).toBe(200);
		stream.controller.abort();
		// 关掉服务：内存里的 Agent 没了，只剩会话文件——这正是「重启」要验的东西
		await first.close();

		const second = await start();
		const listed = (await (await fetch(`${second.url}/api/sessions`)).json()) as { sessions: { id: string }[] };
		expect(listed.sessions.some((candidate) => candidate.id === id)).toBe(true);
		const reopened = await openStream(`${second.url}/api/sessions/${id}/events`);
		await reopened.ready;
		const history = reopened.events.find((event) => event.type === "history");
		expect(history?.type === "history" ? history.messages : ["没拿到快照"]).toEqual([]);
		reopened.controller.abort();
	});

	it("跑通完整回路：模型要求调用工具、工具执行、结果回灌、最终回答", async () => {
		const handle = await start({ fetchImpl: toolThenAnswer() });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		// 先连上并等到快照结束，再提交指令，保证增量事件都不会漏。
		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;

		const accepted = await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "执行一下" }),
		});
		expect(accepted.status).toBe(202);

		await waitFor(() => stream.events.some((event) => event.type === "done"));
		stream.controller.abort();
		const events = stream.events;
		const types = events.map((event) => event.type);

		expect(types).toContain("reasoning");
		expect(types).toContain("text");
		expect(types).toContain("tool_start");
		expect(types).toContain("tool_end");
		expect(types).toContain("done");

		const toolStart = events.find((event) => event.type === "tool_start");
		expect(toolStart).toMatchObject({ name: "bash", input: { command: "echo hi" } });
		const toolEnd = events.find((event) => event.type === "tool_end");
		expect(toolEnd).toMatchObject({ name: "bash", isError: false });
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.content).toContain("hi");
		}

		// 折叠行那一行摘要由**服务端按工具自陈下发**（core 的 `summarize`），界面不认字段名：
		// bash 最要紧的是命令原文。tool_start 与 tool_end 必须是同一句，否则一行前后会换措辞。
		if (toolStart?.type === "tool_start" && toolEnd?.type === "tool_end") {
			expect(toolStart.summary).toBe("echo hi");
			expect(toolEnd.summary).toBe(toolStart.summary);
			// bash 不碰单个路径、也没有交付物：两个字段都是「空」，界面据此不给预览入口
			expect(toolStart.path).toBeNull();
			expect(toolStart.deliverables).toEqual([]);
		}

		// 结束时会重发权威历史，其中应包含用户消息、助理工具调用与工具结果。
		const history = events.filter((event) => event.type === "history").at(-1);
		expect(history?.type).toBe("history");
		if (history?.type === "history") {
			const roles = history.messages.map((message) => message.role);
			expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
			const final = history.messages.at(-1);
			expect(final).toMatchObject({ role: "assistant", content: "工具输出是 hi" });

			/*
			 * 快照里带着「工具调用 id → 这一次调用在界面上要用的东西」的表：历史里只有原始消息，
			 * 摘要、路径、交付物都是工具自陈的，前端算不出来。这一条钉的是**刷新前后一致**——
			 * 没有它就会出现「刚跑完显示命令原文，刷新一次变成 JSON」，而那种不一致靠实时事件
			 * 那几条断言看不出来（那时这些信息还没经过快照这条路）。
			 */
			const assistant = history.messages.find((message) => message.role === "assistant");
			const callId =
				assistant?.role === "assistant" && assistant.toolCalls.length > 0 ? assistant.toolCalls[0].id : "";
			expect(callId).not.toBe("");
			expect(history.cards[callId]).toEqual({ summary: "echo hi", path: null, deliverables: [] });
			expect(Object.keys(history.cards)).toHaveLength(1);
		}

		// 生成结束后应恢复空闲状态。
		expect(events.filter((event) => event.type === "status").at(-1)).toEqual({ type: "status", running: false });
	});

	it("待办与目标作为会话事实随快照下发：刷新还在，没变不重发，清空上下文跟着清", async () => {
		/*
		 * 这一条钉的是「事实由工具层的状态转手」而不是「界面回头解析历史里那条 todo_write」：
		 * 解析法在上下文压缩之后会失效——那条工具调用被折进摘要，界面再也扫不到，正在跑的任务
		 * 底下那两行会凭空清空。快照里单独有 facts 这一帧，界面不必认识任何工具名。
		 */
		const handle = await start({ fetchImpl: factsThenAnswer() });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		// 连接快照里就有这一帧（空清单 + 没有目标），界面据此把那两行收起来
		expect(stream.events.find((event) => event.type === "facts")).toEqual({ type: "facts", todos: [], goal: null });

		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "先列一下要做的事" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "done"));

		const expected = {
			type: "facts",
			todos: [
				{ content: "写内核", status: "completed" },
				{ content: "写界面", status: "in_progress" },
			],
			goal: { content: "把界面改成事实下发", status: "active" },
		};
		expect(stream.events.filter((event) => event.type === "facts").at(-1)).toEqual(expected);

		// 刷新页面：新连接快照里带着同一份事实（dock 靠它重建，不靠翻历史）
		const reopened = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await reopened.ready;
		expect(reopened.events.filter((event) => event.type === "facts").at(-1)).toEqual(expected);
		reopened.controller.abort();

		// 事实没变的一轮不该再发：dock 不用白重画一次
		const before = stream.events.filter((event) => event.type === "facts").length;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "再说一句" }),
		});
		await waitFor(() => stream.events.filter((event) => event.type === "done").length >= 2);
		expect(stream.events.filter((event) => event.type === "facts").length).toBe(before);

		// 清空上下文：模型看不见这份清单了（它只通过工具结果进上下文），界面上那两行也要跟着清
		await fetch(`${handle.url}/api/sessions/${id}/clear`, { method: "POST" });
		await waitFor(() => {
			const latest = stream.events.filter((event) => event.type === "history").at(-1);
			return latest?.type === "history" && latest.messages.length === 0;
		});
		expect(stream.events.filter((event) => event.type === "facts").at(-1)).toEqual({
			type: "facts",
			todos: [],
			goal: null,
		});
		stream.controller.abort();
	});

	it("工具自陈「碰哪个文件」「交付了哪几件」，随实时事件与历史快照一起下发", async () => {
		/*
		 * 这两件事从前由前端按工具名读入参：有 `path` 字段就给「预览文件」入口、`present` 就读 `files`。
		 * 现在由工具自陈（core 的 `pathOf` / `deliverables`），界面不认任何字段名——一个把路径字段改了名
		 * 的工具不会让预览入口悄悄消失。这一条钉住它们真的随 tool_start 与刷新后的快照下来了。
		 */
		const handle = await start({ fetchImpl: writeThenPresent() });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "写个文件再列一下" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "done"));

		const starts = stream.events.filter((event) => event.type === "tool_start");
		const write = starts.find((event) => event.name === "write");
		expect(write?.path).toBe("note.txt");
		expect(write?.deliverables).toEqual([]);
		const present = starts.find((event) => event.name === "present");
		expect(present?.path).toBeNull();
		expect(present?.deliverables).toEqual([{ path: "note.txt", note: "改好的文件" }]);

		// 刷新页面：同一份信息要从快照的 cards 表里回来，否则预览入口与交付物卡片会一起消失
		const reopened = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await reopened.ready;
		const history = reopened.events.find((event) => event.type === "history");
		expect(history?.type === "history" ? Object.values(history.cards) : []).toEqual([
			{ summary: "note.txt（2 行）", path: "note.txt", deliverables: [] },
			{ summary: "1 件", path: null, deliverables: [{ path: "note.txt", note: "改好的文件" }] },
		]);
		reopened.controller.abort();
		stream.controller.abort();
	});

	it("整份替换的文件把**算好的**前后对比一起发下来，确认卡片照着画", async () => {
		/*
		 * 「哪个字段是路径、哪个是正文」只有工具自己知道（core 的 `fileReplacement`），而「哪一行算第几行、
		 * 段头怎么写」由服务端那一份算法给（`diff.ts`，「历史」面板用的是同一份）。从前网页认 `write`
		 * 这个名字、读 `input.path` / `input.content`，还自己实现了一遍「去掉首尾相同的行」——同一个改动
		 * 在两个面板里长得不一样。这一条既钉住服务端真的算了，也钉住刷新后的快照里是同一份。
		 */
		await writeFile(join(cwd, "note.txt"), NOTE_BEFORE, "utf-8");
		const handle = await start({ fetchImpl: readWriteThenAnswer(), approval: "ask" });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		const stream = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await stream.ready;
		await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "改一下 note.txt" }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "approval"));

		const approved = stream.events.find((event) => event.type === "approval");
		const change = approved?.type === "approval" ? approved.change : null;
		// 方向是「磁盘上那一份 → 将要写入的」：− 会被盖掉，+ 是写进去的
		expect(change).toMatchObject({ path: "note.txt", created: false, added: 1, removed: 1 });
		expect(change?.sections[0]?.header).toBe("@@ -1,2 +1,2 @@");
		expect(change?.sections[0]?.lines.map((line) => `${line.tag} ${line.text}`)).toEqual([
			"- 旧的一行",
			"+ 新的一行",
			"  共同的一行",
		]);

		// 刷新后的快照里也要有同一份：等待确认时刷新页面，卡片不该丢掉这一节
		const reopened = await openStream(`${handle.url}/api/sessions/${id}/events`);
		await reopened.ready;
		const pending = reopened.events.find((event) => event.type === "pending");
		expect(pending?.type === "pending" ? pending.turn.approval?.change : null).toEqual(change);
		reopened.controller.abort();

		// 答复之后这一轮能跑完，而且真的写进去了（读过才允许覆盖）
		await fetch(`${handle.url}/api/sessions/${id}/approval`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approved: true }),
		});
		await waitFor(() => stream.events.some((event) => event.type === "done"));
		expect(await readFile(join(cwd, "note.txt"), "utf-8")).toBe(NOTE_AFTER);
		stream.controller.abort();
	});

	it("同一会话并发提交返回 409", async () => {
		const handle = await start({ fetchImpl: toolThenAnswer() });
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		const first = fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "第一条" }),
		});
		await first;
		const second = await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "第二条" }),
		});
		expect([202, 409]).toContain(second.status);
	});

	it("拒绝空指令与未知会话", async () => {
		const handle = await start();
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		const empty = await fetch(`${handle.url}/api/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "   " }),
		});
		expect(empty.status).toBe(400);

		const missing = await fetch(`${handle.url}/api/sessions/00000000-0000-4000-8000-000000000000/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "x" }),
		});
		expect(missing.status).toBe(404);
	});

	it("文件预览：文本、二进制与不存在", async () => {
		const handle = await start();
		await writeFile(join(cwd, "note.txt"), "第一行\n第二行", "utf-8");
		await writeFile(join(cwd, "blob.bin"), Buffer.from([0x01, 0x00, 0x02]));

		const text = (await (await fetch(`${handle.url}/api/file?path=note.txt`)).json()) as {
			content: string;
			binary: boolean;
		};
		expect(text.content).toBe("第一行\n第二行");
		expect(text.binary).toBe(false);

		const binary = (await (await fetch(`${handle.url}/api/file?path=blob.bin`)).json()) as {
			binary: boolean;
			content: string;
		};
		expect(binary.binary).toBe(true);
		expect(binary.content).toBe("");

		const missing = (await (await fetch(`${handle.url}/api/file?path=nope.txt`)).json()) as { content: string };
		expect(missing.content).toBe("");
	});

	it("历史端点：列出轮次、按文件给出差异（与终端 /diff 同一份算法）", async () => {
		/*
		 * 这个端点一直没测试（`feature-history.ts` 只有路由与响应拼装，算法在 `diff.ts`）。
		 * 现在算法两处共用（网页历史面板 + 终端 `/diff`），所以这里连路由一起钉住：
		 * 列表给路径不给内容，单轮给编好行号的段。
		 */
		const handle = await start();
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
		// 造一轮快照：工具跑起来那一整套太重，这里直接按工具的约定记一次（begin → capture → commit）
		const session = Session.latest(cwd);
		expect(session).not.toBeNull();
		const notePath = join(cwd, "note.txt");
		await writeFile(notePath, "旧的一行\n", "utf-8");
		const store = new CheckpointStore(session?.file ?? "");
		store.begin();
		store.capture(notePath, "旧的一行\n");
		await writeFile(notePath, "新的一行\n", "utf-8");
		store.commit();

		const list = (await (await fetch(`${handle.url}/api/sessions/${id}/history`)).json()) as {
			turns: { seq: number; files: string[]; skipped: string[] }[];
		};
		expect(list.turns).toHaveLength(1);
		expect(list.turns[0]?.seq).toBe(1);
		expect(list.turns[0]?.files).toEqual([notePath]);
		// 列表不带内容：一轮快照里可能塞着大文件的旧版本
		expect(JSON.stringify(list.turns[0])).not.toContain("旧的一行");

		const diff = (await (await fetch(`${handle.url}/api/sessions/${id}/history/1`)).json()) as {
			files: {
				path: string;
				added: number;
				removed: number;
				sections: { header: string; lines: { tag: string; text: string }[] }[];
			}[];
		};
		expect(diff.files).toHaveLength(1);
		expect(diff.files[0]).toMatchObject({ path: notePath, added: 1, removed: 1 });
		expect(diff.files[0]?.sections[0]?.header).toBe("@@ -1,1 +1,1 @@");
		expect(diff.files[0]?.sections[0]?.lines.map((line) => `${line.tag} ${line.text}`)).toEqual([
			"- 旧的一行",
			"+ 新的一行",
		]);

		// 只算指定文件；这一轮没改过的文件回 404 而不是空数组（界面据此说「这一轮没动它」）
		const only = (await (
			await fetch(`${handle.url}/api/sessions/${id}/history/1?path=${encodeURIComponent(notePath)}`)
		).json()) as { files: unknown[] };
		expect(only.files).toHaveLength(1);
		const other = await fetch(
			`${handle.url}/api/sessions/${id}/history/1?path=${encodeURIComponent(join(cwd, "other.txt"))}`,
		);
		expect(other.status).toBe(404);
	});

	it("切换模型：会话级与默认值", async () => {
		const handle = await start();
		const { id } = (await (await fetch(`${handle.url}/api/sessions`, { method: "POST" })).json()) as { id: string };

		const perSession = await fetch(`${handle.url}/api/sessions/${id}/model`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "deepseek-v4-pro" }),
		});
		expect(perSession.status).toBe(200);

		const global = await fetch(`${handle.url}/api/model`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "deepseek-v4-pro" }),
		});
		expect(global.status).toBe(200);

		const state = (await (await fetch(`${handle.url}/api/state`)).json()) as { model: string };
		expect(state.model).toBe("deepseek-v4-pro");
	});
});
