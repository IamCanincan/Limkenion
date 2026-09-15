/*
 * 跨会话全文搜索。
 *
 * GET /api/search，结果点开可跳到对应会话。
 *
 * 形态照命令面板（⌘K / VS Code 快速打开）的约定来，不自己发明：顶部居中的浮层、边输边搜、
 * 上下键选、回车打开。用户对这套交互已有肌肉记忆，另起一套只会让人先学一遍怎么用。
 *
 * 入口只有一个：顶部应用栏右侧那个「⌕ 搜索」。它原先插在侧栏头部（把「新建」和搜索包成一组），
 * 但侧栏头部只该有品牌与「新建」，多一个按钮就把品牌挤歪——顶部栏才是各功能共用的入口区。
 *
 * 约定：DOM 与样式都由本模块自己创建（注入 <style>），不要改 index.html 与 app.css——
 * 这样多个功能并行开发时不会互相冲突。
 */

import { api } from "./api.js";
import { addTopBarAction } from "./features.js";
import { formatTime, shortenPath } from "./format.js";

/**
 * 本模块的样式；用一次就够。
 *
 * 全部用 `lks-` 前缀：功能模块的样式是运行时注入的，短类名（.search、.item）会和 app.css
 * 或别的模块撞车，撞了之后表现是「主题一换就串色」这种很难查的问题。
 * 颜色一律取自 app.css 里已有的 CSS 变量，深浅色主题才能跟着一起变。
 */
export const STYLE = /* css */ `
/*
 * 顶部栏入口：外形由外壳的 .lk-topbar-item 给，这里只补「面板开着」时的高亮。
 * 类名仍然带 lks- 前缀，免得与别的模块或 app.css 撞车。
 */
.lks-search-action[aria-expanded="true"] {
	background: var(--accent-soft);
	color: var(--accent-text);
}

/*
 * 遮罩：点它关闭。与 app.css 的 .modal 同一套做法（fixed 铺满 + 模糊背景）。
 * 浮层自己带遮罩，是因为它挂在 body 上而不是侧栏里。
 */
.lks-search-overlay {
	position: fixed;
	inset: 0;
	z-index: 60;
	display: flex;
	justify-content: center;
	align-items: flex-start;
	/* 距顶约 13vh：既不像弹窗那样吊在正中，也不会贴到浏览器地址栏。 */
	padding: 13vh 16px 16px;
	background: rgba(11, 14, 20, 0.38);
	backdrop-filter: blur(16px) saturate(130%);
	-webkit-backdrop-filter: blur(16px) saturate(130%);
}

.lks-search-panel {
	display: flex;
	flex-direction: column;
	width: min(600px, 100%);
	max-height: min(60vh, 520px);
	border: 1px solid var(--border);
	border-radius: var(--radius-lg);
	background: var(--surface-4);
	box-shadow: var(--shadow-lg);
	overflow: hidden;
}

/* 输入框直接坐在浮层顶部：面板打开就能打字，不该再多一次「确认」 */
.lks-search-input {
	width: 100%;
	padding: 14px 18px;
	border: none;
	border-bottom: 1px solid var(--border);
	background: transparent;
	color: var(--text);
	font: inherit;
	font-size: var(--text-md);
}
.lks-search-input:focus {
	outline: none;
}
.lks-search-input::placeholder {
	color: var(--muted);
}

.lks-search-results {
	display: flex;
	flex-direction: column;
	padding: 6px;
	/* min-height: 0 才能让它在 max-height 到达时真的滚动，而不是把底栏挤出面板 */
	min-height: 0;
	overflow-y: auto;
}

.lks-search-item {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	width: 100%;
	padding: 8px 10px;
	border: none;
	/* 与面板同心：外层 --radius-lg(28) − 列表留白 6px = 22 */
	border-radius: calc(var(--radius-lg) - 6px);
	background: transparent;
	color: var(--text);
	font: inherit;
	text-align: left;
	cursor: pointer;
}
/* 选中项（鼠标悬停或上下键）要有明确底色，否则不知道回车会打开哪条 */
.lks-search-item:hover,
.lks-search-item.selected {
	background: var(--surface-2);
}

.lks-search-time {
	flex: 0 0 auto;
	color: var(--muted);
	font-size: var(--text-xs);
}

.lks-search-role {
	flex: 0 0 auto;
	color: var(--accent-text);
	font-size: var(--text-xs);
	font-weight: 600;
}

.lks-search-snippet {
	flex: 1;
	min-width: 0;
	font-size: var(--text-sm);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.lks-search-snippet mark {
	padding: 0 1px;
	border-radius: 3px;
	background: var(--accent-soft);
	color: var(--accent-text);
}

/* 会话路径单独一列：宽浮层里它比片段更能说明「这条来自哪」。
   压到窄窄一条，末段（文件名）仍看得见，又不会把片段挤没。 */
.lks-search-path {
	flex: 0 0 auto;
	max-width: 26%;
	overflow: hidden;
	color: var(--muted);
	font-size: var(--text-xs);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.lks-search-empty {
	padding: 14px 12px;
	color: var(--muted);
	font-size: var(--text-sm);
}

/* 底栏：左边快捷键提示，右边小转圈与条数——请求中只转这一小块，不遮整屏 */
.lks-search-foot {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	padding: 8px 14px;
	border-top: 1px solid var(--border);
	border-bottom-left-radius: var(--radius-lg);
	border-bottom-right-radius: var(--radius-lg);
	background: var(--surface-3);
	color: var(--muted);
	font-size: var(--text-xs);
}

.lks-search-status {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

/* 搜索中：一个静态的 ◐（与终端面板、状态行同一套符号）。**不做转圈动画**——本仓库明确「不加动画」。 */
.lks-search-spinner {
	color: var(--accent-text);
	font-size: var(--text-sm);
}
.lks-search-spinner::before {
	content: "◐";
}
`;

