/*
 * 代码评审：POST /api/review
 *
 * 命令行早有 `limkenion review`（以及 REPL 里的 `/review`）：几个评审者各管一个角度、并行各跑
 * 一遍，再由一个汇总者合成一份带 `VERDICT:` 行的报告。网页一直没有入口，这个模块把那条路补齐。
 *
 * 与终端面板同一套骨架：模块加载时注册路由、同一时刻只允许一轮评审、冲突回 409。
 * 但这里回的是 JSON 而不是 SSE：评审只有「跑完给一份报告」这一个结果，没有中间的输出流，
 * 用 SSE 只会凭空造出「断线了怎么续」的问题。代价是长连接要活到评审结束，所以超时按不设算，
 * 唯一的收尾依据是客户端断开——`response.on("close")` 一响就 abort，把还在跑的评审者收掉，
 * 否则一个关掉的标签页会在后台白烧几分钟的额度。
 *
 * 凭据与模型都从 `FeatureContext` 拿，不另开一条路：`registry.resolveApiKey()` 就是网页上刚填
 * 那把密钥生效的通道，`getModel()` 是界面上选的模型。评审判定「能不能跑」的逻辑（有没有 diff、
 * 有没有评审者给出结论）全在 `review.ts` 里，这里只负责接线与报错。
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createReviewRuntimeFor, runReview } from "../review.ts";
import type { FeatureRoute } from "./features.ts";
import { readJsonBody, sendJson } from "./http.ts";
import type { ErrorResponse } from "./protocol.ts";

/** 评审的端点 */
const REVIEW_PATH = "/api/review";

/**
 * 同一时刻只允许一轮评审。
 *
 * 与终端面板同理，放模块级而不是挂在请求上：每一轮评审都会并发起好几个代理，两轮叠在一起
 * 就是六七个并发请求，撞限速的概率成倍上升；而且它是服务进程里的一份全局资源（一个工作目录）。
 */
let running = false;

/**
 * `POST /api/review` 的响应。
 *
 * 形状定义在本模块而不是 protocol.ts：协议那份共享文件由多个功能并行改动，本功能自带的字段
 * 先留在自己这里（与 feature-files.ts 同一套做法）。前端是手写 JS，靠字段名对齐。
 */
export interface ReviewResponse {
	ok: true;
	/** 汇总后的报告全文，Markdown */
	report: string;
	/** `block` 表示有 blocker（命令行据此回退出码 1），`ok` 表示没有 */
	verdict: "block" | "ok";
	/** 没有给出结论的评审者（角度名）；结论里会说明 */
	failed: string[];
	/** 参与评审的改动文件，相对仓库根 */
	files: string[];
	/**
	 * 实际评审的仓库目录（绝对路径）。
	 *
	 * 回给界面是为了让它能写出「评的是哪个目录」：网页上切换工作目录后，用户没什么别的办法确认
	 * 这一轮对着哪儿跑。服务端已经解析过它，客户端原样显示即可。
	 */
	cwd: string;
}

/** 只认 POST /api/review；命中就整条请求归这里管 */
export const route: FeatureRoute = async (request, response, url, method, context) => {
	if (url.pathname !== REVIEW_PATH) {
		return false;
	}
	if (method !== "POST") {
		sendJson(response, 405, { error: "评审只支持 POST /api/review" } satisfies ErrorResponse);
		return true;
	}
	await handleReview(request, response, context);
	return true;
};

/** 读参数、占住并发位、跑一轮、写回结果 */
async function handleReview(
	request: Parameters<FeatureRoute>[0],
	response: Parameters<FeatureRoute>[1],
	context: Parameters<FeatureRoute>[4],
): Promise<void> {
	// 先检查再读请求体：读体是异步的，两条请求会在这里交错，谁都不会看到对方把 running 置上。
	if (running) {
		sendJson(response, 409, {
			error: "已有一轮评审在跑；评审一次只跑一轮，等它结束再试",
		} satisfies ErrorResponse);
		return;
	}
	running = true;

	// 客户端断开就用它收掉还在跑的评审者。`close` 在正常收尾时也会响，所以不能直接 abort：
	// 先标记「已经答完了」，只有还没写回结果的断开才算中断。
	const abort = new AbortController();
	let settled = false;
	const onClose = (): void => {
		if (!settled) {
			abort.abort();
		}
	};
	response.on("close", onClose);

	try {
		const body = await readJsonBody(request);
		const base = typeof body.base === "string" ? body.base.trim() : "";
		const requested = typeof body.cwd === "string" ? body.cwd.trim() : "";
		const cwd = requested === "" ? context.getCwd() : resolve(requested);
		if (requested !== "") {
			const info = statSync(cwd, { throwIfNoEntry: false });
			if (!info) {
				sendJson(response, 400, { error: `目录不存在：${cwd}` } satisfies ErrorResponse);
				return;
			}
			if (!info.isDirectory()) {
				sendJson(response, 400, { error: `不是目录：${cwd}` } satisfies ErrorResponse);
				return;
			}
		}

		const runtime = createReviewRuntimeFor({
			apiKey: context.registry.resolveApiKey(),
			modelId: context.getModel(),
			baseUrl: context.getBaseUrl(),
			cwd,
			signal: abort.signal,
			fetchImpl: context.fetchImpl,
		});
		const outcome = await runReview(runtime, { cwd, base: base === "" ? undefined : base });
		if (!outcome.ok) {
			sendJson(response, 400, { error: outcome.error } satisfies ErrorResponse);
			return;
		}
		sendJson(response, 200, {
			ok: true,
			report: outcome.report,
			verdict: outcome.verdict,
			failed: outcome.failed,
			files: outcome.files,
			cwd,
		} satisfies ReviewResponse);
	} catch (error) {
		// 断开导致的失败写不回去（响应已经没了），也没有客户端在等这份报错。
		if (!response.writableEnded && !response.destroyed) {
			sendJson(response, 500, { error: describeFailure(error) } satisfies ErrorResponse);
		}
	} finally {
		settled = true;
		response.off("close", onClose);
		// 任何提前返回（缺字段、目录不存在、报错）都要把并发位放掉，否则评审会永久锁死。
		running = false;
	}
}

/**
 * 把异常翻成一句可读的原因。
 *
 * `runReview` 自己已经把「做不了」翻译成 `{ ok: false, error }` 了，能走到这里的是接线层的意外
 * （读请求体失败、目录访问出错）。原样抛出去的 `Error` 会变成 `Error: xxx` 那种带前缀的串，
 * 界面上不好看，所以只取 message。
 */
function describeFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `评审失败：${message}`;
}
