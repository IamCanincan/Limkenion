/**
 * 密钥落盘前的加密封装。
 *
 * 目标很简单：`auth.json` 被复制走（备份、同步网盘、误传）之后，里面的密钥在别的机器上解不开。
 *
 * 做法是不自己管密钥，交给操作系统：Windows 上用 DPAPI 的 `CurrentUser` 作用域，密文只有
 * 同一台机器的同一个用户能解开。这样既不引入依赖，也不需要在本地再放一把用来解密的钥匙——
 * 自己加密、密钥又存在旁边，只是把明文换个写法。
 *
 * 拿不到系统能力时（非 Windows，或 PowerShell 不可用）返回 null，调用方据此回退到明文存储，
 * 并在界面与 `auth status` 里说明，而不是假装加密了。
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** 加密后的密钥与产生它的后端 */
export interface SealedSecret {
	/** base64 密文 */
	secret: string;
	/** 后端标识，解密时必须对上 */
	backend: string;
}

/** 当前支持的加密后端标识 */
export const DPAPI_BACKEND = "dpapi-current-user";

/** 子进程超时：加密是本地计算，超过这个时间说明环境不正常 */
const SPAWN_TIMEOUT_MS = 10_000;

/** 解出来的明文缓存：每次生成都要取密钥，不能每次都起一个 PowerShell */
const decrypted = new Map<string, string>();

/** PowerShell 可执行文件路径 */
function powershellPath(): string {
	const root = process.env.SystemRoot ?? "C:\\Windows";
	return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** 跑一段 PowerShell，从标准输出拿结果；失败返回 null */
function runPowerShell(script: string, payload: string): string | null {
	if (process.platform !== "win32") {
		return null;
	}
	try {
		const result = spawnSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
			// 待处理的数据走环境变量，不拼进命令行：密钥里可能有引号或空格。
			env: { ...process.env, LIMKENION_SECRET_INPUT: payload },
			encoding: "utf-8",
			timeout: SPAWN_TIMEOUT_MS,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status !== 0 || typeof result.stdout !== "string") {
			return null;
		}
		const text = result.stdout.replace(/\r/g, "").trim();
		return text === "" ? null : text;
	} catch {
		return null;
	}
}

/** DPAPI 加密脚本：CurrentUser 作用域，密文换台机器就解不开 */
const ENCRYPT_SCRIPT =
	"Add-Type -AssemblyName System.Security; " +
	"$bytes = [Text.Encoding]::UTF8.GetBytes($env:LIMKENION_SECRET_INPUT); " +
	"$sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'); " +
	"[Console]::Out.Write([Convert]::ToBase64String($sealed))";

/** DPAPI 解密脚本 */
const DECRYPT_SCRIPT =
	"Add-Type -AssemblyName System.Security; " +
	"$sealed = [Convert]::FromBase64String($env:LIMKENION_SECRET_INPUT); " +
	"$bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'CurrentUser'); " +
	"[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))";

/** 当前平台是否具备加密能力，供界面显示用 */
export function encryptionBackend(): string | null {
	if (process.platform !== "win32") {
		return null;
	}
	return DPAPI_BACKEND;
}

/** 加密密钥；拿不到系统能力时返回 null，由调用方回退 */
export function encryptSecret(plain: string): SealedSecret | null {
	if (plain === "" || encryptionBackend() === null) {
		return null;
	}
	const secret = runPowerShell(ENCRYPT_SCRIPT, plain);
	return secret === null ? null : { secret, backend: DPAPI_BACKEND };
}

/** 解密密钥；后端不对或密文损坏都返回 null */
export function decryptSecret(secret: string, backend: string): string | null {
	if (secret === "" || backend !== DPAPI_BACKEND) {
		return null;
	}
	const cached = decrypted.get(secret);
	if (cached !== undefined) {
		return cached;
	}
	const plain = runPowerShell(DECRYPT_SCRIPT, secret);
	if (plain !== null) {
		decrypted.set(secret, plain);
	}
	return plain;
}
