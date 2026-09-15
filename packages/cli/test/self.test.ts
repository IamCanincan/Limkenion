/**
 * `limkenion self` 的测试。
 *
 * 这里全部注入执行器与「起安装进程」的实现，不真的跑 npm、也不真的装东西——要验证的是**顺序与
 * 边界**：门禁不过就不许往下走、失败路径不许动当前版本、回滚没有旧版时要明说。
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseSelfArgs,
	pruneSelfVersions,
	readSelfState,
	readSelfVersions,
	runSelfCommand,
	runSelfUpdate,
	scheduleSelfRollback,
	selfPaths,
} from "../src/commands/self.ts";
import { AGENT_DIR_ENV } from "../src/config.ts";

const originalAgentDir = process.env[AGENT_DIR_ENV];
let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "limkenion-self-"));
	process.env[AGENT_DIR_ENV] = dir;
});

afterEach(async () => {
	if (originalAgentDir === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = originalAgentDir;
	}
	await rm(dir, { recursive: true, force: true });
});

/** 造一个「源码目录」：有 package.json 与打包产物 */
async function makeSource(version: string): Promise<string> {
	const source = join(dir, `src-${version}`);
	await mkdir(join(source, "release"), { recursive: true });
	await writeFile(join(source, "package.json"), JSON.stringify({ name: "limkenion", version }), "utf-8");
	await writeFile(join(source, "release", `limkenion-${version}.tgz`), "假的 tgz", "utf-8");
	return source;
}

/** 记录调用过的命令与是否起过安装进程 */
function recorder(codes: number[]) {
	const calls: string[] = [];
	let spawned = 0;
	return {
		calls,
		get spawned() {
			return spawned;
		},
		deps: {
			// 签名要与 `CommandRunner` 一致（第 4 个参数是「逐行回报」；这里不关心输出）
			run: async (command: string, args: string[], _cwd?: string, _onLine?: (line: string) => void) => {
				calls.push(`${command} ${args.join(" ")}`);
				return codes.shift() ?? 0;
			},
			spawnInstaller: () => {
				spawned += 1;
				return true;
			},
			log: () => undefined,
		},
	};
}

describe("parseSelfArgs", () => {
	it("默认 update，可切 rollback/status/versions，支持 --from、--dry-run 与 --prune", () => {
		expect(parseSelfArgs([])).toEqual({ action: "update", dryRun: false, prune: false });
		expect(parseSelfArgs(["rollback"])).toEqual({ action: "rollback", dryRun: false, prune: false });
		expect(parseSelfArgs(["status"])).toEqual({ action: "status", dryRun: false, prune: false });
		expect(parseSelfArgs(["versions"])).toEqual({ action: "versions", dryRun: false, prune: false });
		expect(parseSelfArgs(["versions", "--prune"])).toEqual({ action: "versions", dryRun: false, prune: true });
		expect(parseSelfArgs(["--from", "/tmp/repo", "--dry-run"])).toEqual({
			action: "update",
			from: "/tmp/repo",
			dryRun: true,
			prune: false,
		});
	});

	it("--from 缺值或参数不认识时报错；--prune 只跟 versions 一起用", () => {
		expect(parseSelfArgs(["--from"])).toEqual({ error: expect.stringContaining("--from") });
		expect(parseSelfArgs(["--nope"])).toEqual({ error: expect.stringContaining("未知参数") });
		// 唯一会删东西的动作必须显式给：写成别的子命令一律拒绝，免得误删
		expect(parseSelfArgs(["--prune"])).toEqual({ error: expect.stringContaining("--prune") });
		expect(parseSelfArgs(["update", "--prune"])).toEqual({ error: expect.stringContaining("--prune") });
	});
});

