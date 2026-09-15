/*
 * 终端面板。
 *
 * 在界面里跑命令，输出不占对话上下文：输出只进面板自己的滚动区，不会拼进 <textarea>，
 * 因此不会变成下一条 prompt 的一部分、也不消耗 token。要与模型协作时，由使用者自己把
 * 关心的那几行贴进输入框——面板不会替他做这个决定。
 *
 * 位置由共享外壳决定（shell.js）：顶部栏一个 ⌗ 动作、右侧 400px 面板里一个标签页。
 * 本模块不再自己造浮层——之前那种底部抽屉会和别的功能抢输入区那一小块地方。
 * 竖长条反而更适合看日志：输出区更高、能横向滚。
 *
 * 面板内部只有三行结构：一条细工具条（左边状态、右边 ⌫ 清除）、吃掉剩余高度的输出区、
 * 底部的命令输入行 + 脚注。面板头已经有「⌗ 终端」标签了，所以这里不再画第二遍标题。
 *
 * 交互照 VS Code 内置终端的约定来：命令回显带 `$ ` 前缀并与输出区分；用户往上滚就停止跟随、
 * 右下角冒出「↓ 跳到最新」；执行中工具条显示 `◐ 运行中 3.2s`，结束显示 `✓/✕` 与退出码。
 * 面板上同一含义永远用同一个符号（⌗ 终端、⌫ 清除、✕ 关闭/失败、↓ 跳到底、✓ 成功、◐ 运行中），
 * 不引图标字体，也不做任何动画。
 *
 * 服务端是 POST /api/terminal/exec，直接以 `text/event-stream` 回事件（ready / out / done）。
 * 同源同 Host，用 fetch 读流即可，不需要 EventSource；而且浏览器对 EventSource 的重连会让
 * 「一次命令一条流」的语义变含糊（重连上来的流拿不到已经跑掉的那段输出）。
 *
 * 约定：DOM 与样式都由本模块自己创建（注入 <style>，类名统一 lkx- 前缀），不要改
 * index.html 与 app.css——这样多个功能并行开发时不会互相冲突。
 */

import { addPanelTab, closePanel, openPanel } from "./shell.js";
import { state } from "./state.js";

/** 终端端点 */
const EXEC_PATH = "/api/terminal/exec";

/** 输出区最多留多少行；更早的行直接丢掉，否则一条 `dir /s` 就能把标签页拖垮 */
const MAX_LINES = 2000;

/** 命令历史条数上限（只活在这个页面里，刷新即清空） */
const MAX_HISTORY = 50;

/** SSE 心跳间隔加上宽限：超过这么久没有任何事件就认定输出流已经死了（服务端 20 秒一次 ping） */
const STREAM_IDLE_MS = 30_000;

/** 超过它就额外提示「还在跑」，免得长时间没输出时看起来像卡住了 */
const SLOW_HINT_MS = 5_000;

/** 离底部多近仍算「贴在底部」；比这更远就认为用户在往回翻 */
const PIN_THRESHOLD_PX = 8;

/** 面板标签页的 id，顶部栏按钮与 Ctrl+` 都用它 */
const PANEL_ID = "terminal";

/**
 * ANSI 转义序列。
 *
 * 只认最常见的 SGR（`ESC[...m`）：清屏、光标移动这些整体控制序列不在这块小面板里实现，
 * 认出来也只当没有；识别不了的序列原样显示，不去猜它的意思。
 */
