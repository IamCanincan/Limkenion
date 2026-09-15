/**
 * 子进程收尾。
 *
 * 单独成模块是因为这件事只有一个正确做法，而它并不直观：`child.kill()` 只杀得掉 shell 本身。
 * Windows 上 cmd.exe 被杀之后，它启动的子进程仍然持有 stdout 管道，`close` 事件要等那些孙进程
 * 自己结束才触发（实测一个 0.5 秒超时拖成了 28 秒）；POSIX 上同理，得连进程组一起收。
 *
 * 代价是 POSIX 下必须让子进程成为进程组组长（`detached: true`）才收得掉整组，因此调用方要配套：
 * `spawn(command, { shell: true, detached: process.platform !== "win32", ... })`。
 */

import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import type { TextDecoder as NodeTextDecoder } from "node:util";

/** POSIX 下要不要让这个子进程单独成一个进程组（配合 `killProcessTree` 用） */
export const DETACH_FOR_KILL = process.platform !== "win32";

/** 终止整棵进程树 */
export function killProcessTree(child: ChildProcess): void {
	if (child.pid === undefined) {
		return;
	}
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// 进程组已经不存在（命令已自行退出）时退回普通 kill，避免抛错打断流程。
		child.kill("SIGKILL");
	}
}

/**
 * 把子进程的输出字节转成文本。
 *
 * Windows 上控制台程序按**代码页**写字：中文系统是 GBK/CP936。直接按 UTF-8 解就是一片乱码——
 * `'cat' 不是内部或外部命令，也不是可运行的程序` 会变成 `'cat' ▓▓▓▓▓…`（实测过）。
 * 所以先严格按 UTF-8 解，解不动再退回系统代码页；POSIX 上输出本来就是 UTF-8，走第一条分支。
 *
 * `candidates` 只在测试里传：候选编码是进程级的（跟平台与 locale 走），想验另一个平台的组合
 * 就得能把它换掉，否则「Linux + zh_CN.GBK」这条路径永远只能在那种机器上手动验。
 *
 * 调用方应当**攒够整段再解**（见 bash.ts 里累积 Buffer 的写法）：按块解会在块边界截断多字节字符。
 */
export function decodeProcessOutput(buffer: Buffer, candidates?: string[]): string {
	if (buffer.byteLength === 0) {
		return "";
	}
	try {
		return decodeFatal(buffer, "utf-8");
	} catch {
		// 不是合法 UTF-8：下面按系统代码页再试
	}
	for (const encoding of candidates ?? legacyEncodings()) {
		try {
			// 同样用 fatal：候选里挑一个**能完整解开**的，而不是第一个「不报错」的——
			// 单字节编码从来不报错，那样就等于永远只用列表里的第一个。
			return decodeFatal(buffer, encoding);
		} catch {
			// 这个编码解不开这段字节（或当前 Node 构建里没有它），换下一个
		}
	}
	return buffer.toString("utf-8");
}

/**
 * 按编码缓存的严格解码器。
 *
 * Web 终端是**逐块**解码输出的，每块新建一次 TextDecoder 就是把 ICU 对象的构造重复一遍。
 * `fatal` 解码器在非流式调用（不传 `{ stream: true }`）里不留残余状态，跨调用复用是安全的。
 */
const fatalDecoders = new Map<string, NodeTextDecoder>();

function decodeFatal(buffer: Buffer, encoding: string): string {
	let decoder = fatalDecoders.get(encoding);
	if (decoder === undefined) {
		decoder = new TextDecoder(encoding, { fatal: true });
		fatalDecoders.set(encoding, decoder);
	}
	return decoder.decode(buffer);
}

/** 候选旧编码只在第一次用的时候算：`Intl` 取默认 locale 是一次 ICU 构造，而平台与语言在进程内不变 */
let legacyEncodingCache: string[] | null = null;

/** 当前进程的候选编码（按平台与 locale 算一次，之后复用） */
function legacyEncodings(): string[] {
	if (legacyEncodingCache === null) {
		legacyEncodingCache = legacyEncodingCandidates(process.platform, process.env);
	}
	return legacyEncodingCache;
}

