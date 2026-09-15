/*
 * 逐轮回滚列表与 diff。
 *
 * 服务端已经有「回滚上一轮」这个动作（`POST /api/sessions/:id/rewind`，一次撤一轮），这里做的是
 * 「先看清楚再决定撤到哪」：按轮列出改动，点开某个文件才看差异，再决定撤几轮。
 *
 * 位置由外壳（`shell.js`）统一安排：顶部栏一个入口，内容注册成右侧面板的一个标签页。
 * 之前每个功能都往侧栏和输入区挤，那两处本来就满，上方与右侧反而空着；注册进外壳之后，
 * 位置、标签栏、关闭按钮、Esc 都归外壳管，本模块只管自己这一格里的内容。
 *
 * 形态照 DSH 自己的界面来：**一行制、信息密度优先**。每行是「▸ 等宽路径 … +12 −3」，
 * 行高约 26px，不用大圆角卡片包住每一行；diff 照统一 diff 的老规矩——行号单独成列、`@@` 段头
 * 弱化、增删行用 `--ok`/`--danger` 的淡底、等宽不折行（400px 的面板里靠横向滚动）。
 *
 * 视觉只用既有的 MD3 角色变量（`--surface-*`、`--accent-*`、`--text-*`、`--radius-*`、`--space-*`），
 * 一个写死的色值都不新造；图标一律用符号（`▸` `▾` `·` `+` `−` `↺`），切换状态直接变、不做动画
 * （进行中的回滚用「文字 + 秒数」交代状态，那是在报进度，不是在放动效）。
 *
 * 三个刻意的取舍：
 * - **DOM 与样式都自己建**：index.html 与 app.css 是主流程与其它功能共用的文件，往里面加东西
 *   既容易互相冲突，也会让「历史」这个功能没法独立开关。
 * - **按文件懒加载 diff**：一轮改了十个文件时，一上来就把十份 diff 都拉回来既慢又没人看；
 *   展开哪个拉哪个，拉过的缓存在内存里。
 * - **回滚按「再撤几轮」实现**：服务端只肯撤最近一轮，撤到更早的轮次就是连着撤，每次都拿到
 *   权威结果再继续。比起在共享的 server.ts 里加一个「撤到指定轮次」的新动作，这样不必碰别人的文件。
 */

import { api } from "./api.js";
import { addPanelTab, panelOpen } from "./features.js";
import { formatTime } from "./format.js";
import { icon } from "./icons.js";
import { state } from "./state.js";
import { setStatus } from "./ui.js";

