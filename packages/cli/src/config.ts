/**
 * 应用的名字与路径。
 *
 * 只留「改一处就能整体改名」的东西：应用名、配置目录名、环境变量名、各处路径。
 * 配置内容的读取（哪些键能设、三层怎么合并）搬去了 `settings.ts`，那边单向依赖这里——
 * 所以这个文件不许反过来 import 它，否则两边成环，谁都初始化不了。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 应用名，同时是命令行程序名 */
export const APP_NAME = "limkenion";

/** 用户主目录下的配置目录名 */
export const CONFIG_DIR_NAME = ".limkenion";

/** 覆盖 agent 配置目录的环境变量 */
export const AGENT_DIR_ENV = "LIMKENION_CODING_AGENT_DIR";

/** 覆盖会话根目录的环境变量 */
export const SESSION_DIR_ENV = "LIMKENION_CODING_AGENT_SESSION_DIR";

/** package.json 里与本应用相关的字段 */
interface PackageInfo {
	version: string;
	configDir?: string;
}

/**
 * 从 package.json 读取版本号与配置目录名。
 *
 * 无论是从 src/ 由 tsx 直接运行，还是从 dist/ 运行，`../package.json` 都指向包根目录。
 * 读不到时返回占位版本号而不是抛错，避免 CLI 在打包异常时完全无法启动。
 */
function readPackageInfo(): PackageInfo {
	try {
		const path = fileURLToPath(new URL("../package.json", import.meta.url));
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			version?: string;
			limkenionConfig?: { configDir?: string };
		};
		return { version: parsed.version ?? "0.0.0", configDir: parsed.limkenionConfig?.configDir };
	} catch {
		return { version: "0.0.0" };
	}
}

const packageInfo = readPackageInfo();

/** 当前版本号 */
export const VERSION = packageInfo.version;

/** 实际使用的配置目录名，允许 package.json 覆盖 */
export const configDirName = packageInfo.configDir ?? CONFIG_DIR_NAME;

/** 取 agent 配置目录，默认 ~/.limkenion/agent */
export function getAgentDir(): string {
	const override = process.env[AGENT_DIR_ENV]?.trim();
	if (override) {
		return resolve(override);
	}
	return join(homedir(), configDirName, "agent");
}

/**
 * 把工作目录编码成可以安全用作目录名的字符串。
 *
 * 例如 /home/me/proj 变成 --home-me-proj--。盘符、冒号、反斜杠一并替换，
 * 保证同一个工作目录每次都落到同一个会话目录。
 */
export function encodeCwd(cwd: string): string {
	const safe = resolve(cwd)
		.replace(/^[/\\]+/, "")
		.replace(/[/\\:]/g, "-");
	return `--${safe}--`;
}

/** 取会话根目录，默认 <agentDir>/sessions */
export function getSessionsDir(): string {
	const override = process.env[SESSION_DIR_ENV]?.trim();
	if (override) {
		return resolve(override);
	}
	return join(getAgentDir(), "sessions");
}

/** 取某个工作目录对应的会话目录 */
export function getSessionDir(cwd: string): string {
	return join(getSessionsDir(), encodeCwd(cwd));
}

/** 确保会话目录存在并返回它 */
export function ensureSessionDir(cwd: string): string {
	const dir = getSessionDir(cwd);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

// =============================================================================
// 路径
// =============================================================================

/** 配置文件路径：<agentDir>/config.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "config.json");
}