/** 按钮与浮层挂进 DOM 后才有值；用 let 是因为 init() 之前它们不存在 */
let button = null;
let overlay = null;
let input = null;
let status = null;
let spinner = null;
let results = null;

/** 当前结果（已画在列表里的顺序），上下键与回车都按它取条目 */
let hits = [];

/** 选中项下标；-1 表示没有选中 */
let selected = -1;

/** 输入防抖用的定时器；每次输入都重排，避免每个字符都扫一遍全部会话 */
let timer = null;

/**
 * 请求令牌：改词、关面板都会 +1。
 *
 * 搜索是异步的，慢的那次（旧关键词）可能后回来；只认「最后一次请求」才不会把新结果盖成旧的。
 */
let token = 0;

/** 一次最多要多少条：与服务端的 100 上限对齐，多了它也只会截断 */
const MAX_HITS = 100;

/**
 * 角色转中文标签。
 *
 * 会话里的 role 是协议字段（user / assistant / tool），直接摆在结果里读不出「谁说的」。
 */
function roleLabel(role) {
	if (role === "user") {
		return "用户";
	}
	if (role === "assistant") {
		return "助手";
	}
	if (role === "tool") {
		return "工具";
	}
	return role;
}

/**
 * 把片段拆成「命中词」与普通文本，命中词交给 <mark> 上底色。
 *
 * 服务端的片段按窗口截断，命中词可能被截在窗口外——那种情况整段当普通文本画，
 * 不做位置猜测，免得标错地方。
 */
function decorate(snippet, query) {
	const flat = snippet.replace(/\s+/g, " ");
	const at = flat.toLowerCase().indexOf(query.toLowerCase());
	if (at < 0) {
		return [document.createTextNode(flat)];
	}
	const parts = [document.createTextNode(flat.slice(0, at))];
	const mark = document.createElement("mark");
	mark.textContent = flat.slice(at, at + query.length);
	parts.push(mark, document.createTextNode(flat.slice(at + query.length)));
	return parts;
}