/** 本模块的样式；用一次就够。变量都带兜底值，万一主题里缺了某个 token 也不至于全白 */
export const STYLE = /* css */ `
/* lkx-history：右侧面板里的回滚历史与 diff。
   整体按「一行制」来做：每行一个文件，行高紧凑，只有展开的那一块才铺 diff。 */
.lkx-history {
	display: flex;
	flex-direction: column;
	gap: var(--space-2, 8px);
	padding: var(--space-2, 8px) var(--space-3, 12px) var(--space-3, 12px);
	font-size: var(--text-sm, 12.5px);
}
.lkx-history-bar {
	display: flex;
	align-items: center;
	gap: var(--space-2, 8px);
	color: var(--muted);
}
.lkx-history-hint {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}
/* 图标按钮：面板里只放符号，含义靠 title */
.lkx-history-icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	flex: none;
	border: 0;
	border-radius: var(--radius-pill, 999px);
	background: transparent;
	color: var(--muted);
	font-size: var(--text-md, 15px);
	line-height: 1;
	cursor: pointer;
}
.lkx-history-icon:hover {
	background: var(--surface-3);
	color: var(--text);
}
.lkx-history-status {
	border-radius: var(--radius-xs, 12px);
	padding: var(--space-1, 4px) var(--space-2, 8px);
	background: var(--surface-2);
	color: var(--text-soft);
}
.lkx-history-status[hidden] {
	display: none;
}
.lkx-history-list {
	display: flex;
	flex-direction: column;
}
/* 轮与轮之间只留一条分隔线，不用卡片；面板窄，卡片会把可用宽度吃光 */
.lkx-history-turn + .lkx-history-turn {
	border-top: 1px solid var(--border);
}
.lkx-history-turn-summary,
.lkx-history-file-summary {
	list-style: none;
	cursor: pointer;
}
.lkx-history-turn-summary::-webkit-details-marker,
.lkx-history-file-summary::-webkit-details-marker {
	display: none;
}
/* 轮次行：轮次 + 时间 + 文件数，一行 26px */
.lkx-history-turn-summary {
	display: flex;
	align-items: center;
	gap: var(--space-2, 8px);
	height: 26px;
	color: var(--text-soft);
}
.lkx-history-turn-summary::before {
	flex: none;
	width: 1em;
	color: var(--muted);
	content: "▸";
}
.lkx-history-turn[open] > .lkx-history-turn-summary::before {
	content: "▾";
}
.lkx-history-seq {
	margin-right: auto;
	font-weight: 600;
}
.lkx-history-time,
.lkx-history-count {
	flex: none;
	color: var(--muted);
	font-size: var(--text-xs, 11px);
}
/* 文件行：▸ · 等宽路径 … +N −M，一行 26px */
.lkx-history-file-summary {
	position: relative;
	display: flex;
	align-items: center;
	gap: var(--space-1, 4px);
	height: 26px;
	padding-left: 1.2em;
}
.lkx-history-file-summary::before {
	position: absolute;
	left: 0;
	width: 1em;
	color: var(--muted);
	content: "▸";
}
.lkx-history-file[open] > .lkx-history-file-summary::before {
	content: "▾";
}
/* 文件图标用 ·，与目录的 ▸ 区分开 */
.lkx-history-dot {
	flex: none;
	color: var(--muted);
}
/* 路径占满中间、放不下就省略；全路径在 title 里 */
.lkx-history-path {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	font-family: var(--font-mono);
	font-size: var(--text-xs, 11px);
}
.lkx-history-stats {
	display: flex;
	flex: none;
	gap: var(--space-1, 4px);
	font-family: var(--font-mono);
	font-size: var(--text-xs, 11px);
}
/* 增删统计与 diff 行同色，扫一眼就知道哪个文件动得多 */
.lkx-history-added {
	color: var(--ok);
}
.lkx-history-removed {
	color: var(--danger);
}
.lkx-history-skipped {
	display: flex;
	align-items: center;
	height: 26px;
	overflow: hidden;
	color: var(--warn);
	font-family: var(--font-mono);
	font-size: var(--text-xs, 11px);
	white-space: nowrap;
	text-overflow: ellipsis;
}
.lkx-history-note {
	padding: 2px 0;
	color: var(--muted);
	font-size: var(--text-xs, 11px);
}
/* diff 横向滚动而不是折行：折了行就看不出哪一行对哪一行了 */
.lkx-history-prewrap {
	margin: 0 0 var(--space-2, 8px) 1.2em;
	overflow-x: auto;
	border-radius: var(--radius-xs, 12px);
	background: var(--code-bg);
	font-family: var(--font-mono);
	font-size: var(--text-xs, 11px);
	line-height: 1.5;
}
/* 宽度按内容走，由 prewrap 负责横向滚动 */
.lkx-history-diffinner {
	display: inline-block;
	min-width: 100%;
}
/* 段头：弱化色 + 右侧放这一轮的回滚动作；横向滚动时留在左边 */
.lkx-history-hunk {
	position: sticky;
	left: 0;
	display: flex;
	align-items: center;
	gap: var(--space-2, 8px);
	padding: var(--space-1, 4px) var(--space-2, 8px);
	color: var(--muted);
}
.lkx-history-hunk-label {
	flex: 1;
	white-space: pre;
}
/* 回滚是这一轮的动作，所以挂在段头；描边而不是实心，免得抢走注意力 */
.lkx-history-rewind {
	flex: none;
	display: inline-flex;
	align-items: center;
	gap: var(--space-1, 4px);
	border: 1px solid var(--accent);
	border-radius: var(--radius-pill, 999px);
	padding: 1px var(--space-2, 8px);
	background: transparent;
	color: var(--accent-text, var(--accent));
	font: inherit;
	font-size: var(--text-xs, 11px);
	cursor: pointer;
}
.lkx-history-rewind:hover:not(:disabled) {
	background: var(--surface-3);
}
.lkx-history-rewind:disabled {
	opacity: 0.5;
	cursor: default;
}
/* 行号列固定宽度并右对齐；不给单行加圆角或边框，免得把 diff 切碎 */
.lkx-history-line {
	display: flex;
	align-items: flex-start;
	white-space: pre;
}
.lkx-history-old,
.lkx-history-new,
.lkx-history-sign {
	flex: none;
	color: var(--muted);
	user-select: none;
}
.lkx-history-old {
	width: 3.5em;
	padding-right: var(--space-1, 4px);
	border-right: 1px solid var(--border);
	text-align: right;
}
.lkx-history-new {
	width: 3.5em;
	padding: 0 var(--space-1, 4px);
	text-align: right;
}
.lkx-history-sign {
	width: 1.4em;
	text-align: center;
}
.lkx-history-text {
	flex: 1;
	min-width: 0;
}
.lkx-history-del {
	background: color-mix(in srgb, var(--danger) 14%, transparent);
	color: var(--danger);
}
.lkx-history-add {
	background: color-mix(in srgb, var(--ok) 14%, transparent);
	color: var(--ok);
}
`;

