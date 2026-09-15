/**
 * `limkenion doctor`：把环境体检的结论打出来，连不上时顺手给出可照做的诊断。
 *
 * 只读检查，不改任何东西；有 fail 时退出码为 1，方便脚本里判断。
 */

import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
	DEFAULT_BASE_URL,
	DEFAULT_MODEL_ID,
	listModelIds,
	readBaseUrlOverride,
	readModelOverride,
	resolveModel,
} from "limkenion-ai";
import { readJsonObject } from "limkenion-core";
import { APP_NAME, getAgentDir, getSessionsDir, getSettingsPath } from "../config.ts";
import { keyStorageDescription, maskKey, resolveApiKey } from "../credentials.ts";
import { collectChecks, type DoctorCheck, summarize } from "../doctor.ts";
import { describeSettingsSources, getManagedSettingsPath, getProjectSettingsPath, loadSettings } from "../settings.ts";
import type { Command } from "./command.ts";
import { wantsHelp } from "./common.ts";

/** doctor 子命令：元信息住在命令自己这里 */
export const doctorCommand: Command = {
	name: "doctor",
	synopsis: "doctor",
	summary: "检查运行环境（Node 版本、目录权限、密钥、接口可达性）",
	run: (argv) => runDoctorCommand(argv),
};

/** 用法说明 */
function doctorUsage(): string {
	return [
		`${APP_NAME} doctor - 检查运行环境`,
		"",
		"用法：",
		`  ${APP_NAME} doctor              逐项检查并给出结论`,
		"",
		"检查项：Node 版本、配置目录、接口密钥、密钥存储方式、会话目录、工作目录、模型、接口可达性、代理环境、PreToolUse 钩子。",
		"连不上时另给一行诊断：证书问题指向 NODE_EXTRA_CA_CERTS，DNS/连接问题指向代理设置。",
		"全部通过退出码为 0；有 fail 为 1（warn 不影响退出码）。",
	].join("\n");
}

/** 状态对应的前缀 */
const STATUS_MARK = { ok: "✓", warn: "!", fail: "✗" } as const;

/** 打印一项 */
function line(check: DoctorCheck): string {
	return `  ${STATUS_MARK[check.status]} ${check.name}：${check.detail}`;
}