/** 画一条结果：一行内给出时间 · 角色 · 片段，末尾补会话路径 */
function renderHit(hit, query) {
	const item = document.createElement("button");
	item.type = "button";
	item.className = "lks-search-item";

	const time = document.createElement("span");
	time.className = "lks-search-time";
	// createdAt 缺失时 formatTime 返回空串，那就退到「第几行」这个更稳定的定位。
	time.textContent = formatTime(hit.createdAt) || `第 ${hit.line} 行`;

	const role = document.createElement("span");
	role.className = "lks-search-role";
	role.textContent = roleLabel(hit.role);

	const snippet = document.createElement("span");
	snippet.className = "lks-search-snippet";
	// 片段已被服务端按窗口截断（首尾带 …），这里只负责单行省略。
	snippet.append(...decorate(hit.snippet, query));

	const path = document.createElement("span");
	path.className = "lks-search-path";
	// 完整路径会把片段挤没；只留末段，完整路径放 title。
	path.textContent = shortenPath(hit.file, 1);
	path.title = hit.file;

	item.append(time, role, snippet, path);
	item.addEventListener("click", () => void openHit(hit));
	item.addEventListener("mousemove", () => select(items.indexOf(item)));
	return item;
}

/** 结果列表里的条目，顺序与 hits 一致 */
let items = [];

/** 高亮第 index 条并滚进可视区；鼠标与上下键共用 */
function select(index) {
	if (index < 0 || index >= items.length) {
		return;
	}
	items[selected]?.classList.remove("selected");
	selected = index;
	const item = items[selected];
	item.classList.add("selected");
	// 上下键选到列表外面时把它带回来；nearest 让已经可见的条目不要跳。
	item.scrollIntoView({ block: "nearest" });
}

/** 用结果整体替换列表 */
function renderResults(list, query) {
	items = [];
	selected = -1;
	results.replaceChildren();
	if (list.length === 0) {
		const empty = document.createElement("div");
		empty.className = "lks-search-empty";
		empty.textContent = "没有找到匹配的内容";
		results.append(empty);
		return;
	}
	for (const hit of list.slice(0, MAX_HITS)) {
		const item = renderHit(hit, query);
		items.push(item);
		results.append(item);
	}
	// 默认选中第一条：输入完直接回车就是「打开最相关的一条」，不用先按一下下。
	select(0);
}

/**
 * 点结果 / 回回车 → 切到那条会话。
 *
 * selectSession 必须动态 import：sessions.js 在 app.js 的启动路径上，静态引它会把
 * 本模块也拖进那条路径（功能模块之间不该有启动顺序依赖），而且这里只用一次。
 *
 * 搜索扫的是所有工作目录，当前目录的会话列表里未必有这条：先刷一遍列表，
 * 刷完还是找不到就说明它属于别的工作目录——那种情况切不过去，如实说出来，
 * 不能让用户点了没反应。
 */
async function openHit(hit) {
	close();
	if (!hit.sessionId) {
		setStatus("这条记录没有会话 id，无法跳转");
		return;
	}
	try {
		const data = await api("/api/sessions");
		const { selectSession } = await import("./sessions.js");
		if (Array.isArray(data.sessions) && data.sessions.some((session) => session.id === hit.sessionId)) {
			selectSession(hit.sessionId);
			return;
		}
		setStatus("这条会话属于其它工作目录，切换目录后才能打开");
	} catch (error) {
		setStatus(`跳转失败：${error.message}`);
	}
}

/** 发起一次搜索 */
async function search(query) {
	token += 1;
	const mine = token;
	setBusy(true);
	try {
		const data = await api(`/api/search?q=${encodeURIComponent(query)}&limit=${MAX_HITS}`);
		if (mine !== token) {
			return;
		}
		hits = Array.isArray(data.hits) ? data.hits : [];
		setStatus(`命中 ${hits.length} 条`);
		renderResults(hits, query);
	} catch (error) {
		if (mine !== token) {
			return;
		}
		hits = [];
		renderResults([], query);
		setStatus(`搜索失败：${error.message}`);
	} finally {
		if (mine === token) {
			setBusy(false);
		}
	}
}

/** 输入变化：250ms 内没有新输入才真的发请求 */
function onInput() {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
	const query = input.value.trim();
	if (query === "") {
		// 空关键词服务端会回 400，没必要发；这里同时把上一次的结果与请求作废。
		token += 1;
		hits = [];
		renderResults([], "");
		setStatus("输入关键词，搜索所有会话");
		return;
	}
	timer = setTimeout(() => {
		timer = null;
		void search(query);
	}, 250);
}