/** 服务端的两个只读端点，以及外壳已有的回滚动作 */
const HISTORY_URL = (id) => `/api/sessions/${encodeURIComponent(id)}/history`;
const DIFF_URL = (id, seq, path) =>
	`/api/sessions/${encodeURIComponent(id)}/history/${seq}?path=${encodeURIComponent(path)}`;
const REWIND_URL = (id) => `/api/sessions/${encodeURIComponent(id)}/rewind`;

/** 面板这一格的 DOM；build 时填上 */
let hint = null;
let status = null;
let list = null;
/** 顶栏那一行的「回滚上一轮」按钮；没有可回滚的轮次时收起 */
let rewindLast = null;
/** 服务端最近一次返回的快照列表 */
let turns = [];
/** 已拉到的 diff，按「轮次:文件」缓存：折叠再展开不必重新请求 */
const diffCache = new Map();
/** 这些缓存属于哪个会话；换会话后必须作废，否则会显示上一次会话的差异 */
let cachedSessionId = null;
/** 一次回滚还没走完时锁住按钮，避免连点撤过头 */
let busy = false;
/**
 * 正在请求中的 key。
 *
 * 「打开面板」和「容器变宽」都可能触发刷新，两次挨得很近时原来的写法会重复请求同一份数据；
 * 带上这个标记，同一条数据在落地之前不会被问第二遍。
 */
const inFlight = new Set();

/**
 * 哪几轮是展开的。
 *
 * 列表每次 `refresh()` 都整体重建（换会话、容器变宽、回滚之后都会刷一遍），不记下来的话，
 * 用户刚点开的那一轮会被下一次重建顺手合上。实测过：打开面板时那次刷新还在路上，点开的轮次
 * 会在刷新落地的一瞬间合上——看起来就是「点了没反应」（验收脚本量到 `open` 一直是 false，
 * 而 DOM 里其实已经有 diff 了）。
 */
const expandedTurns = new Set();
/**
 * 文件行的开合状态（`会话:轮次:路径` → 用户最后一次的选择）。
 *
 * 用三态而不是集合：第一个文件**默认**展开，所以「没有记录」与「用户把它收起来了」必须分得开，
 * 否则重建之后它又会自己弹开。
 */
const fileOpenState = new Map();

/** 初始化：注册顶部栏入口与右侧面板标签页。DOM 由外壳给，本模块只管往里填 */
export function init() {
	injectStyle();
	// 面板第一次被显示时才会调用 build，所以这里不做任何网络请求。
	// icon 显式给 clock：↺ 现在只用在逐轮的「回滚到这一轮」按钮上，标签上更该是时钟
	addPanelTab({ id: "history", symbol: "↺", icon: "clock", label: "历史", build, order: 20 });
}

