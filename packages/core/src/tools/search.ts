import { describeError } from "limkenion-ai";
/**
 * grep / glob 两个搜索工具。
 *
 * 之前模型只能靠 bash 拼 `find` 与 `rg`：不同系统上命令名、参数、输出格式都不一样，还容易
 * 被权限提示卡住。这里用 Node 内置能力实现同样的两件事，行为跨平台一致，并且都**有界**——
 * 目录遍历有文件数上限、单文件有体积上限、结果有数量上限，免得一个巨型仓库把上下文塞满。
 *
 * 搜索始终从工作目录出发（也可以用 path 指定工作目录内的子目录），不会跑到工作目录之外。
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { looksBinary } from "../text.ts";
import { defineTool } from "./contract.ts";
import { MAX_OUTPUT_BYTES, resolveUserPath, truncateHead } from "./path.ts";

/** 遍历时跳过的目录名：都不是「源码」，搜了只会浪费额度 */
const SKIPPED_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	".next",
	".nuxt",
	".venv",
	"venv",
	"__pycache__",
	".idea",
	".vscode",
]);

/** 一次遍历最多看多少个文件 */
const MAX_WALK_FILES = 5000;

/** 单个文件超过这个大小就不搜内容（二进制与打包产物居多） */
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

/** grep 默认与最大的匹配条数 */
const DEFAULT_MATCHES = 100;
const MAX_MATCHES = 500;

/** glob 最多返回多少条 */
const MAX_GLOB_RESULTS = 1000;

/** 两个工具共用的参数 */
export interface SearchToolOptions {
	/** 工作目录，搜索范围不会超出它 */
	cwd: string;
}

/** 遍历结果 */
interface WalkResult {
	/** 相对工作目录的文件路径，统一用 / 分隔 */
	files: string[];
	/** 是否因为文件数上限提前停下 */
	truncated: boolean;
}

/**
 * 遍历目录收集文件。
 *
 * 用队列而不是递归：深目录不会把调用栈撑爆，顺序也稳定（同层按名称排序）。
 */
async function walk(root: string, maxFiles: number): Promise<WalkResult> {
	const files: string[] = [];
	const queue = [root];
	let truncated = false;

	while (queue.length > 0) {
		const current = queue.shift() ?? "";
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			// 权限不足或目录刚被删掉：跳过，不影响其余部分。
			continue;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const absolute = join(current, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) {
					queue.push(absolute);
				}
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			files.push(relative(root, absolute).split(sep).join("/"));
			if (files.length >= maxFiles) {
				truncated = true;
				return { files, truncated };
			}
		}
	}
	return { files, truncated };
}

/** glob 转正则：支持 **、*、? 与 {a,b}，其余字符按字面处理 */
function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				// ** 跨目录；后面的 / 一并吃掉，`**/x` 也能匹配顶层的 x。
				i += 1;
				if (pattern[i + 1] === "/") {
					i += 1;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
				continue;
			}
			source += "[^/]*";
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		if (char === "{") {
			const end = pattern.indexOf("}", i);
			if (end > i) {
				const options = pattern
					.slice(i + 1, end)
					.split(",")
					.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
					.join("|");
				source += `(?:${options})`;
				i = end;
				continue;
			}
		}
		source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/** 把结果按行数/字节数截断，并把截断说明写在末尾 */
function finish(lines: string[], note: string): { content: string; isError: boolean } {
	if (lines.length === 0) {
		return { content: note, isError: false };
	}
	const result = truncateHead(lines.join("\n"), MAX_OUTPUT_BYTES);
	return {
		content: result.truncated ? `${result.content}\n\n[输出过长已截断]` : result.content,
		isError: false,
	};
}

/** 创建 glob 工具：按文件名模式找文件 */
export function createGlobTool(options: SearchToolOptions) {
	return defineTool({
		name: "glob",
		description:
			"按文件名模式查找文件，支持 **、*、? 与 {a,b}。只匹配工作目录内的文件，" +
			`自动跳过 .git、node_modules 等目录，最多返回 ${MAX_GLOB_RESULTS} 条。` +
			"模式里不含 / 时按文件名匹配（等价于 **/模式）。",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "文件名模式，例如 **/*.ts 或 src/**/index.{js,ts}" },
				path: { type: "string", description: "搜索起点，默认工作目录" },
			},
			required: ["pattern"],
		},
		// 只读且互不影响：搜文件不会改任何东西，多个搜索可以并排跑。
		alwaysReadOnly: true,
		isConcurrencySafe: () => true,
		summarize: (input) => (typeof input.pattern === "string" ? input.pattern : ""),
		validate: (input) =>
			typeof input.pattern === "string" && input.pattern.trim() !== ""
				? { ok: true }
				: { ok: false, message: "缺少必填参数 pattern" },
		async execute(input) {
			const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
			if (pattern === "") {
				// validate 已经拦过一次；直接调 execute 的调用方（测试、脚本）也要拿到可读的错误。
				return { content: "缺少必填参数 pattern", isError: true };
			}
			const root = searchRoot(input, options.cwd);
			const effective = pattern.includes("/") ? pattern : `**/${pattern}`;
			const matcher = globToRegExp(effective);

			const { files, truncated } = await walk(root, MAX_WALK_FILES);
			const hits = files.filter((file) => matcher.test(file)).slice(0, MAX_GLOB_RESULTS);
			const summary = `找到 ${hits.length} 个文件${truncated ? "（目录过大，只遍历了前 5000 个文件）" : ""}`;
			// 一条都没有时把话说死，模型不用去猜「0 个」是没匹配还是没搜到。
			const notes = [hits.length === 0 ? "没有匹配的文件" : summary];
			return finish([...notes, ...hits], "没有匹配的文件");
		},
	});
}

