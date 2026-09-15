/**
 * 「本会话不再问」的记忆。
 *
 * 审批模式是粗粒度的
 * ——`ask` 档下每一次 write / edit / bash 都要问一遍，用户很快就会条件反射地按 y，那还不如把
 * 「这一类操作本会话都放行」明确地摆出来让他选一次。
 *
 * 三条边界，缺一条这个模块就会变成后门：
 * 1. **只能放宽「模式要求确认」这一类**。越界写入、疑似危险命令永远每次都要问：它们不是「同一类
 *    日常操作」，记下来等于把上一轮的加固整段作废。所以调用方只在
 *    `isRememberable(verdict.reason)`（即 `{ type: "mode" }`）时才查记忆——从前这句写的是
 *    `cause === "mode"`，一条字符串比较，新增判定时最容易漏。
 * 2. **记的是前缀，且只认单条简单命令**。带 `;` `|` `&&` `>` `$()` 这类元字符的命令一律不给建议、
 *    也不参与匹配——`npm test && rm x` 不能被「npm test」这条规则顺手带过去。
 * 3. **不可逆的动词根本不给建议**：`rm` / `mv` / `dd` / `chmod` / `sudo` / 各种 shell 与包装器
 *    一律返回 null，用户想放行也只能一次一次点。
 *
 * 前缀的粒度：bash 记「命令 + 第一个操作数」（`npm test`、`git status`；`npm run build` 这种
 * 泛动词会多带一个词），write / edit 记所在目录（`src/`）。规则只在进程内存里，退出即失效——
 * 「本会话」就是字面意思。
 */

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveUserPath } from "../tools/path.ts";

/** 一条被记住的规则 */
export interface ApprovalRule {
	/** 工具名：bash / write / edit */
	tool: string;
	/** bash 记命令前缀（`npm test`）；write / edit 记目录（`src`，空串表示工作目录根） */
	prefix: string;
}

/**
 * 无论如何都不给建议的命令头。
 *
 * 分四类：会执行任意字符串的壳、提权与包装器（它们后面才是真正的命令）、一次就不可逆的动词、
 * 以及 shell 之外的解释器——最后这类在「没有脚本操作数」时也一律不给建议（见 `isBareInterpreter`）。
 */
const BANNED_HEADS = new Set([
	// 壳与解释器
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"cmd",
	"powershell",
	"pwsh",
	// 提权与包装器：前缀只是壳，真正的命令在后面，记住它等于什么都记住
	"sudo",
	"doas",
	"pkexec",
	"env",
	"xargs",
	"eval",
	"exec",
	"command",
	"builtin",
	"nohup",
	"timeout",
	"nice",
	"ionice",
	"stdbuf",
	"setsid",
	"time",
	// 一次就不可逆
	"rm",
	"rmdir",
	"rd",
	"del",
	"erase",
	"remove-item",
	"ri",
	"mv",
	"move",
	"dd",
	"chmod",
	"chown",
	"shutdown",
	"reboot",
	"format",
	"diskpart",
]);

/** 名字以这些开头的命令头也一并拒绝（`mkfs.ext4` 这类） */
const BANNED_HEAD_PREFIXES = ["mkfs"];

/** 「没有脚本操作数时不给建议」的解释器：`node -e`、`python -c` 都是任意代码 */
const INTERPRETER_HEADS = new Set([
	"node",
	"deno",
	"bun",
	"python",
	"python3",
	"perl",
	"ruby",
	"php",
	"lua",
	"osascript",
]);

/** 泛动词：后面那个词才是真正要跑的东西，所以前缀要多带一个词（`npm run build`） */
const GENERIC_VERBS = new Set(["run", "exec", "x", "dlx"]);

