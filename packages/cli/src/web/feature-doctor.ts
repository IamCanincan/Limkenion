/*
 * 环境体检：GET /api/doctor
 *
 * 命令行早有 `limkenion doctor`，网页一直没有入口——而「连不上、为什么」恰恰是用户盯着浏览器
 * 界面时最想问的那句话。这个模块把同一套检查搬到服务端跑，再把逐行结论回给右侧面板。
 *
 * 检查本身一行都不在这里重写：`collectChecks`、`summarize`、`proxyEnvRows`、`describeNetworkGuidance`、
 * `hookRows` 全是 `doctor.ts` / `commands/doctor.ts` 里的纯函数，命令行与网页因此不会出现
 * 「CLI 说没事、网页说有事」这种两份实现各自漂移的结果。这里只负责把输入接对：
 *
 * - 工作目录取 `FeatureContext.getCwd()`（网页上可以切目录，`process.cwd()` 是启动目录，不是它）；
 * - 模型取 `getModel()`，接口地址取 `getBaseUrl()`，与界面上选中的、这一轮真正会用的那份一致；
 * - 密钥与评审走同一条路：`registry.resolveApiKey()` 就是网页侧栏里刚填那把密钥生效的通道
 *   （见 feature-review.ts 的说明），不另开第二次凭据查找；
 * - 网络探测沿用 `defaultProbe`（8 秒超时 + describeError），测试里可以用 `context.fetchImpl`
 *   替换掉它——与 CLI 的 `collectChecks({ probe })` 是同一个注入点，所以两端能对着同一个假 fetch
 *   断言出同一组结论（test/web-doctor.test.ts 正是这么做的）。
 *
 * 不加缓存、不做单飞：一次体检要探测网络，最坏八秒，但它是用户按下「重新检查」或刚打开标签
 * 时的主动行为，缓存只会让「我刚插上网线，为什么还说不通」变成新问题。
 */

import { DEFAULT_BASE_URL, DEFAULT_MODEL_ID, describeError, listModelIds, resolveModel } from "limkenion-ai";
import { describeNetworkGuidance, hookRows, proxyEnvRows, readRawHooks } from "../commands/doctor.ts";
import { APP_NAME, getAgentDir, getSessionsDir, VERSION } from "../config.ts";
import { keyStorageDescription, maskKey } from "../credentials.ts";
import type { DoctorCheck } from "../doctor.ts";
import { collectChecks, summarize } from "../doctor.ts";
import { loadSettings } from "../settings.ts";
import type { FeatureRoute } from "./features.ts";
import { sendJson } from "./http.ts";
import type { ErrorResponse } from "./protocol.ts";

/** 体检的端点 */
const DOCTOR_PATH = "/api/doctor";

/** 探测接口可达性时打的那个路径后缀，与 core 的 defaultProbe 一致 */
const MODELS_PATH = "/models";

/** 探测超时；与 `doctor.ts` 里 defaultProbe 的 8 秒保持一致，注入 fetch 时也要有同一个上限 */
const PROBE_TIMEOUT_MS = 8000;

/**
 * `GET /api/doctor` 的响应。
 *
 * 形状定义在本模块而不是 protocol.ts：协议那份共享文件由多个功能并行改动，本功能自带的字段
 * 先留在自己这里（与 feature-files.ts / feature-review.ts 同一套做法）。前端是手写 JS，
 * 靠字段名对齐。
 */
export interface DoctorResponse {
	/** 逐项结论，顺序就是命令行里的顺序：先看能不能跑，再看配置对不对，最后是代理、诊断与钩子 */
	checks: DoctorCheck[];
	/** 应用名与版本，界面上回答「我装的是哪一版」 */
	app: string;
	version: string;
	/** 配置目录；界面头部的「安装路径」就是它（密钥、会话、配置全在这下面） */
	agentDir: string;
	/** 汇总：与 summarize 同义，只是把 failed/warned 换成了界面要念的 ok/warn/fail */
	summary: { ok: number; warn: number; fail: number };
}

/** 只认 GET /api/doctor；命中就整条请求归这里管（包括报错），因此总是返回 true */
export const route: FeatureRoute = async (_request, response, url, method, context) => {
	if (url.pathname !== DOCTOR_PATH) {
		return false;
	}
	// 只读检查：没有请求体可读，因此没有 POST 的语义。
	if (method !== "GET") {
		sendJson(response, 405, { error: "体检只支持 GET /api/doctor" } satisfies ErrorResponse);
		return true;
	}
	sendJson(response, 200, await collectDoctorChecks(context));
	return true;
};