/** 创建 grep 工具：按正则搜索文件内容 */
export function createGrepTool(options: SearchToolOptions) {
	return defineTool({
		name: "grep",
		description:
			"用正则搜索文件内容，返回 路径:行号: 内容。" +
			`默认最多 ${DEFAULT_MATCHES} 条（上限 ${MAX_MATCHES}），可用 include 限定文件名模式（如 *.ts）。` +
			"自动跳过 .git、node_modules 等目录与二进制文件。",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "JavaScript 正则表达式" },
				path: { type: "string", description: "搜索起点，默认工作目录" },
				include: { type: "string", description: "只搜匹配该文件名模式的文件，例如 *.ts" },
				maxResults: { type: "number", description: `最多返回多少条，默认 ${DEFAULT_MATCHES}` },
			},
			required: ["pattern"],
		},
		alwaysReadOnly: true,
		isConcurrencySafe: () => true,
		summarize: (input) => (typeof input.pattern === "string" ? input.pattern : ""),
		validate: (input) =>
			typeof input.pattern === "string" && input.pattern !== ""
				? { ok: true }
				: { ok: false, message: "缺少必填参数 pattern" },
		async execute(input) {
			const pattern = typeof input.pattern === "string" ? input.pattern : "";
			if (pattern === "") {
				return { content: "缺少必填参数 pattern", isError: true };
			}
			let matcher: RegExp;
			try {
				matcher = new RegExp(pattern);
			} catch (error) {
				return { content: `正则不合法：${describeError(error)}`, isError: true };
			}

			const requested = typeof input.maxResults === "number" ? Math.floor(input.maxResults) : DEFAULT_MATCHES;
			const limit = Math.min(Math.max(requested, 1), MAX_MATCHES);
			const include = typeof input.include === "string" ? input.include.trim() : "";
			const includeMatcher = include === "" ? null : globToRegExp(include.includes("/") ? include : `**/${include}`);

			const root = searchRoot(input, options.cwd);
			const { files, truncated } = await walk(root, MAX_WALK_FILES);
			const lines: string[] = [];
			let matched = 0;
			let skippedBinary = 0;

			for (const file of files) {
				if (includeMatcher && !includeMatcher.test(file)) {
					continue;
				}
				const absolute = join(root, file);
				const info = await stat(absolute).catch(() => null);
				if (!info || info.size > MAX_SEARCH_FILE_BYTES) {
					continue;
				}
				const buffer = await readFile(absolute).catch(() => null);
				if (!buffer) {
					continue;
				}
				// 整个文件一起判：grep 是逐行匹配的，只看开头就可能把带 NUL 的文件后半段
				// 当文本搜出乱码结果。
				if (looksBinary(buffer)) {
					skippedBinary += 1;
					continue;
				}
				const content = buffer.toString("utf-8");
				const fileLines = content.split("\n");
				for (let i = 0; i < fileLines.length; i++) {
					const line = fileLines[i] ?? "";
					if (!matcher.test(line)) {
						continue;
					}
					lines.push(`${file}:${i + 1}: ${line.trim().slice(0, 300)}`);
					matched += 1;
					if (matched >= limit) {
						break;
					}
				}
				if (matched >= limit) {
					break;
				}
			}

			const notes = [
				matched === 0
					? "没有匹配的内容"
					: `命中 ${matched} 条` +
						(matched >= limit ? `（已达上限 ${limit}，可调大 maxResults 或缩小范围）` : "") +
						(truncated ? "；目录过大，只遍历了前 5000 个文件" : "") +
						(skippedBinary > 0 ? `；跳过 ${skippedBinary} 个二进制文件` : ""),
			];
			return finish([...notes, ...lines], "没有匹配的内容");
		},
	});
}

/**
 * 取搜索起点。
 *
 * 结果始终限制在工作目录内：给了 path 就用它（会先做一次工作目录内的校验），
 * 否则用工作目录本身。这样模型没法把整个磁盘当成搜索范围。
 */
function searchRoot(input: Record<string, unknown>, cwd: string): string {
	const raw = typeof input.path === "string" ? input.path.trim() : "";
	const root = raw === "" ? resolve(cwd) : resolveUserPath(raw, cwd);
	const base = resolve(cwd);
	if (root !== base && !root.startsWith(base + sep)) {
		// 越界就退回工作目录，工具描述里已经写明范围，静默夹紧比报错更省事。
		return base;
	}
	return root;
}