describe("self update 的顺序与边界", () => {
	it("门禁不过就停在原地：不打包、不起安装进程、不动版本记录", async () => {
		const source = await makeSource("9.9.9");
		const spy = recorder([1]);
		const code = await runSelfCommand(["--from", source], spy.deps);
		expect(code).toBe(1);
		expect(spy.calls).toEqual(["npm run check"]);
		expect(spy.spawned).toBe(0);
		expect(readSelfState()).toEqual({});
	});

	it("门禁过、打包失败也不往下走", async () => {
		const source = await makeSource("9.9.9");
		const spy = recorder([0, 1]);
		expect(await runSelfCommand(["--from", source], spy.deps)).toBe(1);
		expect(spy.calls).toEqual(["npm run check", "npm run release:package"]);
		expect(spy.spawned).toBe(0);
	});

	it("--dry-run 做到打包为止：记下产物当 current，但不安装", async () => {
		const source = await makeSource("9.9.9");
		const spy = recorder([0, 0]);
		expect(await runSelfCommand(["--from", source, "--dry-run"], spy.deps)).toBe(0);
		expect(spy.spawned).toBe(0);
		const state = readSelfState();
		expect(state.current).toContain("limkenion-9.9.9-");
		expect(state.current?.startsWith(selfPaths().dir)).toBe(true);
	});

	it("源码目录不对时给出可操作的提示", async () => {
		const spy = recorder([]);
		expect(await runSelfCommand(["--from", join(dir, "不存在")], spy.deps)).toBe(1);
		expect(spy.calls).toEqual([]);
	});
});

describe("self rollback", () => {
	it("没有上一版时明说，而不是假装回滚", async () => {
		const spy = recorder([]);
		expect(await runSelfCommand(["rollback"], spy.deps)).toBe(1);
		expect(spy.spawned).toBe(0);
	});

	it("有上一版时把 current 与 previous 对调，并交安装进程执行", async () => {
		await runSelfCommand(["rollback"], { ...recorder([]).deps, spawnInstaller: () => true });
		// 先手动写一份记录，模拟「已经自更新过一次」
		const paths = selfPaths();
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.state, JSON.stringify({ current: "/v/new.tgz", previous: "/v/old.tgz" }), "utf-8");
		const spy = recorder([]);
		expect(await runSelfCommand(["rollback"], spy.deps)).toBe(0);
		expect(spy.spawned).toBe(1);
		expect(readSelfState()).toEqual({ current: "/v/old.tgz", previous: "/v/new.tgz" });
	});
});

/*
 * 网页上那个「回滚到上一版」按钮走的是 `scheduleSelfRollback`——与 `self rollback` 同一段动作。
 * 单独测它，是因为它是一条**有副作用**的路（会挂一个 `npm install -g` 的分离进程），
 * 而网页那侧的路由只能靠注入替身才敢测。
 */
describe("scheduleSelfRollback", () => {
	it("没有上一版时返回原因，不起安装进程", async () => {
		let spawned = 0;
		const outcome = scheduleSelfRollback({
			spawnInstaller: () => {
				spawned += 1;
				return true;
			},
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false ? outcome.reason : "").toContain("没有可回滚的版本");
		expect(spawned).toBe(0);
	});

	it("有上一版时挂上安装进程，并对调 current / previous", async () => {
		const paths = selfPaths();
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.state, JSON.stringify({ current: "/v/new.tgz", previous: "/v/old.tgz" }), "utf-8");

		const jobs: string[] = [];
		const outcome = scheduleSelfRollback({
			spawnInstaller: (script, jobFile) => {
				jobs.push(jobFile);
				// 真起的是那个分离安装脚本（`install.cjs`）；这里只确认它被指到了，不真的跑
				expect(script.endsWith("install.cjs")).toBe(true);
				return true;
			},
		});
		expect(outcome).toEqual({ ok: true, tgz: "/v/old.tgz", log: paths.log });
		expect(jobs).toHaveLength(1);
		// 装完之后 `self status` 要说得清现在装的是哪一版
		expect(readSelfState()).toEqual({ current: "/v/old.tgz", previous: "/v/new.tgz" });
	});

	it("安装进程起不来时不改记录（不能让状态说「已经回滚了」）", async () => {
		const paths = selfPaths();
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.state, JSON.stringify({ current: "/v/new.tgz", previous: "/v/old.tgz" }), "utf-8");
		const outcome = scheduleSelfRollback({ spawnInstaller: () => false });
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false ? outcome.reason : "").toContain("无法启动安装进程");
		expect(readSelfState()).toEqual({ current: "/v/new.tgz", previous: "/v/old.tgz" });
	});
});

