/** 共用文本处理的单元测试：NUL 判定、压平空白，以及子进程输出的解码。 */

import { describe, expect, it } from "vitest";
import { decodeProcessOutput, legacyEncodingCandidates } from "../src/process.ts";
import { firstLine, flattenWhitespace, looksBinary, sliceByBytes } from "../src/text.ts";

// Windows 中文系统上，cmd.exe 内建命令的错误信息是 GBK：
// `'cat' 不是内部或外部命令`。这段字节按 UTF-8 解就是一片替换字符（使用者截图里的乱码）。
const gbkBytes = Buffer.from([
	39, 99, 97, 116, 39, 32, 178, 187, 202, 199, 196, 218, 178, 191, 187, 242, 205, 226, 178, 191, 195, 252, 193, 238,
]);

describe("decodeProcessOutput", () => {
	it("合法 UTF-8 原样返回", () => {
		expect(decodeProcessOutput(Buffer.from("中文 ok\n", "utf-8"))).toBe("中文 ok\n");
	});

	it("空输入返回空串", () => {
		expect(decodeProcessOutput(Buffer.alloc(0))).toBe("");
	});

	it.skipIf(process.platform !== "win32")("GBK 字节不会解成替换字符", () => {
		const text = decodeProcessOutput(gbkBytes);
		expect(text).not.toContain("\uFFFD");
		// 中文系统的代码页是 GBK，应该恰好还原这句话；非中文系统也会落到某个能解开它的候选上，
		// 所以这里只对「解出了可读中文」做断言，不假定机器的语言。
		if (text.includes("不是内部或外部命令")) {
			expect(text).toBe("'cat' 不是内部或外部命令");
		}
	});

	it("谁也解不开的字节不抛错", () => {
		// 0xFF 在 UTF-8 / GBK / windows-1252 里都是非法序列：最后退回 UTF-8 的宽容解码（会有替换字符），
		// 但**不允许抛**——工具链路上的解码失败不该把整条命令的结果吞掉。
		expect(() => decodeProcessOutput(Buffer.from([0xff, 0xfe, 0xff]))).not.toThrow();
	});

	it("解码器跨调用复用也不会串味", () => {
		// 解码器是按编码缓存的实例，反复交替解 UTF-8 与另一种字节时，两边结果都要各自稳定。
		const utf8Bytes = Buffer.from("中文 ok", "utf-8");
		const legacyText = decodeProcessOutput(gbkBytes);
		for (let round = 0; round < 3; round += 1) {
			expect(decodeProcessOutput(utf8Bytes)).toBe("中文 ok");
			expect(decodeProcessOutput(gbkBytes)).toBe(legacyText);
		}
		// 「GBK 字节解出可读中文」只在 Windows 上成立：POSIX 的候选表里只有 utf-8
		// （那边输出本来就是 UTF-8，见 process.ts），这段字节在那里是非法 UTF-8，
		// 宽容解码必然带替换字符。所以平台相关的断言只放在 win32 上（CI 跑 Linux，
		// 早先这条没加守卫，于是每次 CI 都红在这里）。
		if (process.platform === "win32") {
			expect(legacyText).not.toContain("\uFFFD");
		}
	});
});

