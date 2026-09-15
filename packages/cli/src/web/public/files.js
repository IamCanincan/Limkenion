/*
 * 文件树与内嵌查看/编辑。
 *
 * 列出工作目录、点开读写文件。
 *
 * 位置交给共享外壳（shell.js，由 features.js 转发）：本模块只在顶部栏注册一个动作、在右侧面板
 * 注册一个标签，不再自己造抽屉、按钮或 Esc 监听——位置统一，也不会去挤本来就不够用的侧栏与输入区。
 * 样式仍由本模块自己注入 <style>（类名统一 lkx- 前缀），不动 index.html 与 app.css。
 *
 * 交互照 VS Code 的资源管理器来，不自创一套：树上点三角展开、双击目录把树根挪进去、单击文件
 * 打开、当前文件用 --accent-soft 高亮、有未保存改动时打一个 ●、Ctrl/Cmd+S 保存。
 *
 * 配色与形状只取 app.css 里的 MD3 角色变量（--surface-1/2/3、--accent-soft、--accent-text、
 * --text、--text-soft、--muted、--border 与 --radius-*、--text-*、--space-*），不写死颜色，
 * 也不加动画：状态切换直接变。
 *
 * 导航状态只保存「相对工作目录的路径」：接口本来就以工作目录为基准解析相对路径，存相对值就不必
 * 在浏览器里拼盘符与分隔符，面包屑也能直接按路径分段。
 */

import { api } from "./api.js";
import { addPanelTab, closePanel, openPanel, panelOpen } from "./features.js";
import { shortenPath } from "./format.js";
import { icon } from "./icons.js";
import { state } from "./state.js";
import { setStatus } from "./ui.js";