const ANSI_RE = /\x1b\[([0-9;:]*)m/g;

/**
 * 本模块的样式；用一次就够。
 *
 * 只走 app.css 已有的 MD3 角色变量与排版 token（surface 五档、text/muted、border、
 * danger/ok、radius-*、text-*、space-*），一个写死的颜色都不留，明暗两套主题自动跟着走。
 * 外壳已经给了面板底色与圆角，这里只画自己这几块，不再套一层卡片。
 */
export const STYLE = /* css */ `
.lkx-panel {
	position: relative;
	display: flex;
	flex-direction: column;
	height: 100%;
	min-width: 0;
	min-height: 0;
	/* 根块不铺底、也就不需要圆角：面板体就是它这一层表面 */
	/* 三块之间的节奏：工具条 / 输出区 / 输入+脚注，统一用 --space-2 隔开 */
	gap: var(--space-2);
}

/*
 * 工具条：整个面板里唯一一行「细」横条。
 * 之前这里画的是「⌗ 终端」标题 + 目录 + 状态，而面板头已经有「⌗ 终端」标签了，
 * 标题成了重复信息；目录也没有非看不可的理由（脚注与输出区里都有），所以整行撤掉。
 * 现在左边只剩状态一句话（就绪 / ◐ 运行中 3.2s / ✓ 0.4s · 退出码 0），右边一个 ⌫ 清除。
 */
.lkx-bar {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	flex: 0 0 auto;
	min-width: 0;
	min-height: 26px;
	color: var(--muted);
	font-size: var(--text-xs);
}

.lkx-bar .lkx-action {
	margin-left: auto;
}

/* 状态符号：◐ 运行中 / ✓ 成功 / ✕ 失败 —— 静态字符，不做旋转动画 */
.lkx-glyph {
	flex: 0 0 auto;
	font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
	font-size: var(--text-sm);
	line-height: 1.2;
}

/* 状态文字是工具条的主角，可以吃掉剩余宽度；太长就省略 */
.lkx-status-text {
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}

/* 状态配色挂在包住符号与文字的那一块上（setStatus 改的就是它的 class）。
   这里**不加**药丸外形：上一轮包了一次，使用者说"终端那块不用药丸"（那一处指的是输入框底部的状态行）。 */
.lkx-state {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-width: 0;
	max-width: 100%;
}

.lkx-state.running {
	color: var(--text-soft);
}

.lkx-state.ok {
	color: var(--ok);
}

.lkx-state.fail {
	color: var(--danger);
}

/* 面板里的动作（⌫ 清除 / ■ 停止接收）：与面板头的 ✕ 同一套外形，小一号 */
.lkx-action {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: 0 0 auto;
	min-width: 26px;
	padding: 3px 8px;
	border: 1px solid transparent;
	border-radius: var(--radius-pill);
	background: transparent;
	color: var(--muted);
	font: inherit;
	font-size: var(--text-base);
	cursor: pointer;
	transition: background 0.15s, color 0.15s;
}

.lkx-action:hover {
	background: var(--surface-3);
	color: var(--text);
}

/* 输出区：吃掉除工具条与输入行之外的全部高度。flex-basis 写 0 才能让 min-height: 0 生效 */
.lkx-body {
	position: relative;
	display: flex;
	flex: 1 1 0;
	min-width: 0;
	min-height: 0;
}

.lkx-out {
	flex: 1 1 0;
	min-width: 0;
	min-height: 0;
	margin: 0;
	/* 内边距给足：命令行输出贴着边框读起来很挤。等宽 + 不折行 + 双向可滚 */
	padding: var(--space-2) var(--space-3);
	overflow: auto;
	background: var(--surface-2);
	border: 1px solid var(--border);
	border-radius: calc(var(--radius-xl) - var(--space-4) - 1px);
	color: var(--text);
	font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
	font-size: var(--text-sm);
	/* 行高约 23px：紧凑面板里一屏能多看几行，日志才读得下去 */
	line-height: 23px;
	/* 保留空格与换行，但不折行：命令行输出按列对齐，折行就读不懂了 */
	white-space: pre;
	overflow-wrap: normal;
	tab-size: 4;
}

.lkx-out > span {
	display: block;
	/* 空行也要占一行高度，否则命令之间的空行会被压掉 */
	min-height: 23px;
}

/* 命令回显：弱化，与真正的输出分开 */
.lkx-out .lkx-echo {
	color: var(--muted);
}

/* 面板自己的提示（工作目录、耗时、退出码…）：次要色，一眼能认出不是命令输出 */
.lkx-out .lkx-sys {
	color: var(--text-soft);
}

/* 失败或出错的那一行 */
.lkx-out .lkx-bad {
	color: var(--danger);
}

.lkx-out .lkx-err {
	color: var(--danger);
}

/* ANSI 前景色：映射到主题色而不是照搬终端的 16 色，明暗两套主题都不刺眼 */
.lkx-out .lkx-red {
	color: var(--danger);
}

.lkx-out .lkx-green {
	color: var(--ok);
}

.lkx-out .lkx-yellow {
	color: var(--warn);
}

.lkx-out .lkx-cyan {
	color: var(--accent-text);
}

.lkx-out .lkx-bold {
	font-weight: 700;
}

.lkx-out .lkx-dim {
	opacity: 0.7;
}

.lkx-jump {
	position: absolute;
	right: var(--space-3);
	bottom: var(--space-3);
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	padding: 4px 12px;
	border: 1px solid var(--border);
	border-radius: var(--radius-pill);
	background: var(--surface-1);
	color: var(--text-soft);
	font: inherit;
	font-size: var(--text-xs);
	cursor: pointer;
	box-shadow: var(--shadow-md);
}

.lkx-jump:hover {
	background: var(--surface-3);
	color: var(--text);
}

/* 命令输入行：只有一个输入框（停止按钮执行中才出现），占满整宽 */
.lkx-foot {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	flex: 0 0 auto;
	min-width: 0;
}

/* 输入框与 app.css 里其它输入一致：surface-2 底 + border + radius-md + 等宽。
   聚焦只换边框色，必须同时按住 :focus 与 :focus-visible——app.css 的全局
   :focus-visible 会画一圈 3px 的 accent 方框（就是截图里那圈粉框），它比单写 :focus 更靠后。 */
.lkx-input {
	width: 100%;
	box-sizing: border-box;
	min-width: 0;
	padding: 8px 12px;
	border: 1px solid var(--border);
	border-radius: calc(var(--radius-xl) - var(--space-4) - 1px);
	background: var(--surface-2);
	color: var(--text);
	font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
	font-size: var(--text-sm);
}

.lkx-input:focus,
.lkx-input:focus-visible {
	outline: none;
	border-color: var(--accent-ring);
}

.lkx-input:disabled {
	opacity: 0.55;
}

/* 脚注：输出多少行、有没有被截、这条跑了多久。弱化成面板最底下的一行小字 */
.lkx-metrics {
	flex: 0 0 auto;
	padding-top: var(--space-2);
	border-top: 1px solid var(--border);
	color: var(--muted);
	font-size: var(--text-xs);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
`;

/** 面板根节点 */
let panel = null;

/** 输出区：唯一被 append 的地方 */
let out = null;

/** 「跳到最新」：不在跟随状态时才出现 */
let jumpButton = null;

/** 工具条左侧那块状态（管配色） */
let status = null;

/** 状态符号（◐ 运行中 / ✓ 成功 / ✕ 失败） */
let statusGlyph = null;

/** 状态文字（`就绪` / `运行中 3.2s` / `0.4s · 退出码 0`） */
let statusText = null;

/** 底部指标条（输出行数 / 是否截断 / 耗时） */
let metrics = null;

/** 命令输入框 */
let input = null;

/** 执行期间才出现的「终止」（只断开读取，服务端的超时与输出上限仍在兜底） */
let stopButton = null;

/** 当前这条命令的读取控制器；不在执行中时为 null */
let controller = null;

/**
 * 输出区当前有的行数。
 *
 * DOM 里「一个 <span> = 一行」与它严格对应，因此裁剪时可以两边一起砍，不会错位；
 * 不把整段输出留在内存里，只数行数就够（保留最近 2000 行靠的是 DOM 与这个计数）。
 */
let lineCount = 0;

/** 最后一行是否已经以换行收尾；决定下一块是接着写新行还是补到当前行后面 */
let endsWithNewline = true;

/** 当前最后一行对应的节点；新的一行要另开一个节点 */
let lastLine = null;

/** 待挂到 DOM 的片段，flush 时一次性写进去——一条 `dir /s` 一秒钟能推几千个小事件 */
const pendingNodes = [];

let frame = 0;

/** 用户是否贴在底部；他自己往上翻之后就停止自动跟随 */
let following = true;

/** 是否正在跑一条命令 */
let busy = false;

/** 命令历史与浏览位置（-1 表示不在历史里，正在编辑新命令） */
const history = [];
let historyAt = -1;

/** 当前命令的开始时刻，用来算耗时 */
let startedAt = 0;

/** 每 200 毫秒滴答一次状态；不在执行中时为 0 */
let ticker = 0;

/** 最近一次收到事件的时刻，用来判断输出流是不是已经死了 */
let lastEventAt = 0;

/**
 * 服务端报的工作目录。
 *
 * 以前它常显在头部那一行里，现在头部只留状态一句话——工作目录在文件面板的面包屑里写着，
 * 面板里再摆一遍是重复信息，所以收进 title：要确认时悬停一下就能看到全路径。
 */
let cwd = "";

/**
 * 初始化：注册顶部栏动作与右侧面板标签页。
 *
 * 面板内容由外壳在第一次显示时调用 build 才建——没打开过就不建 DOM，也不去连任何东西。
 */
export function init() {
	injectStyle();
	addPanelTab({ id: PANEL_ID, symbol: "⌗", label: "终端", build: buildPanel, order: 40 });

	// Ctrl+` 是各编辑器的终端快捷键：直接打开/收起终端标签页，不必去点顶部栏。
	document.addEventListener("keydown", (event) => {
		if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === "`") {
			event.preventDefault();
			openPanel(PANEL_ID);
		}
	});

	/*
	 * 会话换了：把终端这一格换成新会话那一份（输入、命令历史、输出、读数各归各的——使用者：
	 * 「旧的输入输出应该存在旧会话，新会话输入输出存在新会话」）。正在跑命令时先不换：那条命令的
	 * 输出是实时的，换走了就写进别人的面板；它跑完时再各归各位（见 run() 的收尾）。
	 */
	document.addEventListener("lk:session-changed", (event) => {
		if (busy) {
			return;
		}
		swapPane(event.detail?.current ?? "");
	});
}

