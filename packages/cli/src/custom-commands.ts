/**
 * 自定义斜杠命令。
 *
 * **一个命令就是一个 Markdown 文件**：文件名即命令名，文件正文即提示词。
 * 这样扩展成本被压到最低——用户不用改源码、不用写代码，往目录里放个文件就能多一条 `/xxx`。
 *
 * 目录：`<配置目录>/commands/*.md`（与配置、会话放在一起，不散落在项目里）。
 * 参数：正文里的 `$ARGUMENTS` 会被替换成命令后面跟的文本，例如 `/commit 修个错字`。
 *
 * 元数据（可选）：文件开头可以用一行 `---` 包起一段 `key: value`，
 * 元数据只驱动 /help，正文只在命令被调用时才读。
 * 只认三个键：`description`（/help 的一行说明，缺省时退回正文首个非空行）、`argument-hint`
 * （跟在命令名后面的参数提示，如 `[范围]`）、`when-to-use`（更长的使用场景，只存在命令对象上备用）。
 * 键名不区分大小写，`-` 与 `_` 等价；值两端成对的引号会被去掉；块内的空行、`#` 注释与未知键忽略。
 * 元数据整块会从正文里剥掉，绝不发给模型；块没闭合或已知键写空时命令照常注册，只在命令下面
 * 多一行中文提示（`CustomCommand.warning`）。剥掉元数据后正文为空的文件仍按空文件跳过。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 一条自定义命令 */
export interface CustomCommand {
	/** 命令名（不含前导斜杠），来自文件名 */
	name: string;
	/** 一行说明：元数据的 `description`，没写就取正文第一行非空文本，用于 /help */
	description: string;
	/** 元数据的 `argument-hint`：/help 里跟在命令名后面的参数提示，没写就没有 */
	argumentHint?: string;
	/** 元数据的 `when-to-use`：更长的使用场景，默认不显示，留给后续使用 */
	whenToUse?: string;
	/** 元数据有问题时的中文提示（块没闭合、已知键写空），显示在 /help 里该命令下面 */
	warning?: string;
	/** 提示词正文，元数据已被剥掉 */
	body: string;
	/** 文件路径，出错时便于定位 */
	file: string;
}

/** 参数占位符 */
export const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

/** 元数据里认识的键（归一化后）→ 命令对象上的字段名 */
type MetadataField = "description" | "argumentHint" | "whenToUse";

/** 归一化键名 → 字段名；只认这三个键，其他一律忽略 */
const METADATA_KEYS = new Map<string, MetadataField>([
	["description", "description"],
	["argumenthint", "argumentHint"],
	["whentouse", "whenToUse"],
]);

/** 字段名 → 文档里写的规范键名，提示信息用它更贴近用户写的内容 */
const CANONICAL_KEYS: Record<MetadataField, string> = {
	description: "description",
	argumentHint: "argument-hint",
	whenToUse: "when-to-use",
};

/** 一个文件解析后的结果 */
interface ParsedCommandFile {
	/** 剥掉元数据、去掉首尾空白后的正文 */
	body: string;
	description?: string;
	argumentHint?: string;
	whenToUse?: string;
	/** 元数据有问题时的中文提示，多个问题用中文分号连成一行 */
	warning?: string;
}

/** 命令名是否合法：只允许小写字母、数字、短横线与下划线 */
export function isValidCommandName(name: string): boolean {
	return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

/**
 * 从正文里取一行说明。
 *
 * 取第一行非空文本，去掉 Markdown 的井号；取不到就用命令名，保证 /help 里每行都有东西。
 */
export function describeCommand(body: string, fallback: string): string {
	for (const line of body.split("\n")) {
		const text = line.replace(/^#+\s*/, "").trim();
		if (text !== "") {
			return text.length > 60 ? `${text.slice(0, 60)}…` : text;
		}
	}
	return fallback;
}

/** 把 `$ARGUMENTS` 替换成实际参数；没有占位符时把参数附在末尾，避免用户以为参数被忽略 */
export function expandCommand(body: string, args: string): string {
	const trimmed = args.trim();
	if (body.includes(ARGUMENTS_PLACEHOLDER)) {
		return body.split(ARGUMENTS_PLACEHOLDER).join(trimmed);
	}
	if (trimmed === "") {
		return body;
	}
	return `${body}\n\n参数：${trimmed}`;
}

/** 去掉行尾的 \r，让 CRLF 的文件也能按行判断 */
function withoutCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** 是否是元数据的分隔行：整行只有 `---`，允许行尾空白 */
function isMetadataFence(line: string): boolean {
	return /^---[ \t]*$/.test(withoutCarriageReturn(line));
}

/** 键名归一化：大小写不敏感，`-` 与 `_` 也不敏感 */
function normalizeMetadataKey(key: string): string {
	return key.trim().toLowerCase().replace(/[-_]/g, "");
}

/** 拆一行 `key: value`（冒号可紧贴值）；不是这种形状就返回 null */
function splitMetadataLine(line: string): { key: string; value: string } | null {
	const index = line.indexOf(":");
	if (index <= 0) {
		return null;
	}
	return { key: normalizeMetadataKey(line.slice(0, index)), value: line.slice(index + 1).trim() };
}

/** 去掉值两端成对的引号（单双引号都行），不成对就原样返回 */
function stripMatchingQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1).trim();
		}
	}
	return value;
}