/** 代理相关变量：大小写两种写法都查，任一非空就说明网络可能被代理接管过 */
const PROXY_VARIABLES = [
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;

/**
 * Node 自带 fetch（undici）默认**不读** `*_PROXY`。
 *
 * 只有这个开关打开时 undici 才会走环境变量里的代理；没打开时代理等于没设，
 * 而错误信息只会说连不上目标地址——这正是最费时间的那种误导。
 */
const PROXY_SWITCH = "NODE_USE_ENV_PROXY";

/**
 * 这个开关的版本前提。
 *
 * `NODE_USE_ENV_PROXY` 是 Node 24 才加的（等价于命令行 `--use-env-proxy`），而本项目的
 * `engines` 只要求 22.19。只让用户「设置一下」而不说版本，在 Node 22 上会变成「照着做了还是没用」。
 */
const PROXY_SWITCH_VERSION_NOTE = "（该开关需要 Node 24 及以上）";

/** 证书类错误码：这些只可能来自 TLS 校验，不看错误正文就能定性 */
const TLS_CODES = new Set([
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** 连不上类错误码：代理、DNS、路由、超时都落在这里 */
const CONNECT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"]);

/** 没有代理变量时那行的说明 */
const DIRECT_NOTE = "未设置，请求直连目标地址";

/** 代理开关已打开、但没有任何代理变量时那行的说明 */
const PROXY_SWITCH_ONLY_NOTE = `${PROXY_SWITCH}=1 已打开，但没有可用的代理地址（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 都没设），仍然直连`;

/** 代理解释行的前缀 */
const PROXY_EFFECT_NOTE = "代理生效情况：";

/** 拿到实际生效的代理变量（按固定顺序，值为空的不算） */
function proxyEntries(env: NodeJS.ProcessEnv): { name: string; value: string }[] {
	return PROXY_VARIABLES.flatMap((name) => {
		const value = env[name] ?? "";
		return value === "" ? [] : [{ name, value }];
	});
}

/** Node fetch 是否会把上面这些变量当回事 */
function usesEnvProxy(env: NodeJS.ProcessEnv): boolean {
	return env[PROXY_SWITCH] === "1";
}

/**
 * 打码代理地址里的账号密码。
 *
 * 公司代理常写成 `http://user:pass@host:port`，原样打印等于把口令写进日志、截图和 issue。
 * 只保留用户名，密码统一换成 `***`。解析不出来时只留下主机名——宁可少显示，也不要漏出凭据。
 */
export function maskProxyCredential(value: string): string {
	const tryMask = (raw: string): string | null => {
		try {
			const parsed = new URL(raw);
			if (parsed.username === "" && parsed.password === "") {
				return raw;
			}
			const user = parsed.username === "" ? "" : `${parsed.username}:`;
			return `${parsed.protocol}//${user}***@${parsed.host}`;
		} catch {
			return null;
		}
	};

	const masked = tryMask(value);
	if (masked !== null) {
		return masked;
	}
	// 没写协议的常见写法（host:port）：补一个协议再试一次。
	const withScheme = tryMask(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
	return withScheme ?? `${value.replace(/^[^@]*@/, "***@")}`;
}

/**
 * 代理环境的体检行。
 *
 * 纯函数：只读传入的环境变量，不联网、不改环境，因此可以直接单测。
 * 四种情况的结论刻意不同——「没设代理」是直连提示，不是警告；「设了代理但 undici 不读」
 * 才是要用户动手的那一种。
 */
export function proxyEnvRows(env: NodeJS.ProcessEnv): DoctorCheck[] {
	const entries = proxyEntries(env);
	const rows: DoctorCheck[] = [];

	if (entries.length === 0) {
		rows.push({ name: "代理环境", status: "ok", detail: usesEnvProxy(env) ? PROXY_SWITCH_ONLY_NOTE : DIRECT_NOTE });
	} else {
		// 打码只作用于值：变量名原样列出，口令一律换掉。
		rows.push({
			name: "代理环境",
			status: "ok",
			detail: entries.map((entry) => `${entry.name}=${maskProxyCredential(entry.value)}`).join("、"),
		});
	}

	// 代理变量是在这里解释的：单独一行说清它到底会不会被 Node 的 fetch 用上。
	if (entries.length > 0) {
		rows.push({
			name: "代理生效",
			status: usesEnvProxy(env) ? "ok" : "warn",
			detail: usesEnvProxy(env)
				? `${PROXY_EFFECT_NOTE}${PROXY_SWITCH}=1 已设置，Node 的 fetch 会按上面的变量走代理`
				: `${PROXY_EFFECT_NOTE}检测到代理变量，但未设置 ${PROXY_SWITCH}=1，Node 自带 fetch 会忽略它们。请设置 ${PROXY_SWITCH}=1 后再跑一次 doctor${PROXY_SWITCH_VERSION_NOTE}`,
		});
	}

	return rows;
}

/** 钩子那行的名称 */
const HOOKS_CHECK_NAME = "钩子";

/** 没有配置钩子时那行的说明：中性陈述，和「代理环境」那行的语气一致 */
const NO_HOOKS_NOTE = "未配置 PreToolUse 钩子";

/** 找不到命令时 Windows 按 PATHEXT 补的扩展名，环境变量取不到时用这份 */
const DEFAULT_WINDOWS_PATH_EXT = ".COM;.EXE;.BAT;.CMD";

/** 命令里带变量或 `~` 时静态解析不了，体检只提示、不下结论 */
const UNEXPANDED_COMMAND_PATTERN = /[$%]|^~/;

/** 探测一个候选路径得到的结果 */
export type HookProgramKind = "executable" | "not-executable" | "directory" | "missing";

/** 程序判定结果；unresolved 表示命令里有变量或 `~`，没法在体检里展开 */
export type HookProgramStatus = "ok" | "unresolved" | Exclude<HookProgramKind, "executable">;

/** 钩子命令解析的注入项：平台、PATH、PATHEXT、探测函数都能换，单测因此不碰真实环境 */
export interface HookResolveOptions {
	/** 平台标识，默认取当前平台 */
	platform?: NodeJS.Platform;
	/** 相对命令按它解析，默认取当前工作目录 */
	cwd?: string;
	/** 到 PATH 里找命令时用的目录列表 */
	pathDirs?: readonly string[];
	/** Windows 的 PATHEXT，默认读环境变量 */
	pathExt?: string;
	/** 文件探测，默认走 fs；注入后可以在任何平台上测 Windows 那条分支 */
	probe?: (path: string) => HookProgramKind;
}

/** 一条钩子命令的解析结果 */
export interface HookCommandResolution {
	/** 命令里的程序部分：引号已去掉，参数丢掉 */
	program: string;
	/** 判定结果 */
	status: HookProgramStatus;
	/** ok 时是命中的路径；没命中时是拿来报错的路径 */
	path: string;
}

/** 取命令里的程序部分：成对的引号原样去掉，其余按空白切一刀 */
function hookProgram(command: string): string {
	const text = command.trim();
	if (text.startsWith('"') || text.startsWith("'")) {
		const quote = text[0] ?? "";
		const end = text.indexOf(quote, 1);
		return end === -1 ? text.slice(1) : text.slice(1, end);
	}
	return text.split(/\s+/)[0] ?? "";
}

/**
 * 一个程序名要试的写法。
 *
 * Windows 上没写扩展名时，命令解释器会先试原名，再按 PATHEXT 依次补扩展名——所以 `my-hook`
 * 可能实际是 `my-hook.cmd`；只判「文件在不在」会把这类钩子误报成缺失。别的平台不做补全。
 */
function hookProgramCandidates(
	program: string,
	base: string,
	platform: NodeJS.Platform,
	pathExt: string | undefined,
): string[] {
	if (platform !== "win32" || win32.extname(program) !== "") {
		return [base];
	}
	const extensions = (pathExt ?? process.env.PATHEXT ?? DEFAULT_WINDOWS_PATH_EXT)
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "");
	return [base, ...extensions.map((extension) => `${base}${extension}`)];
}

/** PATH 里的目录；默认只看进程环境变量，测试注入，免得结论跟着开发机的 PATH 飘 */
function hookPathDirs(delimiter: string): string[] {
	return (process.env.PATH ?? "").split(delimiter).filter((part) => part !== "");
}

/** 默认探测：Windows 没有可执行位，只确认存在；其它平台查 X_OK，光有文件不算数 */
function defaultHookProbe(platform: NodeJS.Platform): (path: string) => HookProgramKind {
	return (path) => {
		try {
			if (statSync(path).isDirectory()) {
				return "directory";
			}
		} catch {
			return "missing";
		}
		try {
			accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
			return "executable";
		} catch {
			return "not-executable";
		}
	};
}

/**
 * 解析钩子命令里的程序。
 *
 * 命令是交给系统的 shell 跑的（`spawn(command, { shell: true })`），所以这里只判「命令里那个
 * 程序找不找得到、跑不跑得起来」，参数、重定向一概不看。带路径分隔符的按路径解析（相对路径
 * 对着 cwd），裸命令名到 PATH 里逐个找；Windows 再按 PATHEXT 补扩展名。
 *
 * 命令里带 `$VAR` / `%VAR%` / `~` 时展开结果取决于运行时的 shell，静态判不了，直接给
 * unresolved，避免误报「找不到命令」。
 */
export function resolveHookCommand(command: string, options: HookResolveOptions = {}): HookCommandResolution {
	const platform = options.platform ?? process.platform;
	const platformPath = platform === "win32" ? win32 : posix;
	const program = hookProgram(command);
	if (program === "") {
		// 形状问题由 hookRows 报（command 是空串或空引号），这里不重复下结论。
		return { program, status: "ok", path: "" };
	}
	if (UNEXPANDED_COMMAND_PATTERN.test(program)) {
		return { program, status: "unresolved", path: program };
	}

	const hasSeparator = /[\\/]/.test(program);
	const cwd = options.cwd ?? process.cwd();
	const candidates = hasSeparator
		? hookProgramCandidates(
				program,
				platformPath.isAbsolute(program) ? program : platformPath.resolve(cwd, program),
				platform,
				options.pathExt,
			)
		: (options.pathDirs ?? hookPathDirs(platformPath.delimiter)).flatMap((dir) =>
				hookProgramCandidates(program, platformPath.join(dir, program), platform, options.pathExt),
			);

	// 按顺序取第一个存在的候选：真跑起来也是这个顺序，第一个不存在的跳过、第一个存在的定生死。
	const probe = options.probe ?? defaultHookProbe(platform);
	for (const candidate of candidates) {
		const kind = probe(candidate);
		if (kind === "missing") {
			continue;
		}
		return { program, status: kind === "executable" ? "ok" : kind, path: candidate };
	}
	// 一个都没找到：带路径的报那个路径，裸命令名报命令本身（PATH 里哪一段都试过了，报一段没用）。
	return { program, status: "missing", path: hasSeparator ? (candidates[0] ?? program) : program };
}

/** hookRows 的输入 */
export interface HookRowsOptions {
	/** 配置文件里 `hooks` 键的原样值；没有这个键时传 undefined */
	raw?: unknown;
	/** 出问题的钩子来自哪个配置文件，报错时附在末尾 */
	source?: string;
	/** 命令解析的注入项 */
	resolve?: HookResolveOptions;
}

/**
 * PreToolUse 钩子的体检行。
 *
 * 这里读的是**配置文件里的原样值**：`settings.ts` 会把形状不对的项静默处理掉（command 为空的
 * 整条丢掉、不是对象的条目丢掉、matcher 不是字符串的改成 `*`），进了 `readSettings()` 就再也
 * 看不出哪儿写错了。doctor 要报的正是这种「改了却不生效」。
 *
 * 结论的轻重按运行时的真实后果定：
 * - 形状不对 → fail：settings 层直接丢掉，运行时**连一句提示都没有**，用户以为钩子还在守着。
 * - 命令找不到 / 不可执行 / 是目录 → warn：`runPreToolUseHooks` 对 spawn 失败的做法是
 *   「放行 + 警告」（退出码不是 0/2 一律放行，见 packages/core/src/hooks.ts），工具照跑，只在
 *   结果后面附一段 `[钩子提示]`。钩子确实没生效，但它不阻断工作，按 doctor 的语义不算 fail。
 */
export function hookRows(options: HookRowsOptions = {}): DoctorCheck[] {
	const row = (status: DoctorCheck["status"], detail: string): DoctorCheck => ({
		name: HOOKS_CHECK_NAME,
		status,
		detail: options.source === undefined || options.source === "" ? detail : `${detail}（${options.source}）`,
	});

	const { raw } = options;
	// 没有 hooks 键、或者 preToolUse 是空数组，都等于「没有钩子」：中性结论，别把默认配置说成问题。
	if (raw === undefined || raw === null) {
		return [row("ok", NO_HOOKS_NOTE)];
	}
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return [row("fail", "配置里的 hooks 不是对象")];
	}
	const list = (raw as { preToolUse?: unknown }).preToolUse;
	if (list === undefined) {
		return [row("ok", NO_HOOKS_NOTE)];
	}
	if (!Array.isArray(list)) {
		return [row("fail", "配置里的 hooks.preToolUse 不是数组")];
	}
	if (list.length === 0) {
		return [row("ok", NO_HOOKS_NOTE)];
	}

	const problems: string[] = [];
	const programIssues: string[] = [];
	const notes: string[] = [];
	const matchers: string[] = [];
	list.forEach((item, index) => {
		const at = `PreToolUse 钩子的第 ${index + 1} 条`;
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			problems.push(`${at}不是对象`);
			return;
		}
		const { matcher, command } = item as { matcher?: unknown; command?: unknown };
		if (typeof matcher !== "string") {
			problems.push(`${at}：matcher 不是字符串`);
		}
		if (typeof command !== "string" || command.trim() === "") {
			problems.push(`${at}：command 不是非空字符串`);
			return;
		}
		matchers.push(typeof matcher === "string" ? matcher : "*");

		const resolved = resolveHookCommand(command, options.resolve);
		if (resolved.program === "") {
			problems.push(`${at}：command 里没有程序名`);
		} else if (resolved.status === "missing") {
			programIssues.push(`${at}：找不到命令 ${resolved.path}`);
		} else if (resolved.status === "directory") {
			programIssues.push(`${at}：命令指向目录 ${resolved.path}`);
		} else if (resolved.status === "not-executable") {
			programIssues.push(`${at}：命令没有可执行权限 ${resolved.path}`);
		} else if (resolved.status === "unresolved") {
			notes.push(`${at}的命令含变量或 ~，体检不做展开`);
		}
	});

	if (problems.length > 0) {
		return [row("fail", problems.join("；"))];
	}
	if (programIssues.length > 0) {
		return [row("warn", programIssues.join("；"))];
	}
	const note = notes.length === 0 ? "" : `；${notes.join("；")}`;
	return [row("ok", `已配置 ${list.length} 条 PreToolUse 钩子，匹配：${matchers.join("、")}${note}`)];
}

/**
 * 读原始的 hooks 配置。
 *
 * `loadSettings` 会把形状不对的项丢掉或改写，规整完就看不出来了，所以这里直接读原始 JSON。
 * 优先级与 `loadSettings` 一致：用户层 < managed 层。项目层不允许设 hooks（等于跟着陌生仓库
 * 远程执行代码），`settings.ts` 已经把它记成「忽略」，这里不重复报。
 *
 * 导出是为了让网页的体检面板用同一份：两边各写一遍「读哪两个文件、怎么取 hooks」迟早会漂。
 */
export function readRawHooks(): { raw: unknown; source: string } {
	let found: { raw: unknown; source: string } = { raw: undefined, source: "" };
	for (const source of [getSettingsPath(), getManagedSettingsPath()]) {
		const raw = readJsonObject(source);
		if (raw !== null && "hooks" in raw) {
			found = { raw: raw.hooks, source };
		}
	}
	return found;
}

/** 取错误码：优先看错误本身，其次看 undici 挂在 cause 上的底层错误，与重试逻辑里的取法一致 */
function errorCode(error: unknown): string | undefined {
	const direct = (error as { code?: unknown } | null)?.code;
	if (typeof direct === "string" && direct !== "") {
		return direct;
	}
	const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
	const code = cause?.code;
	return typeof code === "string" && code !== "" ? code : undefined;
}

/** 是不是证书类失败：先认证书类错误码，再退回看错误正文里的关键词 */
function isTlsFailure(error: unknown, code: string | undefined): boolean {
	if (code !== undefined && TLS_CODES.has(code)) {
		return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	return /certificate|self[ -]?signed|\bcert\b/i.test(message);
}

/**
 * 连不上时给一行能照做的诊断。
 *
 * 只做判断和措辞，不联网、不装证书、不改任何东西。TLS 与 DNS/连接两类分开说：
 * 前者几乎总是私有 CA，后者在有代理的环境里几乎总是「代理没被用上」。
 */
export function describeNetworkGuidance(error: unknown, env: NodeJS.ProcessEnv): string {
	const code = errorCode(error);
	const proxyConfigured = proxyEntries(env).length > 0;

	if (isTlsFailure(error, code)) {
		const withCode = code === undefined ? "" : `（${code}）`;
		const segments = [
			`TLS 证书校验没过${withCode}：多半是公司自签证书或私有根 CA，不在 Node 自带信任列表里。`,
			"改用私有 CA：把 CA 证书（PEM）路径写进 NODE_EXTRA_CA_CERTS，例如 NODE_EXTRA_CA_CERTS=/path/to/ca.pem，然后重开终端。",
			// 这条最费时间：curl / git / Python 认 SSL_CERT_FILE，Node 的 fetch 不认。
			"注意：Node 的 fetch 不读 SSL_CERT_FILE，别的工具认它不代表这里也认，只设它没有用。",
		];
		if (proxyConfigured && !usesEnvProxy(env)) {
			segments.push(
				`检测到代理变量但未设置 ${PROXY_SWITCH}=1${PROXY_SWITCH_VERSION_NOTE}：请求现在直连，很可能正是被中间代理换掉的证书导致校验失败。`,
			);
		}
		return segments.join("");
	}

	if (code !== undefined && CONNECT_CODES.has(code)) {
		if (proxyConfigured) {
			return usesEnvProxy(env)
				? `连接失败（${code}）：代理变量已设置且 ${PROXY_SWITCH}=1 已打开，先确认代理地址本身连得上；上面那行里的代理变量就是当前在用的。`
				: `连接失败（${code}）：已配置代理变量，但未设置 ${PROXY_SWITCH}=1${PROXY_SWITCH_VERSION_NOTE}，Node 自带 fetch 忽略了它，请求直连目标地址，这是最常见的原因。`;
		}
		const subject =
			code === "ENOTFOUND" || code === "EAI_AGAIN" ? `域名解析不了（${code}）` : `目标地址连不上（${code}）`;
		return `${subject}，且没有设置任何代理变量：请检查网络、DNS 与 --base-url 指向的地址。`;
	}

	return `先确认上面这个地址在浏览器或 curl 里能不能打开；若公司网络要求走代理，请设置 HTTPS_PROXY 与 NODE_USE_ENV_PROXY=1${PROXY_SWITCH_VERSION_NOTE} 后重跑 doctor。`;
}

/** 运行 doctor，返回进程退出码 */
export async function runDoctorCommand(argv: string[]): Promise<number> {
	if (wantsHelp(argv)) {
		process.stdout.write(`${doctorUsage()}\n`);
		return 0;
	}

	const { settings, sources } = loadSettings();
	const modelId = settings.model ?? readModelOverride() ?? DEFAULT_MODEL_ID;
	const checks = await collectChecks({
		agentDir: getAgentDir(),
		sessionsDir: getSessionsDir(),
		cwd: process.cwd(),
		apiKey: resolveApiKey(undefined),
		knownModel: listModelIds().includes(modelId),
		modelId,
		baseUrl: settings.baseUrl ?? readBaseUrlOverride() ?? DEFAULT_BASE_URL,
		mask: (key) => maskKey(key),
		// 用 resolveModel 走一遍，确认未知模型不会有意外
		encryptionAvailable: !keyStorageDescription().includes("明文"),
	});

	// 代理信息排在「接口可达性」之后：先看连不连得上，再看是不是代理没生效。
	const reachability = checks.find((check) => check.name === "接口可达性");
	const proxyRows = proxyEnvRows(process.env);
	checks.push(...proxyRows);
	if (reachability?.status === "fail") {
		// 只有失败才多这一行，网络正常时输出与从前完全一致。
		checks.push({
			name: "连接诊断",
			status: "warn",
			detail: describeNetworkGuidance(new Error(reachability.detail), process.env),
		});
	}

	// 钩子行加在末尾：既有各行的相对顺序一行都不动，它挨着下面的「配置」段落也正合适。
	const rawHooks = readRawHooks();
	checks.push(
		...hookRows({
			raw: rawHooks.raw,
			source: rawHooks.raw === undefined ? undefined : rawHooks.source,
			resolve: { cwd: process.cwd() },
		}),
	);

	// 已知表里查不到时上面已给 warn；这里仅确保未知模型也能取到限额
	resolveModel(modelId);

	const totals = summarize(checks);
	const lines = [`${APP_NAME} 环境体检`, "", ...checks.map(line), ""];

	// 配置分层：哪一层在生效、哪一层的键被忽略了，比一句「配置在哪」有用得多。
	lines.push(...describeSettingsSources(sources));

	lines.push("", `结论：${totals.ok} 项正常、${totals.warned} 项警告、${totals.failed} 项失败`, "");
	lines.push("文件位置：");
	lines.push(`  用户配置：${getSettingsPath()}`);
	lines.push(`  项目配置：${getProjectSettingsPath(process.cwd())}`);
	lines.push(`  managed 配置：${getManagedSettingsPath()}`);
	lines.push(`  配置目录：${getAgentDir()}`);
	const output = `${lines.join("\n")}\n`;
	// 结论走 stdout：doctor 的输出本身就是它的结果，不放进 stderr 的日志流里。
	process.stdout.write(output);
	return totals.failed > 0 ? 1 : 0;
}