/** 本模块的样式；用一次就够 */
export const STYLE = /* css */ `
.lkx-files {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	color: var(--text);
	font-size: var(--text-base);
}
/* 各段的显隐统一用 hidden 属性：app.css 里已有全局的 [hidden] { display: none !important } */
.lkx-crumbs {
	display: flex;
	flex: 0 0 auto;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1);
	/* 横向不留额外内边距：里面的面包屑按钮距面板内边正好 16px，圆角才好与面板同心。
	   纵向要让面包屑到上下**两条分隔线**的距离相等（使用者要求），而且取小的那个（4px）：
	     上 = 面板体留白 16 + 负外边距(-12) + 这里的上内边距(0) = 4
	     下 = 这里的下内边距 = 4
	   面板体的 16px 留白是给所有标签共用的，不能为这一行单独改，所以用负外边距抵掉 12px（不是 16）。 */
	margin-top: calc(-1 * var(--space-3));
	padding: 0 0 var(--space-1);
	border-bottom: 1px solid var(--border);
}
.lkx-crumb {
	max-width: 100%;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	padding: var(--space-1) var(--space-2);
	border: 0;
	/* 与面板同心：32 − 16 − 1 = 15 */
	border-radius: calc(var(--radius-xl) - var(--space-4) - 1px);
	background: transparent;
	color: var(--accent-text);
	font: inherit;
	font-size: var(--text-xs);
	cursor: pointer;
}
.lkx-crumb:hover:not(:disabled) {
	background: var(--surface-3);
}
.lkx-crumb.current {
	color: var(--text);
	font-weight: 600;
	cursor: default;
}
.lkx-sep {
	color: var(--muted);
	font-size: var(--text-xs);
}
.lkx-tree {
	flex: 1 1 auto;
	min-height: 120px;
	/* 不留额外内边距：行因此正好距面板内边 16px，圆角才好与面板同心（32 − 16 − 1 = 15） */
	padding: 0;
	overflow: auto;
}
.lkx-row {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	min-height: 26px;
	padding: 0 var(--space-1);
	/* 与面板同心：32 − 16 − 1 = 15 */
	border-radius: calc(var(--radius-xl) - var(--space-4) - 1px);
	color: var(--text);
	cursor: pointer;
}
.lkx-row:hover:not(.selected) {
	background: var(--surface-3);
}
/* 当前打开的文件：MD3 的选中态就是 accent 色调的容器色 */
.lkx-row.selected {
	background: var(--accent-soft);
}
.lkx-row.selected .lkx-name {
	color: var(--accent-text);
}
/* 未保存符号：与编辑器标题旁同一个 ●，全项目同一含义用同一个符号 */
.lkx-row.dirty::after {
	content: "●";
	flex: 0 0 auto;
	color: var(--accent-text);
	font-size: var(--text-xs);
}
.lkx-twisty {
	flex: 0 0 auto;
	width: 12px;
	color: var(--muted);
	font-size: var(--text-xs);
	text-align: center;
}
.lkx-twisty:hover {
	color: var(--accent-text);
}
/* 类型标识只是两个弱化的字母：不给每个文件套圆角框，行里也不该有第二个视觉重心 */
.lkx-tag {
	flex: 0 0 auto;
	width: 20px;
	padding: 0;
	background: transparent;
	color: var(--muted);
	font-size: var(--text-xs);
	text-align: center;
	text-transform: uppercase;
}
.lkx-name {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	font-family: var(--font-mono);
	font-size: var(--text-base);
}
.lkx-row.dir .lkx-name {
	font-weight: 600;
}
.lkx-size {
	flex: 0 0 auto;
	color: var(--muted);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}
.lkx-empty {
	padding: var(--space-3);
	color: var(--muted);
	font-size: var(--text-xs);
	text-align: center;
}
.lkx-file {
	display: flex;
	flex: 1 1 auto;
	flex-direction: column;
	/* 默认高度：文件树内容多的时候（没有剩余空间可平分）这一块就停在最小值上，所以这个数就是
	   「打开文件时编辑区有多高」（使用者：「默认高度调高点」）。与 JS 里的 EDITOR_MIN_HEIGHT 一致。 */
	min-height: 240px;
	/* 与文件树之间那条分隔线由拖柄自己画（见 .lkx-file-resize）：线就是抓取处，两者重合 */
}
/* 拖过高度之后就不再平分剩余空间，按拖出来的像素站着 */
.lkx-file.sized {
	flex: 0 0 auto;
}
/* 上边缘那条拖柄：往下/往上拖改编辑区高度（编辑器在面板下半截，所以往上拖 = 变高）。
   与侧栏、预览那几条同一个做法——8px 的透明抓取区 + 2px 的线，悬停/聚焦/拖动时才亮。 */
.lkx-file-resize {
	flex: 0 0 auto;
	position: relative;
	height: 8px;
	/* 骑在上下两段的交界线上：一半在文件树那侧、一半在编辑区这侧，抓取区就以那条线为中心 */
	margin-top: -4px;
	cursor: ns-resize;
	touch-action: none;
}
/* 这条线**就是**分界线本身（所以 .lkx-file 不再自己画 border-top）：
   平时 1px 的 --border，与别的分隔线同粗；悬停 / 键盘聚焦 / 拖动时同一位置换成 2px 的强调色——
   线不动，只变色变粗，抓的地方与看到的线是同一处（使用者：「拉伸处应与分割线重合」）。 */
.lkx-file-resize::after {
	content: "";
	position: absolute;
	left: 0;
	right: 0;
	top: 3px;
	height: 1px;
	border-radius: var(--radius-pill);
	background: var(--border);
}
.lkx-file-resize:hover::after,
.lkx-file-resize:focus-visible::after,
.lkx-file-resize[data-dragging="1"]::after {
	height: 2px;
	background: var(--accent);
}
/* 键盘聚焦时就用那条 2px 的线表示，不要 app.css 给按钮准备的那圈 3px 轮廓：
   8px 高的横条外面套一圈带偏移的轮廓，看着像一个凭空多出来的粉色方框 */
.lkx-file-resize:focus-visible {
	outline: none;
}
.lkx-file-head {
	display: flex;
	flex: 0 0 auto;
	align-items: center;
	gap: var(--space-1);
	padding: var(--space-2) var(--space-3);
}
.lkx-file-path {
	display: flex;
	flex: 1;
	align-items: center;
	gap: var(--space-1);
	min-width: 0;
}
.lkx-file-name {
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	/* 编辑器标题（当前文件）：小标题那一档（--text-sm + 600 + 正文色），与设置卡片一致 */
	color: var(--text);
	font-weight: 600;
	font-family: var(--font-mono);
	font-size: var(--text-sm);
}
.lkx-dot {
	flex: 0 0 auto;
	color: var(--accent-text);
	font-size: var(--text-xs);
}
/* 图标按钮：外形照面板标签走，只把内边距收掉凑成方形 */
.lkx-icon {
	width: 28px;
	height: 28px;
	flex: 0 0 auto;
	padding: 0;
	border: none;
	border-radius: var(--radius-pill);
	background: transparent;
	color: var(--muted);
	font: inherit;
	font-size: var(--text-sm);
	cursor: pointer;
}
.lkx-icon:hover {
	background: var(--surface-3);
	color: var(--text);
}
.lkx-icon.primary {
	background: var(--accent-fill);
	color: var(--accent-on-fill);
}
.lkx-icon.primary:hover {
	background: var(--accent-fill-hover);
	color: var(--accent-on-fill);
}
.lkx-readonly {
	flex: 0 0 auto;
	/* 不留额外外边距：距面板内边 16px，与别的盒子一条线 */
	margin: 0 0 var(--space-2);
	padding: var(--space-2);
	/* 与面板同心：15 */
	border-radius: calc(var(--radius-xl) - var(--space-4) - 1px);
	background: var(--danger-soft);
	color: var(--danger);
	font-size: var(--text-xs);
}
/* 等宽 + wrap=off：长行横向滚动，不折行——折了就看不出真实的缩进结构。
   编辑区自己不描边：它整块坐在 --surface-2 上，行里不再多一层卡片 */
/*
 * 框：一块圆角描边的卡片，编辑区（连着它原生的两条滚动条）坐在里面的留白上（使用者：「文件预览的框要像
 * 图二一样」——就是这样一个圆角细边框的空框）。
 *
 * **留白是必须的**：原生滚动条贴着自己那条边画，不留白就会从圆角旁边戳出去。有了这圈 8px，滚动条永远
 * 在边框里面，也就不必再自绘滑块（使用者：「横向的滑块删了吧，不用自绘滑块了」）。
 */
.lkx-editor-frame {
	position: relative;
	display: flex;
	flex: 1;
	flex-direction: column;
	min-height: 0;
	/* 与面板同心：32 − 16 − 1 = 15 */
	border: 1px solid var(--border);
	border-radius: calc(var(--radius-xl) - var(--space-4) - 1px);
	padding: var(--space-2);
}
.lkx-editor {
	flex: 1;
	min-height: 0;
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--text);
	font-family: var(--font-mono);
	font-size: var(--text-sm);
	line-height: 1.6;
	overflow: auto;
	resize: none;
	tab-size: 2;
	white-space: pre;
}
/* app.css 给所有可聚焦元素那圈 3px 强调色轮廓，这里要按掉：textarea 在 Chrome 里点一下也算
   :focus-visible，留着就等于换了个颜色的红框（宽度还更大）。 */
.lkx-editor:focus,
.lkx-editor:focus-visible {
	outline: none;
}
/*
 * 滚动条：横竖两条都是原生的，常显（使用者：「滑块不用默认不可见了」，随后又把横向那条要了回去：
 * 「文件预览的横向滑块还是加回去吧」）。滑块用 --scroll，悬停换 --scroll-hover；两条相交那一格
 * 涂透明（浏览器默认给白色，深色界面里非常跳）。
 */
.lkx-editor::-webkit-scrollbar-thumb {
	background: var(--scroll);
}
.lkx-editor::-webkit-scrollbar-thumb:hover {
	background: var(--scroll-hover);
}
.lkx-editor::-webkit-scrollbar-corner {
	background: transparent;
}
.lkx-editor[readonly] {
	color: var(--text-soft);
}
.lkx-note {
	flex: 0 0 auto;
	min-height: 16px;
	padding: var(--space-2) var(--space-3);
	border-top: 1px solid var(--border);
	color: var(--muted);
	font-size: var(--text-xs);
}
/* 编辑区开着的时候，它自己那圈框就是分界线：字数行这条上边框会从圆角旁边横着穿出去，
   看着像有一条线从框里漏出来（使用者：「线也出来了」）。编辑区收起时它照旧当分隔线用。 */
.lkx-file:not([hidden]) + .lkx-note {
	border-top: 0;
}
.lkx-note.error {
	color: var(--danger);
}
.lkx-note.ok {
	color: var(--ok);
}
`;

