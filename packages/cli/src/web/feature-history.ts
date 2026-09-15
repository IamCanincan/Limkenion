/*
 * 逐轮回滚列表与 diff：GET /api/sessions/:id/history、GET /api/sessions/:id/history/:seq
 *
 * 数据来源是 `CheckpointStore` 本来就落盘的快照文件。运行期已经有 Run 持有它，但历史要能看
 * 旧会话，所以这里按同一份约定（`<会话文件>.checkpoints.jsonl`）再读一次磁盘：不依赖会话
 * 当前是否打开，也不需要为了看一眼差异就把运行加载进内存。
 *
 * 行级 diff 的算法在 `diff.ts`（工具确认卡片上那一节「改动片段」用的是同一份）：这个模块只管
 * 「一轮快照 → 每个文件的差异」这件事——读快照、夹路径、按预算拼响应。
 *
 * 三个刻意的取舍：
 * - **列表不带文件内容**：一轮快照里可能塞着好几个大文件的旧版本，整份返回会把响应撑到
 *   几兆，页面只是要画一个清单。内容只在打开某个文件时按需取。
 * - **返回的是行而不是文本**：界面要照统一 diff 的样子给出「行号列 + `@@` 段头 + 增删统计」
 *   （与 GitHub 的呈现一致），行号必须由算 diff 的这一方给——让浏览器自己去数前缀，就等于
 *   把同一套规则实现两遍，迟早对不上。
 * - **处处限长**：单个文件、单次响应的行数都有上限，超出就明确说明「还有多少行没展开」，
 *   宁可少给也不能让一个巨型文件把内存和页面拖死。
 */

import type { ServerResponse } from "node:http";
import { CheckpointStore } from "limkenion-core";
import { diffTurn, type FileDiff, guardPath } from "../diff.ts";
import type { FeatureContext, FeatureRoute } from "./features.ts";
import { sendJson } from "./http.ts";

/** 历史列表里的一轮快照 */
interface HistoryTurn {
	/** 轮次序号，从 1 开始，与 CheckpointStore 的快照一致 */
	seq: number;
	/** 提交时间（ISO 字符串） */
	at: string;
	/** 这一轮改动的文件绝对路径 */
	files: string[];
	/** 因为太大而没记下旧内容的文件：知道它们存在，但回滚不了 */
	skipped: string[];
}

/** 一轮的 diff 响应 */
interface DiffResponse {
	seq: number;
	at: string;
	files: FileDiff[];
	/** 因为总输出上限而被省掉的文件 */
	omitted: { path: string; note: string }[];
}

/** 逐轮回滚列表。只给路径与时间，不给内容：快照里存着每个文件改动前的全文 */
interface HistoryListResponse {
	turns: HistoryTurn[];
}

/** 路由匹配：`/api/sessions/<id>/history` 与 `/api/sessions/<id>/history/<seq>` */
const HISTORY_PATH_RE = /^\/api\/sessions\/([A-Za-z0-9-]+)\/history(?:\/([^/]+))?$/;

/** 会话 id 的正则与 server.ts 保持一致，避免同一段路径在两处被解释成不同东西 */
const SESSION_ID_RE = /^[A-Za-z0-9-]+$/;

/**
 * 逐轮回滚列表与差异。
 *
 * `GET /api/sessions/:id/history` 列出每轮，`GET /api/sessions/:id/history/:seq` 给出那一轮的差异。
 * 请求体没有用武之地，所以第一个参数按仓库惯例写成 `_request`。
 */
export const route: FeatureRoute = (_request, response, url, method, context) => {
	const match = HISTORY_PATH_RE.exec(url.pathname);
	if (!match) {
		return false;
	}
	// 路径对上了但不是 GET：这里认领下来回 405，而不是放给后面的路由最终变成 404。
	if (method !== "GET") {
		respondError(response, 405, `不支持的方法 ${method} ${url.pathname}`);
		return true;
	}

	const id = match[1] ?? "";
	const seq = match[2];
	if (!SESSION_ID_RE.test(id)) {
		respondError(response, 400, "会话 id 不合法");
		return true;
	}
	const run = context.registry.openById(id);
	if (!run) {
		respondError(response, 404, "会话不存在");
		return true;
	}

	// Run 没有暴露 CheckpointStore，但两者的约定是固定的：快照就在会话文件旁边。
	// 按约定再读一次磁盘，既不用改共享的 runs.ts，也让没打开过的旧会话一样能看历史。
	const store = new CheckpointStore(run.session.file);
	if (seq === undefined) {
		sendHistoryList(response, context, store);
		return true;
	}

	const wanted = Number(seq);
	if (!Number.isInteger(wanted) || wanted < 1) {
		respondError(response, 400, "轮次序号必须是正整数");
		return true;
	}
	const snapshot = store.list().find((item) => item.seq === wanted);
	if (!snapshot) {
		respondError(response, 404, `第 ${wanted} 轮没有快照，可能已经被回滚掉了`);
		return true;
	}
	sendTurnDiff(response, context, snapshot, url.searchParams.get("path"));
	return true;
};

/** 列出每轮改动的文件（不含内容） */
function sendHistoryList(response: ServerResponse, context: FeatureContext, store: CheckpointStore): void {
	const cwd = context.getCwd();
	const turns: HistoryTurn[] = [];
	for (const snapshot of store.list()) {
		const files = snapshot.files.map((file) => guardPath(file.path, cwd)).filter((path) => path !== null);
		const skipped = snapshot.skipped.map((path) => guardPath(path, cwd)).filter((path) => path !== null);
		// 快照里越界的文件直接丢掉：它既不该被展示，也不该成为 diff 的目标。
		if (files.length === 0 && skipped.length === 0) {
			continue;
		}
		turns.push({ seq: snapshot.seq, at: snapshot.at, files, skipped });
	}
	const body: HistoryListResponse = { turns };
	sendJson(response, 200, body);
}

/**
 * 给出某一轮的差异。
 *
 * `requested` 给了就只算那一个文件——前端点开某个文件时才拉它的内容，没必要为了看一个文件
 * 把整轮的都算一遍。没给就按顺序算完整轮，直到撞上总输出上限。
 */
function sendTurnDiff(
	response: ServerResponse,
	context: FeatureContext,
	snapshot: { seq: number; at: string; files: { path: string; content: string | null; existed: boolean }[] },
	requested: string | null,
): void {
	// 算差异那一段与终端的 `/diff` 共用（`diff.ts` 的 `diffTurn`），这里只管拼响应
	const { files, omitted } = diffTurn(snapshot, context.getCwd(), { requested });
	if (requested !== null && files.length === 0) {
		respondError(response, 404, "这一轮没有改动这个文件");
		return;
	}
	const body: DiffResponse = { seq: snapshot.seq, at: snapshot.at, files, omitted };
	sendJson(response, 200, body);
}

/** 统一的错误响应 */
function respondError(response: ServerResponse, status: number, error: string): void {
	sendJson(response, status, { error });
}
