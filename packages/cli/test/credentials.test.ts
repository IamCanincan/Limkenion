/** 凭据存储与密钥优先级解析的单元测试。 */

import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_DIR_ENV } from "../src/config.ts";
import {
	CREDENTIAL_PROVIDER,
	clearApiKey,
	getCredentialsPath,
	maskKey,
	readCredentials,
	readStoredApiKey,
	resolveApiKey,
	storeApiKey,
} from "../src/credentials.ts";
import { decryptSecret, encryptionBackend, encryptSecret } from "../src/secret-store.ts";

let agentDir = "";
const originalAgentDir = process.env[AGENT_DIR_ENV];
const originalApiKey = process.env.DEEPSEEK_API_KEY;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "limkenion-credentials-"));
	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env.DEEPSEEK_API_KEY;
});

afterEach(async () => {
	if (originalAgentDir === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = originalAgentDir;
	}
	if (originalApiKey === undefined) {
		delete process.env.DEEPSEEK_API_KEY;
	} else {
		process.env.DEEPSEEK_API_KEY = originalApiKey;
	}
	await rm(agentDir, { recursive: true, force: true });
});

/** 用一个变量名做键：既能覆盖任意 provider 名，也避开 lint 对字面量键的偏好 */
const OTHER_PROVIDER = "other-provider";

describe("凭据文件", () => {
	it("没有文件时读到空", () => {
		expect(readCredentials()).toEqual({});
		expect(readStoredApiKey()).toBe("");
	});

	it("保存后能读回，且写成预期的结构", async () => {
		const path = storeApiKey("sk-abcdefghijklmnop");
		expect(path).toBe(join(agentDir, "auth.json"));

		const raw = JSON.parse(await readFile(path, "utf-8")) as Record<
			string,
			{ type: string; key?: string; secret?: string }
		>;
		const entry = raw[CREDENTIAL_PROVIDER];
		expect(entry?.type).toBe("api");
		// 有加密能力时必须存密文，没有才退回明文——两者只允许出现一个。
		if (encryptionBackend() === null) {
			expect(entry?.key).toBe("sk-abcdefghijklmnop");
		} else {
			expect(typeof entry?.secret).toBe("string");
			expect(entry?.key).toBeUndefined();
		}
		expect(readStoredApiKey()).toBe("sk-abcdefghijklmnop");
	});

	it("有加密能力时，文件里看不到明文密钥", async () => {
		if (encryptionBackend() === null) {
			return;
		}
		const path = storeApiKey("sk-plaintext-must-not-appear");
		expect(await readFile(path, "utf-8")).not.toContain("sk-plaintext-must-not-appear");
		expect(readStoredApiKey()).toBe("sk-plaintext-must-not-appear");
	});

	it("后端标识对不上就解不开", () => {
		if (encryptionBackend() === null) {
			return;
		}
		const sealed = encryptSecret("sk-roundtrip");
		expect(sealed).not.toBeNull();
		expect(decryptSecret(sealed?.secret ?? "", "some-other-backend")).toBeNull();
		expect(decryptSecret(sealed?.secret ?? "", sealed?.backend ?? "")).toBe("sk-roundtrip");
	});

	it("在 POSIX 上文件权限是 0600", async () => {
		if (process.platform === "win32") {
			return;
		}
		const path = storeApiKey("sk-abcdefghijklmnop");
		const mode = statSync(path).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("保存第二个 provider 时保留第一个", () => {
		storeApiKey("sk-first");
		storeApiKey("sk-second", OTHER_PROVIDER);
		expect(readStoredApiKey()).toBe("sk-first");
		expect(readStoredApiKey(OTHER_PROVIDER)).toBe("sk-second");
	});

	it("删除只移除指定 provider", () => {
		storeApiKey("sk-first");
		storeApiKey("sk-second", OTHER_PROVIDER);
		expect(clearApiKey()).toBe(true);
		expect(readStoredApiKey()).toBe("");
		expect(readStoredApiKey(OTHER_PROVIDER)).toBe("sk-second");
	});

	it("文件不存在时删除返回 false", () => {
		expect(clearApiKey()).toBe(false);
	});

	it("删掉最后一个凭据时连文件一起删", () => {
		storeApiKey("sk-only");
		expect(clearApiKey()).toBe(true);
		expect(existsSync(getCredentialsPath())).toBe(false);
	});

	it("文件损坏时当作没有凭据，而不是抛错", async () => {
		await writeFile(getCredentialsPath(), "{ 这不是 JSON", "utf-8");
		expect(readCredentials()).toEqual({});
		expect(readStoredApiKey()).toBe("");
	});

	it("内容不是对象时也当作没有凭据", async () => {
		await writeFile(getCredentialsPath(), "[1,2,3]", "utf-8");
		expect(readCredentials()).toEqual({});
	});
});

describe("maskKey", () => {
	it("长密钥保留首尾", () => {
		expect(maskKey("sk-abcdefghijklmnop")).toBe("sk-abc…mnop");
	});

	it("短密钥全部打码", () => {
		expect(maskKey("short")).toBe("sh***");
	});

	it("空密钥显示未设置", () => {
		expect(maskKey("")).toBe("(未设置)");
	});
});

describe("resolveApiKey 优先级", () => {
	it("都没有时来源为 none", () => {
		expect(resolveApiKey(undefined)).toEqual({ key: "", source: "none" });
	});

	it("命令行参数优先", () => {
		process.env.DEEPSEEK_API_KEY = "sk-from-env";
		storeApiKey("sk-from-file");
		expect(resolveApiKey("sk-from-flag")).toEqual({ key: "sk-from-flag", source: "flag" });
	});

	it("环境变量优先于本地保存", () => {
		process.env.DEEPSEEK_API_KEY = "sk-from-env";
		storeApiKey("sk-from-file");
		expect(resolveApiKey(undefined)).toEqual({ key: "sk-from-env", source: "env" });
	});

	it("没有环境变量时用本地保存的", () => {
		storeApiKey("sk-from-file");
		expect(resolveApiKey(undefined)).toEqual({ key: "sk-from-file", source: "auth" });
	});

	it("空白参数被忽略", () => {
		storeApiKey("sk-from-file");
		expect(resolveApiKey("   ")).toEqual({ key: "sk-from-file", source: "auth" });
	});
});
