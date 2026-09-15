/**
 * `limkenion self`：让 agent 能安全地换掉自己。
 *
 * 自改最难的不是改代码，而是**换掉正在运行的那份**。两条硬约束决定了这里的做法：
 *
 * 1. **门禁不过就不装**：先跑 `npm run check`（biome + 依赖/许可/导入检查 + tsgo），失败直接退出。
 *    让一个没过测试的版本顶掉能用的版本，是自更新最糟糕的失败方式。
 * 2. **不在运行中的进程里就地覆盖自己**：Windows 上正被加载的文件无法替换，`npm install -g`
 *    会直接失败或留下半套文件。所以安装交给一个**分离的子进程**：它等父进程退出后再动手，
 *    结果写进日志；失败时自动装回上一版。
 *
 * 产物留在 `<配置目录>/versions/`：每次安装过的 tgz 都在，`state.json` 记住当前与上一版，
 * 于是回滚只是「拿 previous 再跑一次同样的安装」。
 */

import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { decodeProcessOutput } from "limkenion-core";
import { APP_NAME, getAgentDir } from "../config.ts";
import type { Command } from "./command.ts";

/** self 子命令：元信息住在命令自己这里 */
export const selfCommand: Command = {
	name: "self",
	synopsis: "self [update|rollback|status|versions]",
	summary: "改自己：过门禁、打包、退出后安装，失败自动回滚；versions 清理历史安装包",
	run: (argv) => runSelfCommand(argv),
};

/** 自更新相关文件都放这里 */
export const VERSIONS_DIR_NAME = "versions";

/** 安装结果，供 `self status` 与下次启动查看 */
export interface SelfResult {
	ok: boolean;
	version?: string;
	error?: string;
	rolledBack?: boolean;
	at: string;
}

/** 当前/上一版记录 */
export interface SelfState {
	current?: string;
	previous?: string;
}

/** 分离安装进程要的作业描述 */
interface InstallJob {
	parentPid: number;
	npm: string;
	bin: string;
	tgz: string;
	version: string;
	previous?: string;
	log: string;
	result: string;
}

/** 自更新的文件位置 */
export function selfPaths(): { dir: string; state: string; log: string; result: string; script: string } {
	const dir = join(getAgentDir(), VERSIONS_DIR_NAME);
	return {
		dir,
		state: join(dir, "state.json"),
		log: join(dir, "install.log"),
		result: join(dir, "last-result.json"),
		script: join(dir, "install.cjs"),
	};
}

/** 解析 self 子命令的参数 */
export function parseSelfArgs(
	argv: string[],
):
	| { action: "update" | "rollback" | "status" | "versions"; from?: string; dryRun: boolean; prune: boolean }
	| { error: string } {
	let action: "update" | "rollback" | "status" | "versions" = "update";
	let from: string | undefined;
	let dryRun = false;
	let prune = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "update" || arg === "rollback" || arg === "status" || arg === "versions") {
			action = arg;
			continue;
		}
		if (arg === "--from") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return { error: "--from 后面要跟源码目录" };
			}
			from = value;
			index += 1;
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--prune") {
			// 只有 versions 认它：那是唯一会删东西的动作，必须显式给
			prune = true;
			continue;
		}
		return { error: `未知参数：${arg}` };
	}
	if (prune && action !== "versions") {
		return { error: "--prune 只跟 self versions 一起用" };
	}
	return { action, from, dryRun, prune };
}

