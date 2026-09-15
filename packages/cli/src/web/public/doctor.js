/*
 * 环境体检面板。
 *
 * 命令行早有 `limkenion doctor`；网页一直没有对应的东西，而「连不上、为什么」正是用户盯着
 * 浏览器界面时最想问的那一句话。这里把同一套检查（服务端 GET /api/doctor）画成一列结论。
 *
 * 与命令行逐行一致：同样的符号（✓ 正常 / ! 警告 / ✗ 失败）、同样的顺序、同样的 detail 原文。
 * 不在这里重新判断任何一项——检查全在服务端的纯函数里跑，两端因此不会给出两种结论。
 *
 * 样式只取 app.css 的 MD3 角色变量与排版 token（--surface-*、--text/-soft、--muted、--border、
 * --ok/--danger/--warn、--radius-*、--text-*、--space-*），不写死颜色、不加动画；
 * DOM 与 <style> 由本模块自己建，类名统一 lkdo- 前缀，不动 index.html 与 app.css。
 *
 * 符号用 ●：AGENTS.md 那套固定符号集里没有蛇杖之类的图形符号，● 在这里表示「状态/结果」，
 * ▤ 归文件、⌕ 归搜索。面板里只有「重新检查」用 ↺，与「回滚」同符同义（重新跑一遍）。
 *
 * 长 detail 必须折行：路径、错误码、代理说明都可能很长，面板只有 400px 宽，横着撑出去会顶破布局；
 * 换行交给 word-break，纵向滚动交给 .lkdo-rows。
 */

import { api } from "./api.js";
import { addPanelTab } from "./features.js";
import { icon } from "./icons.js";
import { state as app } from "./state.js";

/** 体检端点 */
const DOCTOR_PATH = "/api/doctor";

/** 面板标签页的 id */
const PANEL_ID = "doctor";

/** 状态对应的**图标名**（命令行那边是文字符号 ✓ ! ✗，这里换成同一套线性图标） */
// 状态标记用图标（✓ ! ✗ 三个文字符号的字形大小与基线各不相同）
const STATUS_MARK = { ok: "check", warn: "warn", fail: "close" };