/** 服务端列目录的上限，与 feature-files.ts 的 MAX_ENTRIES 对齐；数量到顶时界面要提示可能还有更多 */
const MAX_ENTRIES = 500;

/** 树上每一层的缩进像素；行高 26px 与缩进 12px 照的是高密度列表（DSH 自己的会话列表就是这个量级） */
const INDENT = 12;

/** 编辑区拖柄的两头：最小高度与「文件树至少留多少」（与 .lkx-file / .lkx-tree 的 min-height 对齐） */
const EDITOR_MIN_HEIGHT = 240;
const TREE_MIN_HEIGHT = 120;

/** 面板里的节点；标签第一次显示时建一次，之后只改内容 */
const dom = {};

/** 建树时的工作目录；和 state.cwd 不一致就说明工作目录被换过，得从根重来 */
let anchoredCwd = null;

/** 树的根，相对工作目录（"" 就是工作目录本身） */
let currentDir = "";

/** 树根的绝对路径，只用来做 title 提示（面板只有 400px，行内放不下全路径） */
let currentAbs = "";

/** 已展开的目录（相对工作目录），只影响显示，不影响接口 */
const expanded = new Set();

/** 已载入的目录内容；展开过的目录收起来再展开就不必重新请求 */
const cache = new Map();

/** 每个目录被跳过的项数，和 cache 一起存：提示行要说「已隐藏 N 项」 */
const hiddenCount = new Map();

/** 跳过哪些名字，放在提示行的 title 里；正文只写数量，400px 的面板放不下这一串 */
const SKIP_HINT = "已跳过 .git、node_modules、dist、release";

/** 当前打开的文件，相对工作目录；"" 表示编辑器没开 */
let openPath = "";

/** 打开时的原文（换行已归一成 \n），用来判断有没有未保存的改动 */
let openText = "";

/** 打开或上次保存时服务端给的 mtime，保存时回传，用来发现「打开之后文件被外部改过」 */
let openMtimeMs = null;

/**
 * 原文件的换行风格。
 *
 * textarea 的 value 会把 CRLF 规整成 LF，照原样保存等于把整份 Windows 文件的行尾都改掉，
 * 在 git 里表现为「整个文件都变了」。所以原文里有 CRLF 时，保存时再换回去。
 */
