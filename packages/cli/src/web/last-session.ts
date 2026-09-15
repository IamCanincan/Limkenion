/**
 * 「上次所在的会话」这个使用痕迹的读写。
 *
 * 从 `server.ts` 拆出来的：它是一份**文件格式**（`web-state.json`），而 `server.ts` 是传输层；
 * 状态路由（`routes/state.ts`）也要读它，留在服务器文件里就会让两边互相 import。
 *
 * 为什么不用 localStorage：浏览器存储以 **origin** 为作用域，换一个端口重新打开 `limkenion web`
 * 就丢了（DSH 从 localStorage 迁到宿主配置也是同一个理由）。放这里则换端口、换浏览器都一致，
 * 而且与工作目录一样属于「这台机器上的使用痕迹」，不是会话内容，所以不必写进会话文件头。
 *
 * 读写都容忍坏数据：文件不在、解析不了、字段类型不对，一律当「没有上次」——这类小状态不值得为它报错。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

function webStatePath(): string {
	return join(getAgentDir(), "web-state.json");
}

/** 上次所在的会话 id；没有或读不出来时是空串 */
export function readLastSessionId(): string {
	try {
		const raw = JSON.parse(readFileSync(webStatePath(), "utf8")) as { lastSessionId?: unknown };
		return typeof raw.lastSessionId === "string" ? raw.lastSessionId : "";
	} catch {
		return "";
	}
}

/** 记下这次开的会话；写不进去也不影响使用 */
export function writeLastSessionId(id: string): void {
	try {
		writeFileSync(webStatePath(), `${JSON.stringify({ lastSessionId: id }, null, "\t")}\n`, "utf8");
	} catch {
		// 写不进去（只读目录之类）不影响使用：大不了下次回到「最近更新的那个」
	}
}
