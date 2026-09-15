/**
 * 交付物清单。
 *
 * 一次活儿做完，把「要交给使用者看的东西」列出来：路径 + 一句话说明。它**只记路径与说明，不复制内容**——
 * 界面上整卡可点，点开由右侧面板去预览那个文件（DSH 的 `present` 也是这个契约：只记账，不做搬运）。
 *
 * 只有一个动作 `present`（整表替换整份清单）：这次跑完到底交付了什么，一句话说得清，就不必让使用者
 * 自己去 diff 里翻。路径按工作目录解析（相对路径也算），但**不校验存在性**——工具执行时文件可能刚写好
 * 还没刷盘，而且这一条是为了「指路」，不是「审计」。
 */

import { defineTool } from "./tools/contract.ts";
import type { AgentTool } from "./types.ts";

/** 一次最多记多少件：超过就不是「交付物」而是「目录清单」了 */
export const MAX_PRESENT_FILES = 20;

/** 说明的长度上限 */
export const MAX_PRESENT_NOTE = 120;

/** 一件交付物 */
export interface PresentFile {
	/** 相对工作目录或绝对路径 */
	path: string;
	/** 一句话：这是什么、要看哪一部分 */
	note: string;
}

/** 解析模型给的交付物清单：路径必填，说明可空 */
export function parsePresent(input: unknown): { files: PresentFile[] } | { error: string } {
	if (input === null || typeof input !== "object") {
		return { error: "缺少 files 字段" };
	}
	const raw = (input as { files?: unknown }).files;
	if (!Array.isArray(raw) || raw.length === 0) {
		return { error: "files 不能为空：至少列一件交付物（路径 + 一句话说明）" };
	}
	if (raw.length > MAX_PRESENT_FILES) {
		return { error: `一次最多列 ${MAX_PRESENT_FILES} 件（收到 ${raw.length} 件）：只列真正要看的` };
	}
	const files: PresentFile[] = [];
	for (const [index, item] of raw.entries()) {
		if (item === null || typeof item !== "object") {
			return { error: `第 ${index + 1} 件不是对象：要 {path, note}` };
		}
		const entry = item as { path?: unknown; note?: unknown };
		const path = typeof entry.path === "string" ? entry.path.trim() : "";
		if (path === "") {
			return { error: `第 ${index + 1} 件缺 path` };
		}
		const note = typeof entry.note === "string" ? entry.note.trim() : "";
		files.push({ path, note: note.length > MAX_PRESENT_NOTE ? `${note.slice(0, MAX_PRESENT_NOTE)}…` : note });
	}
	return { files };
}

/** 渲染成人话；空清单给一句说明而不是空串 */
export function renderPresent(files: PresentFile[]): string {
	if (files.length === 0) {
		return "这次还没有列出交付物。";
	}
	const lines = files.map((file, index) => `${index + 1}. ${file.path}${file.note === "" ? "" : ` —— ${file.note}`}`);
	return [`这次交付 ${files.length} 件：`, ...lines].join("\n");
}

/** 会话内的交付物清单（整表替换） */
export class PresentList {
	private files: PresentFile[] = [];

	/** 当前清单（拷贝） */
	get current(): PresentFile[] {
		return this.files.map((file) => ({ ...file }));
	}

	/** 整表替换 */
	replace(files: PresentFile[]): void {
		this.files = files.map((file) => ({ ...file }));
	}

	/** 清掉（换会话时用） */
	clear(): void {
		this.files = [];
	}

	/** 渲染 */
	render(): string {
		return renderPresent(this.files);
	}
}

/** 创建交付物工具 */
export function createPresentTools(present: PresentList): AgentTool[] {
	return [
		defineTool({
			name: "present",
			description:
				"一件事做完时，把要交给使用者看的东西列出来（路径 + 一句话说明）。整表替换，不是增量；" +
				"只列真正值得看的（报告、截图、改好的文件），不要把所有动过的文件都堆上来。" +
				"界面上这些会变成可点的卡片，所以说明要写清「看它的什么」。",
			parameters: {
				type: "object",
				properties: {
					files: {
						type: "array",
						description: "这一次的交付物，按重要性排列",
						items: {
							type: "object",
							properties: {
								path: { type: "string", description: "文件路径（相对工作目录或绝对）" },
								note: { type: "string", description: "一句话：这是什么、看它的什么" },
							},
							required: ["path"],
						},
					},
				},
				required: ["files"],
			},
			// 只记路径与说明，不复制内容、不碰文件系统。
			alwaysReadOnly: true,
			// 交付物卡片画什么由工具自陈：界面不认 `files` 这个字段名（见 contract.ts）
			deliverables: (input) => {
				const parsed = parsePresent(input);
				return "error" in parsed ? [] : parsed.files;
			},
			summarize: (input) => {
				const files = (input as { files?: unknown }).files;
				return Array.isArray(files) ? `${files.length} 件` : "";
			},
			validate: (input) => {
				const parsed = parsePresent(input);
				return "error" in parsed ? { ok: false, message: parsed.error } : { ok: true };
			},
			async execute(input) {
				const parsed = parsePresent(input);
				if ("error" in parsed) {
					return { content: parsed.error, isError: true };
				}
				present.replace(parsed.files);
				return { content: present.render(), isError: false };
			},
		}),
	];
}