let openCrlf = false;

/** 当前文件是否只读（二进制或已截断）：只读时不显示保存 */
let readOnly = false;

/** 树上当前文件那一行；未保存符号要打在它身上 */
let openRow = null;

/**
 * 每个会话各留一份编辑区。
 *
 * 使用者：「会话切换后……旧面板未保存的文件……都应保留」——切走时把这一份（路径、磁盘基线、未保存的
 * 正文、只读提示、换行风格、滚动位置）存起来，切回来再放回去，于是来回切不丢东西、也不会把 A 的文件
 * 摆到 B 的面板里。键用会话 id（还没建会话时是空串）。
 *
 * 树本身仍然跟着**工作目录**（这一格是「工作区浏览器」，换会话不动工作目录，见 sessions.js）。
 */
const editors = new Map();

/** 把当前编辑区截一张快照；没打开文件时返回 null */
function snapshotEditor() {
	if (openPath === "") {
		return null;
	}
	return {
		// 记下它属于哪个工作目录：路径是相对工作目录的，换过目录就不能照原样放回去了
		cwd: state.cwd,
		path: openPath,
		text: dom.editor.value,
		baseline: openText,
		mtimeMs: openMtimeMs,
		crlf: openCrlf,
		readOnly,
		readonlyNote: dom.readonlyNote.hidden ? "" : dom.readonlyNote.textContent,
		scrollTop: dom.editor.scrollTop,
		scrollLeft: dom.editor.scrollLeft,
	};
}

/** 把某一份快照放回编辑区；传 null（或那份快照属于别的工作目录）就收起编辑器 */
function restoreEditor(snapshot) {
	if (!snapshot || snapshot.cwd !== state.cwd) {
		resetEditor();
		renderCrumbs();
		renderTree();
		return;
	}
	openPath = snapshot.path;
	openText = snapshot.baseline;
	openMtimeMs = snapshot.mtimeMs;
	openCrlf = snapshot.crlf;
	readOnly = snapshot.readOnly;
	dom.editor.value = snapshot.text;
	dom.editor.readOnly = snapshot.readOnly;
	dom.editor.scrollTop = snapshot.scrollTop;
	dom.editor.scrollLeft = snapshot.scrollLeft;
	dom.pathText.textContent = shortenPath(absolutePath(snapshot.path), 2);
	dom.filePath.title = absolutePath(snapshot.path);
	dom.save.hidden = snapshot.readOnly;
	dom.readonlyNote.hidden = snapshot.readonlyNote === "";
	dom.readonlyNote.textContent = snapshot.readonlyNote;
	dom.file.hidden = false;
	renderCrumbs();
	renderTree();
	updateDirty();
}

/** 会话换了：把这一份存起来，换上对面那一份 */
function swapEditor(previous, next) {
	if (previous === next) {
		return;
	}
	const snapshot = snapshotEditor();
	if (snapshot === null) {
		editors.delete(previous);
	} else {
		editors.set(previous, snapshot);
	}
	restoreEditor(editors.get(next) ?? null);
}

/** 建元素的小工具：本模块的 DOM 全在这里造，不往 index.html 里加东西 */
function make(tag, className = "", text = "") {
	const node = document.createElement(tag);
	if (className !== "") {
		node.className = className;
	}
	if (text !== "") {
		node.textContent = text;
	}
	return node;
}

/** 图标按钮：符号 + title/aria-label。不引图标字体，符号本身就是全项目统一的那个 */
function iconButton(symbol, label, className = "lkx-icon") {
	const button = make("button", className, symbol);
	button.type = "button";
	button.title = label;
	button.setAttribute("aria-label", label);
	return button;
}

/** 保存快捷键的写法：macOS 上是 ⌘S，判断不出来就按 Windows 写 Ctrl+S */
function saveShortcut() {
	return /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? "") ? "⌘S" : "Ctrl+S";
}

/** 字节数压成人类可读文本，用在列表右侧那一列 */
function formatSize(bytes) {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)}KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 相对路径再拼一段。任何平台的目录名里都不含 `/`，所以用 `/` 拼是安全的 */
function joinPath(dir, name) {
	return dir === "" ? name : `${dir}/${name}`;
}

/** 把相对工作目录的路径翻成绝对路径，只用于 title 提示 */
function absolutePath(rel) {
	if (currentAbs === "") {
		return rel;
	}
	const rest = currentDir === "" ? rel : rel.slice(currentDir.length + 1);
	return `${currentAbs}/${rest}`;
}

/** 文件类型标识：扩展名前两个字母。不引图标库，类型靠字母方块认 */
function fileTag(name) {
	const dot = name.lastIndexOf(".");
	const ext = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
	return ext === "" ? "•" : ext.slice(0, 2);
}

