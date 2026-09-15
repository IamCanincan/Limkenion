/**
 * 子命令的形状，以及帮助文本的排版。
 *
 * **每条命令自己带着元信息**（名字、用法片段、一句话说明），
 * 注册表只负责把它们收在一起。从前元信息单独住在 `catalog.ts` 里，于是「加一条命令」要在两个文件里
 * 各写一半，而漏掉数据那一半**不会报错**——帮助里静默少一行。
 *
 * 与 CC 的另一处一致：**命令不解析 argv**。`CommandHost` 是宿主传给命令的那一小块能力（解析全局选项、
 * 归一化写法），命令声明它要什么，宿主负责给。这一条同时也是解开循环依赖的那一刀——命令模块不再
 * import `args.ts`，`args.ts` 才能反过来 import 命令清单去拼帮助。
 *
 * 这个模块只 import 一个**类型**（`Options`），没有运行时依赖：命令模块要用这些类型，`args.ts` 要用
 * 排版函数，中间任何一条运行时边都会成环。
 */

import type { Options } from "../args.ts";

/**
 * 命令能从宿主那里拿到的东西。
 *
 * 只放「命令确实需要、又不该自己知道怎么写」的那几件：参数语法是宿主的事。
 */
export interface CommandHost {
	/**
	 * 解析全局选项（`--model` / `--api-key` / `--plan` …）。
	 *
	 * 用法错误返回 `"usage-error"`（宿主已经打印过用法），打印过帮助返回 `null`——两者都不是失败，
	 * 命令把对应的退出码原样return 出去就行。
	 */
	parseGlobalOptions(argv: string[]): Options | null | "usage-error";
	/** 把 `--plan strict` 这类分离写法归一成 `--plan=strict`（全局解析器只认后者） */
	normalizePlanArgv(argv: string[]): string[];
}

/** 一条子命令 */
export interface Command {
	/** 第一个 token；大小写敏感 */
	name: string;
	/** 帮助里那一行的用法片段（`web`、`auth login`、`rewind [n]`） */
	synopsis: string;
	/** 一句话说明；帮助与将来的 `doctor` 清单共用 */
	summary: string;
	/** 跑它：argv 是命令名之后的全部参数 */
	run(argv: string[], host: CommandHost): Promise<number>;
}

/**
 * 一段文本在等宽终端里占几列。
 *
 * **不能直接用 `String.length`**：CJK 字是**两列**宽，而 `length` 只数码元。不数对的话
 * `search <关键词>` 这一行会比别人短三个码元、等价于摘要被推后三列——而「列对齐」正是这个函数
 * 唯一的用处。这条是重构时真踩到的：第一版用 `padEnd`，测试量的是码元下标所以全绿，终端里却是歪的。
 */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
	}
	return width;
}

/** 东亚洲宽字符（CJK 标点、假名、谚文、全角形式）—— 近似 East Asian Width 的 W/F 两档 */
function isWide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

/** 把若干「左列 + 右列」的行按**显示列宽**对齐，右列从同一列开始（最长那条之后留两个空格） */
export function padColumns(rows: readonly (readonly [string, string])[], indent = 2): string[] {
	const width = Math.max(...rows.map(([left]) => displayWidth(left)));
	return rows.map(([left, right]) => {
		const padding = " ".repeat(Math.max(0, width - displayWidth(left)) + 2);
		return `${" ".repeat(indent)}${left}${padding}${right}`;
	});
}

/**
 * 帮助里的子命令行，直接从命令自己的元信息出。
 *
 * 列宽取最长的那条 synopsis（按显示列宽算），不在源码里手填空格：手填的后果是改一个 synopsis 就得
 * 重数一遍空格，而数错了只在终端里看得出来。
 */
export function commandUsageLines(commands: readonly Command[], appName: string): string[] {
	return padColumns(commands.map((command) => [`${appName} ${command.synopsis}`, command.summary] as const));
}
