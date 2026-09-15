/**
 * 三层配置读取：项目 < 用户 < managed。
 *
 * 从 `config.ts` 拆出来，是因为两件事的变动节奏不同：「名字与路径」要尽量稳定，
 * 而「哪些键能设、怎么合并、谁被忽略」属于会随策略调整的逻辑。放在一起时，
 * 改一条合并规则就得在路径常量中间找位置，调用方也会为了读一个配置而拖进整份路径代码。
 *
 * 依赖方向是单向的 `settings.ts → config.ts`：这里用它的路径与常量，反过来不行，否则成环。
 */

import { join, resolve } from "node:path";
import { type OutputStyle, type PlanMode, parseOutputStyle, parsePlanMode, readJsonObject } from "limkenion-core";
import { APP_NAME, configDirName, getSettingsPath } from "./config.ts";

/** 覆盖 managed 配置路径的环境变量 */
export const MANAGED_SETTINGS_ENV = "LIMKENION_MANAGED_SETTINGS";

/** 认识的全部键；不在这张表里的键会被忽略，并在 doctor 里点出来 */
const KNOWN_KEYS = new Set([
	"model",
	"baseUrl",
	"maxTurns",
	"approval",
	"hooks",
	"compaction",
	"planMode",
	"style",
	"retries",
	"verbose",
]);

/**
 * 项目级配置允许出现的键。
 *
 * 这是一道安全边界，不是风格偏好：项目配置跟着仓库走，clone 一个陌生仓库就等于让它的作者
 * 替你写配置。所以 `baseUrl`（会把密钥送去别人的服务器）、密钥与 `hooks`（等于远程执行代码）
 * 一律不认，只留下「在这个仓库里怎么干活」这类键。用户配置与 managed 配置都覆盖它。
 */
const PROJECT_ALLOWED_KEYS = new Set(["maxTurns", "compaction", "verbose", "planMode", "style", "approval"]);

/** 配置文件里可以设置的项，全部可选 */
export interface AppSettings {
	/** 默认模型 id */
	model?: string;
	/** 覆盖接口地址 */
	baseUrl?: string;
	/** 单次指令最多几轮工具调用 */
	maxTurns?: number;
	/** 审批模式：auto / ask / readonly */
	approval?: string;
	/** PreToolUse 钩子：在工具执行前跑用户脚本 */
	hooks?: { preToolUse?: { matcher: string; command: string }[] };
	/** 是否启用上下文压缩，默认开启 */
	compaction?: boolean;
	/** 默认计划模式档位：off / strict / guide */
	planMode?: PlanMode;
	/** 默认输出风格：default / concise / explanatory */
	style?: OutputStyle;
	/** 限速或 5xx 时的重试次数 */
	retries?: number;
	/** 是否默认显示思维链与完整工具输出 */
	verbose?: boolean;
}

/** 配置层级，按优先级从低到高 */
export type SettingsLayer = "project" | "user" | "managed";

/** 一个存在但没生效的键 */
export interface IgnoredKey {
	key: string;
	reason: string;
}

/** 一层配置的读取结果，供 doctor 展示 */
export interface SettingsSource {
	layer: SettingsLayer;
	path: string;
	/** 实际生效的键 */
	keys: string[];
	/** 存在但没生效的键 */
	ignored: IgnoredKey[];
}

/** 项目配置路径：<cwd>/.limkenion/config.json */
export function getProjectSettingsPath(cwd: string): string {
	return join(resolve(cwd), configDirName, "config.json");
}

/** managed 配置路径：环境变量优先，Windows 用 %ProgramData%，其它系统用 /etc */
/**
 * managed 配置路径：环境变量优先，Windows 用 %ProgramData%，其它系统用 /etc。
 *
 * 平台与 ProgramData 都可以注入：managed 是「机器统一策略」的入口，目录算错等于策略失效，
 * 而 Linux CI 永远跑不到 Windows 那条分支，只能靠参数化测试补上。
 */
export function getManagedSettingsPath(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): string {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const override = env[MANAGED_SETTINGS_ENV]?.trim();
	if (override) {
		return resolve(override);
	}
	if (platform === "win32") {
		return join(env.ProgramData?.trim() || "C:\\ProgramData", APP_NAME, "managed-settings.json");
	}
	return `/etc/${APP_NAME}/managed-settings.json`;
}

/**
 * 把一份原始对象规整成配置。
 *
 * 字段类型不对只忽略这一项，不让 CLI 起不来。
 */