/**
 * 注入本模块的样式；重复调用只注入一次。
 *
 * 这段以前漏了：STYLE 只被导出、没人挂进文档，于是面板一直接受浏览器默认样式——
 * 输入框是方角的、聚焦时套一圈全局 :focus-visible 的方框、脚注与工具条也没有间距和弱化色。
 * 与 history / files 两个面板保持同一套写法：带 id 守卫，注入一次就不再重复。
 */
function injectStyle() {
	if (document.getElementById("lkx-terminal-style")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "lkx-terminal-style";
	style.textContent = STYLE;
	document.head.append(style);
}

/** 建面板：细工具条 + 输出区 + 输入行 + 脚注，全部挂在壳给的容器里 */
function buildPanel(container) {
	// 容器由外壳控制显示（hidden 一开一关）；这里只排自己这四块，内边距由外壳的面板体给。
	container.classList.add("lkx-panel");

	/*
	 * 工具条：面板头已经有「⌗ 终端」标签，所以这里不再画第二遍标题，只留一行状态 + 清除。
	 * 外层 .lkx-bar 管排版（清除靠右），内层 .lkx-state 管配色，setStatus 改的是内层。
	 */
	const bar = document.createElement("div");
	bar.className = "lkx-bar";
	status = document.createElement("span");
	status.className = "lkx-state ready";
	statusGlyph = document.createElement("span");
	statusGlyph.className = "lkx-glyph";
	statusText = document.createElement("span");
	statusText.className = "lkx-status-text";
	statusText.textContent = "就绪";
	status.append(statusGlyph, statusText);
	// 面板里只留「清除」：关闭与 Esc 归外壳管（右上是外壳的 ✕）。
	const clearButton = document.createElement("button");
	clearButton.type = "button";
	clearButton.className = "lkx-action";
	clearButton.textContent = "⌫";
	clearButton.title = "清空输出区（命令历史还在）";
	clearButton.setAttribute("aria-label", "清除输出");
	clearButton.addEventListener("click", clearOutput);
	bar.append(status, clearButton);
	setStatus("ready", "就绪");

	const body = document.createElement("div");
	body.className = "lkx-body";
	out = document.createElement("pre");
	out.className = "lkx-out";
	out.setAttribute("role", "log");
	// 用户往上翻看历史输出时就停止跟随，否则一有输出就把他拽回底部。
	out.addEventListener("scroll", () => {
		const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight <= PIN_THRESHOLD_PX;
		if (atBottom) {
			following = true;
			jumpButton.hidden = true;
		} else {
			following = false;
			jumpButton.hidden = false;
		}
	});
	jumpButton = document.createElement("button");
	jumpButton.type = "button";
	jumpButton.className = "lkx-jump";
	jumpButton.textContent = "↓ 跳到最新";
	jumpButton.title = "回到输出末尾，继续自动跟随";
	jumpButton.hidden = true;
	jumpButton.addEventListener("click", scrollToEnd);
	body.append(out, jumpButton);

	const foot = document.createElement("form");
	foot.className = "lkx-foot";
	input = document.createElement("input");
	input.className = "lkx-input";
	input.type = "text";
	input.spellcheck = false;
	input.autocomplete = "off";
	input.placeholder = "输入命令，回车执行（↑ ↓ 翻历史）";
	input.setAttribute("aria-label", "终端命令");
	input.addEventListener("keydown", onInputKey);
	// 回车交给 form 的 submit：与 index.html 的输入区同一套写法，键盘与鼠标点「执行」都走这里。
	foot.addEventListener("submit", (event) => {
		event.preventDefault();
		run();
	});
	stopButton = document.createElement("button");
	stopButton.type = "button";
	stopButton.className = "lkx-action";
	stopButton.textContent = "■";
	stopButton.title = "停止接收这条输出（命令仍在服务端跑，最迟在自己的时限里被收掉）";
	stopButton.setAttribute("aria-label", "停止接收输出");
	stopButton.hidden = true;
	stopButton.addEventListener("click", () => controller?.abort());
	foot.append(input, stopButton);

	// 脚注：回答「这条命令产出了多少、有没有被截」，是面板最底下的一行小字，不单独占一行贴在输入框下。
	metrics = document.createElement("div");
	metrics.className = "lkx-metrics";
	metrics.textContent = "输出 0 行 · 未截断";

	panel = container;
	panel.append(bar, body, foot, metrics);
	// 面板第一次建出来时属于当时那个会话；之后跟着 lk:session-changed 换
	paneKey = state.activeId ?? "";
	panel.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			closePanel();
		}
	});

	// 面板可能通过顶部栏按钮或切换标签页打开，两种方式都改的是 hidden，
	// 所以用一个观察者来对齐行为：一露出来就把焦点给输入框。
	new MutationObserver(() => {
		if (!panel.hidden) {
			input.focus();
			if (following) {
				scrollToEnd();
			}
		}
	}).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
}

