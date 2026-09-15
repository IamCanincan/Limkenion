/**
 * `GET /api/doctor` 的服务端测试。
 *
 * 端点跑的是命令行同一套纯函数，所以这里验两件事：响应的形状，以及**同一个注入探测下，
 * 网页给出的逐行结论与命令行完全一致**。网络一律走假 fetch（`fetchImpl`），不碰真实接口。
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASE_URL } from "limkenion-ai";
import { readJsonObject } from "limkenion-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeNetworkGuidance, hookRows, proxyEnvRows } from "../src/commands/doctor.ts";
import { AGENT_DIR_ENV, getSettingsPath, SESSION_DIR_ENV, VERSION } from "../src/config.ts";
import { keyStorageDescription, maskKey } from "../src/credentials.ts";
import { collectChecks, summarize } from "../src/doctor.ts";
import { getManagedSettingsPath, MANAGED_SETTINGS_ENV } from "../src/settings.ts";
import type { DoctorResponse } from "../src/web/feature-doctor.ts";
import { startWebServer, type WebServerHandle } from "../src/web/server.ts";

/** 测试里固定的模型，与 startWebServer 的入参一致 */
const MODEL_ID = "deepseek-flash";

let cwd = "";
let server: WebServerHandle | null = null;
const originalEnv = new Map<string, string | undefined>(
	[AGENT_DIR_ENV, SESSION_DIR_ENV, MANAGED_SETTINGS_ENV].map((key) => [key, process.env[key]]),
);

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "limkenion-web-doctor-"));
	// 配置目录也指到临时目录：体检会读用户层与 managed 层的 hooks，
	// 不隔离的话结论就跟着开发机上的配置飘。
	process.env[AGENT_DIR_ENV] = cwd;
	process.env[SESSION_DIR_ENV] = join(cwd, "sessions");
	process.env[MANAGED_SETTINGS_ENV] = join(cwd, "managed-settings.json");
	// 会话目录先建出来：体检只做可写性判断，不会替用户创建目录，
	// 不建的话「一切正常」那个用例里它会是一条 fail（与平时用过的机器不一样）。
	await mkdir(join(cwd, "sessions"), { recursive: true });
});

afterEach(async () => {
	await server?.close();
	server = null;
	for (const [key, value] of originalEnv) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	await rm(cwd, { recursive: true, force: true });
});

/**
 * 造一个假 fetch，并把探测到的地址记进 `probed`（可选）。
 *
 * 端点与「命令行那一份」共用它，所以两边探的是同一个地址、拿到的是同一个状态码——
 * 这正是「同一个注入探测下结论必须一致」的前提。测试里一律不碰真实网络。
 *
 * `expectSignal` 只在端点那条路上开：命令行的 `collectChecks` 直接吃 `probe` 回调，
 * 超时信号由调用方自己带（这里就是下面那个 probe 里的 AbortSignal.timeout），
 * 与端点里的注入探测是同一件事，只是断言点不同。
 */
function fakeProbe(status: number, probed: string[] = [], expectSignal = true): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		probed.push(String(input));
		if (expectSignal) {
			// 探到超时信号才算与 defaultProbe 同形：调用方拿它做 8 秒上限。
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		}
		expect(init?.method).toBe("GET");
		return new Response("{}", { status });
	}) as unknown as typeof fetch;
}

/** 起服务；`status` 是假 fetch 回的 HTTP 状态码，用来控制接口可达性那一条 */
async function start(status: number): Promise<string[]> {
	const probed: string[] = [];
	server = await startWebServer({
		cwd,
		// 与评审共用同一条密钥通道：这里固定一把，测试不读凭据文件。
		resolveApiKey: () => "test-key",
		modelId: MODEL_ID,
		host: "127.0.0.1",
		port: 0,
		fetchImpl: fakeProbe(status, probed),
	});
	return probed;
}

/** 取一次体检结果 */
async function fetchDoctor(): Promise<DoctorResponse> {
	const response = await fetch(`${server?.url}/api/doctor`);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("application/json");
	return (await response.json()) as DoctorResponse;
}

/**
 * 命令行在同一份输入下会打印的行。
 *
 * 逐项与 `runDoctorCommand` 对齐：collectChecks（工作目录用这里的 cwd，密钥用 test-key）
 * → 代理两行 → 只在接口不可达时补「连接诊断」→ 钩子。顺序也照抄。
 */
async function expectedChecks(status: number) {
	const checks = await collectChecks({
		agentDir: cwd,
		sessionsDir: join(cwd, "sessions"),
		cwd,
		apiKey: { key: "test-key", source: "web 生效中的密钥" },
		knownModel: true,
		modelId: MODEL_ID,
		baseUrl: DEFAULT_BASE_URL,
		mask: (key) => maskKey(key),
		encryptionAvailable: !keyStorageDescription().includes("明文"),
		// 与端点里的注入探测同形：同一个假 fetch、同一条 /models 路径、同一个 8 秒上限。
		probe: async (url: string) => {
			const response = await fakeProbe(
				status,
				[],
				false,
			)(`${url.replace(/\/+$/, "")}/models`, {
				method: "GET",
				signal: AbortSignal.timeout(8000),
			});
			if (response.ok || response.status === 401 || response.status === 403) {
				return { ok: true, detail: `HTTP ${response.status}` };
			}
			return { ok: false, detail: `HTTP ${response.status}` };
		},
	});

	// 代理两行排在「接口可达性」之后；接口不可达时再补一行「连接诊断」。
	const reachability = checks.find((check) => check.name === "接口可达性");
	checks.push(...proxyEnvRows(process.env));
	if (status >= 400) {
		checks.push({
			name: "连接诊断",
			status: "warn",
			detail: describeNetworkGuidance(new Error(reachability?.detail ?? ""), process.env),
		});
	}

	// 钩子行在末尾，读的是原始配置文件（settings.ts 会把形状不对的项悄悄丢掉）。
	// 这里自己读一遍而不是借端点里的实现，正是为了让两边独立得出同一结论。
	let raw: unknown;
	let source = "";
	for (const path of [getSettingsPath(), getManagedSettingsPath()]) {
		const parsed = readJsonObject(path);
		if (parsed !== null && "hooks" in parsed) {
			raw = parsed.hooks;
			source = path;
		}
	}
	checks.push(...hookRows({ raw, source: raw === undefined ? undefined : source, resolve: { cwd } }));
	return checks;
}

