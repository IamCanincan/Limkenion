/**
 * 工具共用的路径与输出处理。
 *
 * 三个文件工具都需要「把用户/模型给的路径解析成绝对路径」和「把过长的输出截断」，
 * 放在一起避免各写一遍。
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { sliceByBytes } from "../text.ts";

/** 单次输出保留的最大行数 */
export const MAX_OUTPUT_LINES = 2000;

/** 单次输出保留的最大字节数 */
export const MAX_OUTPUT_BYTES = 50 * 1024;

/** 截断结果 */
export interface TruncationResult {
	/** 截断后的正文 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 截断原因：行数或字节数 */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始行数 */
	totalLines: number;
	/** 实际保留的行数 */
	keptLines: number;
}

/**
 * 把输入路径解析成绝对路径。
 *
 * 支持 `~` 开头表示用户主目录；相对路径以 cwd 为基准。不做任何越权检查：
 * 这个 agent 的设计前提就是它可以访问用户让它访问的任何位置。
 */
export function resolveUserPath(input: string, cwd: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") {
		return homedir();
	}
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return resolve(homedir(), trimmed.slice(2));
	}
	return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

/** 把字节数格式化成人类可读文本 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)}KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 从头部截断文本。
 *
 * 先按行数截断，再按字节数收紧，两个限制谁先命中就用谁。按字节截断时不会把
 * 一个多字节字符切成两半：用 Buffer 定位后按字符边界回退。
 */
export function truncateHead(
	text: string,
	maxLines: number = MAX_OUTPUT_LINES,
	maxBytes: number = MAX_OUTPUT_BYTES,
): TruncationResult {
	const allLines = text.split("\n");
	let kept = allLines;
	let truncatedBy: "lines" | "bytes" | null = null;

	if (allLines.length > maxLines) {
		kept = allLines.slice(0, maxLines);
		truncatedBy = "lines";
	}

	let content = kept.join("\n");
	if (Buffer.byteLength(content, "utf-8") > maxBytes) {
		content = sliceByBytes(content, maxBytes);
		truncatedBy = "bytes";
	}

	return {
		content,
		truncated: truncatedBy !== null,
		truncatedBy,
		totalLines: allLines.length,
		keptLines: content.split("\n").length,
	};
}

/**
 * 确认卡片里一段预览最多显示多少行。
 *
 * 超出的说清「还有 N 行」而不是悄悄砍掉：用户在卡片上做的是「批不批」的决定，
 * 看不见的那部分必须至少知道自己没看见。
 */
export const APPROVAL_PREVIEW_LINES = 12;