/** 本模块的样式；用一次就够 */
const STYLE = /* css */ `
.lkdo-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-width: 0;
	min-height: 0;
	gap: var(--space-2);
	/* 根块不铺底、也就不需要圆角：面板体（--surface-glass-strong）就是它这一层表面，
	   再叠一层同色系的底会变成「面板里套卡、卡里再套卡」（使用者反馈过这个）。 */
	color: var(--text);
}

/* 头部：一行「● 环境体检」+ 版本，下面一行打码前也照原样显示的安装路径。
   用户来问「为什么连不上」时，先要知道自己在哪一版、哪一个目录上。 */
.lkdo-head {
	flex: 0 0 auto;
	min-width: 0;
}
.lkdo-title {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	font-size: var(--text-sm);
	/* 小标题：与设置面板的卡片标题同一套（--text-sm + 600 + 正文色） */
	font-weight: 600;
	color: var(--text);
}
.lkdo-head .lkdo-glyph {
	flex: 0 0 auto;
	color: var(--accent-text);
}
.lkdo-version {
	/* 说明行：把字重压回 400，别继承小标题那档 600（它就挂在小标题那一行里） */
	font-weight: 400;
	color: var(--muted);
	font-size: var(--text-xs);
}
/* 安装路径：可能很长，两行封顶后省略号——它只是给人认位置的，不该把结论区挤走 */
.lkdo-path {
	margin-top: 2px;
	color: var(--muted);
	font-size: var(--text-xs);
	line-height: 1.4;
	overflow-wrap: anywhere;
	word-break: break-all;
}

/* 工具条：左边汇总一句话，右边「重新检查」。 */
.lkdo-bar {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	flex: 0 0 auto;
	min-width: 0;
}
.lkdo-summary {
	min-width: 0;
	color: var(--text-soft);
	font-size: var(--text-sm);
	/* 一行汇总，太长就省略；它只有三个数字，正常不会省略 */
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}
/* 图例：一行「✓ 正常 · ! 警告 · ✗ 失败」，符号的含义不必悬停去猜 */
.lkdo-legend {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	flex: 0 0 auto;
	padding: 2px 0;
	color: var(--muted);
	font-size: var(--text-xs);
}
.lkdo-legend-item {
	display: inline-flex;
	align-items: center;
	gap: 4px;
}
.lkdo-legend-ok .lkdo-mark {
	color: var(--ok);
}
.lkdo-legend-warn .lkdo-mark {
	color: var(--warn);
}
.lkdo-legend-fail .lkdo-mark {
	color: var(--danger);
}

.lkdo-action {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	flex: 0 0 auto;
	margin-left: auto;
	padding: 4px 12px;
	border: 1px solid var(--border);
	border-radius: var(--radius-pill);
	background: transparent;
	color: var(--text-soft);
	font: inherit;	font-size: var(--text-xs);
	cursor: pointer;
}
.lkdo-action:hover:not(:disabled) {
	background: var(--surface-3);
	color: var(--text);
}
.lkdo-action:disabled {
	opacity: 0.55;
	cursor: default;
}

/* 结论区：吃掉剩余高度，自己纵向滚动。检查项十几条，窄屏下一定放不下。 */
.lkdo-rows {
	display: flex;
	flex-direction: column;
	flex: 1 1 0;
	min-width: 0;
	min-height: 0;
	gap: var(--space-1);
	/* 不额外留白：行与面板体之间只隔一层 16px，同心半径才落到 15 而不是 7（更耐看） */
	padding: 0;
	overflow: auto;
	/* 列表容器不铺底、不描边：每一行自己就是一张卡，容器再套一层框就成了「卡里套卡」 */
	border-radius: var(--radius-md);
}

/* 一行结论：符号 + 名称 + detail。符号与名称各占固定一小块，detail 吃掉剩下的宽度并折行。 */
.lkdo-row {
	display: flex;
	align-items: flex-start;
	gap: var(--space-1);
	min-width: 0;
	padding: var(--space-1);
	border-radius: var(--radius-sm);
	border-left: 3px solid transparent;
}
.lkdo-mark {
	flex: 0 0 auto;
	width: 14px;
	font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
	font-size: var(--text-sm);
	line-height: 1.5;
	text-align: center;
}
.lkdo-name {
	flex: 0 0 auto;
	min-width: 4.5em;
	color: var(--text);
	font-size: var(--text-sm);
	line-height: 1.5;
}
/* detail 是这一行的正文：长路径与错误说明必须折行，否则会顶破 400px 的面板 */
.lkdo-detail {
	flex: 1 1 auto;
	min-width: 0;
	color: var(--text-soft);
	font-size: var(--text-sm);
	line-height: 1.5;
	/* 中文没有空格可断，长英文路径与错误码也没有：两样都要能断 */
	overflow-wrap: anywhere;
	word-break: break-word;
	white-space: normal;
}

/* 正常：安静的一行，符号用成功色，别让十几条 ok 抢视线 */
.lkdo-row.ok .lkdo-mark {
	color: var(--ok);
}
/* 警告：黄符号 + 淡底色，扫一眼就能挑出「要动手但没坏」的那几条 */
.lkdo-row.warn {
	background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.lkdo-row.warn .lkdo-mark {
	color: var(--warn);
}
/* 失败：红符号 + 红左边条 + 淡底色，是整块面板里最重的信号 */
.lkdo-row.fail {
	background: color-mix(in srgb, var(--danger) 12%, transparent);
	border-left-color: var(--danger);
}
.lkdo-row.fail .lkdo-mark {
	color: var(--danger);
}
.lkdo-row.fail .lkdo-detail {
	color: var(--text);
}

/* 加载中 / 出错时的单行说明 */
.lkdo-note {
	padding: var(--space-2);
	color: var(--muted);
	font-size: var(--text-sm);
}
.lkdo-note.fail {
	color: var(--danger);
	background: color-mix(in srgb, var(--danger) 12%, transparent);
	border-radius: var(--radius-sm);
}
`;

/** 面板根节点；build 之前为 null */
let panel = null;

