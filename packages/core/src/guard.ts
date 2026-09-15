/**
 * 循环卫生（guard）。
 *
 * 借鉴 DSH 的 guard 家族，盯住两种最常见的「白烧时间与 token」：
 *
 * 1. **重复调用**：模型把同一个工具、同一份参数反复调，结果当然也不会变。这里只做提醒——
 *    把「这是第 N 次完全相同的调用」附在工具结果后面，让它换思路或直接收尾；不做硬性熔断，
 *    因为偶发的重复（例如轮询等待）是合理的。
 * 2. **工具超时**：工具可以自己声明 `timeoutMs`，超时就给模型一个明确的超时错误，而不是让
 *    会话干挂着。默认不设超时（各工具自己最清楚该等多久）。
 */

/** 默认在第几次完全相同的调用后提醒 */
export const DEFAULT_REPEAT_LIMIT = 3;

/** 一次工具调用的签名：工具名 + 原始参数 */
export function callSignature(name: string, args: string): string {
	return `${name}\u0000${args}`;
}

/** 重复调用的提醒文案 */
export function repeatReminder(toolName: string, times: number): string {
	return `[提示] 这已经是第 ${times} 次完全相同的 ${toolName} 调用，结果大概率不会变。请换一种做法（改参数、换工具）或直接给出结论。`;
}

/** 重复调用追踪器 */
export class RepeatGuard {
	/** 连续相同调用达到这个次数就提醒 */
	private readonly limit: number;
	/** 上一次的签名 */
	private last = "";
	/** 已经连续重复了几次 */
	private count = 0;

	constructor(limit: number = DEFAULT_REPEAT_LIMIT) {
		this.limit = Math.max(limit, 2);
	}

	/**
	 * 记录一次调用。
	 *
	 * 返回提醒文案（达到阈值时）或 null；换了一个调用就重新计数。
	 */
	observe(name: string, args: string): string | null {
		const signature = callSignature(name, args);
		if (signature === this.last) {
			this.count += 1;
		} else {
			this.last = signature;
			this.count = 1;
		}
		if (this.count < this.limit) {
			return null;
		}
		// 达到阈值后每次都提醒：模型若还在重复，说明需要持续的压力。
		return repeatReminder(name, this.count);
	}

	/** 当前连续重复次数，供测试与调试 */
	get repeats(): number {
		return this.count;
	}
}

/** 超时错误文案 */
export function timeoutMessage(toolName: string, timeoutMs: number): string {
	return `${toolName} 超时（超过 ${timeoutMs}ms），已中止这一次调用。可以缩小范围重试，或改用更小的输入。`;
}

/**
 * 给一次工具调用套上超时。
 *
 * 工具没声明 `timeoutMs` 就不设限；超时后不再等待（结果被丢弃），但**不强行杀掉工具**——
 * 工具内部若有子进程，应由它自己按 signal 收尾。超时值非正数视为不设限。
 */
export async function withToolTimeout(
	toolName: string,
	timeoutMs: number | undefined,
	run: () => Promise<{ content: string; isError: boolean }>,
): Promise<{ content: string; isError: boolean }> {
	if (timeoutMs === undefined || timeoutMs <= 0) {
		return run();
	}
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			run(),
			new Promise<{ content: string; isError: boolean }>((resolve) => {
				timer = setTimeout(() => {
					resolve({ content: timeoutMessage(toolName, timeoutMs), isError: true });
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
