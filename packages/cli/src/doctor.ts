import { describeError } from "limkenion-ai";
/**
 * 环境体检。
 *
 * 「为什么跑不起来」这类问题，九成出在几个固定的地方：Node 版本、配置目录权限、凭据来源、
 * 会话目录与工作目录能不能写、接口能不能连上。挨个试一遍比让用户来回描述现象快得多。
 *
 * 每个检查都是**纯函数**（能注入版本号、目录、fetch），所以可以单独测；
 * `runDoctor` 只负责把它们串起来、算总账。
 */

import { accessSync, constants } from "node:fs";

/** 单个检查的结论 */
export interface DoctorCheck {
	/** 检查项名称 */
	name: string;
	/** ok 正常、warn 能用但有隐患、fail 会直接导致跑不起来 */
	status: "ok" | "warn" | "fail";
	/** 给用户看的一句话结论 */
	detail: string;
}

/** 体检输入，测试里可以全部注入 */
export interface DoctorInput {
	/** Node 版本号，默认取当前进程 */
	nodeVersion?: string;
	/** 配置目录 */
	agentDir: string;
	/** 会话根目录 */
	sessionsDir: string;
	/** 工作目录 */
	cwd: string;
	/** 已解析的密钥与来源 */
	apiKey: { key: string; source: string };
	/** 默认模型 id 是否在已知表里 */
	knownModel: boolean;
	/** 默认模型 id */
	modelId: string;
	/** 接口地址 */
	baseUrl: string;
	/** 检查可写性用的实现，默认走 fs */
	canWrite?: (dir: string) => boolean;
	/** 探测接口可达性，默认 fetch + 超时 */
	probe?: (url: string) => Promise<{ ok: boolean; detail: string }>;
	/** 密钥打码函数，默认只显示首尾 */
	mask?: (key: string) => string;
	/** 平台标识，默认取当前平台 */
	platform?: string;
	/** 系统加密后端是否可用 */
	encryptionAvailable?: boolean;
}

/** 要求的最低 Node 版本，与 package.json 的 engines 保持一致 */
export const MIN_NODE_VERSION = "22.19.0";

/** 默认的接口探测超时 */
const PROBE_TIMEOUT_MS = 8000;

/** 比较版本号：a 是否 >= b */
export function versionAtLeast(a: string, b: string): boolean {
	const parse = (value: string): number[] =>
		value
			.split("-")[0]
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0);
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) {
			return diff > 0;
		}
	}
	return true;
}

/** 目录可写性：用 access 判断，不真的写文件 */
function defaultCanWrite(dir: string): boolean {
	try {
		accessSync(dir, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** 默认的接口探测：只要连得上并且有 HTTP 响应就算通，不校验鉴权 */
export async function defaultProbe(url: string): Promise<{ ok: boolean; detail: string }> {
	try {
		const response = await fetch(`${url.replace(/\/+$/, "")}/models`, {
			method: "GET",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		// 401/403 说明连得上，只是没带对密钥——对「可达性」来说算通过。
		if (response.ok || response.status === 401 || response.status === 403) {
			return { ok: true, detail: `HTTP ${response.status}` };
		}
		return { ok: false, detail: `HTTP ${response.status}` };
	} catch (error) {
		const reason = describeError(error);
		return { ok: false, detail: reason };
	}
}

/** 执行全部检查；顺序按「先看能不能跑，再看配置对不对」排 */
export async function collectChecks(input: DoctorInput): Promise<DoctorCheck[]> {
	const canWrite = input.canWrite ?? defaultCanWrite;
	const probe = input.probe ?? defaultProbe;
	const mask = input.mask ?? ((key: string) => (key === "" ? "(未设置)" : `${key.slice(0, 6)}…${key.slice(-4)}`));
	const nodeVersion = input.nodeVersion ?? process.versions.node;
	const platform = input.platform ?? process.platform;

	const checks: DoctorCheck[] = [];

	checks.push(
		versionAtLeast(nodeVersion, MIN_NODE_VERSION)
			? { name: "Node 版本", status: "ok", detail: `${nodeVersion}（要求 ≥ ${MIN_NODE_VERSION}）` }
			: {
					name: "Node 版本",
					status: "fail",
					detail: `${nodeVersion} 低于要求的 ${MIN_NODE_VERSION}，请升级 Node`,
				},
	);

	checks.push(
		canWrite(input.agentDir)
			? { name: "配置目录", status: "ok", detail: input.agentDir }
			: { name: "配置目录", status: "fail", detail: `不可写：${input.agentDir}` },
	);

	checks.push(
		input.apiKey.key === ""
			? {
					name: "接口密钥",
					status: "warn",
					detail: "没有可用密钥，可以浏览历史会话但无法发起生成（用 auth login 或在网页侧栏填写）",
				}
			: { name: "接口密钥", status: "ok", detail: `${mask(input.apiKey.key)}（来自 ${input.apiKey.source}）` },
	);

	if (platform === "win32") {
		checks.push(
			input.encryptionAvailable === false
				? { name: "密钥存储", status: "warn", detail: "系统加密不可用，本地密钥以明文保存（权限 0600）" }
				: { name: "密钥存储", status: "ok", detail: "DPAPI 加密，仅本机本用户可解" },
		);
	}

	checks.push(
		canWrite(input.sessionsDir)
			? { name: "会话目录", status: "ok", detail: input.sessionsDir }
			: { name: "会话目录", status: "fail", detail: `不可写：${input.sessionsDir}` },
	);

	checks.push(
		canWrite(input.cwd)
			? { name: "工作目录", status: "ok", detail: input.cwd }
			: { name: "工作目录", status: "warn", detail: `不可写：${input.cwd}（工具无法改文件）` },
	);

	checks.push(
		input.knownModel
			? { name: "模型", status: "ok", detail: input.modelId }
			: {
					name: "模型",
					status: "warn",
					detail: `${input.modelId} 不在已知模型表里，将按保守上限（64K 上下文）处理`,
				},
	);

	const probed = await probe(input.baseUrl);
	checks.push(
		probed.ok
			? { name: "接口可达性", status: "ok", detail: `${input.baseUrl}（${probed.detail}）` }
			: { name: "接口可达性", status: "fail", detail: `${input.baseUrl} 连不上：${probed.detail}` },
	);

	return checks;
}

/** 汇总：有 fail 就算不通过 */
export function summarize(checks: DoctorCheck[]): { failed: number; warned: number; ok: number } {
	return {
		failed: checks.filter((check) => check.status === "fail").length,
		warned: checks.filter((check) => check.status === "warn").length,
		ok: checks.filter((check) => check.status === "ok").length,
	};
}