/** 汇总那一行 */
let summaryNode = null;

/** 结论区：唯一被替换内容的地方 */
let rowsNode = null;

/** 安装路径那一行 */
let pathNode = null;

/** 头部那一块：版本号 + 安装路径，两者都来自服务端响应 */
let versionNode = null;

/** 「重新检查」按钮：请求在飞的时候禁用，避免连点出一串并发探测 */
let buttonNode = null;

/** 初始化：注册右侧面板标签页 */
export function init() {
	injectStyle();
	addPanelTab({ id: PANEL_ID, symbol: "●", label: "体检", build: buildPanel, order: 50 });

	/*
	 * 会话换了就把这一格换成新会话那一份（结论行 + 汇总那句）：使用者「旧的输入输出应该存在旧会话，
	 * 新会话输入输出存在新会话」。没跑过的会话先摆一句「点重新检查」——体检会探测一次接口可达性，
	 * 不在切会话时悄悄发请求。
	 */
	document.addEventListener("lk:session-changed", (event) => {
		swapPanes(event.detail?.current ?? "");
	});
}

/**
 * 每个会话各留一份体检面板：结论行与汇总那句。
 *
 * 体检结果是「跑的那一刻」的快照，按会话各留一份之后，来回切会话还能看到各自那一次跑出来的结论。
 */
const panes = new Map();

/** 当前显示的这一份属于哪个会话 */
let paneKey = "";

function savePane() {
	if (rowsNode === null) {
		return;
	}
	panes.set(paneKey, { rowsHtml: rowsNode.innerHTML, summary: summaryNode.textContent });
}

function loadPane() {
	if (rowsNode === null) {
		return;
	}
	const saved = panes.get(paneKey);
	if (saved === undefined) {
		summaryNode.textContent = "这个会话还没检查过";
		rowsNode.replaceChildren(note("点右上角「重新检查」按当前工作目录跑一遍。"));
		return;
	}
	summaryNode.textContent = saved.summary;
	rowsNode.innerHTML = saved.rowsHtml;
}

function swapPanes(key) {
	if (rowsNode === null || key === paneKey) {
		return;
	}
	savePane();
	paneKey = key;
	loadPane();
}