/** 清空输出区与行计数 */
function clearOutput() {
	pendingNodes.length = 0;
	if (frame !== 0) {
		cancelAnimationFrame(frame);
		frame = 0;
	}
	out.replaceChildren();
	lineCount = 0;
	endsWithNewline = true;
	lastLine = null;
	following = true;
	jumpButton.hidden = true;
}

/**
 * 每个会话各留一份终端面板：输入框里没发出去的、命令历史、输出、工具条读数与状态行。
 *
 * 使用者：「旧的输入输出应该存在旧会话，新会话输入输出存在新会话」。会话换了就把当前这份存起来、
 * 把对面那份放回去（`savePane` / `loadPane` 与文件面板的编辑器快照同一套做法）。
 *
 * **正在跑命令的那一份例外**：那条命令的输出是实时的，换会话时不把界面换走（否则输出写进别人的
 * 面板里），等它跑完再各归各位。
 */
const panes = new Map();

/** 当前显示的这一份属于哪个会话 */
let paneKey = "";

/** 把当前面板存到 `paneKey` 名下 */
function savePane() {
	if (out === null) {
		return;
	}
	// 还没挂上去的片段先落地：它们也是这一份输出的一部分
	if (pendingNodes.length > 0) {
		if (frame !== 0) {
			cancelAnimationFrame(frame);
			frame = 0;
		}
		flush();
	}
	panes.set(paneKey, {
		html: out.innerHTML,
		lineCount,
		endsWithNewline,
		metrics: metrics.textContent,
		statusClass: status.className,
		statusGlyph: statusGlyph.textContent,
		statusText: statusText.textContent,
		input: input.value,
		history: [...history],
		historyAt,
		following,
	});
}