/**
 * 解析一个命令文件：剥掉开头的元数据块，取出认识的键。
 *
 * 没有元数据时正文原样返回，保持老行为。块没闭合时只认开头连续的、写得像元数据的行（空行、
 * `#` 注释、已知键），遇到别的内容就停手，剩下的当正文，尽量别把提示词吃掉。
 */
function parseCommandFile(raw: string): ParsedCommandFile {
	const [first = "", ...rest] = raw.split("\n").map(withoutCarriageReturn);
	if (!isMetadataFence(first)) {
		return { body: raw.trim() };
	}
	const metadata: { description?: string; argumentHint?: string; whenToUse?: string } = {};
	const warnings: string[] = [];
	const end = rest.findIndex(isMetadataFence);
	/** 认出一个已知键就落到 metadata；值为空只记提示，不覆盖其他键 */
	const applyKey = (key: string, rawValue: string): void => {
		const field = METADATA_KEYS.get(key);
		if (field === undefined) {
			// 未知键静默忽略：别的工具的命令文件里常见，报错只会吵人。
			return;
		}
		const value = stripMatchingQuotes(rawValue);
		if (value === "") {
			warnings.push(`元数据 ${CANONICAL_KEYS[field]} 的值为空，已忽略`);
			return;
		}
		metadata[field] = value;
	};
	let bodyLines: string[];
	if (end === -1) {
		warnings.push("元数据块缺少结尾的 ---，只解析了开头认得出的几行");
		let consumed = 0;
		for (const line of rest) {
			const text = line.trim();
			if (text === "" || text.startsWith("#")) {
				consumed += 1;
				continue;
			}
			const pair = splitMetadataLine(text);
			if (pair === null || !METADATA_KEYS.has(pair.key)) {
				break;
			}
			applyKey(pair.key, pair.value);
			consumed += 1;
		}
		bodyLines = rest.slice(consumed);
	} else {
		for (const line of rest.slice(0, end)) {
			const text = line.trim();
			if (text === "" || text.startsWith("#")) {
				continue;
			}
			const pair = splitMetadataLine(text);
			if (pair === null) {
				continue;
			}
			applyKey(pair.key, pair.value);
		}
		bodyLines = rest.slice(end + 1);
	}
	const parsed: ParsedCommandFile = { body: bodyLines.join("\n").trim() };
	if (metadata.description !== undefined) {
		parsed.description = metadata.description;
	}
	if (metadata.argumentHint !== undefined) {
		parsed.argumentHint = metadata.argumentHint;
	}
	if (metadata.whenToUse !== undefined) {
		parsed.whenToUse = metadata.whenToUse;
	}
	if (warnings.length > 0) {
		parsed.warning = warnings.join("；");
	}
	return parsed;
}

/** 列出某个目录下的自定义命令，按名称排序；目录不存在时返回空数组 */
export function listCustomCommands(dir: string): CustomCommand[] {
	if (!existsSync(dir)) {
		return [];
	}
	const commands: CustomCommand[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".md")) {
			continue;
		}
		const name = entry.slice(0, -3);
		if (!isValidCommandName(name)) {
			// 文件名不合规就跳过：它没法被当成 /命令 调起来，静默忽略比报错更省事。
			continue;
		}
		const file = join(dir, entry);
		let raw: string;
		try {
			raw = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		const parsed = parseCommandFile(raw);
		if (parsed.body === "") {
			// 剥掉元数据后没正文的文件仍按空文件跳过：发不出提示词，留着也调不动。
			continue;
		}
		const command: CustomCommand = {
			name,
			description: parsed.description ?? describeCommand(parsed.body, name),
			body: parsed.body,
			file,
		};
		if (parsed.argumentHint !== undefined) {
			command.argumentHint = parsed.argumentHint;
		}
		if (parsed.whenToUse !== undefined) {
			command.whenToUse = parsed.whenToUse;
		}
		if (parsed.warning !== undefined) {
			command.warning = parsed.warning;
		}
		commands.push(command);
	}
	return commands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 按名字找命令 */
export function findCustomCommand(commands: CustomCommand[], name: string): CustomCommand | null {
	return commands.find((command) => command.name === name) ?? null;
}

/** 拼给模型的提示词：明确这是自定义命令，要求照办 */
export function buildCommandPrompt(command: CustomCommand, args: string): string {
	return `[自定义命令 /${command.name}]\n\n${expandCommand(command.body, args)}`;
}

/**
 * `/help` 里自定义命令那一段。
 *
 * `when-to-use` 印在这一行**下面**而不是并进描述：描述是「这条命令做什么」（一行扫完），使用场景是
 * 「什么时候该想起它」，塞进同一行会把两者都挤没。只对写了这个字段的命令多印一行。
 */
export function describeCustomCommands(commands: CustomCommand[], dir: string): string {
	if (commands.length === 0) {
		return `\n自定义命令：把 Markdown 文件放进 ${dir} 即可，文件名就是命令名（例如 commit.md → /commit），开头还能用 --- 元数据补 description、argument-hint 与 when-to-use。\n`;
	}
	const lines = commands.map((command) => {
		const label = command.argumentHint === undefined ? command.name : `${command.name} ${command.argumentHint}`;
		const parts = [`  /${label.padEnd(14)}${command.description}`];
		if (command.whenToUse !== undefined) {
			parts.push(`    何时用：${command.whenToUse}`);
		}
		// 元数据有问题时在该命令下面补一行提示，正常的行保持原样。
		if (command.warning !== undefined) {
			parts.push(`    提示：${command.warning}`);
		}
		return parts.join("\n");
	});
	return `\n自定义命令（${dir}）：\n${lines.join("\n")}\n`;
}