/** 写底部说明行；kind 取 "" | "error" | "ok" 只管上色，title 给悬停看细节 */
function note(text, kind = "", title = "") {
	dom.note.textContent = text;
	dom.note.className = kind === "" ? "lkx-note" : `lkx-note ${kind}`;
	dom.note.title = title;
}

/** 编辑器内容和打开时的原文不同吗 */
function isDirty() {
	return openPath !== "" && !readOnly && dom.editor.value !== openText;
}

/** 刷新未保存标记：编辑器标题旁一个 ●，树上那一行末尾一个 */
function updateDirty() {
	const dirty = isDirty();
	dom.dot.hidden = !dirty;
	openRow?.classList.toggle("dirty", dirty);
}

/** 本模块的标签现在是不是正显示着：外壳收起面板时标签的 hidden 不变，所以要连面板一起问 */
function showing() {
	return panelOpen() && dom.root !== undefined && !dom.root.hidden;
}

/** 把样式插进 <head>；只插一次，重复初始化也不会叠两份 */
function injectStyle() {
	if (document.getElementById("lkx-files-style")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "lkx-files-style";
	style.textContent = STYLE;
	document.head.append(style);
}

/** 建出「面包屑 + 目录树 + 编辑区」三段。外壳给的容器**就是**本模块的根块 */
function buildPanel(container) {
	/*
	 * 外壳的容器直接当根块用（终端 / 评审 / 体检也是这么做的）：它挂在 `.lk-panel-body` 那个定高列里，
	 * `.lkx-files` 的 `height: 100%` 才算得出高度。自己再套一层子 div 的话，100% 落在「高度 auto」的
	 * 父级上等于没有——文件树与编辑区只按内容撑，面板下半截空着，拖柄也就没地方可拖（踩过）。
	 * 顺带把「标签切走了」这件事接回来：hidden 翻的是容器，挂在容器上才收得到。
	 */
	container.classList.add("lkx-files");
	const root = container;

	const crumbs = make("div", "lkx-crumbs");
	const tree = make("div", "lkx-tree");

	// 编辑区独立成一段：树上始终留着当前文件的高亮，所以不把树藏起来换成编辑态。
	const file = make("div", "lkx-file");
	file.hidden = true;
	// 上边缘的拖柄：拖它改编辑区高度（顺序上排在 head 之前，所以是「上边缘」）
	const resize = make("div", "lkx-file-resize");
	resize.tabIndex = 0;
	resize.setAttribute("role", "separator");
	resize.setAttribute("aria-orientation", "horizontal");
	resize.setAttribute("aria-label", "上下拖动改编辑区高度");
	resize.title = "上下拖动改编辑区高度；双击复位";
	const fileHead = make("div", "lkx-file-head");
	const filePath = make("span", "lkx-file-path");
	const dot = make("span", "lkx-dot");
	dot.append(icon("dot", 7));
	dot.hidden = true;
	const pathText = make("span", "lkx-file-name");
	filePath.append(dot, pathText);
	const collapse = iconButton("", "收起编辑器（不会写磁盘）");
	collapse.append(icon("close", 15));
	collapse.addEventListener("click", collapseEditor);
	const save = iconButton("", `保存（${saveShortcut()}）`, "lkx-icon primary");
	save.append(icon("check", 15));
	save.addEventListener("click", () => void saveFile());
	fileHead.append(filePath, collapse, save);
	const readonlyNote = make("div", "lkx-readonly");
	readonlyNote.hidden = true;
	// wrap=off 关掉软折行：长行横向滚，缩进结构才看得准。
	const editor = make("textarea", "lkx-editor");
	editor.wrap = "off";
	editor.readOnly = true;
	editor.spellcheck = false;
	editor.setAttribute("aria-label", "文件内容");
	editor.addEventListener("input", updateDirty);
	// 编辑区与两条自绘滚动条同住一个框里：聚焦时那一圈轮廓画在框上，滑块就永远在框内
	const editorFrame = make("div", "lkx-editor-frame");
	editorFrame.append(editor);
	file.append(resize, fileHead, readonlyNote, editorFrame);

	const noteLine = make("div", "lkx-note");
	root.append(crumbs, tree, file, noteLine);

	Object.assign(dom, {
		root,
		crumbs,
		tree,
		file,
		resize,
		filePath,
		pathText,
		dot,
		save,
		readonlyNote,
		editor,
		editorFrame,
		note: noteLine,
	});

	initEditorResize();

	// 外壳只翻标签容器的 hidden 来表示「切到了这个标签」，跟着它把树对齐到当前工作目录。
	new MutationObserver(() => {
		if (!root.hidden) {
			reanchor();
		}
	}).observe(root, { attributes: true, attributeFilter: ["hidden"] });

	// 工作目录在**面板开着的时候**被换掉（会话菜单里的「工作目录」）：光靠上面那个「重新显示时对一次」
	// 收不到，树会停在旧目录上。事件名与 session-list.js 里的 CWD_EVENT 一致。
	document.addEventListener("lk:cwd-changed", () => {
		if (!root.hidden) {
			reanchor();
		}
	});

	// 会话换了（点别的会话行）：这一格换成新会话那一份编辑区（旧的存起来，切回来还在）。
	// 事件名与 sessions.js 里的 SESSION_EVENT 一致。
	document.addEventListener("lk:session-changed", (event) => {
		const detail = event.detail ?? {};
		swapEditor(detail.previous ?? "", detail.current ?? "");
	});

	anchoredCwd = state.cwd;
	void loadDir("");
}

/**
 * 编辑区上边缘那条拖柄。
 *
 * 编辑区在面板下半截，所以往上拖是变高。高度只在这一次页面里有效（界面偏好一律不落盘，
 * 刷新即回默认），双击或按 Home 复位成「与文件树平分剩余空间」。
 * 上限按「文件树至少留 120px」算，和 `.lkx-tree` 的 min-height 是同一个数。
 */
function initEditorResize() {
	const handle = dom.resize;
	// 除文件树与编辑区之外，根块里其它东西占掉的高度（含外边距：面包屑上边那条 −12px 的负外边距同样占地方）
	const occupied = () => {
		let sum = 0;
		for (const node of [dom.crumbs, dom.note]) {
			const style = getComputedStyle(node);
			sum +=
				node.offsetHeight +
				Number.parseFloat(style.marginTop || "0") +
				Number.parseFloat(style.marginBottom || "0");
		}
		return sum;
	};
	// 上限 = 面板这一段的高度 − 其它东西 − 给文件树留的 120px（与 .lkx-tree 的 min-height 同一个数）
	const limit = () => Math.max(EDITOR_MIN_HEIGHT, dom.root.clientHeight - occupied() - TREE_MIN_HEIGHT);
	const apply = (height) => {
		dom.file.style.height = `${Math.round(Math.min(limit(), Math.max(EDITOR_MIN_HEIGHT, height)))}px`;
		dom.file.classList.add("sized");
	};
	const reset = () => {
		dom.file.style.removeProperty("height");
		dom.file.classList.remove("sized");
	};

	handle.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = dom.file.getBoundingClientRect().height;
		handle.setAttribute("data-dragging", "1");
		handle.setPointerCapture(event.pointerId);
		const move = (moveEvent) => {
			apply(startHeight + (startY - moveEvent.clientY));
		};
		const up = () => {
			handle.removeAttribute("data-dragging");
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up);
	});
	// 键盘跟着拖柄走：拖柄在编辑区**上**边，所以 ↑ 是变高
	handle.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
			return;
		}
		event.preventDefault();
		const step = event.key === "ArrowUp" ? 24 : -24;
		apply(dom.file.getBoundingClientRect().height + step);
	});
	handle.addEventListener("dblclick", reset);
}