/** 读 state.json；缺失或损坏都当作「没有记录」 */
export function readSelfState(): SelfState {
	const path = selfPaths().state;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as SelfState;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

/** 读上次安装结果 */
function readSelfResult(): SelfResult | null {
	try {
		const parsed = JSON.parse(readFileSync(selfPaths().result, "utf-8")) as SelfResult;
		return typeof parsed?.ok === "boolean" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * 自更新的全部状态，**结构化的**。
 *
 * `self status`（终端）与网页「设置」面板里那张卡片共用这一份：两边各拼一遍字符串的话，
 * 「上一版到底能不能回滚」「上次更新成没成」这些判断迟早会在一边走偏。
 * 它只读本机的 `versions/` 目录，不碰网络、不装东西。
 */
export interface SelfStatus {
	/** 当前记录：上次装过的 tgz 绝对路径；从没自更新过就是 null */
	current: string | null;
	/** 上一版（回滚点）：`limkenion self rollback` 会装回它 */
	previous: string | null;
	/** 上次自更新的结果 */
	result: SelfResult | null;
	/** 安装日志路径 */
	log: string;
	/** 各版本 tgz 的存放目录 */
	dir: string;
}

/** 读自更新状态；`self status` 与网页那张卡片都走这里 */
export function readSelfStatus(): SelfStatus {
	const state = readSelfState();
	const paths = selfPaths();
	return {
		current: state.current ?? null,
		previous: state.previous ?? null,
		result: readSelfResult(),
		log: paths.log,
		dir: paths.dir,
	};
}

/** 上次自更新结果的人话（终端与网页共用同一句） */
export function describeSelfResult(result: SelfResult | null): string {
	if (result === null) {
		return "没有记录";
	}
	const outcome = result.ok
		? `成功${result.version === undefined || result.version === "" ? "" : `（${result.version}）`}`
		: `失败（${result.error ?? "未知原因"}${result.rolledBack === true ? "，已回滚" : ""}）`;
	return `${outcome}　${result.at}`;
}

/**
 * 分离安装脚本的源码。
 *
 * 写成独立文件而不是 `node -e`：一来引号与转义在 Windows 上极易出错，二来出问题能直接看这个文件。
 * 它只做四件事：等父进程退出、装新版本、校验版本号、失败就用上一版装回去。
 */
function installerSource(): string {
	return `// 由 limkenion self 写入：等父进程退出后安装新版本，失败自动回滚。
const { execFileSync } = require("node:child_process");
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");

const job = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const log = (line) => appendFileSync(job.log, "[" + new Date().toISOString() + "] " + line + "\\n", "utf-8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
// Windows 上 npm 是 .cmd 包装脚本：Node 出于安全考虑**拒绝不带 shell 直接 spawn 它**，所以这里
// 必须走 shell。做法是只给一条命令字符串（不传参数数组）——既避开"参数被拼接"的 DEP0190 警告，
// 也不让用户输入进入命令行：路径由我们自己生成，这里显式加引号。
const install = (tgz) =>
	execFileSync(\`\${job.npm} install -g "\${tgz}"\`, { shell: true, stdio: "pipe", encoding: "utf-8" });
const version = () => execFileSync(\`\${job.bin} --version\`, { shell: true, encoding: "utf-8" }).trim();

(async () => {
	log("等待 " + job.parentPid + " 退出后再安装（运行中的文件在 Windows 上换不掉）");
	for (let i = 0; i < 900 && alive(job.parentPid); i += 1) {
		await sleep(200);
	}
	try {
		log("安装 " + job.tgz);
		install(job.tgz);
		const actual = version();
		log("已安装版本 " + actual);
		if (job.version && actual !== job.version) {
			throw new Error("版本不符：期望 " + job.version + "，实际 " + actual);
		}
		writeFileSync(job.result, JSON.stringify({ ok: true, version: actual, at: new Date().toISOString() }), "utf-8");
		log("完成");
	} catch (error) {
		const message = String((error && error.message) || error);
		log("失败：" + message);
		let rolledBack = false;
		if (job.previous) {
			try {
				log("回滚到 " + job.previous);
				install(job.previous);
				rolledBack = true;
				log("回滚完成");
			} catch (again) {
				log("回滚也失败：" + String((again && again.message) || again));
			}
		}
		writeFileSync(
			job.result,
			JSON.stringify({ ok: false, error: message, rolledBack, at: new Date().toISOString() }),
			"utf-8",
		);
	}
})();
`;
}

/** 跑一条命令并等它结束；测试里可以注入 */
export type CommandRunner = (
	command: string,
	args: string[],
	cwd: string,
	/** 给了就逐行回报输出（网页那张卡片靠它显示「跑到哪一行了」）；不给就直接继承 stdio */
	onLine?: (line: string) => void,
) => Promise<number>;

/** 默认执行器 */
const defaultRunner: CommandRunner = (command, args, cwd, onLine) =>
	new Promise((resolve) => {
		// 只给一条命令字符串、不传参数数组：Windows 上 .cmd 必须走 shell（Node 拒绝直接 spawn），
		// 而数组配 shell 又会触发 DEP0190 的"参数被拼接"警告。这里 args 全是我们写死的固定值，
		// 用户输入只通过 cwd 传入，不参与命令字符串。
		const child = spawn(`${command} ${args.join(" ")}`, {
			cwd,
			// 要逐行回报时得留住管道；否则按老样子直接继承终端（终端里看得见实时输出）
			stdio: onLine === undefined ? "inherit" : ["ignore", "pipe", "pipe"],
			shell: true,
		});
		if (onLine !== undefined) {
			// 按行切：进度只显示整行，半行会把界面弄花
			let buffer = "";
			const feed = (chunk: Buffer): void => {
				buffer += decodeProcessOutput(chunk);
				let index = buffer.indexOf("\n");
				while (index !== -1) {
					onLine(buffer.slice(0, index));
					buffer = buffer.slice(index + 1);
					index = buffer.indexOf("\n");
				}
			};
			child.stdout?.on("data", feed);
			child.stderr?.on("data", feed);
			child.on("close", () => {
				if (buffer.trim() !== "") {
					onLine(buffer);
				}
			});
		}
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", () => resolve(1));
	});

/** `self` 命令的依赖，便于测试注入 */
export interface SelfDeps {
	run?: CommandRunner;
	/** 起分离安装进程；返回是否成功启动 */
	spawnInstaller?: (script: string, jobFile: string) => boolean;
	log?: (line: string) => void;
}

/** 把作业写进文件并起分离进程 */
function launchInstaller(job: InstallJob, deps: SelfDeps): boolean {
	const paths = selfPaths();
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(paths.script, installerSource(), "utf-8");
	const jobFile = join(paths.dir, "install-job.json");
	writeFileSync(jobFile, JSON.stringify(job, null, 2), "utf-8");
	const spawnInstaller =
		deps.spawnInstaller ??
		((script: string, file: string) => {
			const child = spawn(process.execPath, [script, file], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			child.unref();
			return child.pid !== undefined;
		});
	return spawnInstaller(paths.script, jobFile);
}

/**
 * 安排一次回滚：装回上一版。
 *
 * `self rollback` 与网页「设置」面板那个按钮走的是**同一段**动作（起分离安装进程 + 对调
 * current/previous）。安装进程会等**本进程退出**再动手——Windows 上正在被加载的文件换不掉，
 * 所以调用方拿到 `ok` 之后要告诉用户「停掉这个进程」，而不是以为已经装好了。
 */
export function scheduleSelfRollback(
	deps: SelfDeps = {},
): { ok: true; tgz: string; log: string } | { ok: false; reason: string } {
	const status = readSelfStatus();
	if (status.previous === null) {
		return { ok: false, reason: "没有可回滚的版本（只在至少自更新成功一次之后才有记录）" };
	}
	const paths = selfPaths();
	const started = launchInstaller(
		{
			parentPid: process.pid,
			npm: "npm",
			bin: APP_NAME,
			tgz: status.previous,
			version: "",
			log: paths.log,
			result: paths.result,
		},
		deps,
	);
	if (!started) {
		return { ok: false, reason: "无法启动安装进程" };
	}
	// 对调当前与上一版：装完之后 `self status` 才说得清现在装的是哪一版
	writeFileSync(paths.state, JSON.stringify({ current: status.previous, previous: status.current }, null, 2), "utf-8");
	return { ok: true, tgz: status.previous, log: paths.log };
}

/** 自更新跑到哪一步了；终端与网页各自翻译成人话 */
export type SelfUpdateStep = "check" | "package" | "install";

/**
 * 跑一次自更新：门禁 → 打包 → 记下旧版 → 交给分离进程。
 *
 * **顺序不可调换**，任何一步失败都停在原地（当前装着的版本不受影响）。终端（`self update`）与
 * 网页上那个「更新」按钮走的是同一段——网页那边要的是「异步 + 有进度」，所以这一段不自己打印，
 * 而是通过 `onStep` / `onLine` 把进度交出去：
 * - `onStep`：换到下一步了（跑门禁 / 打包 / 已安排安装）；
 * - `onLine`：构建输出的一行（网页那张卡片显示最后几行，终端不传、直接继承终端输出）。
 */
export async function runSelfUpdate(options: {
	source: string;
	deps?: SelfDeps;
	/** 只做到打包为止（`self update --dry-run`）：记下产物当 current，但**不挂安装作业** */
	dryRun?: boolean;
	onStep?: (step: SelfUpdateStep) => void;
	onLine?: (line: string) => void;
}): Promise<
	| { ok: true; version: string; tgz: string; log: string; previous: string | null; scheduled: boolean }
	| { ok: false; reason: string }
> {
	const deps = options.deps ?? {};
	const run = deps.run ?? defaultRunner;
	const paths = selfPaths();
	const source = options.source;

	if (!existsSync(join(source, "package.json"))) {
		return { ok: false, reason: `${source} 看起来不是 Limkenion 的源码目录（没有 package.json）` };
	}
	options.onStep?.("check");
	if ((await run("npm", ["run", "check"], source, options.onLine)) !== 0) {
		return { ok: false, reason: "门禁没通过，已中止；当前版本未受影响" };
	}
	options.onStep?.("package");
	if ((await run("npm", ["run", "release:package"], source, options.onLine)) !== 0) {
		return { ok: false, reason: "打包失败，已中止" };
	}

	const version = readSourceVersion(source);
	if (version === "") {
		return { ok: false, reason: "读不到源码版本号，已中止" };
	}
	const built = join(source, "release", `${APP_NAME}-${version}.tgz`);
	if (!existsSync(built)) {
		return { ok: false, reason: `打包产物不存在：${built}` };
	}

	mkdirSync(paths.dir, { recursive: true });
	const stored = join(paths.dir, `${APP_NAME}-${version}-${Date.now()}.tgz`);
	copyFileSync(built, stored);
	const state = readSelfState();
	writeFileSync(paths.state, JSON.stringify({ current: stored, previous: state.current }, null, 2), "utf-8");

	// `--dry-run` 到此为止：产物记下了（下一次自更新会把它当「上一版」），但不挂安装作业
	if (options.dryRun === true) {
		return { ok: true, version, tgz: stored, log: paths.log, previous: state.current ?? null, scheduled: false };
	}

	const installed = launchInstaller(
		{
			parentPid: process.pid,
			npm: "npm",
			bin: APP_NAME,
			tgz: stored,
			version,
			previous: state.current,
			log: paths.log,
			result: paths.result,
		},
		deps,
	);
	if (!installed) {
		return { ok: false, reason: "无法启动安装进程" };
	}
	options.onStep?.("install");
	return { ok: true, version, tgz: stored, log: paths.log, previous: state.current ?? null, scheduled: true };
}

/** `self versions` 要列的东西 */
export interface SelfVersions {
	/** 版本记录目录 */
	dir: string;
	/** current / previous 指向的 tgz：**这两个不删**（一个是在用的、一个是回滚点） */
	keep: string[];
	/** 各版本 tgz */
	packages: { path: string; size: number; at: number; keep: boolean }[];
	/** 安装前的整份备份目录：旧流程留下的，现在没有任何代码读它 */
	backups: { path: string; size: number; at: number }[];
	/** 目录里的其它文件（state.json、安装脚本、日志…）：一律不动 */
	others: string[];
	/** 目前一共占多少字节 */
	totalBytes: number;
}

/** 统计一个目录的总大小（读不到就按 0 算，别让清理入口因为一个坏文件失败） */
function directorySize(dir: string): number {
	let total = 0;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	for (const name of entries) {
		const path = join(dir, name);
		try {
			const info = statSync(path);
			total += info.isDirectory() ? directorySize(path) : info.size;
		} catch {
			// 读不到就跳过
		}
	}
	return total;
}

/** 读 `versions/` 目录里有什么：哪些能删、哪些是在用的 */
export function readSelfVersions(): SelfVersions {
	const paths = selfPaths();
	const status = readSelfStatus();
	const keep = [status.current, status.previous].filter((path): path is string => path !== null);
	const versions: SelfVersions = { dir: paths.dir, keep, packages: [], backups: [], others: [], totalBytes: 0 };

	let entries: string[];
	try {
		entries = readdirSync(paths.dir);
	} catch {
		return versions;
	}
	for (const name of entries) {
		const path = join(paths.dir, name);
		let info: ReturnType<typeof statSync>;
		try {
			info = statSync(path);
		} catch {
			continue;
		}
		if (info.isDirectory()) {
			const size = directorySize(path);
			versions.backups.push({ path, size, at: info.mtimeMs });
			versions.totalBytes += size;
			continue;
		}
		if (name.endsWith(".tgz")) {
			versions.packages.push({ path, size: info.size, at: info.mtimeMs, keep: keep.includes(path) });
			versions.totalBytes += info.size;
			continue;
		}
		versions.others.push(path);
		versions.totalBytes += info.size;
	}
	versions.packages.sort((left, right) => right.at - left.at);
	versions.backups.sort((left, right) => right.at - left.at);
	return versions;
}

/**
 * 清理历史安装包。
 *
 * 规则只有一条：**留下的只有「在用的那一版 + 回滚点」的 tgz，以及最新一份安装前备份**。
 * 目录里的其它文件（state.json / 安装脚本 / 日志）一律不动——它们不是历史包，是这套机制本身。
 * 删除项逐条返回，调用方要如实打出来（删了用户 200MB 的东西，不能只有一句「已完成」）。
 */
export function pruneSelfVersions(versions: SelfVersions): { removed: string[]; freedBytes: number } {
	const removed: string[] = [];
	let freedBytes = 0;
	for (const item of versions.packages) {
		if (item.keep) {
			continue;
		}
		try {
			rmSync(item.path, { force: true });
			removed.push(item.path);
			freedBytes += item.size;
		} catch {
			// 删不掉（占用、权限）就留着：清理入口不该因为一个文件失败
		}
	}
	// 备份目录留最新一份：它们是旧流程的产物（现在没有任何代码读），但留一份不吃亏
	for (const item of versions.backups.slice(1)) {
		try {
			rmSync(item.path, { recursive: true, force: true });
			removed.push(item.path);
			freedBytes += item.size;
		} catch {
			// 同上
		}
	}
	return { removed, freedBytes };
}

/**
 * 运行 self 子命令，返回进程退出码。
 *
 * `update` 的顺序不可调换：门禁 → 打包 → 记下旧版 → 交给分离进程。任何一步失败都停在原地，
 * 当前装着的版本不受影响。
 */
export async function runSelfCommand(argv: string[], deps: SelfDeps = {}): Promise<number> {
	const note = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const parsed = parseSelfArgs(argv);
	if ("error" in parsed) {
		note(
			`${parsed.error}\n用法：${APP_NAME} self [update|rollback|status|versions] [--from <源码目录>] [--dry-run] [--prune]`,
		);
		return 2;
	}

	if (parsed.action === "status") {
		const status = readSelfStatus();
		process.stdout.write(
			[
				`当前版本记录：${status.current ?? "(无)"}`,
				`上一版记录：${status.previous ?? "(无)"}`,
				`上次自更新：${describeSelfResult(status.result)}`,
				`日志：${status.log}`,
				"",
			].join("\n"),
		);
		return 0;
	}

	if (parsed.action === "versions") {
		const versions = readSelfVersions();
		// 逐项列出来：这个目录动辄几百 MB，「一共多少、哪些是在用的」必须看得见
		const lines = [`目录：${versions.dir}`, `合计：${formatBytes(versions.totalBytes)}`];
		lines.push(`版本包（${versions.packages.length} 个）：`);
		for (const item of versions.packages.slice(0, 20)) {
			lines.push(`  ${item.keep ? "★" : " "} ${formatBytes(item.size).padStart(9)}  ${item.path}`);
		}
		if (versions.packages.length > 20) {
			lines.push(`  …… 还有 ${versions.packages.length - 20} 个`);
		}
		if (versions.backups.length > 0) {
			const backupBytes = versions.backups.reduce((total, item) => total + item.size, 0);
			lines.push(`安装前备份目录（${versions.backups.length} 个，${formatBytes(backupBytes)}）：`);
			for (const item of versions.backups.slice(0, 5)) {
				lines.push(`    ${formatBytes(item.size).padStart(9)}  ${item.path}`);
			}
			if (versions.backups.length > 5) {
				lines.push(`    …… 还有 ${versions.backups.length - 5} 个`);
			}
			lines.push("  （旧流程留下的整份备份，现在没有任何代码读它）");
		}
		lines.push("★ = 在用的那一版与回滚点，不会被清理");

		if (!parsed.prune) {
			lines.push(`要清理：${APP_NAME} self versions --prune（只留 ★ 与最新一份备份，其它全删）`);
			process.stdout.write(`${lines.join("\n")}\n`);
			return 0;
		}

		const outcome = pruneSelfVersions(versions);
		lines.push(`已删除 ${outcome.removed.length} 项，释放 ${formatBytes(outcome.freedBytes)}`);
		process.stdout.write(`${lines.join("\n")}\n`);
		return 0;
	}

	if (parsed.action === "rollback") {
		const outcome = scheduleSelfRollback(deps);
		if (!outcome.ok) {
			note(outcome.reason);
			return 1;
		}
		process.stdout.write(`已安排回滚到 ${outcome.tgz}；本进程退出后完成，日志见 ${outcome.log}\n`);
		return 0;
	}

	// update：序列在 `runSelfUpdate` 里（网页上那个「更新」按钮走的是同一段），这里只负责打印
	const source = parsed.from ?? process.cwd();
	const outcome = await runSelfUpdate({
		source,
		deps,
		dryRun: parsed.dryRun,
		onStep: (step) => {
			if (step === "check") {
				note("① 跑门禁 npm run check（不过就停在这里，不动当前版本）…");
			} else if (step === "package") {
				note("② 打包 npm run release:package…");
			}
		},
	});
	if (!outcome.ok) {
		note(outcome.reason);
		return 1;
	}
	if (!outcome.scheduled) {
		process.stdout.write(
			`--dry-run：已过门禁并打包到 ${outcome.tgz}，没有安装（上一版仍是 ${outcome.previous ?? "无"}）\n`,
		);
		return 0;
	}
	process.stdout.write(
		[
			`③ 已安排安装 ${outcome.version}：本进程退出后由独立进程执行，失败会自动装回 ${outcome.previous ?? "（无上一版）"}。`,
			`日志：${outcome.log}`,
			`查看结果：${APP_NAME} self status`,
			"",
		].join("\n"),
	);
	return 0;
}

/** 人类可读的字节数 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)}KB`;
	}
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 从源码的根 package.json 读版本号 */
function readSourceVersion(source: string): string {
	try {
		const parsed = JSON.parse(readFileSync(join(source, "package.json"), "utf-8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "";
	} catch {
		return "";
	}
}