/** 注入本模块的样式；重复调用只注入一次 */
function injectStyle() {
	if (document.getElementById("lkdo-style")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "lkdo-style";
	style.textContent = STYLE;
	document.head.append(style);
}

/** 建面板：头部（版本 + 安装路径）+ 工具条（汇总 + 重新检查）+ 结论区 */
function buildPanel(container) {
	container.classList.add("lkdo-panel");

	const head = document.createElement("div");
	head.className = "lkdo-head";
	const title = document.createElement("div");
	title.className = "lkdo-title";
	const glyph = document.createElement("span");
	glyph.className = "lkdo-glyph";
	glyph.textContent = "";
	glyph.append(icon("dot", 9));
	const label = document.createElement("span");
	label.textContent = "环境体检";
	versionNode = document.createElement("span");
	versionNode.className = "lkdo-version";
	title.append(glyph, label, versionNode);
	pathNode = document.createElement("div");
	pathNode.className = "lkdo-path";
	pathNode.textContent = "正在读取版本与安装路径…";
	head.append(title, pathNode);

	const bar = document.createElement("div");
	bar.className = "lkdo-bar";
	summaryNode = document.createElement("span");
	summaryNode.className = "lkdo-summary";
	summaryNode.textContent = "检查中…";
	buttonNode = document.createElement("button");
	buttonNode.type = "button";
	buttonNode.className = "lkdo-action";
	buttonNode.textContent = "";
	buttonNode.append(icon("refresh", 14));
	const rerunLabel = document.createElement("span");
	rerunLabel.textContent = "重新检查";
	buttonNode.append(rerunLabel);
	buttonNode.title = "重新跑一遍全部检查（会探测一次接口可达性）";
	buttonNode.addEventListener("click", () => void load());
	bar.append(summaryNode, buttonNode);

	/*
	 * 图例：`✓ ! ✗` 的含义直接写出来。
	 *
	 * 逐行只看得到符号，而「!」是什么意思得悬停才知道——这跟模式弹层里把含义藏在 tooltip 里是同一类
	 * 毛病，所以给一行常驻图例，颜色之外也有字。
	 */
	const legend = document.createElement("div");
	legend.className = "lkdo-legend";
	for (const [status, meaning] of [
		["ok", "正常"],
		["warn", "警告"],
		["fail", "失败"],
	]) {
		const item = document.createElement("span");
		item.className = `lkdo-legend-item lkdo-legend-${status}`;
		const mark = document.createElement("span");
		mark.className = "lkdo-mark";
		mark.textContent = "";
		mark.append(icon(STATUS_MARK[status], 13));
		const text = document.createElement("span");
		text.textContent = meaning;
		item.append(mark, text);
		legend.append(item);
	}

	rowsNode = document.createElement("div");
	rowsNode.className = "lkdo-rows";

	panel = container;
	panel.append(head, bar, legend, rowsNode);
	// 面板第一次建出来时属于当时那个会话（下面那次 load 的结论就记在它名下）
	paneKey = app.activeId ?? "";

	// 面板第一次显示时外壳才调用 build；这里直接拉一次，打开就有结论。
	void load();
}

/** 跑一次体检并重画 */
async function load() {
	buttonNode.disabled = true;
	summaryNode.textContent = "检查中…";
	rowsNode.replaceChildren(note("正在检查环境…"));
	try {
		const data = await api(DOCTOR_PATH);
		paint(data);
	} catch (error) {
		summaryNode.textContent = "检查失败";
		rowsNode.replaceChildren(note(`✗ ${error.message}`, "fail"));
	} finally {
		buttonNode.disabled = false;
	}
}

/** 画头部、汇总与逐行结论 */
function paint(data) {
	// 版本与安装路径都放在头部：来问「为什么连不上」的人，先要知道自己在哪一版、哪个目录上。
	versionNode.textContent = `${data.app ?? "limkenion"} ${data.version ?? "?"}`;
	pathNode.textContent = data.agentDir ?? "";
	pathNode.title = data.agentDir ?? "";

	const checks = Array.isArray(data.checks) ? data.checks : [];
	const summary = data.summary ?? {};
	// 汇总先按服务端给的数念；服务端没给（或字段缺失）时退回落回行数，宁可自己数也不要显示 undefined。
	const ok = summary.ok ?? checks.filter((check) => check.status === "ok").length;
	const warn = summary.warn ?? checks.filter((check) => check.status === "warn").length;
	const fail = summary.fail ?? checks.filter((check) => check.status === "fail").length;
	summaryNode.textContent = `${ok} 项正常 · ${warn} 警告 · ${fail} 失败`;

	rowsNode.replaceChildren();
	for (const check of checks) {
		rowsNode.append(row(check));
	}
	if (checks.length === 0) {
		rowsNode.append(note("没有任何检查项：服务端返回了空列表"));
	}
}

/** 画一行结论：符号 + 名称 + detail */
function row(check) {
	const status = check.status === "warn" || check.status === "fail" ? check.status : "ok";
	const line = document.createElement("div");
	line.className = `lkdo-row ${status}`;

	const mark = document.createElement("span");
	mark.className = "lkdo-mark";
	// STATUS_MARK 存的是**图标名**（check / warn / close），这里要放图标而不是文字——
	// 少改这一处就会把 "check" 当文字画出来，被列宽截成 "che" 压在名字上（踩过）
	mark.textContent = "";
	mark.append(icon(STATUS_MARK[status], 13));

	const name = document.createElement("span");
	name.className = "lkdo-name";
	name.textContent = check.name ?? "";

	const detail = document.createElement("span");
	detail.className = "lkdo-detail";
	detail.textContent = check.detail ?? "";

	line.append(mark, name, detail);
	return line;
}

/** 一行说明（加载中 / 出错 / 空列表） */
function note(text, className = "") {
	const line = document.createElement("div");
	line.className = className === "" ? "lkdo-note" : `lkdo-note ${className}`;
	line.textContent = text;
	return line;
}