/** 注入样式；重复调用只注入一次 */
function injectStyle() {
	if (document.getElementById("lkx-history-style")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "lkx-history-style";
	style.textContent = STYLE;
	document.head.append(style);
}

/** 建面板内容：一行状态 + 一段逐轮列表 */
function build(container) {
	container.classList.add("lkx-history");
	const bar = document.createElement("div");
	bar.className = "lkx-history-bar";
	hint = document.createElement("span");
	hint.className = "lkx-history-hint";
	hint.textContent = "还没有加载";
	/*
	 * 「回滚上一轮」放在这一行：这条动作原来在会话行的 ▾ 菜单里，使用者要求搬进「历史」面板
	 * （「会话中的回滚上一轮也移至历史板块中」）。逐轮那个按钮撤的是「这一轮以及它之后」，
	 * 挂最新一轮就是「上一轮」——这里给一个不用展开就能按到的入口，两处走的是同一条 rewind()。
	 *
	 * **没有可撤的轮次时留着它、只置灰**，不要藏起来：藏起来的话使用者会以为这个入口根本不存在
	 * （把「还没有轮次」看成「功能没做」——真踩过）。置灰时 title 说明为什么按不动。
	 */
	rewindLast = document.createElement("button");
	rewindLast.type = "button";
	rewindLast.className = "lkx-history-rewind";
	rewindLast.disabled = true;
	rewindLast.dataset.lkxLabel = "回滚上一轮";
	rewindLast.append(icon("refresh", 14));
	rewindLast.append(labelSpan("回滚上一轮"));
	rewindLast.title = "这个会话还没有可回滚的轮次";
	rewindLast.addEventListener("click", () => {
		const latest = turns[turns.length - 1];
		if (latest !== undefined) {
			void rewind(latest, rewindLast);
		}
	});
	// 会话切走、跑完一轮之后列表都会过期，给一个手动刷新的出口。
	const reload = document.createElement("button");
	reload.type = "button";
	reload.className = "lkx-history-icon";
	reload.textContent = "⟳";
	reload.title = "刷新历史";
	reload.addEventListener("click", () => void refresh());
	bar.append(hint, rewindLast, reload);

	status = document.createElement("div");
	status.className = "lkx-history-status";
	status.hidden = true;

	list = document.createElement("div");
	list.className = "lkx-history-list";
	container.append(bar, status, list);
	// 面板被打开的那一刻就拉一次，省得用户再点一下刷新。
	void refresh();
	/*
	 * 换了会话就把列表换成那个会话的（事件名与 sessions.js 里的 SESSION_EVENT 一致）。
	 * 从前只靠下面那个「容器变宽」来触发，于是面板开着切会话时列表还是上一个会话的轮次。
	 */
	document.addEventListener("lk:session-changed", () => void refresh());
	// 换会话不会走本模块的任何代码，而容器被外壳藏起来时宽度会变成 0；盯着宽度变化就知道
	// 「面板又被打开了一次」，这时刷新才不会显示上一个会话的旧列表。
	if (typeof ResizeObserver === "function") {
		new ResizeObserver(() => {
			if (container.offsetWidth > 0) {
				void refresh();
			}
		}).observe(container);
	}
}

/** 面板顶栏左边那行字：这一格是**哪个会话**的、有几轮。
 *
 * 带上会话名是为了让「换会话了」看得见（使用者：「点击新会话，面板并没有刷新」）：两个空会话的轮次
 * 说明本来就一样，只写「1 轮 / 还没改过文件」的话，换过会话看着像没换。 */
function nameOf(id) {
	const session = state.sessions.find((item) => item.id === id);
	if (session === undefined) {
		return "这个会话";
	}
	if (session.title !== "") {
		return session.title;
	}
	return session.preview !== "" ? session.preview : "新会话";
}

/** 拉取逐轮列表并重绘 */
async function refresh() {
	if (list === null) {
		// build 还没跑过（面板从没打开过），打开时自然会拉。
		return;
	}
	const id = state.activeId;
	list.replaceChildren();
	hint.textContent = "";
	setNote("");
	if (!id) {
		hint.textContent = "还没有会话";
		return;
	}
	if (id !== cachedSessionId) {
		// 换会话：上一份列表与 diff 都不再适用。
		cachedSessionId = id;
		diffCache.clear();
		// 展开状态也按会话分开记：轮次序号在不同会话里毫无关系，留着会让新会话的第 1 轮自己弹开。
		expandedTurns.clear();
		fileOpenState.clear();
		turns = [];
	}
	const key = `${id}:list`;
	if (inFlight.has(key)) {
		// 同一份列表已经有一个请求在路上了，等它回来就行。
		return;
	}
	inFlight.add(key);
	hint.textContent = "正在加载…";
	try {
		const data = await api(HISTORY_URL(id));
		turns = Array.isArray(data.turns) ? data.turns : [];
	} catch (error) {
		hint.textContent = `加载失败：${error.message}`;
		return;
	} finally {
		inFlight.delete(key);
	}
	hint.textContent = turns.length === 0 ? `${nameOf(id)} · 还没改过文件` : `${nameOf(id)} · ${turns.length} 轮`;
	if (rewindLast !== null) {
		// 没有可撤的轮次时只置灰、不藏起来：这个入口得一直在那儿，使用者才知道回滚搬到了这里
		rewindLast.disabled = turns.length === 0;
		rewindLast.title = turns.length === 0 ? "这个会话还没有可回滚的轮次" : "撤掉最近一轮的文件改动";
	}
	renderTurns();
}

/** 画出每一轮：轮次默认收起，展开后是文件清单（第一个文件默认展开） */
function renderTurns() {
	list.replaceChildren();
	for (const turn of turns) {
		const files = Array.isArray(turn.files) ? turn.files : [];
		const skipped = Array.isArray(turn.skipped) ? turn.skipped : [];

		const details = document.createElement("details");
		details.className = "lkx-history-turn";
		// 重建时恢复用户的开合状态（见 expandedTurns 的说明）
		details.open = expandedTurns.has(turn.seq);
		details.addEventListener("toggle", () => {
			if (details.open) {
				expandedTurns.add(turn.seq);
			} else {
				expandedTurns.delete(turn.seq);
			}
		});
		const summary = document.createElement("summary");
		summary.className = "lkx-history-turn-summary";
		const label = document.createElement("span");
		label.className = "lkx-history-seq";
		label.textContent = `第 ${turn.seq} 轮`;
		const time = document.createElement("span");
		time.className = "lkx-history-time";
		time.textContent = formatTime(turn.at);
		const count = document.createElement("span");
		count.className = "lkx-history-count";
		count.textContent = `· ${files.length} 个文件`;
		summary.append(label, time, count);
		details.append(summary);

		const body = document.createElement("div");
		body.className = "lkx-history-turn-body";
		// 文件多时不全铺开：只自动展开第一个，其余等用户点。
		for (const [index, path] of files.entries()) {
			body.append(fileItem(turn, path, index === 0));
		}
		for (const path of skipped) {
			// 快照都没抄下来的文件，回滚也回不去：直接说明，别让人以为它也能撤。
			const item = document.createElement("div");
			item.className = "lkx-history-skipped";
			item.textContent = `· ${path}（太大，未记录旧内容，无法回滚）`;
			item.title = path;
			body.append(item);
		}
		if (files.length === 0 && skipped.length === 0) {
			const empty = document.createElement("div");
			empty.className = "lkx-history-note";
			empty.textContent = "这一轮没有改动文件";
			body.append(empty);
		}
		details.append(body);
		list.append(details);
	}
}

/** 一个文件：一行清单（`▸ · 路径 … +N −M`）+ 展开后才去拉的 diff */
function fileItem(turn, path, expanded) {
	const item = document.createElement("details");
	item.className = "lkx-history-file";
	// 缓存键与开合状态的键都带上会话 id：同一轮次序号在不同会话里毫无关系，别让它们互相顶掉。
	const openKey = `${state.activeId}:${turn.seq}:${path}`;
	item.open = fileOpenState.get(openKey) ?? expanded;

	const summary = document.createElement("summary");
	summary.className = "lkx-history-file-summary";
	const dot = document.createElement("span");
	dot.className = "lkx-history-dot";
	dot.textContent = "·";
	const name = document.createElement("span");
	name.className = "lkx-history-path";
	name.textContent = path;
	// 面板窄，路径会被省略，全路径放 title 里。
	name.title = path;
	// 统计要等 diff 回来才知道，先把位置留出来。
	const stats = document.createElement("span");
	stats.className = "lkx-history-stats";
	summary.append(dot, name, stats);

	const result = document.createElement("div");
	result.className = "lkx-history-diff";
	result.hidden = true;

	// 缓存键带上会话 id：同一轮次序号在不同会话里毫无关系，别让它们互相顶掉。
	const key = `${state.activeId}:${turn.seq}:${path}`;
	let loaded = false;
	item.addEventListener("toggle", () => {
		// 先记开合（重建时按它恢复），再决定要不要去拉 diff
		fileOpenState.set(openKey, item.open);
		if (!item.open || loaded) {
			return;
		}
		loaded = true;
		void loadDiff(result, stats, turn, path, key);
	});
	if (expanded) {
		// 默认展开的那一个不会走 toggle，主动拉一次。
		loaded = true;
		void loadDiff(result, stats, turn, path, key);
	}
	item.append(summary, result);
	return item;
}

/** 拉（或取缓存）一个文件的差异并渲染 */
async function loadDiff(result, stats, turn, path, key) {
	const cached = diffCache.get(key);
	if (cached) {
		renderDiff(result, stats, cached, turn);
		return;
	}
	result.hidden = false;
	result.replaceChildren(noteNode("正在算差异…"));
	if (inFlight.has(key)) {
		// 同一个文件的差异已经在拉了（折叠再展开、或外壳连开两次），不必重复问。
		return;
	}
	inFlight.add(key);
	try {
		const data = await api(DIFF_URL(state.activeId, turn.seq, path));
		// 「这一轮这个文件的差异」不会再变，拉过一次就够了。
		diffCache.set(key, data);
		if (panelOpen()) {
			renderDiff(result, stats, data, turn);
		}
	} catch (error) {
		if (panelOpen()) {
			result.replaceChildren(noteNode(`读差异失败：${error.message}`));
		}
	} finally {
		inFlight.delete(key);
	}
}

/** 回滚到某一轮之前：这一轮以及它之后的轮次都会被撤掉（服务端一次只肯撤最近一轮） */
async function rewind(turn, button) {
	const id = state.activeId;
	if (!id || busy) {
		return;
	}
	const index = turns.findIndex((item) => item.seq === turn.seq);
	if (index === -1) {
		// 列表已经变了，说明看到的不是最新状态：先刷新，再让用户重新点。
		setNote("列表已经过期，正在刷新，请重新确认");
		await refresh();
		return;
	}
	// 服务端一次只撤最近一轮，所以撤到这一轮之前要连着撤「它和它之后」的轮数。
	const steps = turns.length - index;
	if (!window.confirm(`确定回滚到第 ${turn.seq} 轮之前吗？这会撤掉 ${steps} 轮的文件改动，且无法撤销。`)) {
		return;
	}

	busy = true;
	button.disabled = true;
	button.textContent = "↺ 正在回滚…";
	// 一轮一次请求，慢的时候得让人看见还在动：文案后面挂秒数，而不是只给一个转圈。
	const startedAt = Date.now();
	const tick = () => {
		const seconds = Math.round((Date.now() - startedAt) / 1000);
		setNote(`↺ 回滚到第 ${turn.seq} 轮之前… ${seconds} 秒`);
	};
	tick();
	const timer = setInterval(tick, 1000);
	let restored = 0;
	let removed = 0;
	let done = 0;
	/** 结论要等刷新之后再写：refresh() 会先清空状态行，先写会被它抹掉 */
	let outcome = "";
	try {
		for (let step = 0; step < steps; step++) {
			const result = await api(REWIND_URL(id), { method: "POST" });
			restored += result.restored ?? 0;
			removed += result.removed ?? 0;
			done++;
		}
		const seconds = Math.round((Date.now() - startedAt) / 1000);
		outcome = `✓ 已回滚 ${done} 轮（${seconds} 秒）：改回 ${restored} 个文件，删除 ${removed} 个新建文件`;
		setStatus(`已回滚到第 ${turn.seq} 轮之前`);
	} catch (error) {
		// 中途失败等于撤了一半，如实说出来：已经撤掉的轮次不会自己回来。
		outcome = `✕ 回滚中断：${error.message}（已撤掉 ${done} 轮，撤掉的改动不会自动恢复）`;
		setStatus(`回滚失败：${error.message}`);
	} finally {
		clearInterval(timer);
	}
	busy = false;
	button.disabled = false;
	button.textContent = "";
	button.append(icon("refresh", 14));
	// 复原成这个按钮原来那句话（顶栏那颗是「回滚上一轮」，段头上那颗是「回滚到这一轮」）
	button.append(labelSpan(button.dataset.lkxLabel ?? "回滚"));
	// 刷新能看到「已经撤掉的那几轮不在了」，然后把结论留在状态行上。
	await refresh();
	setNote(outcome);
}

/** 渲染一个文件的差异：统计放清单行，diff 按统一 diff 排版 */
function renderDiff(result, stats, data, turn) {
	const files = Array.isArray(data.files) ? data.files : [];
	const file = files[0];
	if (!file) {
		stats.replaceChildren();
		result.replaceChildren(noteNode("没有可显示的差异"));
		return;
	}

	stats.replaceChildren();
	const added = document.createElement("span");
	added.className = "lkx-history-added";
	added.textContent = `+${file.added ?? 0}`;
	const removed = document.createElement("span");
	removed.className = "lkx-history-removed";
	removed.textContent = `−${file.removed ?? 0}`;
	stats.append(added, removed);

	const nodes = [];
	if (file.created) {
		nodes.push(noteNode("这一轮新建了该文件"));
	}
	if (file.deleted) {
		nodes.push(noteNode("该文件现在已被删除"));
	}
	const sections = Array.isArray(file.sections) ? file.sections : [];
	for (const [index, section] of sections.entries()) {
		const pre = document.createElement("div");
		pre.className = "lkx-history-prewrap";
		// 内层按内容撑开，横向滚动交给 prewrap：折行会看不出行与行的对应关系。
		const inner = document.createElement("div");
		inner.className = "lkx-history-diffinner";
		const header = document.createElement("div");
		header.className = "lkx-history-hunk";
		const label = document.createElement("span");
		label.className = "lkx-history-hunk-label";
		label.textContent = section.header ?? "";
		header.append(label);
		// 回滚是整轮的动作，挂在第一个段头上就够，不必每段都放一个。
		if (index === 0) {
			header.append(rewindButton(turn));
		}
		inner.append(header);
		for (const line of section.lines ?? []) {
			inner.append(diffRow(line));
		}
		pre.append(inner);
		nodes.push(pre);
	}
	for (const item of Array.isArray(data.omitted) ? data.omitted : []) {
		nodes.push(noteNode(`· ${item.path}：${item.note}`));
	}
	if (file.note) {
		nodes.push(noteNode(file.note));
	}
	if (nodes.length === 0) {
		nodes.push(noteNode("与当前内容一致，没有差异"));
	}
	result.hidden = false;
	result.replaceChildren(...nodes);
}

/** 段头上的回滚按钮：按下前给一次确认，撤几轮由这一轮的位置决定 */
function rewindButton(turn) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "lkx-history-rewind";
	button.textContent = "";
	button.append(icon("refresh", 14));
	button.dataset.lkxLabel = "回滚到这一轮";
	button.append(labelSpan("回滚到这一轮"));
	button.title = `撤掉第 ${turn.seq} 轮及其之后的文件改动`;
	button.addEventListener("click", () => void rewind(turn, button));
	return button;
}

