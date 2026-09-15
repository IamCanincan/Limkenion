/**
 * 跨会话搜索。
 *
 * 会话本来就是 JSONL，用 grep 也能查；做成命令是为了补上 grep 做不到的三件事：**跳过**逐轮快照文件
 * （它们同目录同名后缀，混进来会把「回滚记录」当成对话）、把命中还原成「哪个会话、第几条、谁说的」、
 * 以及只输出一行可读片段。
 *
 * 这里只读不写，也不解析成完整的 Message：搜索要的是文本，不需要模型的类型。
 */

import { readFileSync } from "node:fs";
import { firstLine, flattenWhitespace, parseJsonLines, parseJsonObject } from "limkenion-core";
import { listAllSessionFiles } from "./session.ts";

/** 片段长度上限 */
export const SNIPPET_LENGTH = 120;

/** 默认最多返回多少条 */
export const DEFAULT_SEARCH_LIMIT = 20;

/** 一条命中 */
export interface SearchHit {
	/** 会话文件路径 */
	file: string;
	/** 会话 id */
	sessionId: string;
	/** 会话所属的工作目录 */
	cwd: string;
	/** 会话创建时间 */
	createdAt: string;
	/** 命中的消息角色 */
	role: string;
	/** 命中的消息在会话文件里的行号（从 1 开始，含表头那一行） */
	line: number;
	/** 命中位置的上下文片段（已压平空白） */
	snippet: string;
	/** 命中词在片段里的起始下标；前端据此高亮，不必自己再找一遍 */
	matchStart?: number;
	/** 命中词长度 */
	matchLength?: number;
}

/** 会话文件里的表头（与 Session 的结构一致，这里只取搜索需要的字段） */
interface HeaderRecord {
	type?: string;
	id?: string;
	cwd?: string;
	createdAt?: string;
}

/** 把一条消息记录压成可搜索的文本；不是消息的记录返回空串 */
function searchableText(record: Record<string, unknown>): { role: string; text: string } {
	const role = typeof record.role === "string" ? record.role : "";
	const parts: string[] = [];
	if (typeof record.content === "string") {
		parts.push(record.content);
	}
	if (typeof record.reasoning === "string") {
		parts.push(record.reasoning);
	}
	if (Array.isArray(record.results)) {
		for (const result of record.results) {
			if (result !== null && typeof result === "object") {
				const content = (result as { content?: unknown }).content;
				if (typeof content === "string") {
					parts.push(content);
				}
			}
		}
	}
	if (Array.isArray(record.toolCalls)) {
		for (const call of record.toolCalls) {
			if (call !== null && typeof call === "object") {
				const args = (call as { arguments?: unknown }).arguments;
				if (typeof args === "string") {
					parts.push(args);
				}
			}
		}
	}
	return { role, text: parts.join("\n") };
}

/** 取命中位置附近的片段，把换行压平 */
function makeSnippet(text: string, index: number, queryLength: number): { text: string; matchStart: number } {
	// text 必须已经压平（调用方先 flattenWhitespace）：否则 index 是压平前的位置，
	// 而窗口取自压平后的文本，两者错位会让关键词高亮标到别的字上（实测踩到）。
	const start = Math.max(0, index - Math.floor((SNIPPET_LENGTH - queryLength) / 2));
	const window = text.slice(start, start + SNIPPET_LENGTH);
	const prefix = start > 0 ? "…" : "";
	const suffix = start + SNIPPET_LENGTH < text.length ? "…" : "";
	// 顶部与尾部不再 trim：取多少字符就是多少，偏移才能算准。
	return { text: `${prefix}${window}${suffix}`, matchStart: prefix.length + (index - start) };
}

/**
 * 在会话根目录里搜关键词。
 *
 * 大小写不敏感的子串匹配：正则虽然更灵活，但用户随手输的内容里全是元字符，而搜索这件事
 * 「搜不到」比「搜得不够花」更让人困惑。
 */
export function searchSessions(root: string, query: string, options: { limit?: number } = {}): SearchHit[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") {
		return [];
	}
	const limit = Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT);
	const hits: SearchHit[] = [];

	// 新的会话更可能被想起，所以从后往前扫；返回时也按这个顺序——最近的排最前。
	for (const file of listAllSessionFiles(root).reverse()) {
		let raw: string;
		try {
			raw = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		// 表头坏了也继续搜：内容还在，比整份丢掉强。
		const header = (parseJsonObject(firstLine(raw)) ?? {}) as HeaderRecord;

		// 到上限就整体停下：回调里 return 只结束这一行，所以要在外层跳出文件循环。
		let full = false;
		parseJsonLines(raw, (record, line) => {
			// 带 type 的是记录而不是消息（会话头、清空标记）：没有正文，搜出来只会是空片段。
			if (full || record.type !== undefined) {
				return;
			}
			const { role, text } = searchableText(record);
			// 先压平再定位：窗口按压平后的文本取，偏移才对得上（否则高亮会标到别的字上，实测踩到）。
			const flat = flattenWhitespace(text);
			const at = flat.toLowerCase().indexOf(needle);
			if (at < 0) {
				return;
			}
			const piece = makeSnippet(flat, at, needle.length);
			hits.push({
				file,
				sessionId: header.id ?? "",
				cwd: header.cwd ?? "",
				createdAt: header.createdAt ?? "",
				role: role === "" ? "?" : role,
				line,
				snippet: piece.text,
				matchStart: piece.matchStart,
				matchLength: needle.length,
			});
			if (hits.length >= limit) {
				full = true;
			}
		});
		if (full) {
			break;
		}
	}
	return hits;
}