/** 工作目录可能被切过（前端没有全局事件总线），重新显示时对一下，不一致就整棵重来 */
function reanchor() {
	if (anchoredCwd === state.cwd) {
		return;
	}
	anchoredCwd = state.cwd;
	// 换目录等于换一棵树：编辑区先收起来，再把**当前会话在这个目录里**那一份放回去
	// （会话是跨工作目录的，切到别的工作目录时它自己那份可能就属于这里）。
	const mine = editors.get(state.activeId ?? "");
	restoreEditor(mine ?? null);
	void loadDir("");
}

/** 画面包屑：根 › 每一段（打开文件时最后一段是文件名），点任意一段跳过去 */
function renderCrumbs() {
	dom.crumbs.replaceChildren();
	const full = openPath === "" ? currentDir : openPath;
	const parts = full === "" ? [] : full.split("/");

	const root = make("button", "lkx-crumb", state.cwd === "" ? "工作目录" : shortenPath(state.cwd, 1));
	root.type = "button";
	root.title = state.cwd;
	root.addEventListener("click", () => void loadDir(""));
	dom.crumbs.append(root);

	let prefix = "";
	for (const [index, part] of parts.entries()) {
		prefix = joinPath(prefix, part);
		// 每轮取一个常量，闭包才能记住这一段对应的目录。
		const target = prefix;
		const last = index === parts.length - 1;
		const crumb = make("button", last ? "lkx-crumb current" : "lkx-crumb", part);
		crumb.type = "button";
		crumb.title = absolutePath(target);
		if (last) {
			// 最后一段就是「当前所在处」，再点一次没有意义；文件那一层更是不能当目录打开。
			crumb.disabled = true;
		} else {
			crumb.addEventListener("click", () => void loadDir(target));
		}
		// MD3 的分层用 › 表达，比 / 更像「一层套一层」。
		dom.crumbs.append(make("span", "lkx-sep", "›"), crumb);
	}
}