/** 把 `paneKey` 名下那一份放回面板；没有过就是一块干净的终端 */
function loadPane() {
	clearOutput();
	metrics.textContent = "输出 0 行 · 未截断";
	setStatus("ready", "就绪");
	input.value = "";
	history.length = 0;
	historyAt = -1;
	const saved = panes.get(paneKey);
	if (saved === undefined) {
		return;
	}
	out.innerHTML = saved.html;
	lineCount = saved.lineCount;
	endsWithNewline = saved.endsWithNewline;
	// 续写目标按新 DOM 末行认：trimLines 砍掉那一行时它也会跟着变成 null
	lastLine = out.lastElementChild;
	metrics.textContent = saved.metrics;
	status.className = saved.statusClass;
	statusGlyph.textContent = saved.statusGlyph;
	statusText.textContent = saved.statusText;
	input.value = saved.input;
	history.push(...saved.history);
	historyAt = saved.historyAt;
	following = saved.following;
	jumpButton.hidden = saved.following;
	if (saved.following) {
		out.scrollTop = out.scrollHeight;
	}
}

/** 会话换了：存下这一份，换上对面那一份 */
function swapPane(key) {
	if (out === null || key === paneKey) {
		return;
	}
	savePane();
	paneKey = key;
	loadPane();
}

