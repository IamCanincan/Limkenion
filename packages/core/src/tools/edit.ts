/**
 * edit 工具：用精确文本替换修改文件。
 *
 * 关键约束是「唯一匹配」：每段 oldText 在原文中必须恰好出现一次。如果允许模糊匹配，
 * 模型少抄几行就可能改错位置；报错让它重试比悄悄改错要安全。
 *
 * 与 write 一样，安全姿态来自契约的 fail-closed 默认值（会写、不并发）。
 */

import { readFile, writeFile } from "node:fs/promises";
import type { CheckpointStore } from "../checkpoints.ts";
import { defineTool } from "./contract.ts";
import type { ReadEvidence } from "./evidence.ts";
import { APPROVAL_PREVIEW_LINES, resolveUserPath } from "./path.ts";

/** 单条替换 */
interface Edit {
	oldText: string;
	newText: string;
}

/** 已定位的一次替换 */
interface ResolvedEdit {
	start: number;
	end: number;
	edit: Edit;
}

/** 显示用的 diff 最大行数 */
const MAX_DIFF_LINES = 40;

/** 确认卡片里最多逐处列出几次替换；再多也没人逐处看，正文在展开面板里 */
const APPROVAL_PREVIEW_EDITS = 3;

/** 「标题 + 前几行」的预览；不是文本就整段省掉 */
function previewBlock(label: string, text: unknown): string {
	if (typeof text !== "string") {
		return "";
	}
	const lines = text.split("\n");
	const shown = lines.slice(0, APPROVAL_PREVIEW_LINES);
	const more = lines.length > shown.length ? `\n… 还有 ${lines.length - shown.length} 行` : "";
	return `${label}：\n${shown.join("\n")}${more}`;
}

/** edit 工具的可配置项 */
export interface EditToolOptions {
	/** 读取证据表：改之前要先读过，且读过之后文件没被改过 */
	evidence?: ReadEvidence;
	/** 逐轮快照：把改动前的内容记下来，供 /rewind 回滚 */
	checkpoints?: CheckpointStore;
	/** 工作目录 */
	cwd: string;
}

/** 创建 edit 工具 */
export function createEditTool(options: EditToolOptions) {
	return defineTool({
		name: "edit",
		description:
			"对文件做精确文本替换。edits[].oldText 必须与原文完全一致（含缩进）且在文件中唯一。" +
			"同一文件的多处修改请放在一次调用里，各段之间不能重叠。只新建文件或整体重写才用 write。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "要修改的文件路径" },
				edits: {
					type: "array",
					description: "一处或多处替换，全部针对原文匹配，不按顺序累积",
					items: {
						type: "object",
						properties: {
							oldText: { type: "string", description: "要被替换的原文，必须唯一" },
							newText: { type: "string", description: "替换后的文本，留空表示删除" },
						},
						required: ["oldText", "newText"],
					},
				},
			},
			required: ["path", "edits"],
		},
		// 摘要里带上改了几处：和 write 的行数同理，界面上那一行只显示 `summarize()`。
		summarize: (input) => {
			const path = typeof input.path === "string" ? input.path : "";
			const count = normalizeEdits(input).length;
			if (count === 0) {
				return path;
			}
			const places = `${count} 处`;
			return path === "" ? places : `${path}（${places}）`;
		},
		/**
		 * 确认卡片的正文：逐处列出「原来 / 改成」。
		 *
		 * 前端从前读的是 `old_string` / `new_string`——那两个字段名**根本不存在**（真正的是
		 * `edits[].oldText/newText`），于是确认卡片上一直是一坨 JSON，改了什么完全看不见。
		 * 现在这段归工具自己写，字段名只有一处知道。
		 */
		describeApproval: (input) => {
			const path = typeof input.path === "string" ? input.path : "";
			const edits = normalizeEdits(input);
			if (edits.length === 0) {
				return path === "" ? "" : `将要修改：${path}`;
			}
			const shown = edits.slice(0, APPROVAL_PREVIEW_EDITS);
			const parts = shown.map((edit, index) => {
				const head = edits.length > 1 ? `第 ${index + 1} 处\n` : "";
				return `${head}${previewBlock("原来", edit.oldText)}\n${previewBlock("改成", edit.newText)}`;
			});
			const more = edits.length > shown.length ? `\n… 还有 ${edits.length - shown.length} 处` : "";
			return `将要修改：${path}\n${parts.join("\n")}${more}`;
		},
		pathOf: (input) => (typeof input.path === "string" && input.path.trim() !== "" ? input.path.trim() : null),
		validate: (input) => {
			if (typeof input.path !== "string" || input.path.trim() === "") {
				return { ok: false, message: "缺少必填参数 path" };
			}
			return normalizeEdits(input).length === 0
				? { ok: false, message: "缺少必填参数 edits，且没有提供 oldText/newText" }
				: { ok: true };
		},
		async execute(input) {
			const rawPath = (input.path as string).trim();
			const edits = normalizeEdits(input);

			const absolute = resolveUserPath(rawPath, options.cwd);
			const raw = await readFile(absolute, "utf-8").catch(() => null);
			if (raw === null) {
				return { content: `文件不存在或不可读：${rawPath}`, isError: true };
			}
			// 读取证据：没读过、或读过之后变了，都先拒绝，让模型重新读一遍再改。
			// 先记快照再动手：回滚要有「这轮开始前」的原始内容。
			options.checkpoints?.capture(absolute, raw);
			const problem = options.evidence?.check(absolute, raw);
			if (problem) {
				return { content: problem, isError: true };
			}

			// BOM 与换行符单独保管，替换只在 LF 归一化后的正文上做。
			const hasBom = raw.startsWith("\uFEFF");
			const withoutBom = hasBom ? raw.slice(1) : raw;
			const usesCrlf = withoutBom.includes("\r\n");
			const content = withoutBom.replace(/\r\n/g, "\n");

			const resolved: ResolvedEdit[] = [];
			for (const edit of edits) {
				if (edit.oldText === "") {
					return { content: "edits[].oldText 不能为空", isError: true };
				}
				const first = content.indexOf(edit.oldText);
				if (first === -1) {
					return { content: `原文中找不到这段内容：\n${preview(edit.oldText)}`, isError: true };
				}
				if (content.indexOf(edit.oldText, first + 1) !== -1) {
					return {
						content: `这段内容在文件中出现多次，请补充上下文使其唯一：\n${preview(edit.oldText)}`,
						isError: true,
					};
				}
				resolved.push({ start: first, end: first + edit.oldText.length, edit });
			}

			const overlap = findOverlap(resolved);
			if (overlap) {
				return { content: "edits 之间存在重叠，请合并为一处修改", isError: true };
			}

			// 从后往前替换，前面的下标才不会被后面的替换影响。
			const ordered = [...resolved].sort((a, b) => b.start - a.start);
			let updated = content;
			for (const item of ordered) {
				updated = updated.slice(0, item.start) + item.edit.newText + updated.slice(item.end);
			}

			const restored = usesCrlf ? updated.replace(/\n/g, "\r\n") : updated;
			const written = hasBom ? `\uFEFF${restored}` : restored;
			await writeFile(absolute, written, "utf-8");
			// 刚写进去的内容就是新的「已知状态」，同一轮里接着改不会误判为外部改动。
			options.evidence?.record(absolute, written);

			const diff = buildDiff(resolved);
			return {
				content: `已修改 ${rawPath}（${resolved.length} 处）\n${diff}`,
				isError: false,
			};
		},
	});
}

