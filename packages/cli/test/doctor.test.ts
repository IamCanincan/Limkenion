/** doctor 的单元测试：所有检查都能注入，因此不碰真实环境。 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describeNetworkGuidance,
	type HookProgramKind,
	hookRows,
	maskProxyCredential,
	proxyEnvRows,
	resolveHookCommand,
	runDoctorCommand,
} from "../src/commands/doctor.ts";
import { AGENT_DIR_ENV, SESSION_DIR_ENV } from "../src/config.ts";
import { collectChecks, defaultProbe, summarize, versionAtLeast } from "../src/doctor.ts";
import { MANAGED_SETTINGS_ENV } from "../src/settings.ts";

let dir = "";
const signal = new AbortController().signal;
void signal;

/** 代理相关变量：用例改完必须原样还原，否则会污染同一进程里别的测试 */
const PROXY_ENV_KEYS = [
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
	"NODE_USE_ENV_PROXY",
] as const;

const originalEnv = new Map<string, string | undefined>(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "limkenion-doctor-"));
	// 环境是进程级的：不先清干净，本机真实设了代理时用例就会飘。
	for (const key of PROXY_ENV_KEYS) {
		delete process.env[key];
	}
});

afterEach(async () => {
	for (const key of PROXY_ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	await rm(dir, { recursive: true, force: true });
});

/** 一份「一切正常」的输入，各用例只改自己关心的那项 */
function baseInput(overrides: Record<string, unknown> = {}) {
	return {
		nodeVersion: "24.20.0",
		agentDir: dir,
		sessionsDir: dir,
		cwd: dir,
		apiKey: { key: "sk-abcdefghijklmnop", source: "auth" },
		knownModel: true,
		modelId: "deepseek-flash",
		baseUrl: "https://api.deepseek.com",
		canWrite: () => true,
		probe: async () => ({ ok: true, detail: "HTTP 200" }),
		mask: (key: string) => `${key.slice(0, 6)}…${key.slice(-4)}`,
		platform: "linux",
		...overrides,
	};
}

/** 取某项检查 */
function find(checks: Awaited<ReturnType<typeof collectChecks>>, name: string) {
	return checks.find((check) => check.name === name);
}

/** 造一个带错误码的普通 Error，用来喂纯函数；测试里不走网络 */
function codedError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

/** 造一个错误码挂在 cause 上的普通 Error，形状与 undici 的 TypeError 一致 */
function causedError(message: string, causeCode: string): Error {
	return new Error(message, { cause: codedError("底层失败", causeCode) });
}

/** 抓一段 stdout：doctor 只往 stdout 写结果 */
function captureStdout(run: () => Promise<number>): Promise<{ code: number; output: string }> {
	const original = process.stdout.write;
	let output = "";
	const stub = ((chunk: string | Uint8Array): boolean => {
		output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
		return true;
	}) as typeof process.stdout.write;
	process.stdout.write = stub;
	return run()
		.then((code) => ({ code, output }))
		.finally(() => {
			process.stdout.write = original;
		});
}

describe("版本比较", () => {
	it("按段比较而不是字符串比较", () => {
		expect(versionAtLeast("22.19.0", "22.19.0")).toBe(true);
		expect(versionAtLeast("24.20.0", "22.19.0")).toBe(true);
		expect(versionAtLeast("22.9.0", "22.19.0")).toBe(false);
		expect(versionAtLeast("22.19.0-nightly", "22.19.0")).toBe(true);
		expect(versionAtLeast("20.11.1", "22.19.0")).toBe(false);
	});
});

describe("collectChecks", () => {
	it("一切正常时全部 ok", async () => {
		const checks = await collectChecks(baseInput());
		expect(checks.every((check) => check.status === "ok")).toBe(true);
		expect(summarize(checks)).toEqual({ ok: checks.length, warned: 0, failed: 0 });
		// 网络正常时不该冒出诊断行：默认输出不比从前多话。
		expect(find(checks, "连接诊断")).toBeUndefined();
		expect(find(checks, "代理环境")).toBeUndefined();
	});

	it("Node 版本过低判失败", async () => {
		const checks = await collectChecks(baseInput({ nodeVersion: "20.11.1" }));
		expect(find(checks, "Node 版本")?.status).toBe("fail");
		expect(summarize(checks).failed).toBe(1);
	});

	it("配置目录不可写判失败", async () => {
		const checks = await collectChecks(baseInput({ canWrite: (target: string) => target !== dir }));
		expect(find(checks, "配置目录")?.status).toBe("fail");
	});

	it("会话目录不可写判失败，工作目录不可写只算警告", async () => {
		const checks = await collectChecks(
			baseInput({
				agentDir: "/ok",
				sessionsDir: "/bad",
				cwd: "/bad",
				canWrite: (target: string) => target === "/ok",
			}),
		);
		expect(find(checks, "会话目录")?.status).toBe("fail");
		expect(find(checks, "工作目录")?.status).toBe("warn");
	});

	it("没有密钥是警告而不是失败（还能看历史会话）", async () => {
		const checks = await collectChecks(baseInput({ apiKey: { key: "", source: "none" } }));
		const check = find(checks, "接口密钥");
		expect(check?.status).toBe("warn");
		expect(check?.detail).toContain("auth login");
	});

	it("密钥只显示打码结果", async () => {
		const checks = await collectChecks(baseInput());
		const detail = find(checks, "接口密钥")?.detail ?? "";
		expect(detail).toContain("sk-abc…mnop");
		expect(detail).not.toContain("sk-abcdefghijklmnop");
	});

	it("未知模型是警告，提示会退化到保守上限", async () => {
		const checks = await collectChecks(baseInput({ knownModel: false, modelId: "some-new-model" }));
		expect(find(checks, "模型")?.detail).toContain("64K");
	});

	it("接口连不上判失败", async () => {
		const checks = await collectChecks(baseInput({ probe: async () => ({ ok: false, detail: "ECONNREFUSED" }) }));
		expect(find(checks, "接口可达性")?.status).toBe("fail");
	});

	it("只在 Windows 上报告密钥存储方式", async () => {
		const linux = await collectChecks(baseInput());
		expect(find(linux, "密钥存储")).toBeUndefined();

		const win = await collectChecks(baseInput({ platform: "win32", encryptionAvailable: true }));
		expect(find(win, "密钥存储")?.status).toBe("ok");

		const winPlain = await collectChecks(baseInput({ platform: "win32", encryptionAvailable: false }));
		expect(find(winPlain, "密钥存储")?.status).toBe("warn");
	});
});

describe("defaultProbe", () => {
	it("401 也算连通：说明网络与地址没问题，只是没带对密钥", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
		try {
			expect(await defaultProbe("https://api.deepseek.com")).toEqual({ ok: true, detail: "HTTP 401" });
		} finally {
			globalThis.fetch = original;
		}
	});

	it("抛异常时报失败并带上原因", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("connect ETIMEDOUT");
		}) as unknown as typeof fetch;
		try {
			const probed = await defaultProbe("https://api.deepseek.com");
			expect(probed.ok).toBe(false);
			expect(probed.detail).toContain("ETIMEDOUT");
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("proxyEnvRows", () => {
	it("没有代理变量时是直连说明，不是警告", () => {
		expect(proxyEnvRows({})).toEqual([{ name: "代理环境", status: "ok", detail: "未设置，请求直连目标地址" }]);
	});

	it("设了代理却没开 NODE_USE_ENV_PROXY：点名变量，判 warn", () => {
		expect(proxyEnvRows({ HTTPS_PROXY: "http://proxy.corp.example:8080" })).toEqual([
			{ name: "代理环境", status: "ok", detail: "HTTPS_PROXY=http://proxy.corp.example:8080" },
			{
				name: "代理生效",
				status: "warn",
				detail:
					"代理生效情况：检测到代理变量，但未设置 NODE_USE_ENV_PROXY=1，Node 自带 fetch 会忽略它们。请设置 NODE_USE_ENV_PROXY=1 后再跑一次 doctor（该开关需要 Node 24 及以上）",
			},
		]);
	});

	it("设了代理且开了 NODE_USE_ENV_PROXY：判 ok，不再提醒", () => {
		expect(proxyEnvRows({ https_proxy: "http://proxy.corp.example:8080", NODE_USE_ENV_PROXY: "1" })).toEqual([
			{ name: "代理环境", status: "ok", detail: "https_proxy=http://proxy.corp.example:8080" },
			{
				name: "代理生效",
				status: "ok",
				detail: "代理生效情况：NODE_USE_ENV_PROXY=1 已设置，Node 的 fetch 会按上面的变量走代理",
			},
		]);
	});

	it("只有开关没有代理地址时判 ok：仍然直连，但不必提醒设置", () => {
		expect(proxyEnvRows({ NODE_USE_ENV_PROXY: "1" })).toEqual([
			{
				name: "代理环境",
				status: "ok",
				detail:
					"NODE_USE_ENV_PROXY=1 已打开，但没有可用的代理地址（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 都没设），仍然直连",
			},
		]);
	});

	it("按固定顺序列出所有生效的代理变量（含 NO_PROXY）", () => {
		const rows = proxyEnvRows({
			ALL_PROXY: "socks5://proxy.corp.example:1080",
			no_proxy: "localhost,127.0.0.1",
			HTTP_PROXY: "http://proxy.corp.example:8080",
		});
		expect(rows[0]).toEqual({
			name: "代理环境",
			status: "ok",
			detail:
				"HTTP_PROXY=http://proxy.corp.example:8080、ALL_PROXY=socks5://proxy.corp.example:1080、no_proxy=localhost,127.0.0.1",
		});
	});

	it("代理地址里的口令打码，用户名保留", () => {
		expect(maskProxyCredential("http://alice:s3cr3t@proxy.corp.example:8080")).toBe(
			"http://alice:***@proxy.corp.example:8080",
		);
		expect(maskProxyCredential("http://proxy.corp.example:8080")).toBe("http://proxy.corp.example:8080");
	});

	it("带口令的代理行不打印口令", () => {
		expect(proxyEnvRows({ HTTPS_PROXY: "http://alice:s3cr3t@proxy.corp.example:8080" })[0]).toEqual({
			name: "代理环境",
			status: "ok",
			detail: "HTTPS_PROXY=http://alice:***@proxy.corp.example:8080",
		});
	});
});

describe("hookRows", () => {
	it("没配钩子时给中性说明，不是警告", () => {
		expect(hookRows()).toEqual([{ name: "钩子", status: "ok", detail: "未配置 PreToolUse 钩子" }]);
		expect(hookRows({ raw: { preToolUse: [] } })).toEqual([
			{ name: "钩子", status: "ok", detail: "未配置 PreToolUse 钩子" },
		]);
	});

	it("真实存在的可执行文件判 ok，detail 列出条数与 matcher", async () => {
		const script = join(dir, "guard.mjs");
		await writeFile(script, "process.exit(0)\n", "utf-8");
		await chmod(script, 0o755);
		expect(hookRows({ raw: { preToolUse: [{ matcher: "bash", command: script }] } })).toEqual([
			{ name: "钩子", status: "ok", detail: "已配置 1 条 PreToolUse 钩子，匹配：bash" },
		]);
	});

	it("多条钩子按顺序列出 matcher，引号里的程序带空格也认得", async () => {
		const spaced = join(dir, "quoted hook.mjs");
		const plain = join(dir, "plain-hook.mjs");
		for (const script of [spaced, plain]) {
			await writeFile(script, "process.exit(0)\n", "utf-8");
			await chmod(script, 0o755);
		}
		const rows = hookRows({
			raw: {
				preToolUse: [
					// 路径里有空格，得加引号才算一个程序；不加引号时按 shell 语义切在空格处。
					{ matcher: "bash", command: `"${spaced}" --strict` },
					{ matcher: "write,edit", command: plain },
				],
			},
		});
		expect(rows).toEqual([
			{ name: "钩子", status: "ok", detail: "已配置 2 条 PreToolUse 钩子，匹配：bash、write,edit" },
		]);
	});

	it("程序找不到时判 warn：运行时是放行加提示，不阻断工作", () => {
		const missing = join(dir, "nope-hook");
		expect(hookRows({ raw: { preToolUse: [{ matcher: "*", command: missing }] } })).toEqual([
			{ name: "钩子", status: "warn", detail: `PreToolUse 钩子的第 1 条：找不到命令 ${missing}` },
		]);
	});

	it("程序指向目录时判 warn，并点出那个目录", async () => {
		const folder = join(dir, "hooks-dir");
		await mkdir(folder, { recursive: true });
		expect(hookRows({ raw: { preToolUse: [{ matcher: "*", command: folder }] } })).toEqual([
			{ name: "钩子", status: "warn", detail: `PreToolUse 钩子的第 1 条：命令指向目录 ${folder}` },
		]);
	});

	it("存在但不可执行时判 warn（注入探测，不依赖本机平台）", () => {
		const probe = (candidate: string): HookProgramKind =>
			candidate === "/opt/guard.sh" ? "not-executable" : "missing";
		expect(
			hookRows({
				raw: { preToolUse: [{ matcher: "*", command: "/opt/guard.sh" }] },
				resolve: { platform: "linux", probe },
			}),
		).toEqual([
			{ name: "钩子", status: "warn", detail: "PreToolUse 钩子的第 1 条：命令没有可执行权限 /opt/guard.sh" },
		]);
	});

	it("matcher 不是字符串判 fail，并点出条目序号", () => {
		expect(hookRows({ raw: { preToolUse: [{ matcher: 1, command: join(dir, "guard") }] } })).toEqual([
			{ name: "钩子", status: "fail", detail: "PreToolUse 钩子的第 1 条：matcher 不是字符串" },
		]);
	});

	it("command 为空或不是字符串判 fail，多条问题一次说完", () => {
		expect(hookRows({ raw: { preToolUse: [{ matcher: "*", command: "   " }] } })).toEqual([
			{ name: "钩子", status: "fail", detail: "PreToolUse 钩子的第 1 条：command 不是非空字符串" },
		]);
		expect(hookRows({ raw: { preToolUse: [{ matcher: "*" }, { matcher: "*", command: 3 }] } })).toEqual([
			{
				name: "钩子",
				status: "fail",
				detail:
					"PreToolUse 钩子的第 1 条：command 不是非空字符串；PreToolUse 钩子的第 2 条：command 不是非空字符串",
			},
		]);
	});

	it("条目不是对象判 fail，并点出条目序号", () => {
		expect(hookRows({ raw: { preToolUse: ["node guard.mjs"] } })).toEqual([
			{ name: "钩子", status: "fail", detail: "PreToolUse 钩子的第 1 条不是对象" },
		]);
	});

	it("hooks 不是对象、preToolUse 不是数组都判 fail", () => {
		expect(hookRows({ raw: "nope" })).toEqual([{ name: "钩子", status: "fail", detail: "配置里的 hooks 不是对象" }]);
		expect(hookRows({ raw: { preToolUse: "*" } })).toEqual([
			{ name: "钩子", status: "fail", detail: "配置里的 hooks.preToolUse 不是数组" },
		]);
	});

	it("报错行末尾附上出问题的配置文件路径", () => {
		expect(hookRows({ raw: { preToolUse: [null] }, source: "/home/u/.limkenion/config.json" })).toEqual([
			{
				name: "钩子",
				status: "fail",
				detail: "PreToolUse 钩子的第 1 条不是对象（/home/u/.limkenion/config.json）",
			},
		]);
	});

	it("命令里含变量或 ~ 时不误报找不到，只说明没做展开", () => {
		expect(hookRows({ raw: { preToolUse: [{ matcher: "*", command: "$HOME/bin/guard.sh" }] } })).toEqual([
			{
				name: "钩子",
				status: "ok",
				detail: "已配置 1 条 PreToolUse 钩子，匹配：*；PreToolUse 钩子的第 1 条的命令含变量或 ~，体检不做展开",
			},
		]);
	});

	it("Windows 上裸命令按 PATHEXT 依次补扩展名（注入探测，任何平台都能跑）", () => {
		const tried: string[] = [];
		const rows = hookRows({
			raw: { preToolUse: [{ matcher: "*", command: "my-hook" }] },
			resolve: {
				platform: "win32",
				pathDirs: ["C:\\tools"],
				pathExt: ".CMD;.EXE",
				probe: (candidate) => {
					tried.push(candidate);
					return candidate === "C:\\tools\\my-hook.CMD" ? "executable" : "missing";
				},
			},
		});
		// 先试原名，再按 PATHEXT 顺序；命中最先存在的那个就停。
		expect(tried).toEqual(["C:\\tools\\my-hook", "C:\\tools\\my-hook.CMD"]);
		expect(rows).toEqual([{ name: "钩子", status: "ok", detail: "已配置 1 条 PreToolUse 钩子，匹配：*" }]);
	});

	it.skipIf(process.platform !== "win32")("Windows 上裸命令解析到真实存在的 .cmd", async () => {
		await writeFile(join(dir, "my-hook.cmd"), "@echo off\r\n", "utf-8");
		expect(
			hookRows({
				raw: { preToolUse: [{ matcher: "*", command: "my-hook" }] },
				resolve: { platform: "win32", pathDirs: [dir], pathExt: ".CMD" },
			}),
		).toEqual([{ name: "钩子", status: "ok", detail: "已配置 1 条 PreToolUse 钩子，匹配：*" }]);
	});
});

describe("resolveHookCommand", () => {
	it("带引号的命令只取引号里的程序，后面的参数不算路径", () => {
		const seen: string[] = [];
		const resolution = resolveHookCommand('"C:\\Program Files\\hook.cmd" --strict', {
			platform: "win32",
			probe: (candidate) => {
				seen.push(candidate);
				return "executable";
			},
		});
		// 程序部分整段带着空格，参数 --strict 不参与解析。
		expect(seen).toEqual(["C:\\Program Files\\hook.cmd"]);
		expect(resolution).toEqual({
			program: "C:\\Program Files\\hook.cmd",
			status: "ok",
			path: "C:\\Program Files\\hook.cmd",
		});
	});

	it("相对路径对着 cwd 解析，裸命令名到 PATH 里找", () => {
		const probe = (candidate: string): HookProgramKind =>
			candidate === "/work/bin/guard" ? "executable" : "missing";
		expect(resolveHookCommand("./bin/guard", { platform: "linux", cwd: "/work", probe })).toEqual({
			program: "./bin/guard",
			status: "ok",
			path: "/work/bin/guard",
		});
		expect(
			resolveHookCommand("guard", { platform: "linux", pathDirs: ["/usr/bin", "/opt/bin"], probe: () => "missing" }),
		).toEqual({ program: "guard", status: "missing", path: "guard" });
	});

	it.skipIf(process.platform === "win32")("POSIX 上光有文件不算数，必须带可执行位", async () => {
		const script = join(dir, "plain.sh");
		await writeFile(script, "#!/bin/sh\n", "utf-8");
		await chmod(script, 0o644);
		expect(resolveHookCommand(script, { platform: "linux" })).toEqual({
			program: script,
			status: "not-executable",
			path: script,
		});
	});
});

describe("describeNetworkGuidance", () => {
	it("TLS 错误指向 NODE_EXTRA_CA_CERTS，并说明 fetch 不读 SSL_CERT_FILE", () => {
		const text = describeNetworkGuidance(codedError("unable to verify", "SELF_SIGNED_CERT_IN_CHAIN"), {});
		expect(text).toContain("NODE_EXTRA_CA_CERTS");
		expect(text).toContain("SSL_CERT_FILE");
		expect(text).toContain("不读");
	});

	it("只看错误正文也能认出证书失败", () => {
		const text = describeNetworkGuidance(new Error("unable to verify the first certificate"), {});
		expect(text).toContain("NODE_EXTRA_CA_CERTS");
	});

	it("错误码挂在 cause 上时同样能认出来", () => {
		const text = describeNetworkGuidance(causedError("fetch failed", "DEPTH_ZERO_SELF_SIGNED_CERT"), {});
		expect(text).toContain("NODE_EXTRA_CA_CERTS");
		expect(text).toContain("DEPTH_ZERO_SELF_SIGNED_CERT");
	});

	it("TLS 失败且代理没生效时，顺带点名 NODE_USE_ENV_PROXY", () => {
		const text = describeNetworkGuidance(codedError("certificate has expired", "CERT_HAS_EXPIRED"), {
			HTTPS_PROXY: "http://proxy.corp.example:8080",
		});
		expect(text).toContain("NODE_USE_ENV_PROXY=1");
	});

	it("ENOTFOUND 且没配代理：说清是域名解析问题", () => {
		expect(describeNetworkGuidance(codedError("getaddrinfo ENOTFOUND api.deepseek.com", "ENOTFOUND"), {})).toBe(
			"域名解析不了（ENOTFOUND），且没有设置任何代理变量：请检查网络、DNS 与 --base-url 指向的地址。",
		);
	});

	it("连不上且配了代理但代理没生效：点明这是最常见的原因", () => {
		expect(
			describeNetworkGuidance(codedError("connect ECONNREFUSED", "ECONNREFUSED"), {
				HTTPS_PROXY: "http://proxy.corp.example:8080",
			}),
		).toBe(
			"连接失败（ECONNREFUSED）：已配置代理变量，但未设置 NODE_USE_ENV_PROXY=1（该开关需要 Node 24 及以上），Node 自带 fetch 忽略了它，请求直连目标地址，这是最常见的原因。",
		);
	});

	it("连不上且代理已生效：提示先确认代理自身可达", () => {
		const text = describeNetworkGuidance(codedError("connect ETIMEDOUT", "ETIMEDOUT"), {
			HTTPS_PROXY: "http://proxy.corp.example:8080",
			NODE_USE_ENV_PROXY: "1",
		});
		expect(text).toContain("代理变量已设置且 NODE_USE_ENV_PROXY=1 已打开");
	});

	it("认不出的错误也给一条能试的方向，且不谎称能修好", () => {
		const text = describeNetworkGuidance(new Error("fetch failed"), {});
		expect(text).toContain("HTTPS_PROXY");
		expect(text).toContain("NODE_USE_ENV_PROXY=1");
	});
});

describe("doctor 命令的诊断接线", () => {
	it("探测失败时多打代理行与证书诊断行，退出码仍是 1", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("unable to verify the first certificate");
		}) as unknown as typeof fetch;
		process.env[AGENT_DIR_ENV] = dir;
		process.env[SESSION_DIR_ENV] = dir;
		try {
			const { code, output } = await captureStdout(() => runDoctorCommand([]));
			expect(code).toBe(1);
			expect(output).toContain("  ✓ 代理环境：未设置，请求直连目标地址\n");
			expect(output).toContain("  ! 连接诊断：TLS 证书校验没过");
			expect(output).toContain("NODE_EXTRA_CA_CERTS");
			expect(output).toContain("SSL_CERT_FILE");
		} finally {
			globalThis.fetch = original;
			delete process.env[AGENT_DIR_ENV];
			delete process.env[SESSION_DIR_ENV];
		}
	});

	it("配置里的钩子接线到 doctor 输出：程序找不到只判警告，退出码仍是 0", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
		const configPath = join(dir, "config.json");
		const missing = join(dir, "missing-hook");
		await writeFile(
			configPath,
			JSON.stringify({ hooks: { preToolUse: [{ matcher: "*", command: missing }] } }),
			"utf-8",
		);
		process.env[AGENT_DIR_ENV] = dir;
		process.env[SESSION_DIR_ENV] = dir;
		// managed 层也指到临时目录：结论不跟着开发机上的机器级配置飘。
		process.env[MANAGED_SETTINGS_ENV] = join(dir, "managed-settings.json");
		try {
			const { code, output } = await captureStdout(() => runDoctorCommand([]));
			expect(code).toBe(0);
			expect(output).toContain(`  ! 钩子：PreToolUse 钩子的第 1 条：找不到命令 ${missing}（${configPath}）\n`);
		} finally {
			globalThis.fetch = original;
			delete process.env[AGENT_DIR_ENV];
			delete process.env[SESSION_DIR_ENV];
			delete process.env[MANAGED_SETTINGS_ENV];
		}
	});
});
