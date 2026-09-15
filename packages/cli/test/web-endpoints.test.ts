/**
 * 后台任务与子代理这两组网页端点的契约测试。
 *
 * 只走 HTTP，不碰内核内部：这里的价值是**把路由、白名单正则与返回形状钉住**——这些端点是临时探针验完就没了，
 * 而它们一旦改名或换形状，界面会在运行时静默失效（`jobs.js` / `subagents.js` 都是按这些路径取数的）。
 * 真实作业与子代理的生命周期由 core 的单测覆盖（`jobs.test.ts` / `subagent-*.test.ts`）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommandRunner, readSelfState, selfPaths } from "../src/commands/self.ts";
import { AGENT_DIR_ENV, SESSION_DIR_ENV } from "../src/config.ts";
import { startWebServer, type WebServerHandle } from "../src/web/server.ts";

let sessionRoot = "";
let cwd = "";
let server: WebServerHandle | null = null;
const originalSessionDir = process.env[SESSION_DIR_ENV];
const originalAgentDir = process.env[AGENT_DIR_ENV];

beforeEach(async () => {
	sessionRoot = await mkdtemp(join(tmpdir(), "limkenion-endpoints-sessions-"));
	cwd = await mkdtemp(join(tmpdir(), "limkenion-endpoints-cwd-"));
	process.env[SESSION_DIR_ENV] = sessionRoot;
	// 自更新那几个端点读的是 <配置目录>/versions/：指到临时目录，别碰开发机上真实的自更新记录
	process.env[AGENT_DIR_ENV] = await mkdtemp(join(tmpdir(), "limkenion-endpoints-agent-"));
});

afterEach(async () => {
	await server?.close();
	server = null;
	if (originalSessionDir === undefined) {
		delete process.env[SESSION_DIR_ENV];
	} else {
		process.env[SESSION_DIR_ENV] = originalSessionDir;
	}
	const agentDir = process.env[AGENT_DIR_ENV];
	if (originalAgentDir === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = originalAgentDir;
	}
	await rm(sessionRoot, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
	if (agentDir?.includes("limkenion-endpoints-agent-")) {
		await rm(agentDir, { recursive: true, force: true });
	}
});

/** 起服务并新建一个会话，返回它的 id 与服务器句柄的 url */
async function startWithSession(
	extra: {
		spawnInstaller?: (script: string, jobFile: string) => boolean;
		selfRunner?: CommandRunner;
		selfSource?: string;
	} = {},
): Promise<{
	url: string;
	id: string;
}> {
	server = await startWebServer({
		cwd,
		resolveApiKey: () => "test-key",
		modelId: "deepseek-flash",
		host: "127.0.0.1",
		port: 0,
		// 回滚那条路会挂一个分离进程去 npm install -g、更新那条路会跑门禁与打包：
		// 测试里一律注入替身，绝不真装、也绝不等几分钟
		spawnInstaller: extra.spawnInstaller,
		selfRunner: extra.selfRunner,
		selfSource: extra.selfSource,
	});
	const created = (await (await fetch(`${server.url}/api/sessions`, { method: "POST" })).json()) as { id: string };
	return { url: server.url, id: created.id };
}

/** 造一个「源码目录」：有 package.json 与打包产物（够 `runSelfUpdate` 走完流程） */
async function makeSource(version: string): Promise<string> {
	const source = await mkdtemp(join(tmpdir(), "limkenion-endpoints-src-"));
	await mkdir(join(source, "release"), { recursive: true });
	await writeFile(join(source, "package.json"), JSON.stringify({ name: "limkenion", version }), "utf-8");
	await writeFile(join(source, "release", `limkenion-${version}.tgz`), "假的 tgz", "utf-8");
	return source;
}