/**
 * POSIX 的 codeset 名 → WHATWG 编码标签；不是能用的旧编码（含 UTF-8）就返回空串。
 *
 * TextDecoder 认的是 WHATWG 那套标签，**不认 cp936 / cp932 / cp949 这类 Windows 代码页号**，
 * 所以常见的中日韩代码页要单独映射一支；`cp1251` 这种能直接翻成 `windows-1251` 的就翻。
 */
function codesetToEncoding(codeset: string): string {
	if (codeset === "" || codeset === "utf-8" || codeset === "utf8") {
		return "";
	}
	const mapped: Record<string, string> = {
		gb2312: "gbk",
		gbk: "gbk",
		"euc-cn": "gbk",
		cp936: "gbk",
		gb18030: "gb18030",
		big5: "big5",
		cp950: "big5",
		"euc-jp": "euc-jp",
		eucjp: "euc-jp",
		"euc-jp-ms": "euc-jp",
		sjis: "shift_jis",
		shift_jis: "shift_jis",
		cp932: "shift_jis",
		"euc-kr": "euc-kr",
		euckr: "euc-kr",
		uhc: "euc-kr",
		cp949: "euc-kr",
		"koi8-r": "koi8-r",
		"koi8-u": "koi8-u",
	};
	const alias = mapped[codeset];
	if (alias !== undefined) {
		return alias;
	}
	// iso-8859-1、windows-1251 这类本来就是 WHATWG 标签，直接用
	if (/^iso-?8859-?\d+$/.test(codeset)) {
		return codeset.replace(/^iso-?8859-?/, "iso-8859-");
	}
	if (/^windows-125\d$/.test(codeset)) {
		return codeset;
	}
	const codepage = /^cp125(\d)$/.exec(codeset);
	return codepage === null ? "" : `windows-125${codepage[1]}`;
}

/** locale 名里的 codeset：形如 `language[_territory][.codeset][@modifier]`，没有点就没有 codeset */
function posixCodeset(locale: string): string {
	const withoutModifier = locale.split("@")[0] ?? "";
	const dot = withoutModifier.lastIndexOf(".");
	return dot === -1
		? ""
		: withoutModifier
				.slice(dot + 1)
				.trim()
				.toLowerCase();
}

/**
 * 候选的旧编码，按平台分两套。
 *
 * **Windows**：控制台代码页不在环境变量里，只能按语言猜——`LC_ALL` / `LANG` 有就听，没有就看
 * `Intl` 给的默认 locale，认得语言就取它的代码页，再兜底 GBK 与 windows-1252（单字节编码永远
 * 「解得开」的特性在这里是有用的：宁可乱码，也别给一整屏替换字符）。
 *
 * **POSIX**：只认 locale 里**明写**的 codeset（`zh_CN.GBK` → gbk）。这一条是刻意收窄的：
 * 单字节编码永远解得开，只要放进候选表，`en_US.UTF-8` 的机器上随便一段二进制就会被解成
 * windows-1252 的乱码，比替换字符更难查。所以没有 codeset、或 codeset 就是 UTF-8 时，
 * 这里返回的候选和「什么都不试」等价——保持原先的行为不变。
 *
 * `platform` 与 `env` 走参数而不是直接读进程：CI 跑 Linux、开发机多半是 Windows，两边分支都要能测。
 */
export function legacyEncodingCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	if (platform !== "win32") {
		const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(
			(value) => typeof value === "string" && value.trim() !== "",
		);
		const encoding = codesetToEncoding(posixCodeset(locale ?? ""));
		return encoding === "" ? ["utf-8"] : [encoding];
	}
	const locale = (env.LC_ALL ?? env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale ?? "").toLowerCase();
	const preferred = locale.startsWith("zh")
		? "gbk"
		: locale.startsWith("ja")
			? "shift_jis"
			: locale.startsWith("ko")
				? "euc-kr"
				: locale.startsWith("ru")
					? "windows-1251"
					: "windows-1252";
	// 偏好项可能就是兜底表里的某一个，去掉重复的那次尝试
	return [...new Set([preferred, "gbk", "windows-1252"])];
}
