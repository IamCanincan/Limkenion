/**
 * read 工具：读取文本文件。
 *
 * 输出会按行数与字节数截断，并在末尾给出继续读取的 offset，避免一次把巨大的文件
 * 整个塞进上下文。
 *
 * `maxResultBytes: Infinity` 是刻意的：read 自己已经把输出卡在 50KB 并给出续读的 offset，
 * 再让结果层把它落盘就变成了「读一个文件 → 拿到落盘路径 → 再读那个文件」——模型会照着提示
 * 去读落盘文件，而落盘文件同样只给前几十行，于是原地打转。读文件这个工具也是
 * 这么设的：它的大小上限就是「不设上限」。其余工具的输出是「一次性产物」，落盘才有意义。
 */

import { readFile, stat } from "node:fs/promises";
import { looksBinary } from "../text.ts";
import { defineTool } from "./contract.ts";
import type { ReadEvidence } from "./evidence.ts";
import { formatSize, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, resolveUserPath, truncateHead } from "./path.ts";

/** read 工具的可配置项 */
export interface ReadToolOptions {
	/** 工作目录 */
	cwd: string;
	/** 读取证据表：记下模型看过的内容，供 edit / write 比对 */
	evidence?: ReadEvidence;
}

/** 创建 read 工具 */
export function createReadTool(options: ReadToolOptions) {
	return defineTool({
		name: "read",
		description:
			"读取一个文本文件的内容。可用 offset/limit 分段读取大文件。" +
			`单次最多返回 ${MAX_OUTPUT_LINES} 行或 ${formatSize(MAX_OUTPUT_BYTES)}，超出部分需用 offset 继续读取。`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径，相对路径以工作目录为基准" },
				offset: { type: "number", description: "从第几行开始读，从 1 开始计数" },
				limit: { type: "number", description: "最多读取多少行" },
			},
			required: ["path"],
		},
		// 只读且互不影响：多个 read 可以并排跑，也不必过审批。
		alwaysReadOnly: true,
		isConcurrencySafe: () => true,
		// 读一个文件不会因为「没先读过」而出错，所以永不落盘（见文件头）。
		maxResultBytes: Number.POSITIVE_INFINITY,
		summarize: (input) => (typeof input.path === "string" ? input.path : ""),
		// 读的就是这个文件，于是界面那一行能给出「预览文件」入口（它不参与判定：只读工具在上面就放行了）
		pathOf: (input) => (typeof input.path === "string" && input.path.trim() !== "" ? input.path.trim() : null),
		validate: (input) =>
			typeof input.path === "string" && input.path.trim() !== ""
				? { ok: true }
				: { ok: false, message: "缺少必填参数 path" },
		async execute(input) {
			const rawPath = (input.path as string).trim();
			const absolute = resolveUserPath(rawPath, options.cwd);

			const info = await stat(absolute).catch(() => null);
			if (!info) {
				return { content: `文件不存在：${rawPath}`, isError: true };
			}
			if (info.isDirectory()) {
				return { content: `${rawPath} 是目录，请用 bash 的 ls 查看内容`, isError: true };
			}

			const buffer = await readFile(absolute);
			// 整个文件一起判：read 要说的是「这个文件能不能当文本读」，只看开头会把
			// 后面带 NUL 的文件读成乱码。
			if (looksBinary(buffer)) {
				return {
					content: `${rawPath} 看起来是二进制文件（${formatSize(info.size)}），无法作为文本读取`,
					isError: true,
				};
			}

			const text = buffer.toString("utf-8");
			// 记的是完整正文：展示时截断不影响「这个文件此刻长这样」这个事实。
			options.evidence?.record(absolute, text);
			return render(text, rawPath, input, info.size);
		},
	});
}

/** 按 offset/limit 切片并截断 */
function render(
	text: string,
	rawPath: string,
	input: Record<string, unknown>,
	size: number,
): { content: string; isError: boolean } {
	const allLines = text.split("\n");
	const total = allLines.length;
	const offset = toPositiveInt(input.offset) ?? 1;
	const limit = toPositiveInt(input.limit);

	if (offset > total) {
		return { content: `offset ${offset} 超出文件范围（共 ${total} 行）`, isError: true };
	}

	const start = offset - 1;
	const end = limit === undefined ? total : Math.min(start + limit, total);
	const selected = allLines.slice(start, end).join("\n");
	const truncation = truncateHead(selected);

	if (!truncation.truncated) {
		const lastShown = start + truncation.keptLines;
		if (lastShown < total) {
			return {
				content: `${truncation.content}\n\n[共 ${total} 行，已显示到第 ${lastShown} 行。继续读取请用 offset=${lastShown + 1}]`,
				isError: false,
			};
		}
		return { content: truncation.content, isError: false };
	}

	if (truncation.truncatedBy === "bytes" && truncation.keptLines <= 1) {
		return {
			content: `第 ${offset} 行本身超过 ${formatSize(MAX_OUTPUT_BYTES)} 限制。可改用 bash：sed -n '${offset}p' ${rawPath} | head -c ${MAX_OUTPUT_BYTES}`,
			isError: false,
		};
	}

	const lastShown = start + truncation.keptLines;
	const reason =
		truncation.truncatedBy === "lines" ? `最多 ${MAX_OUTPUT_LINES} 行` : `${formatSize(MAX_OUTPUT_BYTES)}`;
	return {
		content: `${truncation.content}\n\n[文件共 ${total} 行 / ${formatSize(size)}，因${reason}限制显示到第 ${lastShown} 行。继续读取请用 offset=${lastShown + 1}]`,
		isError: false,
	};
}

/** 把入参转成正整数，非法值返回 undefined */
function toPositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}
	const rounded = Math.floor(value);
	return rounded > 0 ? rounded : undefined;
}