/** 提交一次执行 */
async function run() {
	if (busy) {
		setStatus("fail", "已有一条命令在跑，先点停");
		return;
	}
	const command = input.value.trim();
	if (command === "") {
		return;
	}
	input.value = "";
	if (history[0] !== command) {
		history.unshift(command);
		history.length = Math.min(history.length, MAX_HISTORY);
	}
	historyAt = -1;

	// 每次执行先清屏：面板是「跑一条看一条」，留着上一次的输出只会让人分不清哪条是哪条。
	clearOutput();
	// 先把命令回显出来（带 $ 前缀、弱化色），与它的输出分得清。
	appendOutput(`$ ${command}\n`, "lkx-echo");

	startedAt = Date.now();
	setBusy(true);
	// 工具条只放「现在怎么了」，200 毫秒一跳的计时；产出多少行放底部脚注。
	setStatus("running", "运行中 0.0s");
	metrics.textContent = "输出 0 行 · 未截断";

	controller = new AbortController();
	// 状态行按 200 毫秒滴答：安静的长时间命令也要看得出它还在跑（符号是静态的，只有数字在走）。
	ticker = setInterval(() => {
		const elapsed = Date.now() - startedAt;
		if (Date.now() - lastEventAt > STREAM_IDLE_MS) {
			setStatus("fail", `${formatElapsed(elapsed)} · 输出流没有动静`);
			return;
		}
		setStatus(
			"running",
			elapsed >= SLOW_HINT_MS
				? `运行中 ${formatElapsed(elapsed)} · 最多 120 秒`
				: `运行中 ${formatElapsed(elapsed)}`,
		);
	}, 200);

	try {
		const response = await fetch(EXEC_PATH, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command }),
			signal: controller.signal,
		});
		if (!response.ok) {
			// 409（已有命令在跑）、400（命令为空）这类是服务端明确回的 JSON。
			const detail = await response.text();
			let message = `HTTP ${response.status}`;
			try {
				message = JSON.parse(detail).error ?? message;
			} catch {
				// 不是 JSON 就保留状态码，别把一个解析错误当成真正的失败原因显示出去。
			}
			appendOutput(`✕ ${message}\n`, "lkx-bad");
			setStatus("fail", message);
		} else if (!response.body) {
			appendOutput("✕ 响应没有内容\n", "lkx-bad");
			setStatus("fail", "响应没有内容");
		} else {
			await readStream(response.body);
		}
	} catch (error) {
		// abort 是使用者自己点的停止，不是故障。
		const aborted = error.name === "AbortError";
		appendOutput(aborted ? "■ 已停止接收输出\n" : `✕ 连接失败：${error.message}\n`, aborted ? "lkx-sys" : "lkx-bad");
		setStatus("fail", aborted ? "已停止接收" : "连接失败");
	} finally {
		clearInterval(ticker);
		ticker = 0;
		controller = null;
		setBusy(false);
		if (out.textContent === "") {
			// 命令没有任何输出；空白的框会让人以为它没跑。
			appendOutput("(命令没有输出)\n", "lkx-sys");
		}
		input.focus();
	}
}

/** 读 SSE 流：按空行切事件块，逐块交给 handleEvent */
async function readStream(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		pending += decoder.decode(value, { stream: true });
		// 事件块之间用空行分隔；心跳是 `: ping` 这样的注释行，parse 出来是 null，自然被忽略。
		const blocks = pending.split("\n\n");
		pending = blocks.pop() ?? "";
		for (const block of blocks) {
			lastEventAt = Date.now();
			const event = parseEvent(block);
			if (event) {
				handleEvent(event.name, event.data);
			}
		}
	}
}

/** 解析一个 SSE 事件块；只有注释、没有 data、或 data 不是 JSON 都返回 null */
function parseEvent(block) {
	let name = "message";
	const data = [];
	for (const line of block.split("\n")) {
		if (line.startsWith("event:")) {
			name = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			data.push(line.slice(5).trimStart());
		}
	}
	if (data.length === 0) {
		return null;
	}
	// 服务端每一种事件的 data 都是 JSON 对象；解析不了（代理插了东西、连接断了半截）
	// 就当没有这一块，别把整条流搞崩。
	try {
		return { name, data: JSON.parse(data.join("\n")) };
	} catch {
		return null;
	}
}

/** 处理一条事件 */
function handleEvent(name, data) {
	if (name === "out") {
		appendOutput(data.text, data.channel === "stderr" ? "lkx-err" : "");
		return;
	}
	if (name === "ready") {
		// 目录与两道上限都由服务端给：界面里不写死「120 秒 / 1 MB」，
		// 免得服务端改一处、提示里还留着旧数字。
		cwd = String(data.cwd ?? "");
		panel.title = cwd === "" ? "终端" : `终端 · ${cwd}`;
	}
	if (name === "done") {
		// 工具条：结束状态一句话（`✓ 0.4s · 退出码 0`）。符号由 setStatus 按结果给。
		const statusParts = [formatElapsed(data.durationMs)];
		const notes = [];
		if (data.truncated) {
			notes.push("输出超过上限，已截断并终止命令");
		} else if (data.timedOut) {
			notes.push("超过时限被终止");
		} else {
			// 只有正常收尾时才谈退出码：被截断或被超时杀掉时，那个码来自「我们杀它」，
			// 报出来只会让人以为命令自己失败了。
			statusParts.push(data.code === null || data.code === undefined ? "已终止" : `退出码 ${data.code}`);
		}
		if (data.failure) {
			notes.push(data.failure);
		}
		const failed = data.failure !== undefined || data.timedOut || data.truncated || (data.code ?? 0) !== 0;

		// 底部脚注回答「产出多少、有没有被截」；工具条一行是「现在怎么了」，两者不重复。
		const flags = data.truncated ? `已截断（${formatBytes(data.bytes)}）` : "未截断";
		metrics.textContent = `输出 ${lineCount} 行 · ${flags} · ${formatDuration(data.durationMs)}`;

		// 同一含义同一个符号：成功 ✓、失败 ✕。结果也写进输出区（跟着输出一起滚走）。
		appendOutput(`${failed ? "✕" : "✓"} ${[...statusParts, ...notes].join(" · ")}\n`, failed ? "lkx-bad" : "lkx-sys");
		setStatus(failed ? "fail" : "ok", statusParts.join(" · "));
		/*
		 * 这条命令归它发起时那个会话所有：存下那一份，再把界面还给**当前**会话（跑的过程中使用者
		 * 可能已经切走了，那时按约定没有换界面）。
		 */
		savePane();
		const now = state.activeId ?? "";
		if (now !== paneKey) {
			paneKey = now;
			loadPane();
		}
	}
}