/** 一行文件或目录 */
function entryRow(entry, child, depth) {
	const row = make("div", entry.dir ? "lkx-row dir" : "lkx-row");
	// 缩进按层数算，不用嵌套容器：嵌套容器会把点击区域与拖拽宽度都弄乱。
	row.style.paddingLeft = `${6 + depth * INDENT}px`;
	// 面板只有 400px，行内装不下全路径，完整路径放 title。
	row.title = entry.dir ? `${absolutePath(child)}（双击进入，点三角展开）` : absolutePath(child);

	if (entry.dir) {
		const twisty = make("span", "lkx-twisty");
		twisty.append(icon(expanded.has(child) ? "chevronDown" : "chevronRight", 13));
		twisty.addEventListener("click", (event) => {
			// 不冒泡：单击三角只展开，别连带触发整行的双击进目录。
			event.stopPropagation();
			void toggleDir(child);
		});
		row.append(twisty, make("span", "lkx-tag"));
		// 目录按需求用双击进入：目录列表常常很长，单击就跳走太容易误触发。
		row.addEventListener("dblclick", () => void loadDir(child));
	} else {
		// 文件用 · 点一下名，类型再用扩展名方块标出来；两者都不是图标字体。
		const tag = make("span", "lkx-tag", fileTag(entry.name));
		row.append(make("span", "lkx-twisty", "·"), tag);
		row.addEventListener("click", () => void openFile(child));
	}

	row.append(make("span", "lkx-name", entry.dir ? `${entry.name}/` : entry.name));
	if (!entry.dir) {
		row.append(make("span", "lkx-size", formatSize(entry.size)));
	}
	if (child === openPath) {
		row.classList.add("selected");
		openRow = row;
	}
	return row;
}

/** 递归铺开一层；展开的目录紧接着它的行往下铺 */
function appendEntries(container, dir, entries, depth) {
	for (const entry of entries) {
		const child = joinPath(dir, entry.name);
		container.append(entryRow(entry, child, depth));
		if (entry.dir && expanded.has(child)) {
			appendEntries(container, child, cache.get(child) ?? [], depth + 1);
		}
	}
}

/** 按缓存重画整棵树；数据变了就整棵重画，省得维护一堆「哪一行该改」的分支 */
function renderTree() {
	openRow = null;
	dom.tree.replaceChildren();
	const entries = cache.get(currentDir) ?? [];
	if (entries.length === 0) {
		dom.tree.append(make("div", "lkx-empty", "（空目录）"));
	} else {
		appendEntries(dom.tree, currentDir, entries, 0);
	}
	updateDirty();
}

/** 目录内容的提示行：数量到顶与被跳过的项都要说明，不能静默丢掉 */
function treeHint() {
	const parts = [];
	if ((cache.get(currentDir) ?? []).length >= MAX_ENTRIES) {
		parts.push(`已列出 ${MAX_ENTRIES} 项，可能还有更多`);
	}
	const hidden = hiddenCount.get(currentDir) ?? 0;
	if (hidden > 0) {
		parts.push(`已隐藏 ${hidden} 项`);
	}
	parts.push(`▸ 展开，双击进入，单击打开（${saveShortcut()} 保存）`);
	return parts.join(" · ");
}

/** 取某个目录的内容；force 为真时重新请求，否则用缓存 */
async function ensureDir(dir, force) {
	if (!force && cache.has(dir)) {
		return cache.get(dir);
	}
	const data = await api(`/api/files?path=${encodeURIComponent(dir)}`);
	cache.set(dir, data.entries);
	hiddenCount.set(dir, data.hidden ?? 0);
	return data.entries;
}

/** 载入并显示一个目录；path 是相对工作目录的路径，"" 表示根 */
async function loadDir(path) {
	note("载入中…");
	try {
		const data = await api(`/api/files?path=${encodeURIComponent(path)}`);
		cache.set(path, data.entries);
		hiddenCount.set(path, data.hidden ?? 0);
		currentDir = path;
		// 服务端回的是解析过符号链接的绝对路径：既是「身在何处」的答案，也是行 title 的基准。
		currentAbs = data.path;
		// 换了根，旧的展开状态属于另一棵树，清掉比留着更不容易误解。
		expanded.clear();
		renderCrumbs();
		renderTree();
		note(treeHint(), "", SKIP_HINT);
	} catch (error) {
		note(`无法打开目录：${error.message}`, "error");
	}
}

/** 展开或收起一个目录 */
async function toggleDir(path) {
	if (expanded.has(path)) {
		expanded.delete(path);
		renderTree();
		return;
	}
	note("载入中…");
	try {
		await ensureDir(path, false);
		expanded.add(path);
		renderTree();
		note(treeHint(), "", SKIP_HINT);
	} catch (error) {
		note(`无法展开 ${path}：${error.message}`, "error");
	}
}

/** 清空编辑器状态并收起它，不动磁盘上的文件 */
function resetEditor() {
	openPath = "";
	openMtimeMs = null;
	openText = "";
	openCrlf = false;
	readOnly = false;
	dom.editor.value = "";
	dom.editor.readOnly = true;
	dom.file.hidden = true;
	dom.dot.hidden = true;
}