/**
 * 从入参里取出替换列表。
 *
 * 同时接受 `edits: [...]`、单个 `oldText/newText`、以及模型偶尔发来的 JSON 字符串，
 * 这些都在真实使用中出现过，在这里一次性归一化，避免上层反复踩。
 */
function normalizeEdits(input: Record<string, unknown>): Edit[] {
	const raw = input.edits;
	let list: unknown = raw;
	if (typeof raw === "string") {
		try {
			list = JSON.parse(raw);
		} catch {
			list = undefined;
		}
	}
	if (isEdit(list)) {
		return [list];
	}
	if (Array.isArray(list)) {
		return list.filter(isEdit);
	}
	if (isEdit(input)) {
		return [{ oldText: input.oldText, newText: input.newText }];
	}
	return [];
}

/** 判断一个值是否是合法的替换项 */
function isEdit(value: unknown): value is Edit {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return typeof candidate.oldText === "string" && typeof candidate.newText === "string";
}

/** 找出第一对重叠的替换 */
function findOverlap(items: ResolvedEdit[]): ResolvedEdit | undefined {
	const sorted = [...items].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i += 1) {
		const previous = sorted[i - 1];
		const current = sorted[i];
		if (previous && current && current.start < previous.end) {
			return current;
		}
	}
	return undefined;
}

/** 生成简洁的替换摘要，只保留变化的那几行 */
function buildDiff(items: ResolvedEdit[]): string {
	const lines: string[] = [];
	for (const item of items) {
		for (const line of item.edit.oldText.split("\n")) {
			lines.push(`- ${line}`);
		}
		for (const line of item.edit.newText.split("\n")) {
			lines.push(`+ ${line}`);
		}
	}
	if (lines.length > MAX_DIFF_LINES) {
		return [...lines.slice(0, MAX_DIFF_LINES), `... 其余 ${lines.length - MAX_DIFF_LINES} 行略`].join("\n");
	}
	return lines.join("\n");
}

/** 截断用于报错的片段 */
function preview(text: string): string {
	const lines = text.split("\n").slice(0, 5);
	return lines.join("\n");
}
