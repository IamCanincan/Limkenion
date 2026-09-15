/**
 * `limkenion search <关键词>`：在历史会话语料里找一句话。
 *
 * 输出走 stdout（一行一条命中），用法像 grep：**找到就 0，没找到就 1**，出错才 2。
 * 这样它可以直接用在脚本里，比如「上次是怎么解决这个报错的」。
 */

import { basename } from "node:path";
import { APP_NAME, getSessionsDir } from "../config.ts";
import { DEFAULT_SEARCH_LIMIT, type SearchHit, searchSessions } from "../session-search.ts";
import type { Command } from "./command.ts";
import { wantsHelp } from "./common.ts";

/** search 子命令：元信息住在命令自己这里 */
export const searchCommand: Command = {
	name: "search",
	synopsis: "search <关键词>",
	summary: "在历史会话里搜内容（找到 0 / 没找到 1）",
	// 搜索是同步的（只读本地会话文件，不碰网络），包一层只为统一签名。
	run: async (argv) => runSearchCommand(argv),
};

/** 用法说明 */
function searchUsage(): string {
	return [
		`${APP_NAME} search <关键词> [--limit <n>]`,
		"",
		"在全部历史会话里搜关键词（大小写不敏感的子串匹配），一行一条命中。",
		"逐轮快照文件不是对话，会被跳过。",
		"",
		"参数：",
		`  --limit <n>   最多返回多少条，默认 ${DEFAULT_SEARCH_LIMIT}`,
		"",
		"退出码：0 有命中；1 没有命中；2 参数不对。",
	].join("\n");
}

/** 解析 search 的参数 */
export function parseSearchArgs(argv: string[]): { query: string; limit: number } | { error: string } {
	const words: string[] = [];
	let limit = DEFAULT_SEARCH_LIMIT;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--limit") {
			const value = Number.parseInt(argv[index + 1] ?? "", 10);
			if (!Number.isFinite(value) || value <= 0) {
				return { error: "--limit 后面要跟一个正整数" };
			}
			limit = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			return { error: `未知参数：${arg}` };
		}
		words.push(arg);
	}
	const query = words.join(" ").trim();
	if (query === "") {
		return { error: "请给出要搜的关键词" };
	}
	return { query, limit };
}

/** 把命中格式化成一行：时间、说的角色、片段，以及回看它需要的会话文件 */
export function formatHit(hit: SearchHit): string {
	const time = hit.createdAt === "" ? "时间未知" : hit.createdAt.replace("T", " ").slice(0, 16);
	const where = hit.cwd === "" ? basename(hit.file) : hit.cwd;
	return `${time}  ${hit.role.padEnd(9)}  ${hit.snippet}\n          ${where}  ${hit.file}:${hit.line}`;
}

/** 运行 search 子命令，返回进程退出码 */
export function runSearchCommand(argv: string[]): number {
	if (wantsHelp(argv)) {
		process.stdout.write(`${searchUsage()}\n`);
		return 0;
	}
	const parsed = parseSearchArgs(argv);
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n\n${searchUsage()}\n`);
		return 2;
	}

	const hits = searchSessions(getSessionsDir(), parsed.query, { limit: parsed.limit });
	if (hits.length === 0) {
		process.stderr.write(`没有找到「${parsed.query}」\n`);
		return 1;
	}
	process.stdout.write(`${hits.map(formatHit).join("\n")}\n`);
	if (hits.length >= parsed.limit) {
		// 到上限时明确说一句，免得看起来「就这么多」。
		process.stderr.write(`只显示前 ${parsed.limit} 条，要更多用 --limit 调大\n`);
	}
	return 0;
}