describe("self status", () => {
	it("没有任何记录时也不报错", async () => {
		const spy = recorder([]);
		const stdout = process.stdout.write.bind(process.stdout);
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			expect(await runSelfCommand(["status"], spy.deps)).toBe(0);
		} finally {
			process.stdout.write = stdout;
		}
		expect(spy.spawned).toBe(0);
	});
});

/*
 * `runSelfUpdate` 是终端 `self update` 与网页那张卡片的「更新」按钮**共用**的一段：
 * 门禁 → 打包 → 记下旧版 → 交给分离进程。这里用注入的执行器与「起安装进程」替身验顺序与边界，
 * 顺带钉住 `--dry-run`（做到打包为止，**不挂安装作业**）与进度回调（网页靠它显示跑到哪了）。
 */
describe("runSelfUpdate", () => {
	it("顺序：门禁 → 打包 → 挂作业；并把产物记成 current、旧 current 记成 previous", async () => {
		const source = await makeSource("9.9.9");
		const paths = selfPaths();
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.state, JSON.stringify({ current: "/v/old.tgz" }), "utf-8");

		const steps: string[] = [];
		const lines: string[] = [];
		const spy = recorder([0, 0]);
		const outcome = await runSelfUpdate({
			source,
			deps: {
				run: async (command, args, cwd, onLine) => {
					onLine?.("> 构建输出一行");
					return spy.deps.run(command, args, cwd);
				},
				spawnInstaller: () => true,
			},
			onStep: (step) => steps.push(step),
			onLine: (line) => lines.push(line),
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.ok === true ? outcome.scheduled : false).toBe(true);
		expect(outcome.ok === true ? outcome.version : "").toBe("9.9.9");
		expect(spy.calls).toEqual(["npm run check", "npm run release:package"]);
		expect(steps).toEqual(["check", "package", "install"]);
		// 两条命令各回报一行（真跑时这里就是 npm 的输出）
		expect(lines).toEqual(["> 构建输出一行", "> 构建输出一行"]);
		// 记下的是**复制到 versions/** 的那一份（不是源码目录里的 release/*.tgz）
		const state = readSelfState();
		expect(state.current?.startsWith(paths.dir)).toBe(true);
		expect(state.current).toContain("limkenion-9.9.9-");
		expect(state.previous).toBe("/v/old.tgz");
		expect(existsSync(state.current ?? "")).toBe(true);
	});

	it("门禁不过就停在原地：不打包、不挂作业、不动记录", async () => {
		const source = await makeSource("9.9.9");
		const spy = recorder([1]);
		const outcome = await runSelfUpdate({ source, deps: spy.deps });
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false ? outcome.reason : "").toContain("门禁没通过");
		expect(spy.calls).toEqual(["npm run check"]);
		expect(spy.spawned).toBe(0);
		expect(readSelfState()).toEqual({});
	});

	it("打包失败同样不动记录", async () => {
		const source = await makeSource("9.9.9");
		const spy = recorder([0, 1]);
		const outcome = await runSelfUpdate({ source, deps: spy.deps });
		expect(outcome.ok).toBe(false);
		expect(spy.spawned).toBe(0);
		expect(readSelfState()).toEqual({});
	});

	it("--dry-run：记下产物但不挂安装作业", async () => {
		const source = await makeSource("9.9.9");
		const spy = recorder([0, 0]);
		const outcome = await runSelfUpdate({ source, deps: spy.deps, dryRun: true });
		expect(outcome.ok === true ? outcome.scheduled : true).toBe(false);
		expect(spy.spawned).toBe(0);
		expect(readSelfState().current).toContain("limkenion-9.9.9-");
	});

	it("源码目录不对时直接说清，一条命令都不跑", async () => {
		const spy = recorder([]);
		const outcome = await runSelfUpdate({ source: join(dir, "不存在"), deps: spy.deps });
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false ? outcome.reason : "").toContain("源码目录");
		expect(spy.calls).toEqual([]);
	});
});