/** 按钮里的文字那一截（图标之外的部分） */
function labelSpan(text) {
	const span = document.createElement("span");
	span.textContent = text;
	return span;
}

/** 一行 diff：两个行号 + 符号 + 内容；`+` / `-` 行整行着色 */
function diffRow(line) {
	const row = document.createElement("div");
	row.className = "lkx-history-line";
	// 没有行号的一侧留空位，保持各列对齐。
	const old = document.createElement("span");
	old.className = "lkx-history-old";
	old.textContent = line.oldLine ?? "";
	const fresh = document.createElement("span");
	fresh.className = "lkx-history-new";
	fresh.textContent = line.newLine ?? "";
	const sign = document.createElement("span");
	sign.className = "lkx-history-sign";
	sign.textContent = line.tag ?? " ";
	const text = document.createElement("span");
	text.className = "lkx-history-text";
	text.textContent = line.text ?? "";
	if (line.tag === "+") {
		row.classList.add("lkx-history-add");
	} else if (line.tag === "-") {
		row.classList.add("lkx-history-del");
	}
	row.append(old, fresh, sign, text);
	return row;
}

/** 一行提示文字 */
function noteNode(text) {
	const div = document.createElement("div");
	div.className = "lkx-history-note";
	div.textContent = text;
	return div;
}

/** 面板里的状态行，空字符串即隐藏 */
function setNote(text) {
	if (status === null) {
		return;
	}
	status.textContent = text;
	status.hidden = text === "";
}
