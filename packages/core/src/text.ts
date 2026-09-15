/**
 * 跨模块共用的文本处理。
 *
 * 收到这里的都是「多个调用点各自写了一遍、且语义确实相同」的处理：按字节截断、压平空白、
 * NUL 判定。语义不同的部分（截断长度、窗口、省略号）仍留在各自调用点，不往这里塞。
 */

/** NUL 字符本身，判定二进制的唯一依据 */
const NUL = "\u0000";

/**
 * 这段内容是否应当按二进制对待。
 *
 * 判据是出现 NUL 字节。文本编码（UTF-8、GBK、Latin-1 等）不会产生 \0，二进制格式却几乎都有
 * 大片对齐填充的 \0，所以它比按扩展名或统计可打印字符都简单，也更准。副作用是 UTF-16 文本
 * 也会被判成二进制：那正是想要的——按 UTF-8 解出来每个字符之间夹一个 \0，喂给模型就是乱码。
 *
 * 只看开头若干字节这件事故意没做：调用方传进来的就是它愿意检查的那一段，截取窗口是调用方的
 * 策略。目前三处（read、grep、Web 预览）都传整个文件，因为「只看开头」会把后半段带 NUL 的
 * 文件当文本读，那是行为变化而不是重构。
 *
 * 入参允许字节数组，是因为调用方手里本来就是 Buffer，为了看一眼 NUL 先转成字符串不划算。
 * 两条分支不能合并成 text.includes(0)：字符串的 includes 会把参数当字符串，0 变成 "0"，
 * 于是 NUL 永远匹配不上——多字节与字符串两种入参必须分开判。
 */
export function looksBinary(text: string | Uint8Array): boolean {
	return typeof text === "string" ? text.includes(NUL) : text.includes(0);
}

/**
 * 把连续空白压成单个空格并去掉首尾空白。
 *
 * 终端展示与搜索片段都要「一行内说完」，多行内容里的换行、缩进、制表符只会把版面撑乱。
 * 只做压平，不截断也不加省略号：截断长度各调用点不同（会话预览 80 字、片段 120 字），
 * 合并进来反而要再加参数。
 */
export function flattenWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * 按字节上限截取字符串，且不切断多字节字符。
 *
 * 不能直接按字符数截断：一个中文在 UTF-8 下占 3 字节，按字节数硬切会切出半个字符，
 * 拼进提示词或工具输出就是乱码。这里用 Buffer 量真实长度，超了就往前退到字符边界。
 *
 * 往前退用二分：UTF-8 每个字符至少 1 字节，所以答案不会超过 `min(字符数, 上限)`；
 * 而「前缀字节数 ≤ 上限」随长度单调，可以二分找最长的那个前缀。逐字符回退的代价不是
 * 常数——按 50KB 截断一段中文要退三万余次，每次都重量一遍近 50KB 的前缀，实测单次 900ms，
 * 且整个过程卡住事件循环（工具输出、diff、文件预览都走这里）。
 *
 * 上限非正数时返回空串：没有额度就等于留不下任何内容。
 */
export function sliceByBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) {
		return "";
	}
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
		return text;
	}
	let low = 0;
	let high = Math.min(text.length, maxBytes);
	while (low < high) {
		const mid = low + Math.ceil((high - low) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= maxBytes) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return text.slice(0, low);
}

/**
 * 取一段文本的第一行。
 *
 * 会话与快照都是 JSONL，表头就在第一行；而列出会话时要把每个文件都打开看一眼，
 * `split("\n")[0]` 等于为了一行把整份文件切成行数组——实测 4MB 的会话取一次首行 1.9ms，
 * 几十个会话就是上百毫秒的临时字符串。行尾的 `\r` 原样保留，要不要去掉由调用方决定。
 */
export function firstLine(text: string): string {
	const at = text.indexOf("\n");
	return at < 0 ? text : text.slice(0, at);
}

/** 展示用的一行摘要长度上限 */
export const INLINE_LIMIT = 200;

/**
 * 把任意值压成一行，供终端展示。
 *
 * 两处调用（工具入参预览、审批确认）原来各写一份，连省略号都不一致（"..." 与 "…"）。
 * JSON 化失败（循环引用、BigInt 混在一起）时不抛错，退回 String()——这类展示代码出错会把
 * 整条渲染路径打断，为了显示一行参数并不值得。
 */
export function summarizeInline(value: unknown, maxLength = INLINE_LIMIT): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	const flat = flattenWhitespace(text);
	return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}
