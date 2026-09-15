/** 模型解析的单元测试。 */

import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, listModelIds, resolveModel } from "../src/models.ts";

describe("resolveModel", () => {
	it("已知模型返回精确限额", () => {
		const model = resolveModel("deepseek-flash");
		expect(model.name).toBe("DeepSeek V4.1 Flash");
		expect(model.contextWindow).toBe(1_000_000);
	});

	it("未知模型按其 id 原样接受，并使用保守限额", () => {
		const model = resolveModel("deepseek-未来型号");
		expect(model.id).toBe("deepseek-未来型号");
		expect(model.contextWindow).toBe(64_000);
		expect(model.maxOutputTokens).toBe(8_192);
	});

	it("默认模型在已知表里", () => {
		expect(listModelIds()).toContain(DEFAULT_MODEL_ID);
	});
});