/**
 * 跑一遍全部检查。
 *
 * 与 `runDoctorCommand` 的顺序逐条对齐：collectChecks（Node 版本 → … → 接口可达性）→ 代理两行 →
 * 只在接口不可达时补一行「连接诊断」→ 钩子。界面上因此读到的就是命令行打印的那几行，
 * 连「网络正常时不冒出诊断行」这种取舍都一致。
 */
export async function collectDoctorChecks(context: Parameters<FeatureRoute>[4]): Promise<DoctorResponse> {
	const { settings } = loadSettings();
	// 与命令行同一套兜底：配置文件、环境变量、默认值。网页这边正常是 getModel() 给的模型，
	// 但它为 undefined 时（没给 modelId 直接起服务）仍要有一个能体检的值。
	const modelId = context.getModel() || settings.model || DEFAULT_MODEL_ID;
	const baseUrl = context.getBaseUrl() ?? settings.baseUrl ?? DEFAULT_BASE_URL;

	const checks = await collectChecks({
		agentDir: getAgentDir(),
		sessionsDir: getSessionsDir(),
		cwd: context.getCwd(),
		// 与评审同一条密钥通道：网页上刚保存的那把立刻生效，不重启服务。
		apiKey: { key: context.registry.resolveApiKey(), source: "web 生效中的密钥" },
		knownModel: listModelIds().includes(modelId),
		modelId,
		baseUrl,
		mask: (key) => maskKey(key),
		encryptionAvailable: !keyStorageDescription().includes("明文"),
		// 注入假 fetch 时才替换探测：与 CLI 的 collectChecks({ probe }) 是同一个注入点，
		// 因此测试里同一个假 fetch 在命令行与网页两边得到同一组结论。不给时走 defaultProbe。
		probe: context.fetchImpl === undefined ? undefined : (url) => probeModels(url, context.fetchImpl as typeof fetch),
	});

	// 代理信息排在「接口可达性」之后：先看连不连得上，再看是不是代理没生效。
	const reachability = checks.find((check) => check.name === "接口可达性");
	checks.push(...proxyEnvRows(process.env));
	if (reachability?.status === "fail") {
		// 只有失败才多这一行，网络正常时与命令行输出一样不多话。
		checks.push({
			name: "连接诊断",
			status: "warn",
			detail: describeNetworkGuidance(new Error(reachability.detail), process.env),
		});
	}

	// 钩子行加在末尾：既有各行的相对顺序一行都不动。
	const rawHooks = readRawHooks();
	checks.push(
		...hookRows({
			raw: rawHooks.raw,
			source: rawHooks.raw === undefined ? undefined : rawHooks.source,
			resolve: { cwd: context.getCwd() },
		}),
	);

	// 未知模型在上面已经给了 warn；这里与命令行一样走一遍 resolveModel，确保不认识的模型也拿得到限额。
	resolveModel(modelId);

	const totals = summarize(checks);
	return {
		checks,
		app: APP_NAME,
		version: VERSION,
		agentDir: getAgentDir(),
		summary: { ok: totals.ok, warn: totals.warned, fail: totals.failed },
	};
}

/**
 * 用注入的 fetch 探一次接口可达性。
 *
 * 与 `doctor.ts` 的 defaultProbe 同一套判据：401/403 说明连得上、只是没带对密钥，对「可达性」
 * 来说算通过；其余状态码照实报 HTTP 码；抛异常时走 describeError，把错误码（ENOTFOUND、
 * CERT_HAS_EXPIRED 之类）保留下来，后面的「连接诊断」全靠它定性。
 */
async function probeModels(url: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; detail: string }> {
	try {
		const response = await fetchImpl(`${url.replace(/\/+$/, "")}${MODELS_PATH}`, {
			method: "GET",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (response.ok || response.status === 401 || response.status === 403) {
			return { ok: true, detail: `HTTP ${response.status}` };
		}
		return { ok: false, detail: `HTTP ${response.status}` };
	} catch (error) {
		return { ok: false, detail: describeError(error) };
	}
}