function parseSettings(raw: Record<string, unknown>): AppSettings {
	const settings: AppSettings = {};
	if (typeof raw.model === "string" && raw.model.trim() !== "") {
		settings.model = raw.model.trim();
	}
	if (typeof raw.baseUrl === "string" && raw.baseUrl.trim() !== "") {
		settings.baseUrl = raw.baseUrl.trim();
	}
	const rawHooks = raw.hooks;
	if (rawHooks !== null && typeof rawHooks === "object" && !Array.isArray(rawHooks)) {
		const list = (rawHooks as { preToolUse?: unknown }).preToolUse;
		if (Array.isArray(list)) {
			const parsed = list
				.filter(
					(item): item is { matcher?: unknown; command?: unknown } => item !== null && typeof item === "object",
				)
				.map((item) => ({
					matcher: typeof item.matcher === "string" ? item.matcher : "*",
					command: typeof item.command === "string" ? item.command.trim() : "",
				}))
				.filter((item) => item.command !== "");
			if (parsed.length > 0) {
				settings.hooks = { preToolUse: parsed };
			}
		}
	}
	if (typeof raw.compaction === "boolean") {
		settings.compaction = raw.compaction;
	}
	const plan = parsePlanMode(raw.planMode);
	if (plan !== undefined) {
		settings.planMode = plan;
	}
	const style = parseOutputStyle(raw.style);
	if (style !== undefined) {
		settings.style = style;
	}
	// 与 model / baseUrl 一样判空：一句 `"approval": ""` 不该把下面几层设好的模式清掉。
	if (typeof raw.approval === "string" && raw.approval.trim() !== "") {
		settings.approval = raw.approval.trim();
	}
	if (typeof raw.retries === "number" && Number.isFinite(raw.retries) && raw.retries >= 0) {
		settings.retries = Math.min(Math.floor(raw.retries), 10);
	}
	if (typeof raw.maxTurns === "number" && Number.isFinite(raw.maxTurns) && raw.maxTurns > 0) {
		settings.maxTurns = Math.floor(raw.maxTurns);
	}
	if (typeof raw.verbose === "boolean") {
		settings.verbose = raw.verbose;
	}
	return settings;
}

/**
 * 三层配置合并，优先级从低到高：项目 < 用户 < managed。
 *
 * - **项目**（`<cwd>/.limkenion/config.json`）：只认 `PROJECT_ALLOWED_KEYS`，别的键一律不生效。
 * - **用户**（`<agentDir>/config.json`）：完整的键集合，覆盖项目配置。
 * - **managed**（`<系统目录>/limkenion/managed-settings.json`）：机器上统一发的策略，覆盖前两者。
 *
 * 命令行参数与环境变量仍然覆盖最终结果——它们比文件更「当下」，也更容易看出是谁改的。
 * 每层返回自己生效了哪些键、忽略了哪些键，`doctor` 直接把它打出来，省得猜「我改的怎么没生效」。
 */
export function loadSettings(cwd: string = process.cwd()): {
	settings: AppSettings;
	sources: SettingsSource[];
} {
	const settings: AppSettings = {};
	const sources: SettingsSource[] = [];
	const layers: { layer: SettingsLayer; path: string; allowed: (key: string) => boolean }[] = [
		{ layer: "project", path: getProjectSettingsPath(cwd), allowed: (key) => PROJECT_ALLOWED_KEYS.has(key) },
		{ layer: "user", path: getSettingsPath(), allowed: () => true },
		{ layer: "managed", path: getManagedSettingsPath(), allowed: () => true },
	];

	for (const { layer, path, allowed } of layers) {
		const raw = readJsonObject(path);
		if (raw === null) {
			continue;
		}
		const parsed = parseSettings(raw);
		const ignored: IgnoredKey[] = [];
		for (const key of Object.keys(raw)) {
			if (!KNOWN_KEYS.has(key)) {
				ignored.push({ key, reason: "未知的键" });
			} else if (!allowed(key)) {
				ignored.push({ key, reason: `${layer} 层不允许设它` });
			} else if (parsed[key as keyof AppSettings] === undefined) {
				// 类型不对、空值、以及值不被接受（例如 planMode 写了别的档位名）都落在这里。
				ignored.push({ key, reason: "类型不对或取值不被接受" });
			}
			if (!allowed(key)) {
				delete (parsed as Record<string, unknown>)[key];
			}
		}
		// 后面的层覆盖前面的层，逐键覆盖而不是整份替换。
		Object.assign(settings, parsed);
		sources.push({ layer, path, keys: Object.keys(parsed), ignored });
	}

	return { settings, sources };
}

/**
 * 把各层的生效 / 忽略情况整理成给 doctor 打印的文本行。
 *
 * 单独抽出来是为了能直接断言输出：这段是用户排查「我改的怎么没生效」时唯一看得见的东西，
 * 藏在命令里就没法测。
 */
export function describeSettingsSources(sources: readonly SettingsSource[]): string[] {
	if (sources.every((source) => source.keys.length === 0)) {
		return ["配置：三层都没有生效的键（项目 < 用户 < managed）"];
	}
	const lines = ["配置（优先级从低到高）："];
	for (const source of sources) {
		if (source.keys.length === 0 && source.ignored.length === 0) {
			continue;
		}
		lines.push(`  ${source.layer}：${source.path}`);
		if (source.keys.length > 0) {
			lines.push(`    生效：${source.keys.join("、")}`);
		}
		for (const item of source.ignored) {
			lines.push(`    忽略：${item.key}（${item.reason}）`);
		}
	}
	return lines;
}

/**
 * 读取最终生效的配置。
 *
 * 需要「哪一层生效了什么」时用 `loadSettings`。
 */
export function readSettings(cwd: string = process.cwd()): AppSettings {
	return loadSettings(cwd).settings;
}