/** 收起编辑器 */
function collapseEditor() {
	if (isDirty() && !window.confirm("有未保存的改动，确定收起吗？")) {
		return;
	}
	resetEditor();
	renderCrumbs();
	renderTree();
}

/** 打开文件进入查看/编辑 */
async function openFile(path) {
	note("读取中…");
	try {
		const data = await api(`/api/file-content?path=${encodeURIComponent(path)}`);
		openPath = path;
		openMtimeMs = typeof data.mtimeMs === "number" ? data.mtimeMs : null;
		openCrlf = data.content.includes("\r\n");
		openText = data.content.replace(/\r\n/g, "\n");
		readOnly = data.binary || data.truncated;

		dom.editor.value = openText;
		dom.editor.readOnly = readOnly;
		// 赋值会把光标留在末尾（Chrome 是这样），随后聚焦时浏览器顺着光标把视图滚到底：
		// 打开一个文件却停在最后一行，每次都得自己拖回开头。显式回到第一行。
		dom.editor.selectionStart = 0;
		dom.editor.selectionEnd = 0;
		dom.editor.scrollTop = 0;
		dom.editor.scrollLeft = 0;
		dom.pathText.textContent = shortenPath(data.path, 2);
		dom.filePath.title = data.path;
		dom.save.hidden = readOnly;
		dom.readonlyNote.hidden = !readOnly;
		dom.readonlyNote.textContent = data.binary
			? "二进制文件：按文本编辑会破坏内容，因此只读。"
			: "内容超过 200KB 已被截断：保存会用截断后的内容覆盖整个文件，因此只读。";
		dom.file.hidden = false;
		renderCrumbs();
		renderTree();
		note(readOnly ? "只读打开" : `${openText.length} 字`);
	} catch (error) {
		note(`打开失败：${error.message}`, "error");
	}
}

/**
 * 保存当前文件。
 *
 * force 只在「已经确认过外部改动、选择覆盖」时用：那种情况不能再拦一道，否则使用者答完第一问
 * 还得答第二问。带 expectedMtimeMs 时由服务端做乐观并发检查——「打开之后文件被外部改过」必须
 * 让使用者自己决定覆盖还是丢弃，不能替他抹掉别人的改动。
 */
async function saveFile(force = false) {
	if (openPath === "" || readOnly) {
		return;
	}
	// 覆盖不可逆，网页上也没有别处能撤销：每次都先把目标文件摆出来问一次。
	const target = dom.filePath.title || openPath;
	if (!force && !window.confirm(`保存会覆盖 ${target}，确定吗？`)) {
		return;
	}

	// textarea 里恒是 LF；原文是 CRLF 就换回去，否则一次保存会把整份文件的行尾都改掉。
	const content = openCrlf ? dom.editor.value.replace(/\r?\n/g, "\r\n") : dom.editor.value;
	const body = { path: openPath, content };
	if (!force && typeof openMtimeMs === "number") {
		body.expectedMtimeMs = openMtimeMs;
	}

	try {
		const saved = await api("/api/file-content", { method: "POST", body });
		openMtimeMs = typeof saved.mtimeMs === "number" ? saved.mtimeMs : null;
		openText = dom.editor.value;
		updateDirty();
		note(`已保存 ${formatSize(saved.bytes)}`, "ok");
		setStatus(`已保存 ${shortenPath(saved.path, 2)}`);
	} catch (error) {
		if (error.status === 409) {
			const overwrite = window.confirm(
				`${error.message}\n\n确定＝用编辑器里的内容覆盖；取消＝丢弃我的改动，重新载入磁盘上的版本`,
			);
			if (overwrite) {
				await saveFile(true);
			} else {
				note("已放弃本次改动");
				await openFile(openPath);
			}
			return;
		}
		note(`保存失败：${error.message}`, "error");
	}
}

/** 顶部栏动作与 Ctrl/Cmd+B 共用的开关：在看文件就收起面板，否则打开并切到文件标签 */
function togglePanel() {
	if (showing()) {
		closePanel();
	} else {
		openPanel("files");
	}
}

/** 初始化：把顶部栏动作与右侧面板标签注册进共享外壳，外壳负责位置、收起与 Esc */
export function init() {
	injectStyle();
	addPanelTab({
		id: "files",
		symbol: "▤",
		label: "文件",
		build: buildPanel,
		// 文件树是开得最勤的，排在标签条最前。
		order: 10,
	});

	// 外壳只管收起面板；Ctrl+B 是给本面板用的，标题里写了就得真的能用。Ctrl/Cmd+S 保存同理：
	// 浏览器默认会弹「保存网页」，必须先拦下来。
	window.addEventListener("keydown", (event) => {
		if (!(event.ctrlKey || event.metaKey)) {
			return;
		}
		const key = event.key.toLowerCase();
		if (key === "b") {
			event.preventDefault();
			togglePanel();
			return;
		}
		if (key === "s" && showing() && openPath !== "") {
			event.preventDefault();
			void saveFile();
		}
	});
}
