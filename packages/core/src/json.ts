/**
 * JSON / JSONL 读取。
 *
 * 配置、凭据、会话、快照都是「读一个 JSON 文件（或一行文本），坏了就当没有」的模式。早先每个模块
 * 各写一遍 try \/ catch，连错误处理的分寸都不一致——有的返回 null，有的返回 {}，有的直接抛。
 * 收到这里之后只剩一条规矩：**读不到或形状不对就是 null，由调用方决定怎么兜**。
 */

import { readFileSync } from "node:fs";

/** 顶层是普通对象时收窄成 Record，否则 null */
function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** 解析一段 JSON 文本；不是合法 JSON 或顶层不是对象时返回 null */
export function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(text));
	} catch {
		return null;
	}
}

/**
 * 逐行解析 JSONL。
 *
 * 空行与坏行直接跳过：会话与快照都是追加写入的，进程被杀时最后一行只写了一半，
 * 那是常态而不是异常，为它整份文件读不出来不值得。回调拿到的行号从 1 起，方便报错定位。
 */
export function parseJsonLines(text: string, visit: (record: Record<string, unknown>, line: number) => void): void {
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = (lines[index] ?? "").trim();
		if (trimmed === "") {
			continue;
		}
		const record = parseJsonObject(trimmed);
		if (record !== null) {
			visit(record, index + 1);
		}
	}
}

/** 读一个 JSON 对象文件；缺失、损坏、顶层不是对象都返回 null */
export function readJsonObject(path: string): Record<string, unknown> | null {
	try {
		return parseJsonObject(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}
