/**
 * 命令行参数的单元测试。
 *
 * 重点在 `--plan` 的可选档位：`limkenion --plan "做点什么"` 里的下一段是提示词而不是档位，
 * 只有恰好是档位名时才该被吃掉。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Options, parseOptions } from "../src/args.ts";
import { AGENT_DIR_ENV } from "../src/config.ts";

/** 只关心「解析成功」的用例走这个助手；参数错误另有单独的断言 */
function parse(argv: string[]): Options {
	const result = parseOptions(argv);
	if (result === null || result === "usage-error") {
		throw new Error(`参数没解析成功：${argv.join(" ")}`);
	}
	return result;
}

describe("参数错误与帮助要分开", () => {
	it("参数不认识时返回 usage-error，让调用方退出 2", () => {
		expect(parseOptions(["--bogus"])).toBe("usage-error");
		// 正常参数不受影响
		expect(parseOptions(["--plan"])).not.toBe("usage-error");
	});
});

const originalAgentDir = process.env[AGENT_DIR_ENV];
let dir = "";

beforeEach(async () => {
	// 指向空目录，免得读到开发机上真实的 config.json。
	dir = await mkdtemp(join(tmpdir(), "limkenion-args-"));
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

describe("--style", () => {
	it("认三个风格名，默认是 default", () => {
		expect(parse([]).style).toBe("default");
		expect(parse(["--style", "concise"]).style).toBe("concise");
		expect(parse(["--style", "explanatory"]).style).toBe("explanatory");
	});

	it("名字不认识时退回默认，而不是让 CLI 起不来", () => {
		expect(parse(["--style", "啰嗦"]).style).toBe("default");
	});
});

describe("--plan 的档位", () => {
	it("不带档位时按严格档处理", () => {
		expect(parse(["--plan"]).plan).toBe("strict");
	});

	it("支持 --plan=guide 与 --plan guide 两种写法", () => {
		expect(parse(["--plan=guide"]).plan).toBe("guide");
		expect(parse(["--plan", "guide"]).plan).toBe("guide");
	});

	it("紧跟其后的提示词不会被当成档位", () => {
		const options = parse(["--plan", "把 README 的错别字改掉"]);
		expect(options?.plan).toBe("strict");
		expect(options?.prompt).toBe("把 README 的错别字改掉");
	});

	it("档位后面仍然可以跟提示词", () => {
		const options = parse(["--plan", "guide", "重构这个模块"]);
		expect(options?.plan).toBe("guide");
		expect(options?.prompt).toBe("重构这个模块");
	});

	it("off 就是关闭", () => {
		expect(parse(["--plan=off"]).plan).toBe("off");
		expect(parse([]).plan).toBe("off");
	});
});