/** 按名字取一行，找不到就抛：比 undefined?.status 的断言更容易看出问题 */
function row(data: DoctorResponse, name: string) {
	const found = data.checks.find((check) => check.name === name);
	if (!found) {
		throw new Error(`没有这一行：${name}`);
	}
	return found;
}

describe("GET /api/doctor", () => {
	it("接口可达时每一行都是 ok，汇总与行数对得上，版本与配置目录一并回给界面", async () => {
		const probed = await start(200);
		const data = await fetchDoctor();

		// 探测确实打了一次 /models，而且是拿 baseUrl 拼出来的。
		expect(probed).toEqual([`${DEFAULT_BASE_URL}/models`]);

		// 形状：checks 是非空数组，每项都有 name / status / detail。
		expect(Array.isArray(data.checks)).toBe(true);
		expect(data.checks.length).toBeGreaterThan(5);
		for (const check of data.checks) {
			expect(typeof check.name).toBe("string");
			expect(["ok", "warn", "fail"]).toContain(check.status);
			expect(typeof check.detail).toBe("string");
		}

		// 全通的情况下不该冒出「连接诊断」；代理与钩子那两段仍照命令行一样拼在后面。
		expect(data.checks.map((check) => check.name)).toEqual([
			"Node 版本",
			"配置目录",
			"接口密钥",
			...(process.platform === "win32" ? ["密钥存储"] : []),
			"会话目录",
			"工作目录",
			"模型",
			"接口可达性",
			"代理环境",
			"钩子",
		]);
		expect(data.checks.every((check) => check.status === "ok")).toBe(true);

		// 汇总必须与逐行数出来的数一致，否则界面上的「N 项正常」就是假话。
		const counted = {
			ok: data.checks.filter((check) => check.status === "ok").length,
			warn: data.checks.filter((check) => check.status === "warn").length,
			fail: data.checks.filter((check) => check.status === "fail").length,
		};
		expect(data.summary).toEqual(counted);
		expect(data.summary).toEqual({ ok: data.checks.length, warn: 0, fail: 0 });
		expect(summarize(data.checks)).toEqual({ ok: data.checks.length, warned: 0, failed: 0 });

		// 界面头部要的版本与安装路径。
		expect(data.app).toBe("limkenion");
		expect(data.version).toBe(VERSION);
		expect(data.agentDir).toBe(cwd);

		// 密钥只以打码形式出现（8 位以内只留头两个字符，后面全是星号）。
		expect(row(data, "接口密钥").detail).toContain(maskKey("test-key"));
		expect(row(data, "接口密钥").detail).not.toContain("test-key");
	});

	it("接口连不上时那一行判 fail，并多出一行「连接诊断」指向代理设置", async () => {
		await start(503);
		const data = await fetchDoctor();

		expect(row(data, "接口可达性").status).toBe("fail");
		expect(row(data, "接口可达性").detail).toContain(`${DEFAULT_BASE_URL} 连不上：HTTP 503`);

		// 诊断行只有可达性失败时才出现，而且不谎称能修好：先给浏览器 / curl 与代理两条方向。
		const guidance = row(data, "连接诊断");
		expect(guidance.status).toBe("warn");
		expect(guidance.detail).toContain("HTTPS_PROXY");
		expect(guidance.detail).toContain("NODE_USE_ENV_PROXY=1");

		// 失败恰好一处，其余行不受影响。
		expect(data.summary.fail).toBe(1);
		expect(data.summary.warn).toBe(1);
		expect(data.summary.ok).toBe(data.checks.length - 2);
	});

	it("同一份注入探测下，网页的逐行结论与命令行一致", async () => {
		for (const status of [200, 503]) {
			const probed = await start(status);
			const data = await fetchDoctor();
			const expected = await expectedChecks(status);

			// 工作目录来自 FeatureContext，不是服务进程的 process.cwd()：切换目录后体检跟着走。
			expect(row(data, "工作目录").detail).toBe(cwd);
			// 逐行原样对齐：名字、状态、detail 一个字都不差。
			expect(data.checks.map((check) => [check.name, check.status, check.detail])).toEqual(
				expected.map((check) => [check.name, check.status, check.detail]),
			);
			expect(probed).toEqual([`${DEFAULT_BASE_URL}/models`]);

			await server?.close();
			server = null;
		}
	});
});

describe("GET /api/doctor 的方法与方法之外的路径", () => {
	it("非 GET 请求回 405，别的路径不受影响", async () => {
		await start(200);
		const posted = await fetch(`${server?.url}/api/doctor`, { method: "POST" });
		expect(posted.status).toBe(405);
		expect(await posted.json()).toEqual({ error: "体检只支持 GET /api/doctor" });
	});
});