/**
 * 一段输出入队。
 *
 * 按行切：第一行接着上一个节点写（上一次可能只收到半行），之后每行各起一个节点，
 * 这样「DOM 里一个 <span> = 一行」，裁剪行数时两边能一起砍。
 */
function appendOutput(text, className = "") {
	if (text === "") {
		return;
	}
	const fragment = document.createDocumentFragment();
	for (const rawLine of splitLines(text)) {
		if (rawLine.continuation && lastLine) {
			// 上一次的结尾没有换行：这一段是同一行的续写。
			appendSpans(lastLine, rawLine.text, className);
		} else {
			const line = document.createElement("span");
			line.className = className;
			appendSpans(line, rawLine.text, className);
			fragment.append(line);
			lastLine = line;
			lineCount += 1;
		}
	}
	endsWithNewline = text.endsWith("\n");
	if (fragment.childNodes.length > 0) {
		pendingNodes.push(fragment);
	}
	// 攒到一帧再挂上去：逐个 append 会卡住主线程。
	if (frame === 0) {
		frame = requestAnimationFrame(flush);
	}
}

/**
 * 把一段文本按换行切开。
 *
 * 顺带把 `\r` 去掉：Windows 上是 `\r\n`（切完就没了），而进度条那种只回车的覆盖式输出
 * 会留下一串 `\r`，留着显示会莫名其妙。
 */
function splitLines(text) {
	const clean = text.replace(/\r/g, "");
	const parts = clean.split("\n");
	const lines = [];
	for (let index = 0; index < parts.length; index += 1) {
		const piece = parts[index] ?? "";
		const last = index === parts.length - 1;
		// 以换行结尾的块，split 出来的最后一个是空串，它只代表「下一块的起点」，不是一行内容。
		if (piece === "" && last) {
			break;
		}
		lines.push({ text: piece, continuation: index === 0 && !endsWithNewline });
	}
	return lines;
}

/**
 * 把带 ANSI 颜色的文本拆成若干 span 挂到目标节点上。
 *
 * 只处理红 / 绿 / 黄 / 青与粗体、暗色：这几种覆盖了绝大多数命令行工具的高亮，
 * 其余颜色码按默认色显示（不猜色号），不认识的控制序列原样输出去。
 */
function appendSpans(target, text, className) {
	let cursor = 0;
	// 每一行重新算颜色：命令换行之后不该继承上一行的颜色。
	const style = { color: "", bold: false, dim: false };
	ANSI_RE.lastIndex = 0;
	for (;;) {
		const match = ANSI_RE.exec(text);
		if (!match) {
			break;
		}
		if (match.index > cursor) {
			target.append(makeSpan(text.slice(cursor, match.index), className, style));
		}
		applyAnsi(style, match[1] ?? "");
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) {
		target.append(makeSpan(text.slice(cursor), className, style));
	}
}

/** 造一个带当前颜色的文本节点 */
function makeSpan(text, className, style) {
	const span = document.createElement("span");
	const classes = [];
	if (className) {
		classes.push(className);
	}
	if (style.color) {
		classes.push(style.color);
	}
	if (style.bold) {
		classes.push("lkx-bold");
	}
	if (style.dim) {
		classes.push("lkx-dim");
	}
	if (classes.length > 0) {
		span.className = classes.join(" ");
	}
	span.textContent = text;
	return span;
}

