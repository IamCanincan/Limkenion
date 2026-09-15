/**
 * 环境变量读取。
 *
 * 单独放一个文件，方便上层做优先级合并：命令行参数 > 环境变量 > 代码默认值。
 */

/** API Key 的环境变量名 */
export const API_KEY_ENV = "DEEPSEEK_API_KEY";

/** 接口地址覆盖的环境变量名 */
export const BASE_URL_ENV = "DEEPSEEK_BASE_URL";

/** 默认模型 id 的环境变量名 */
export const MODEL_ENV = "LIMKENION_MODEL";

/** 读取 API Key。未设置时返回空字符串，由调用方决定如何报错。 */
export function readApiKey(): string {
	return process.env[API_KEY_ENV]?.trim() ?? "";
}

/** 读取接口地址覆盖值 */
export function readBaseUrlOverride(): string | undefined {
	const value = process.env[BASE_URL_ENV]?.trim();
	return value ? value : undefined;
}

/** 读取默认模型 id 覆盖值 */
export function readModelOverride(): string | undefined {
	const value = process.env[MODEL_ENV]?.trim();
	return value ? value : undefined;
}
