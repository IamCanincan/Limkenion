/*
 * 跨会话全文搜索：GET /api/search?q=&limit=
 *
 * 走功能路由而不是 server.ts：加功能不必改共享的请求分发代码，多人（或多 agent）并行开发时
 * 也不会互相踩。真正扫盘的是 session-search.ts，这里只负责把查询参数翻译成一次调用、
 * 再把结果包成 JSON——参数校验与业务逻辑分开，两边都好单独读。
 */

import { getSessionsDir } from "../config.ts";
import { DEFAULT_SEARCH_LIMIT, type SearchHit, searchSessions } from "../session-search.ts";
import type { FeatureRoute } from "./features.ts";
import { sendJson } from "./http.ts";

/** 一次搜索最多返回多少条；再大也只是让人滚不完，还多扫一堆盘 */
const MAX_SEARCH_LIMIT = 100;

/**
 * 解析 limit 查询参数。
 *
 * 网页上的这个值来自我们自己的输入框，但 API 是公开的：给不出合法正整数时退回默认值而不是报错，
 * 因为「条数没写对」不该让整次搜索失败；只有关键词为空才是真的没法搜。
 */
function parseLimit(raw: string | null): number {
	const value = Number((raw ?? "").trim());
	// 小数、负数、NaN、0 一律按「没给」处理。
	if (!Number.isFinite(value) || Math.floor(value) < 1) {
		return DEFAULT_SEARCH_LIMIT;
	}
	return Math.min(Math.floor(value), MAX_SEARCH_LIMIT);
}

/**
 * GET /api/search：搜会话根目录下的全部会话。
 *
 * 搜的是 getSessionsDir() 而不是 context.getCwd()：会话按工作目录分目录存放，只搜当前目录的话
 * 「跨会话搜索」就退化成「当前目录搜索」，而用户找的往往是「上周在别的项目里说过的那句话」。
 */
export const route: FeatureRoute = (_request, response, url, method) => {
	if (method !== "GET" || url.pathname !== "/api/search") {
		return false;
	}

	const query = (url.searchParams.get("q") ?? "").trim();
	// 空关键词直接 400：空串会命中每一行（下限为 0 的子串），返回一屏无意义的结果。
	if (query === "") {
		sendJson(response, 400, { error: "缺少查询关键词 q" });
		return true;
	}

	const hits: SearchHit[] = searchSessions(getSessionsDir(), query, {
		limit: parseLimit(url.searchParams.get("limit")),
	});
	sendJson(response, 200, { hits });
	return true;
};