/** 上下键选条目 */
function move(step) {
	if (items.length === 0) {
		return;
	}
	// 没选中时从列表头/尾进入，而不是原地不动。
	if (selected < 0) {
		select(step > 0 ? 0 : items.length - 1);
		return;
	}
	// 到头就停住：命令面板里循环最让人迷失位置。
	select(Math.min(items.length - 1, Math.max(0, selected + step)));
}

/** 打开浮层 */
function open() {
	overlay.hidden = false;
	button.setAttribute("aria-expanded", "true");
	input.focus();
	input.select();
}

/** 关闭浮层，并作废在途请求：关掉之后回来的结果不该再画进隐藏的浮层 */
function close() {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
	token += 1;
	setBusy(false);
	overlay.hidden = true;
	button.setAttribute("aria-expanded", "false");
}

function toggle() {
	if (overlay.hidden) {
		open();
	} else {
		close();
	}
}

/** 底栏文案 */
function setStatus(text) {
	status.textContent = text;
}

/** 转圈只出现在底栏右下角；请求期间不遮输入框，用户可以接着改词 */
function setBusy(busy) {
	spinner.hidden = !busy;
}

/** 初始化：注册顶部栏入口、建浮层、绑事件 */
export function init() {
	const style = document.createElement("style");
	style.textContent = STYLE;
	document.head.append(style);

	/*
	 * 入口放顶部应用栏，不再插进侧栏头部：那里只有品牌与「新建」两个元素，
	 * 塞进第三个按钮既挤又把品牌顶偏。顶部栏是外壳给所有功能的共享位置，各功能只注册。
	 */
	button = addTopBarAction({
		symbol: "⌕",
		label: "搜索",
		title: "搜索历史会话（Ctrl+K）",
		onClick: toggle,
	});
	if (button === null) {
		return;
	}
	button.classList.add("lks-search-action");
	button.setAttribute("aria-expanded", "false");
	// 窄屏下只留 ⌕（见 shell.js 里那条媒体查询）：顶栏是内嵌药丸条，五个入口挤不下
	button.dataset.lkCompact = "1";

	overlay = document.createElement("div");
	overlay.className = "lks-search-overlay";
	overlay.hidden = true;

	const panel = document.createElement("div");
	panel.className = "lks-search-panel";
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-modal", "true");
	panel.setAttribute("aria-label", "搜索会话");

	input = document.createElement("input");
	input.type = "text";
	input.className = "lks-search-input";
	input.placeholder = "搜索所有会话的内容…";
	input.spellcheck = false;
	input.autocomplete = "off";
	input.setAttribute("aria-label", "搜索关键词");

	results = document.createElement("div");
	results.className = "lks-search-results";

	const foot = document.createElement("div");
	foot.className = "lks-search-foot";
	const hint = document.createElement("span");
	hint.textContent = "↑↓ 选择 · Enter 打开 · Esc 关闭";
	// 转圈与文案是两个节点：转圈在请求期间单独开关，不会把文案一起清掉。
	spinner = document.createElement("span");
	spinner.className = "lks-search-spinner";
	spinner.hidden = true;
	status = document.createElement("span");
	// 用 aria-live 播报条数：浮层是可视化的，读屏用户不该只能靠数条目。
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	const statusBox = document.createElement("span");
	statusBox.className = "lks-search-status";
	statusBox.append(spinner, status);
	foot.append(hint, statusBox);

	panel.append(input, results, foot);
	overlay.append(panel);
	// 挂 body 而不是侧栏：侧栏有 overflow，浮层会被裁掉。
	document.body.append(overlay);

	input.addEventListener("input", onInput);
	input.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			move(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			move(-1);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const hit = hits[selected];
			if (hit) {
				void openHit(hit);
			}
			return;
		}
		if (event.key === "Escape") {
			close();
		}
	});

	// 点遮罩关闭；点浮层里面不算（面板自己会 stopPropagation 太绕，直接判断来源）。
	overlay.addEventListener("click", (event) => {
		if (!panel.contains(event.target)) {
			close();
		}
	});

	// Esc 关闭：与 picker / settings 用同一种做法（全局监听 + 只在打开时生效）。
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !overlay.hidden) {
			close();
		}
	});

	setStatus("输入关键词，搜索所有会话");
}