describe("候选编码", () => {
	it("POSIX 只认 locale 里明写的 codeset，不按语言猜", () => {
		// 没有 codeset（或就是 UTF-8）时等于「什么都不试」，行为与以前完全一致：
		// 把单字节编码放进候选表的话，en_US.UTF-8 的机器上随便一段二进制都会被解成乱码。
		expect(legacyEncodingCandidates("linux", {})).toEqual(["utf-8"]);
		expect(legacyEncodingCandidates("linux", { LANG: "en_US.UTF-8" })).toEqual(["utf-8"]);
		expect(legacyEncodingCandidates("linux", { LANG: "C" })).toEqual(["utf-8"]);
		expect(legacyEncodingCandidates("linux", { LANG: "zh_CN.UTF-8" })).toEqual(["utf-8"]);
		// 明写了的才认，而且 LC_ALL > LC_CTYPE > LANG
		expect(legacyEncodingCandidates("linux", { LANG: "zh_CN.GBK" })).toEqual(["gbk"]);
		expect(legacyEncodingCandidates("linux", { LC_CTYPE: "zh_CN.GBK", LANG: "en_US.UTF-8" })).toEqual(["gbk"]);
		expect(legacyEncodingCandidates("linux", { LC_ALL: "zh_CN.GBK", LANG: "en_US.UTF-8" })).toEqual(["gbk"]);
		// 空串按未设置处理（POSIX 就是这么定的），不能被它挡住后面的 LANG
		expect(legacyEncodingCandidates("linux", { LC_ALL: "", LANG: "zh_CN.GBK" })).toEqual(["gbk"]);
		// locale 名后缀 @modifier 不算 codeset 的一部分
		expect(legacyEncodingCandidates("linux", { LANG: "zh_CN.GBK@euro" })).toEqual(["gbk"]);
	});

	it("认得常见的 codeset，认不出来就不猜", () => {
		const on = (lang: string): string[] => legacyEncodingCandidates("linux", { LANG: lang });
		expect(on("zh_CN.gb2312")).toEqual(["gbk"]);
		expect(on("zh_CN.gb18030")).toEqual(["gb18030"]);
		expect(on("zh_TW.big5")).toEqual(["big5"]);
		expect(on("ja_JP.sjis")).toEqual(["shift_jis"]);
		expect(on("ja_JP.eucJP")).toEqual(["euc-jp"]);
		expect(on("ko_KR.eucKR")).toEqual(["euc-kr"]);
		expect(on("ru_RU.KOI8-R")).toEqual(["koi8-r"]);
		expect(on("ru_RU.cp1251")).toEqual(["windows-1251"]);
		expect(on("de_DE.ISO-8859-15")).toEqual(["iso-8859-15"]);
		// 不认识的 codeset：宁可给替换字符，也不要挑一个「反正解得出」的编码糊上去
		expect(on("xx_XX.WHATEVER")).toEqual(["utf-8"]);
	});

	it("Windows 上按语言猜代码页，并兜底 GBK 与 windows-1252", () => {
		expect(legacyEncodingCandidates("win32", { LANG: "zh_CN" })).toEqual(["gbk", "windows-1252"]);
		expect(legacyEncodingCandidates("win32", { LANG: "ja_JP" })).toEqual(["shift_jis", "gbk", "windows-1252"]);
		expect(legacyEncodingCandidates("win32", { LANG: "ru_RU" })).toEqual(["windows-1251", "gbk", "windows-1252"]);
	});

	it("POSIX + GBK locale 下 GBK 字节能解成中文", () => {
		// 这条以前在任何机器上都验不了：候选表跟着平台与 locale 走，而 CI 只有 Linux+UTF-8。
		// 现在候选能作为参数传进来，两个平台的组合都能在这里断。
		const candidates = legacyEncodingCandidates("linux", { LANG: "zh_CN.GBK" });
		const text = decodeProcessOutput(gbkBytes, candidates);
		expect(text).toBe("'cat' 不是内部或外部命令");
		expect(text).not.toContain("\uFFFD");
	});
});

describe("looksBinary", () => {
	it("纯文本不算二进制", () => {
		expect(looksBinary("const a = 1;\n中文也没问题\n")).toBe(false);
	});

	it("含 NUL 就算二进制", () => {
		// 与 read / grep / Web 预览三处原先的 buffer.includes(0) 判据一致。
		expect(looksBinary("ab\u0000cd")).toBe(true);
	});

	it("空串不算二进制", () => {
		expect(looksBinary("")).toBe(false);
	});

	it("只认入参那一段：NUL 在窗口之外就判不出来", () => {
		// 边界写清楚：函数本身不截窗口，窗口是调用方的策略。传整段能看出 NUL，传前缀看不出来。
		const buffer = Buffer.from("ab\u0000cd", "utf-8");
		expect(looksBinary(buffer)).toBe(true);
		expect(looksBinary(buffer.subarray(0, 2))).toBe(false);
	});

	it("接受字节数组，不必先转字符串", () => {
		expect(looksBinary(Buffer.from([0x01, 0x00, 0x02]))).toBe(true);
		expect(looksBinary(Buffer.from([0x01, 0x02, 0x03]))).toBe(false);
		expect(looksBinary(new Uint8Array([0x41, 0x00]))).toBe(true);
	});

	it("UTF-16 文本被判成二进制", () => {
		// UTF-16LE 每个 ASCII 字符后面都跟一个 \0，按 UTF-8 解出来是乱码，所以这个「误判」是想要的。
		expect(looksBinary(Buffer.from("hello", "utf16le"))).toBe(true);
	});
});