/*
 * `self versions`：历史安装包越攒越多（这台机器上曾经 69 个 tgz + 59 份整份备份目录，约 240MB）。
 * 清理入口的规则只有一条：**留下的只有在用的那一版、回滚点，以及最新一份安装前备份**。
 */
describe("self versions", () => {
	/** 造一份 versions 目录：两个 tgz（current/previous）、两份备份目录、一个其它文件 */
	async function makeVersions(): Promise<{ current: string; previous: string }> {
		const paths = selfPaths();
		await mkdir(paths.dir, { recursive: true });
		const current = join(paths.dir, "limkenion-1.3.1-1000.tgz");
		const previous = join(paths.dir, "limkenion-1.3.1-2000.tgz");
		await writeFile(current, "x".repeat(100), "utf-8");
		await writeFile(previous, "x".repeat(200), "utf-8");
		await writeFile(join(paths.dir, "limkenion-1.3.1-3000.tgz"), "x".repeat(50), "utf-8");
		// 旧流程留下的整份备份目录（现在没有任何代码读它）
		for (const stamp of ["100", "200", "300"]) {
			const backup = join(paths.dir, `installed-before-${stamp}`);
			await mkdir(backup, { recursive: true });
			await writeFile(join(backup, "package.json"), "x".repeat(10), "utf-8");
		}
		await writeFile(paths.state, JSON.stringify({ current, previous }), "utf-8");
		return { current, previous };
	}

	it("认出在用的那一版与回滚点，并把备份目录与其它文件分开列", async () => {
		const { current, previous } = await makeVersions();
		const versions = readSelfVersions();
		expect(versions.keep).toEqual([current, previous]);
		expect(versions.packages).toHaveLength(3);
		expect(
			versions.packages
				.filter((item) => item.keep)
				.map((item) => item.path)
				.sort(),
		).toEqual([current, previous].sort());
		expect(versions.backups).toHaveLength(3);
		// 备份目录是目录，大小按里面文件算
		expect(versions.backups.every((item) => item.size === 10)).toBe(true);
		expect(versions.others).toHaveLength(1);
		// 只算「历史包」那两类的合计（state.json 等其它文件也占地方，但那不是历史包）
		const historical =
			versions.packages.reduce((total, item) => total + item.size, 0) +
			versions.backups.reduce((total, item) => total + item.size, 0);
		expect(historical).toBe(100 + 200 + 50 + 30);
	});

	it("清理：只留 ★ 与最新一份备份，其它全删并报出释放多少", async () => {
		const { current, previous } = await makeVersions();
		const before = readSelfVersions();
		const outcome = pruneSelfVersions(before);
		// 删掉：一个多余 tgz（50）+ 两份旧备份（各 10）
		expect(outcome.removed).toHaveLength(3);
		expect(outcome.freedBytes).toBe(70);

		const after = readSelfVersions();
		expect(after.packages.map((item) => item.path).sort()).toEqual([current, previous].sort());
		expect(after.backups).toHaveLength(1);
		// 其它文件（state.json）一律不动：那是这套机制本身，不是历史包
		expect(after.others).toHaveLength(1);
		expect(readSelfState()).toEqual({ current, previous });
	});

	it("目录不存在时是空的，清理也不报错", async () => {
		const versions = readSelfVersions();
		expect(versions.packages).toEqual([]);
		expect(versions.backups).toEqual([]);
		expect(pruneSelfVersions(versions)).toEqual({ removed: [], freedBytes: 0 });
	});
});
