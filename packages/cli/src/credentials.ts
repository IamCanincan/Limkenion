/**
 * 接口凭据的本地存储与隐藏式输入。
 *
 * 凭据放在独立的 auth.json 里，与普通配置分开，文件权限 0600。
 * 这样备份或分享配置文件时不会连密钥一起带出去，也省得每次都去设环境变量。
 *
 * 在此基础上再做一层：密钥优先加密后落盘（见 secret-store.ts），所以即使 auth.json 被复制到
 * 别的机器也解不开。拿不到系统加密能力时才退回明文，并在 auth status 里说明。
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readApiKey } from "limkenion-ai";
import { firstLine, readJsonObject } from "limkenion-core";
import { getAgentDir } from "./config.ts";
import { decryptSecret, encryptionBackend, encryptSecret } from "./secret-store.ts";

/** 存储时使用的 provider 名，与默认接入的供应商对应 */
export const CREDENTIAL_PROVIDER = "deepseek";

/** 密钥的来源，按优先级从高到低 */
export type ApiKeySource = "flag" | "env" | "auth" | "none";

/** 一条 API 密钥凭据。secret 与 key 二选一：前者是密文，后者是退化的明文 */
export interface ApiCredential {
	type: "api";
	/** 明文密钥。只在当前系统没有加密后端时出现 */
	key?: string;
	/** 加密后的密钥（base64） */
	secret?: string;
	/** 产生密文的后端标识 */
	backend?: string;
}

/** auth.json 的形状：provider 名到凭据 */
export type CredentialStore = Record<string, ApiCredential | undefined>;

/** auth.json 的路径 */
export function getCredentialsPath(): string {
	return join(getAgentDir(), "auth.json");
}

/**
 * 读取全部凭据。
 *
 * 文件不存在或内容损坏都返回空对象：凭据文件坏掉不该让 CLI 完全起不来，
 * 后续会因为「缺少密钥」给出明确提示。
 */
export function readCredentials(): CredentialStore {
	// 文件缺失、损坏、顶层不是对象都当作「没有凭据」：凭据坏掉不该让 CLI 完全起不来，
	// 后续会因为「缺少密钥」给出明确提示。
	return (readJsonObject(getCredentialsPath()) as CredentialStore | null) ?? {};
}

/** 读取某个 provider 的密钥，没有则返回空字符串 */
export function readStoredApiKey(provider: string = CREDENTIAL_PROVIDER): string {
	const entry = readCredentials()[provider];
	if (!entry) {
		return "";
	}
	if (typeof entry.secret === "string" && entry.secret !== "") {
		return decryptSecret(entry.secret, entry.backend ?? "")?.trim() ?? "";
	}
	return typeof entry.key === "string" ? entry.key.trim() : "";
}

/**
 * 按优先级确定生效的 API 密钥：命令行 > 环境变量 > 本地凭据文件。
 *
 * 优先级：显式传入的永远优先，环境变量适合 CI，auth.json 适合本地日常使用。
 */
export function resolveApiKey(flagValue: string | undefined): { key: string; source: ApiKeySource } {
	const fromFlag = flagValue?.trim();
	if (fromFlag) {
		return { key: fromFlag, source: "flag" };
	}
	const fromEnv = readApiKey();
	if (fromEnv) {
		return { key: fromEnv, source: "env" };
	}
	const stored = readStoredApiKey();
	if (stored) {
		return { key: stored, source: "auth" };
	}
	return { key: "", source: "none" };
}

/** 写入密钥，返回写入的文件路径。优先加密，拿不到系统能力时退回明文 */
export function storeApiKey(key: string, provider: string = CREDENTIAL_PROVIDER): string {
	const path = getCredentialsPath();
	mkdirSync(getAgentDir(), { recursive: true });
	const credentials = readCredentials();
	const sealed = encryptSecret(key);
	credentials[provider] = sealed
		? { type: "api", secret: sealed.secret, backend: sealed.backend }
		: { type: "api", key };
	// mode 只在创建时生效，且 Windows 会忽略它；补一次 chmod 以覆盖已存在文件被放宽的情况。
	writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Windows 上 chmod 基本无效，忽略即可。
	}
	return path;
}

/** 当前平台的密钥存储方式，用于在界面与 auth status 里如实说明 */
export function keyStorageDescription(): string {
	return encryptionBackend() === null ? "明文（当前平台没有可用的加密后端）" : "系统加密（DPAPI，仅本机本用户可解）";
}

/** 删除某个 provider 的密钥。返回是否真的删掉了。 */
export function clearApiKey(provider: string = CREDENTIAL_PROVIDER): boolean {
	const path = getCredentialsPath();
	if (!existsSync(path)) {
		return false;
	}
	const credentials = readCredentials();
	if (!(provider in credentials)) {
		return false;
	}
	delete credentials[provider];
	// 没有别的 provider 了就直接删文件，免得留下一个空的 auth.json 让人以为还有凭据。
	if (Object.keys(credentials).length === 0) {
		rmSync(path, { force: true });
		return true;
	}
	writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	return true;
}

/** 把密钥打码，只留首尾便于确认用的是哪一把 */
export function maskKey(key: string): string {
	if (key === "") {
		return "(未设置)";
	}
	if (key.length <= 12) {
		return `${key.slice(0, 2)}${"*".repeat(Math.max(key.length - 2, 2))}`;
	}
	return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** 从标准输入读第一行，用于非交互场景 */
async function readLineFromStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk as Uint8Array));
	}
	const text = Buffer.concat(chunks).toString("utf-8");
	return firstLine(text).trim();
}

/**
 * 读取一行输入且不在终端回显，用于输入密钥。
 *
 * TTY 下切到原始模式逐字符读取，自己处理回车、退格与 Ctrl+C；非 TTY（管道、重定向）下
 * 按普通行读取，此时输入本来就不会显示在用户屏幕上。
 */
export async function promptSecret(question: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		const value = await readLineFromStdin();
		if (value === "") {
			throw new Error("没有从标准输入读到内容");
		}
		return value;
	}

	process.stderr.write(question);
	stdin.setRawMode(true);
	stdin.resume();

	return new Promise<string>((resolve, reject) => {
		// 用 StringDecoder 拼接，避免多字节字符被分片切断。
		const decoder = new StringDecoder("utf8");
		let value = "";

		const cleanup = (): void => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
		};

		const onData = (chunk: Buffer): void => {
			for (const char of decoder.write(chunk)) {
				if (char === "\r" || char === "\n") {
					cleanup();
					process.stderr.write("\n");
					resolve(value);
					return;
				}
				if (char === "\u0003") {
					// Ctrl+C：原始模式下不会自动产生信号，需要自己处理。
					cleanup();
					process.stderr.write("\n");
					reject(new Error("已取消"));
					return;
				}
				if (char === "\u007f" || char === "\b") {
					value = value.slice(0, -1);
					continue;
				}
				value += char;
			}
		};

		stdin.on("data", onData);
	});
}