describe("flattenWhitespace", () => {
	it("连续空白压成单个空格并 trim", () => {
		expect(flattenWhitespace("  a \n\t b  ")).toBe("a b");
	});

	it("换行与制表符都算空白", () => {
		expect(flattenWhitespace("第一行\n\n第二行\t第三行")).toBe("第一行 第二行 第三行");
	});

	it("本身就只有空白的字符串压成空串", () => {
		expect(flattenWhitespace(" \n\t ")).toBe("");
		expect(flattenWhitespace("")).toBe("");
	});

	it("不动非空白的多字节字符", () => {
		expect(flattenWhitespace("中文\u3000全角空格")).toBe("中文 全角空格");
	});
});

/**
 * 按字节上限截断的验收口径是「最长的那个前缀」：
 * 返回值的字节数不超上限，后面再多留一个字符就超——两者一起才排除「退得太多」与「切过头」。
 */
function expectLongestPrefix(text: string, maxBytes: number): string {
	const result = sliceByBytes(text, maxBytes);
	expect(text.startsWith(result)).toBe(true);
	expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(maxBytes);
	if (result.length < text.length) {
		expect(Buffer.byteLength(text.slice(0, result.length + 1), "utf-8")).toBeGreaterThan(maxBytes);
	}
	return result;
}

describe("sliceByBytes", () => {
	it("不超上限时原样返回", () => {
		expect(sliceByBytes("短文本", 100)).toBe("短文本");
		expect(sliceByBytes("", 10)).toBe("");
	});

	it("恰好等于上限时整段留下", () => {
		const text = "中文";
		const exact = Buffer.byteLength(text, "utf-8");
		expect(sliceByBytes(text, exact)).toBe(text);
	});

	it("上限非正数就什么都不留", () => {
		// 负数上限原本会走进 slice(0, 负数)，把末尾几个字符留着——上限为负显然不该是这个意思。
		expect(sliceByBytes("中文内容", 0)).toBe("");
		expect(sliceByBytes("中文内容", -5)).toBe("");
	});

	it("中文不会被切成半个字", () => {
		const text = "中".repeat(100);
		for (const maxBytes of [1, 2, 3, 4, 5, 7, 100, 299, 300, 301]) {
			const result = expectLongestPrefix(text, maxBytes);
			// 合法 UTF-8 的截断结果重新编码后不会带上替换字符，也不会变长。
			expect(result).not.toContain("\uFFFD");
			expect(Buffer.from(result, "utf-8").toString("utf-8")).toBe(result);
		}
	});

	it("混排 ASCII、中文与 emoji 都取最长前缀", () => {
		const text = `a中😀b日本語\n${"尾".repeat(50)}`;
		for (let maxBytes = 1; maxBytes <= 40; maxBytes += 1) {
			expectLongestPrefix(text, maxBytes);
		}
	});

	it("大段中文按 512KB 截断也不拖时间", () => {
		// 逐字符回退在这个尺度上要退几十万次、每次重量一遍前缀，实测几十秒都回不来；
		// 二分的实现是毫秒级。阈值取 2 秒，留出两个数量级的余量，不会因机器慢而抖动。
		const text = "中".repeat(1_000_000);
		const started = performance.now();
		const result = expectLongestPrefix(text, 512 * 1024);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(512 * 1024);
	});
});

describe("firstLine", () => {
	it("没有换行时就是整段", () => {
		expect(firstLine('{"type":"session"}')).toBe('{"type":"session"}');
		expect(firstLine("")).toBe("");
	});

	it("有换行时只取第一行", () => {
		expect(firstLine("第一行\n第二行\n第三行")).toBe("第一行");
		expect(firstLine("\n第二行")).toBe("");
		expect(firstLine("a\r\nb")).toBe("a\r");
	});

	it('与 split("\\n")[0] 的结果一致', () => {
		const samples = ["", "\n", "a", "a\n", "a\nb\n", "a\r\nb", "中\n文", "\n\n\n"];
		for (const sample of samples) {
			expect(firstLine(sample)).toBe(sample.split("\n")[0]);
		}
	});
});
