/**
 * DeepSeek 模型定义。
 *
 * 只维护一份很小的已知模型表，用于给出合理的上下文上限与默认值。模型 id 允许任意
 * 字符串：DeepSeek 会调整型号命名，硬编码白名单会让 CLI 在对方改名当天就不可用。
 *
 * 表里两条对应官方「模型 & 价格」页当前提供的两个模型：`deepseek-v4-flash`、
 * `deepseek-v4-flash-vision-exp` 这两个旧名虽然还能调，但对应型号已下线，请求一律由
 * DeepSeek-V4.1-Flash 承接，列出来只会让人以为还有别的选择，因此不进表（仍然可用）。
 */

/** 模型的能力与限额描述 */
export interface Model {
	/** 传给 API 的 model 字段 */
	id: string;
	/** 人类可读名称，仅用于展示 */
	name: string;
	/** 是否返回思维链（reasoning_content） */
	reasoning: boolean;
	/** 上下文窗口 token 数 */
	contextWindow: number;
	/** 单次回复的最大 token 数 */
	maxOutputTokens: number;
}

/** DeepSeek 默认接口地址，兼容 OpenAI 的 /chat/completions */
export const DEFAULT_BASE_URL = "https://api.deepseek.com";

/** 默认模型 id */
export const DEFAULT_MODEL_ID = "deepseek-flash";

/** 已知模型。表里没有的 id 也能用，只是拿不到精确的上下文上限。 */
export const KNOWN_MODELS: Readonly<Record<string, Model>> = {
	"deepseek-flash": {
		id: "deepseek-flash",
		name: "DeepSeek V4.1 Flash",
		reasoning: true,
		contextWindow: 1_000_000,
		maxOutputTokens: 384_000,
	},
	"deepseek-v4-pro": {
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		reasoning: true,
		contextWindow: 1_000_000,
		maxOutputTokens: 384_000,
	},
};

/** 未知模型使用的保守默认值 */
const UNKNOWN_MODEL_LIMITS = { contextWindow: 64_000, maxOutputTokens: 8_192 } as const;

/**
 * 把模型 id 解析成 Model。
 *
 * 未知 id 不会被拒绝，只按保守上限处理，这样 DeepSeek 上新模型时无需改代码。
 */
export function resolveModel(id: string): Model {
	const known = KNOWN_MODELS[id];
	if (known) {
		return known;
	}
	return {
		id,
		name: id,
		reasoning: true,
		contextWindow: UNKNOWN_MODEL_LIMITS.contextWindow,
		maxOutputTokens: UNKNOWN_MODEL_LIMITS.maxOutputTokens,
	};
}

/** 列出已知模型的 id */
export function listModelIds(): string[] {
	return Object.keys(KNOWN_MODELS);
}