/** 元字符：出现就不给建议、也不参与匹配（见模块头第 2 条） */
const METACHARACTERS = /[;&|<>`$(){}*?\n\r~]/;

/** 取可执行文件名字：去掉目录、Windows 扩展名，统一小写（与 dangerous-command.ts 同口径） */
function executableName(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? "";
	const lowered = base.toLowerCase();
	for (const suffix of [".exe", ".cmd", ".bat", ".com", ".ps1"]) {
		if (lowered.endsWith(suffix)) {
			return lowered.slice(0, -suffix.length);
		}
	}
	return lowered;
}

/**
 * 一条简单命令的「前缀」，取不到就返回 null。
 *
 * 只按空白切词，不解释引号：这里要的是「用户看得懂的一小段」，不是完整的 shell 解析。含引号
 * 的词（中间有空白）不参与前缀，免得把 `-m "两个词"` 这种参数混进去。
 */
function commandPrefixOf(command: string): string | null {
	const trimmed = command.trim();
	if (trimmed === "" || METACHARACTERS.test(trimmed)) {
		return null;
	}
	const words = trimmed.split(/\s+/).filter((word) => word !== "");
	const head = words[0];
	if (head === undefined) {
		return null;
	}
	const name = executableName(head);
	if (BANNED_HEADS.has(name) || BANNED_HEAD_PREFIXES.some((prefix) => name.startsWith(prefix))) {
		return null;
	}
	if (!/^[\w.@/\\:-]+$/.test(head)) {
		return null;
	}

	// 第一个不是开关的词就是操作数：`npm test`、`git status`、`node scripts/build.mjs`。
	const operandIndex = words.findIndex((word, index) => index > 0 && !word.startsWith("-"));
	if (operandIndex === -1) {
		// 没有操作数就不给建议：同一句话随时可能换成别的参数（`npm publish`、`node -e`），
		// 而「总是允许」是要长期生效的。
		return null;
	}
	const operand = words[operandIndex];
	if (operand === undefined || !/^[\w.@/\\:-]+$/.test(operand)) {
		return null;
	}
	if (INTERPRETER_HEADS.has(name) && operand.startsWith(".")) {
		// `node .` / `python .` 之类：等价于没给具体脚本
		return null;
	}
	if (GENERIC_VERBS.has(operand.toLowerCase())) {
		const next = words.slice(operandIndex + 1).find((word) => !word.startsWith("-"));
		if (next === undefined || !/^[\w.@/\\:-]+$/.test(next)) {
			return null;
		}
		return `${head} ${operand} ${next}`;
	}
	return `${head} ${operand}`;
}

/** 把相对目录统一成 `/` 分隔，便于比较与展示 */
function toSlash(value: string): string {
	return value.split(sep).join("/");
}

/**
 * 目标路径所在目录（相对工作目录）。
 *
 * 越界或算不出相对位置时返回 null：这类调用本来就该每次问（越界判定在审批里排在记忆之前），
 * 给不出前缀正好。
 */
function pathDirectoryOf(path: string, cwd: string): string | null {
	const target = resolve(cwd, resolveUserPath(path, cwd));
	const offsets = relative(resolve(cwd), target);
	if (offsets === "" || offsets === ".." || offsets.startsWith(`..${sep}`) || isAbsolute(offsets)) {
		return null;
	}
	const directory = dirname(offsets);
	return directory === "." ? "" : toSlash(directory);
}

/**
 * 给这次调用提一个「本会话总是允许」的前缀；提不出来就返回 null。
 *
 * 返回 null 有三种情况：调用本身没有可记的前缀（越界路径、解释器裸跑）、命令含元字符、
 * 命令头属于不可逆或包装器那一类。null 不代表拒绝，只代表「这次不能记」。
 */
export function suggestApprovalPrefix(tool: string, input: Record<string, unknown>, cwd: string): string | null {
	if (tool === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return command === "" ? null : commandPrefixOf(command);
	}
	if (tool === "write" || tool === "edit") {
		const path = typeof input.path === "string" ? input.path.trim() : "";
		return path === "" ? null : pathDirectoryOf(path, cwd);
	}
	return null;
}

/** 前缀是否覆盖候选前缀：bash 按词比，路径按目录比（含子目录） */
function coversPrefix(tool: string, rule: string, candidate: string): boolean {
	if (tool !== "bash") {
		// 目录规则覆盖它下面的所有层级；空串是工作目录根，也就是「工作目录内任何位置」。
		return candidate === rule || candidate.startsWith(rule === "" ? "" : `${rule}/`);
	}
	return candidate === rule || candidate.startsWith(`${rule} `);
}

/**
 * 把前缀写成给用户看的一句话。
 *
 * 措辞集中在这里：CLI 的确认提示与网页的卡片都用它，免得两边对「这条规则到底放行了什么」的
 * 说法不一致——用户是照着这句话点「总是允许」的。
 */
export function describeApprovalPrefix(tool: string, prefix: string): string {
	if (tool !== "bash") {
		return prefix === "" ? "写入工作目录内任何位置" : `写入 ${prefix}/ 及其子目录`;
	}
	return `执行以「${prefix}」开头的单条命令`;
}

/**
 * 本会话的放行记忆。
 *
 * 只在内存里，进程退出即清空：不落盘是有意的——「本会话」被写进磁盘就成了长期后门，而用户点
 * 「总是允许」时想的是「这一轮别再问我了」。
 */
export class ApprovalMemory {
	private readonly rules: ApprovalRule[] = [];

	/** 记下一条规则；已经记过同样的就直接返回 */
	remember(rule: ApprovalRule): void {
		if (!this.rules.some((existing) => existing.tool === rule.tool && existing.prefix === rule.prefix)) {
			this.rules.push({ tool: rule.tool, prefix: rule.prefix });
		}
	}

	/** 这次调用是否已经被允许过 */
	matches(tool: string, input: Record<string, unknown>, cwd: string): boolean {
		if (this.rules.length === 0) {
			return false;
		}
		const candidate = suggestApprovalPrefix(tool, input, cwd);
		if (candidate === null) {
			return false;
		}
		return this.rules.some((rule) => rule.tool === tool && coversPrefix(tool, rule.prefix, candidate));
	}

	/** 当前记下的规则（副本，改它不影响记忆） */
	list(): ApprovalRule[] {
		return this.rules.map((rule) => ({ ...rule }));
	}

	/** 忘掉全部规则 */
	clear(): void {
		this.rules.length = 0;
	}

	/** 规则条数 */
	get size(): number {
		return this.rules.length;
	}
}
