/**
 * 请求重试。
 *
 * 网关偶发 429/5xx、或网络抖动时，直接失败会让一整轮生成白跑——上游任务可能已经跑了几十个
 * 工具调用。这里做最朴素也最有效的处理：指数退避 + 抖动重试几次，并且：
 *
 * - 只重试「值得重试」的：429、5xx、网络错误；401/400 这类重试多少次都是一样的结果；
 * - 尊重服务端的 `Retry-After`（DeepSeek 限速时会带），且**不受我们自己的退避上限约束**；
 * - 用户主动取消（AbortSignal）立刻停下，不把退避拖成「点了停止还在跑」。
 */

/** 默认重试次数（不含首次请求） */
export const DEFAULT_RETRIES = 2;

/** 退避基准毫秒数：第 n 次重试等待 base * 2^n */
export const RETRY_BASE_MS = 600;

/** 单次等待上限，避免上游长时间不可用时卡太久 */
export const RETRY_MAX_DELAY_MS = 8000;

/**
 * 服务端 `Retry-After` 的硬上限。
 *
 * 它**不**受 `RETRY_MAX_DELAY_MS` 约束（那是我们自己退避的上限），但也不能让一个病态的响应头
 * （比如 6 小时）把一整轮生成挂死。等待期间用户看得见（CLI 会打「Nms 后重试」），
 * 所以「按服务端说的等久一点」比「到点就撞回去」好。
 */
export const RETRY_AFTER_MAX_MS = 300_000;

/** 重试参数 */
export interface RetryOptions {
	/** 重试次数，0 表示不重试 */
	retries?: number;
	/** 退避基准毫秒数 */
	baseDelayMs?: number;
	/** 单次等待上限 */
	maxDelayMs?: number;
}

/** 值得重试的 HTTP 状态码 */
export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * 是否是值得重试的网络层错误。
 *
 * fetch 的失败统一抛 TypeError（网络中断、DNS 失败、连接被重置），此外 Node 的 undici 会把
 * 底层错误挂在 cause 上。主动取消抛的是 AbortError，绝不能重试。
 */
export function isRetryableError(error: unknown): boolean {
	if (error instanceof Error) {
		if (error.name === "AbortError") {
			return false;
		}
		if (error.name === "TimeoutError") {
			return true;
		}
		const code = (error as { code?: string }).code ?? (error.cause as { code?: string } | undefined)?.code;
		if (code !== undefined) {
			return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"].includes(code);
		}
		return error.name === "TypeError";
	}
	return false;
}

/** 解析 Retry-After：支持秒数与 HTTP 日期两种写法，解析不出来就返回 null */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
	if (!header) {
		return null;
	}
	const trimmed = header.trim();
	if (/^\d+$/.test(trimmed)) {
		return Number(trimmed) * 1000;
	}
	const date = Date.parse(trimmed);
	return Number.isNaN(date) ? null : Math.max(date - now, 0);
}

/**
 * 算这一次重试该等多久。
 *
 * 指数退避 + 最多 25% 的抖动：多个会话同时被限速时，抖动能把它们错开，不至于一起再撞上去。
 *
 * `Retry-After` 是**服务端下的指令**，不受我们自己的退避上限约束。原先的实现把它一起夹到 `maxDelayMs`：
 * 服务端说「30 秒后再来」，我们 8 秒就撞回去，几次重试全落在同一个限速窗口里，一整轮白跑。
 * 现在只受 `RETRY_AFTER_MAX_MS` 这个硬上限约束。
 */
export function retryDelayMs(
	attempt: number,
	options: RetryOptions = {},
	retryAfterMs: number | null = null,
	random: () => number = Math.random,
): number {
	const base = options.baseDelayMs ?? RETRY_BASE_MS;
	const max = options.maxDelayMs ?? RETRY_MAX_DELAY_MS;
	const exponential = Math.min(base * 2 ** attempt, max);
	if (retryAfterMs !== null) {
		// 比我们自己的退避短时按我们的来（等够再试总没错），长时听服务端的
		return Math.min(Math.max(retryAfterMs, exponential), RETRY_AFTER_MAX_MS);
	}
	const jitter = 1 + random() * 0.25;
	return Math.min(Math.round(exponential * jitter), max);
}

/** 可取消的等待；被取消时返回 false */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) {
		return Promise.resolve(false);
	}
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