describe("后台任务与子代理的端点", () => {
	it("目录两个端点都给空列表（新会话还没有作业）", async () => {
		const { url, id } = await startWithSession();
		const jobs = await fetch(`${url}/api/sessions/${id}/jobs`);
		expect(jobs.status).toBe(200);
		expect(await jobs.json()).toEqual({ jobs: [] });

		const subagents = await fetch(`${url}/api/sessions/${id}/subagents`);
		expect(subagents.status).toBe(200);
		expect(await subagents.json()).toEqual({ subagents: [] });
	});

	it("收一条不存在的：返回 false 而不是报错", async () => {
		const { url, id } = await startWithSession();
		const killed = await fetch(`${url}/api/sessions/${id}/jobs/job-9/kill`, { method: "POST" });
		expect(killed.status).toBe(200);
		expect(await killed.json()).toEqual({ id: "job-9", killed: false });

		const stopped = await fetch(`${url}/api/sessions/${id}/subagents/没有这个/stop`, { method: "POST" });
		expect(stopped.status).toBe(200);
		expect(await stopped.json()).toEqual({ label: "没有这个", stopped: false });
	});

	it("读不存在的作业日志：404 并给一句人话", async () => {
		const { url, id } = await startWithSession();
		const log = await fetch(`${url}/api/sessions/${id}/jobs/job-9/log`);
		expect(log.status).toBe(404);
		expect((await log.json()) as { error: string }).toHaveProperty("error");
	});

	it("白名单是紧的：多一节路径、少一节路径都不认", async () => {
		const { url, id } = await startWithSession();
		for (const path of [
			`jobs/job-1/boom`,
			`jobs/job-1/kill/extra`,
			`jobs//kill`,
			`subagents/stop`,
			`subagents/a/b/stop`,
		]) {
			const response = await fetch(`${url}/api/sessions/${id}/${path}`, { method: "POST" });
			expect(response.status, path).toBe(404);
		}
	});

	it("会话不存在时这两组端点也走 404", async () => {
		const { url } = await startWithSession();
		const missing = "00000000-0000-4000-8000-000000000000";
		expect((await fetch(`${url}/api/sessions/${missing}/jobs`)).status).toBe(404);
		expect((await fetch(`${url}/api/sessions/${missing}/subagents`)).status).toBe(404);
	});
});

