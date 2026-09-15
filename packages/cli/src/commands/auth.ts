/**
 * `limkenion auth` 子命令：管理本地保存的接口密钥。
 *
 * 密钥到底从哪来常常是排查问题的第一步，所以 `status` 会同时报告本地存了什么、
 * 环境变量有没有，以及最终生效的是哪一个。
 */

import { parseArgs } from "node:util";
import { describeError, readApiKey, readBaseUrlOverride } from "limkenion-ai";
import { APP_NAME, getAgentDir, getSettingsPath } from "../config.ts";
import {
	type ApiKeySource,
	clearApiKey,
	getCredentialsPath,
	keyStorageDescription,
	maskKey,
	promptSecret,
	readStoredApiKey,
	resolveApiKey,
	storeApiKey,
} from "../credentials.ts";
import { readSettings } from "../settings.ts";
import type { Command } from "./command.ts";
import { EXIT_USAGE, wantsHelp } from "./common.ts";

/** auth 子命令：元信息住在命令自己这里（元信息跟着命令自己走） */
export const authCommand: Command = {
	name: "auth",
	synopsis: "auth login",
	summary: "保存 API Key，之后不用再设环境变量",
	run: (argv) => runAuthCommand(argv),
};

/** auth 子命令的用法说明 */
function authUsage(): string {
	return [
		`${APP_NAME} auth - 管理接口密钥`,
		"",
		"用法：",
		`  ${APP_NAME} auth login                交互式输入密钥并保存（不回显）`,
		`  ${APP_NAME} auth login --api-key <key>     直接保存，适合脚本`,
		`  ${APP_NAME} auth status               查看当前生效的密钥与来源`,
		`  ${APP_NAME} auth logout               删除本地保存的密钥`,
		"",
		`密钥保存在 ${getCredentialsPath()}，文件权限 0600。`,
		"生效优先级：命令行 --api-key > 环境变量 DEEPSEEK_API_KEY > 本地保存的密钥。",
	].join("\n");
}

/** 把密钥来源转成中文说明 */
function describeKeySource(source: ApiKeySource): string {
	if (source === "flag") {
		return "命令行参数";
	}
	if (source === "env") {
		return "环境变量 DEEPSEEK_API_KEY";
	}
	if (source === "auth") {
		return "本地保存的密钥";
	}
	return "无";
}

/** 保存密钥：优先取参数，没有就交互式读取 */
async function login(rest: string[]): Promise<number> {
	let key = "";
	try {
		const { values } = parseArgs({
			args: rest,
			allowPositionals: false,
			options: { "api-key": { type: "string" } },
		});
		key = values["api-key"]?.trim() ?? "";
	} catch (error) {
		process.stderr.write(`参数错误：${describeError(error)}\n`);
		return EXIT_USAGE;
	}

	if (key === "") {
		try {
			key = (await promptSecret("请输入 DeepSeek API Key（输入不会回显）：")).trim();
		} catch (error) {
			process.stderr.write(`读取密钥失败：${describeError(error)}\n`);
			return 1;
		}
	}
	if (key === "") {
		process.stderr.write("密钥为空，未保存。\n");
		return EXIT_USAGE;
	}

	const path = storeApiKey(key);
	process.stderr.write(`已保存密钥 ${maskKey(key)} 到 ${path}\n`);
	process.stderr.write(`现在可以直接运行 ${APP_NAME}，不需要再设环境变量。\n`);
	return 0;
}

/** 删除密钥 */
function logout(): number {
	const removed = clearApiKey();
	process.stderr.write(removed ? `已删除 ${getCredentialsPath()} 中保存的密钥\n` : "本地没有保存密钥\n");
	// 不说清楚的话，用户会以为已经断开，其实环境变量还在生效。
	if (readApiKey() !== "") {
		process.stderr.write("注意：环境变量 DEEPSEEK_API_KEY 仍然设置着，删除本地密钥后它依然生效。\n");
	}
	return 0;
}

/** 展示当前配置与密钥来源 */
function status(): number {
	const stored = readStoredApiKey();
	const fromEnv = readApiKey();
	const resolved = resolveApiKey(undefined);
	const settings = readSettings();
	const lines = [
		`配置目录：${getAgentDir()}`,
		`配置文件：${getSettingsPath()}`,
		`凭据文件：${getCredentialsPath()}`,
		"",
		`本地保存的密钥：${maskKey(stored)}`,
		`存储方式：${keyStorageDescription()}`,
		`环境变量密钥：${fromEnv === "" ? "(未设置)" : maskKey(fromEnv)}`,
		`当前生效：${maskKey(resolved.key)}（来自 ${describeKeySource(resolved.source)}）`,
		"",
		`默认模型：${settings.model ?? "(未设置，用内置默认值)"}`,
		`接口地址：${settings.baseUrl ?? readBaseUrlOverride() ?? "(未设置，用官方地址)"}`,
		`最大轮数：${settings.maxTurns ?? "(未设置，默认 25)"}`,
	];
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

/** 运行 auth 子命令，返回进程退出码 */
export async function runAuthCommand(argv: string[]): Promise<number> {
	const action = argv[0] ?? "status";
	const rest = argv.slice(1);

	if (wantsHelp([action])) {
		process.stdout.write(`${authUsage()}\n`);
		return 0;
	}
	if (action === "login") {
		return login(rest);
	}
	if (action === "logout") {
		return logout();
	}
	if (action === "status") {
		return status();
	}

	process.stderr.write(`未知的 auth 子命令：${action}\n\n${authUsage()}\n`);
	return EXIT_USAGE;
}