/** 解析 SGR 参数并落到样式对象上 */
function applyAnsi(style, params) {
	const codes = params
		.split(/[;:]/)
		.filter((part) => part !== "")
		.map(Number);
	if (codes.length === 0) {
		// `ESC[m` 等价于 `ESC[0m`。
		applyAnsi(style, "0");
		return;
	}
	for (const code of codes) {
		if (code === 0) {
			style.color = "";
			style.bold = false;
			style.dim = false;
		} else if (code === 1) {
			style.bold = true;
		} else if (code === 2) {
			style.dim = true;
		} else if (code === 22) {
			style.bold = false;
			style.dim = false;
		} else if (code === 39) {
			style.color = "";
		} else {
			style.color = ANSI_COLORS[code] ?? style.color;
		}
	}
}

/** 认得的颜色码 → class；认不得的保持当前颜色 */
const ANSI_COLORS = {
	31: "lkx-red",
	32: "lkx-green",
	33: "lkx-yellow",
	36: "lkx-cyan",
	91: "lkx-red",
	92: "lkx-green",
	93: "lkx-yellow",
	96: "lkx-cyan",
};

/** 把攒下的片段写进输出区、裁剪行数、必要时滚到底 */
function flush() {
	frame = 0;
	if (pendingNodes.length === 0) {
		return;
	}
	const fragment = document.createDocumentFragment();
	for (const node of pendingNodes) {
		fragment.append(node);
	}
	pendingNodes.length = 0;
	out.append(fragment);
	trimLines();
	if (following) {
		scrollToEnd();
	}
}

/** 只保留最近 MAX_LINES 行；超了就从头砍，DOM 与行数一起砍，两边不会错位 */
function trimLines() {
	if (lineCount <= MAX_LINES) {
		return;
	}
	const drop = lineCount - MAX_LINES;
	let droppedLast = false;
	for (let index = 0; index < drop; index += 1) {
		const first = out.firstElementChild;
		droppedLast = droppedLast || first === lastLine;
		first?.remove();
	}
	lineCount = MAX_LINES;
	// 被砍掉的正好是还没结束的那一行时，续写目标已经脱离文档了，必须先断开，
	// 否则接下来的输出会写进一个看不见的节点里。
	if (droppedLast) {
		lastLine = null;
	}
}

/** 滚到底部并恢复跟随 */
function scrollToEnd() {
	out.scrollTop = out.scrollHeight;
	following = true;
	jumpButton.hidden = true;
}

/** 切换执行中的界面状态 */
function setBusy(value) {
	busy = value;
	input.disabled = value;
	stopButton.hidden = !value;
	if (value) {
		lastEventAt = Date.now();
	}
}

/**
 * 写状态（配色 + 符号 + 文字）。
 *
 * 同一含义全用同一个符号：✓ 就绪 / 成功、◐ 运行中、✕ 失败 —— 静态字符，不做旋转动画。
 */
function setStatus(kind, text) {
	status.className = `lkx-state ${kind}`;
	statusGlyph.textContent = kind === "running" ? "◐" : kind === "fail" ? "✕" : "✓";
	statusText.textContent = text;
}

/** 输入框的按键：上下翻历史（回车交给表单的 submit） */
function onInputKey(event) {
	if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
		return;
	}
	if (history.length === 0) {
		return;
	}
	if (event.key === "ArrowUp") {
		historyAt = Math.min(historyAt + 1, history.length - 1);
	} else if (historyAt <= 0) {
		// 已经到最近一条，再往下就回到「正在写的新命令」。
		historyAt = -1;
	} else {
		historyAt -= 1;
	}
	input.value = historyAt === -1 ? "" : (history[historyAt] ?? "");
	// 光标移到末尾，否则接上来的历史命令要在中间改。
	input.setSelectionRange(input.value.length, input.value.length);
	event.preventDefault();
}

/** 毫秒转成「1.2 秒 / 2 分 03 秒」 */
function formatDuration(ms) {
	if (ms < 1000) {
		return `${ms} 毫秒`;
	}
	const seconds = ms / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(1)} 秒`;
	}
	return `${Math.floor(seconds / 60)} 分 ${String(Math.floor(seconds % 60)).padStart(2, "0")} 秒`;
}

/** 字节转成 KB / MB；指标条里说「被截在 1 MB」比说 1048576 好读得多 */
function formatBytes(bytes) {
	if (bytes >= 1024 * 1024) {
		return `${Math.round(bytes / (1024 * 1024))} MB`;
	}
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 头部结束状态里的耗时。
 *
 * 面板头一行很窄，所以这里不写「1.2 秒」里的单位长尾：不足一秒给 `0.4s`，
 * 超过给 `3.2s`，一分钟向上才让 formatDuration 接管成「1 分 05 秒」。
 */
function formatElapsed(ms) {
	if (ms >= 60_000) {
		return formatDuration(ms);
	}
	return `${(ms / 1000).toFixed(1)}s`;
}