/** 轮询 `GET /api/version`，等这次更新安排完成为止 */
async function waitForScheduled(versionUrl: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const body = (await (await fetch(versionUrl)).json()) as { updateJob: { status: string } | null };
		if (body.updateJob !== null && body.updateJob.status !== "running") {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("等更新安排完成超时");
}

/*
 * 版本与自更新：网页「设置」面板那张卡片的数据源。
 *
 * 它读的是本机 `versions/` 目录（`self status` 的同一份），所以这里只钉「读得到、形状对、只读」——
 * 具体装过哪一版取决于跑测试的机器，不能写死。
 */
describe("版本与自更新端点", () => {
	it("GET /api/version：给出当前版本与自更新状态（没记录时是空值，不是报错）", async () => {
		const { url } = await startWithSession();
		const response = await fetch(`${url}/api/version`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			version: string;
			current: string | null;
			previous: string | null;
			lastResult: string;
			log: string;
			dir: string;
			howToUpdate: string;
		};
		expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
		// 这台机器上没自更新过时是 null；有记录时是 tgz 路径。两种都正当，所以只钉类型
		expect(body.current === null || typeof body.current === "string").toBe(true);
		expect(body.previous === null || typeof body.previous === "string").toBe(true);
		expect(typeof body.lastResult).toBe("string");
		expect(body.lastResult).not.toBe("");
		expect(body.log).toContain("install.log");
		expect(body.dir).toContain("versions");
		// 更新只能在终端里跑：卡片上那句话必须说清，否则用户会找按钮
		expect(body.howToUpdate).toContain("self update");
	});

	it("只读：其它方法回 405 而不是 404", async () => {
		const { url } = await startWithSession();
		const posted = await fetch(`${url}/api/version`, { method: "POST" });
		expect(posted.status).toBe(405);
		expect((await posted.json()) as { error: string }).toHaveProperty("error");
	});

	it("POST /api/self/rollback：没有上一版时回 400，且不起安装进程", async () => {
		let spawned = 0;
		const { url } = await startWithSession({
			spawnInstaller: () => {
				spawned += 1;
				return true;
			},
		});
		const response = await fetch(`${url}/api/self/rollback`, { method: "POST" });
		expect(response.status).toBe(400);
		expect((await response.json()) as { error: string }).toHaveProperty(
			"error",
			expect.stringContaining("没有可回滚"),
		);
		expect(spawned).toBe(0);
	});

	it("POST /api/self/rollback：有上一版时挂上安装作业，并说清「要停掉服务」", async () => {
		// 造一份自更新记录（隔离的配置目录里），current/previous 指向两个假 tgz
		const paths = selfPaths();
		await mkdir(paths.dir, { recursive: true });
		await writeFile(
			paths.state,
			JSON.stringify({ current: join(paths.dir, "new.tgz"), previous: join(paths.dir, "old.tgz") }),
			"utf-8",
		);

		let spawned = 0;
		const { url } = await startWithSession({
			spawnInstaller: () => {
				spawned += 1;
				return true;
			},
		});
		const response = await fetch(`${url}/api/self/rollback`, { method: "POST" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; tgz: string; log: string; note: string };
		expect(body.ok).toBe(true);
		expect(body.tgz).toContain("old.tgz");
		expect(body.log).toContain("install.log");
		// 关键口径：这是「安排」，不是「已完成」——安装进程要等服务退出
		expect(body.note).toContain("请停止这个服务");
		expect(body.note).toContain("退出后自动完成");
		expect(spawned).toBe(1);
		// 记录对调了，装完之后 `self status` 才说得清现在装的是哪一版
		expect(readSelfState()).toEqual({ current: join(paths.dir, "old.tgz"), previous: join(paths.dir, "new.tgz") });

		// 回滚只有 POST；GET 回 405
		expect((await fetch(`${url}/api/self/rollback`)).status).toBe(405);
	});

	it("POST /api/self/update：没给源码目录时回 400（并说清怎么给）", async () => {
		let ran = 0;
		const { url } = await startWithSession({
			selfRunner: async () => {
				ran += 1;
				return 0;
			},
		});
		const response = await fetch(`${url}/api/self/update`, { method: "POST" });
		expect(response.status).toBe(400);
		expect((await response.json()) as { error: string }).toHaveProperty("error", expect.stringContaining("--from"));
		expect(ran).toBe(0);
	});

	it("POST /api/self/update：异步跑门禁与打包，进度随 /api/version 出来", async () => {
		const source = await makeSource("9.9.9");
		let spawned = 0;
		const commands: string[] = [];
		const { url } = await startWithSession({
			selfSource: source,
			selfRunner: async (command, args, _cwd, onLine) => {
				commands.push(`${command} ${args.join(" ")}`);
				// 逐行回报：卡片上那行「最近输出」靠它
				onLine?.(`> ${command} ${args.join(" ")} 的输出`);
				return 0;
			},
			spawnInstaller: () => {
				spawned += 1;
				return true;
			},
		});

		const started = await fetch(`${url}/api/self/update`, { method: "POST" });
		expect(started.status).toBe(202);
		// 立刻回 202：门禁与打包要跑几分钟，不能把请求挂在那里
		const first = (await started.json()) as { job: { status: string; step: string } };
		expect(first.job.status).toBe("running");

		// 轮询到安排完成为止（假执行器瞬间返回，所以这里很快）
		await waitForScheduled(`${url}/api/version`);
		const status = (await (await fetch(`${url}/api/version`)).json()) as {
			selfSource: string | null;
			updateJob: { status: string; version: string | null; note: string; tail: string[] } | null;
		};
		expect(status.selfSource).toBe(source);
		expect(status.updateJob?.status).toBe("scheduled");
		expect(status.updateJob?.version).toBe("9.9.9");
		// 关键口径：这是「安排」，装是在服务退出之后
		expect(status.updateJob?.note).toContain("请停止这个服务");
		// 构建输出留了几行给界面看（卡片上那行「最近输出」）
		expect(status.updateJob?.tail).toEqual(["> npm run check 的输出", "> npm run release:package 的输出"]);
		expect(commands).toEqual(["npm run check", "npm run release:package"]);
		expect(spawned).toBe(1);
	});

	it("POST /api/self/update：已经在跑时回 409", async () => {
		const source = await makeSource("9.9.9");
		// 卡住不退出的执行器：模拟「门禁还在跑」
		const { url } = await startWithSession({
			selfSource: source,
			selfRunner: () => new Promise<number>(() => {}),
		});
		expect((await fetch(`${url}/api/self/update`, { method: "POST" })).status).toBe(202);
		const second = await fetch(`${url}/api/self/update`, { method: "POST" });
		expect(second.status).toBe(409);
		expect((await second.json()) as { error: string }).toHaveProperty("error", expect.stringContaining("已经在更新"));
		// 更新只有 POST；GET 回 405
		expect((await fetch(`${url}/api/self/update`)).status).toBe(405);
	});

	it("更新时执行器抛错：记成失败并说清，不把服务带走", async () => {
		const source = await makeSource("9.9.9");
		const { url } = await startWithSession({
			selfSource: source,
			selfRunner: async () => {
				throw new Error("执行器炸了");
			},
		});
		expect((await fetch(`${url}/api/self/update`, { method: "POST" })).status).toBe(202);
		const status = (await (await fetch(`${url}/api/version`)).json()) as {
			updateJob: { status: string; note: string } | null;
		};
		expect(status.updateJob?.status).toBe("failed");
		expect(status.updateJob?.note).toContain("执行器炸了");
		// 服务还活着：这条请求能正常答复
		expect((await fetch(`${url}/api/state`)).status).toBe(200);
	});
});
