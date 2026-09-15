/*
 * 代码评审面板。
 *
 * 命令行有 `limkenion review`、REPL 有 `/review`，网页一直没有入口：几个评审者各管一个角度并行
 * 各跑一遍、再由一个汇总者合成一份带 `VERDICT:` 行的报告，这件事在浏览器里做不了。本模块补上它：
 * 一条基线输入（留空就是工作区的未提交改动，与命令行不带 `--base` 时一致）、一个「开始评审」、
 * 一行状态，报告用共享的 renderMarkdown 渲染在下方的滚动区里。
 *
 * 位置由共享外壳决定（shell.js）：右侧 400px 面板里的一个标签页。DOM 与样式都由本模块自己建
 * （注入 <style>，类名统一 lkx-review 前缀），不改 index.html 与 app.css——多个功能并行开发时
 * 不会互相覆盖。
 *
 * 三件必须处理的事：
 * 1. **一次只跑一轮**：服务端回 409 时把原因原样显示出来，而不是自己再拦一道（服务端那份才是真的）。
 * 2. **没有可评审的改动**：服务端回 400，原因写在 error 里（「没有可评审的改动…」或「不是 git 仓库」），
 *    面板照抄那句话——这是最常见的失败，编不出一句更准的。
 * 3. **报告很长**：结论行单独提成面板顶部的一个徽标（`VERDICT: block` / `ok`），报告本身在下面滚，
 *    这样滚到报告中间也还看得见结论。
 *
 * 评审要跑好几分钟（每个评审者都可能读好几个文件），所以请求不带超时：只由浏览器自己的连接决定
 * 什么时候放弃。用户关掉标签页时连接断开，服务端会 abort 掉还在跑的评审者，不会让它们在后台空转。
 *
 * 不做任何动画；配色与排版全部走 app.css 已有的 MD3 变量与 token。
 */

import { api } from "./api.js";
import { addPanelTab } from "./features.js";
import { renderMarkdown } from "./format.js";
import { icon } from "./icons.js";
import { state as app } from "./state.js";

/** 评审端点 */
const REVIEW_PATH = "/api/review";

/** 面板标签页的 id */
const PANEL_ID = "review";

/** 基线输入框里那句提示：说清留空时比的是什么，别让人以为是「随便填一个」 */
const BASE_PLACEHOLDER = "默认：未提交的改动（工作区相对 HEAD）";

/**
 * 本模块的样式；用一次就够。
 *
 * 只走 app.css 已有的变量与 token：surface 几档、text/muted、border、ok/danger、radius-*、
 * text-*、space-*。一个写死的颜色都不留，明暗两套主题自动跟着走。
 */
export const STYLE = /* css */ `
.lkx-review {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-width: 0;
	min-height: 0;
	gap: var(--space-2);
	/* 根块不铺底、也就不需要圆角：面板体就是它这一层表面 */
}

/* 顶部：基线输入 + 开始按钮。宽度不够时换行，绝不把按钮压出可视区 */
.lkx-review-bar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	flex: 0 0 auto;
	min-width: 0;
}

.lkx-review-input {
	flex: 1 1 140px;
	min-width: 0;
	box-sizing: border-box;
	padding: 7px 12px;
	border: 1px solid var(--border);
	border-radius: var(--radius-pill);
	background: var(--surface-2);
	color: var(--text);
	font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
	font-size: var(--text-sm);
}

/* 聚焦只换边框色：app.css 的全局 :focus-visible 会画一圈 3px 的 accent 方框，它更靠后，
   所以两颗选择器都要写上（与终端面板同一条理由）。 */
.lkx-review-input:focus,
.lkx-review-input:focus-visible {
	outline: none;
	border-color: var(--accent-ring);
}

.lkx-review-input:disabled {
	opacity: 0.55;
}

.lkx-review-start {
	flex: 0 0 auto;
	padding: 7px 16px;
	border: 1px solid transparent;
	border-radius: var(--radius-pill);
	background: var(--accent-soft);
	color: var(--accent-text);
	font: inherit;
	font-size: var(--text-sm);
	white-space: nowrap;
	cursor: pointer;
}

.lkx-review-start:hover:not(:disabled) {
	background: var(--accent-fill-hover);
}

.lkx-review-start:disabled {
	opacity: 0.55;
	cursor: default;
}

/* 状态行：一句「现在怎么了」。符号静态，不做任何旋转或脉冲 */
.lkx-review-state {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	flex: 0 0 auto;
	min-width: 0;
	min-height: 22px;
	color: var(--muted);
	font-size: var(--text-xs);
}

.lkx-review-state.running {
	color: var(--text-soft);
}

.lkx-review-state.ok {
	color: var(--ok);
}

.lkx-review-state.fail {
	color: var(--danger);
}

.lkx-review-glyph {
	flex: 0 0 auto;
	font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
	font-size: var(--text-sm);
	line-height: 1.2;
}

.lkx-review-statustext {
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}

/*
 * 结论徽标：整块面板最要紧的一行，所以固定贴在报告上方不参与滚动。
 * 报告有几百行时，「这次评审到底放没放行」必须一眼看得见，而不是滚到最上面去找。
 * 没有结论时不占位置（hidden 由脚本控制）。
 */
.lkx-review-verdict {
	flex: 0 0 auto;
	padding: 5px var(--space-3);
	border: 1px solid var(--border);
	border-radius: var(--radius-sm);
	background: var(--surface-2);
	color: var(--text-soft);
	font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
	font-size: var(--text-sm);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.lkx-review-verdict.block {
	border-color: var(--danger);
	background: var(--danger-soft);
	color: var(--danger);
}

.lkx-review-verdict.ok {
	border-color: var(--ok);
	color: var(--ok);
}

/* 报告区：吃掉剩余高度，自己滚。flex-basis 写 0 才能让 min-height: 0 生效 */
.lkx-review-report {
	flex: 1 1 0;
	min-width: 0;
	min-height: 0;
	padding: var(--space-3);
	overflow: auto;
	background: var(--surface-2);
	border: 1px solid var(--border);
	border-radius: calc(var(--radius-xl) - var(--space-4) - 1px);
	color: var(--text);
	font-size: var(--text-base);
	line-height: 1.7;
	overflow-wrap: anywhere;
}

/* 首尾不留白：报告一开头就是标题，前面空一大截很难看 */
.lkx-review-report > :first-child {
	margin-top: 0;
}

.lkx-review-report > :last-child {
	margin-bottom: 0;
}

.lkx-review-report h1,
.lkx-review-report h2,
.lkx-review-report h3,
.lkx-review-report h4,
.lkx-review-report h5,
.lkx-review-report h6 {
	margin: var(--space-4) 0 var(--space-2);
	font-size: var(--text-md);
	line-height: 1.4;
}

.lkx-review-report p,
.lkx-review-report ul,
.lkx-review-report ol {
	margin: var(--space-2) 0;
}

.lkx-review-report ul,
.lkx-review-report ol {
	padding-left: var(--space-5);
}

.lkx-review-report li {
	margin: var(--space-1) 0;
}

.lkx-review-report code {
	padding: 1px 5px;
	border-radius: var(--radius-xs);
	background: var(--surface-3);
	font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
	font-size: var(--text-sm);
}

/* 代码块按 renderMarkdown 的 .code-block 结构画。等宽的评审片段不折行，自己横滚 */
.lkx-review-report .code-block {
	margin: var(--space-3) 0;
	border: 1px solid var(--border);
	border-radius: var(--radius-sm);
	background: var(--code-bg);
	overflow: hidden;
}

.lkx-review-report .code-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
	padding: 4px var(--space-2);
	border-bottom: 1px solid var(--border);
	background: var(--code-lang-bg);
}

.lkx-review-report .code-lang {
	color: var(--muted);
	font-size: var(--text-xs);
}

.lkx-review-report .code-copy {
	padding: 2px var(--space-2);
	border: 1px solid transparent;
	border-radius: var(--radius-pill);
	background: transparent;
	color: var(--muted);
	font-size: var(--text-xs);
	cursor: pointer;
}

.lkx-review-report .code-block pre {
	margin: 0;
	padding: var(--space-2) var(--space-3);
	overflow-x: auto;
}

.lkx-review-report .code-block code {
	padding: 0;
	background: none;
	white-space: pre;
}
`;

/** 面板根节点 */
let panel = null;

/** 基线输入框 */
let baseInput = null;

/** 「开始评审」按钮 */
let startButton = null;

/** 状态行（管配色） */
let state = null;

/** 状态符号（▸ 运行中 / ✓ 完成 / ✕ 失败） */
let glyph = null;

/** 状态文字 */
let stateText = null;

/** 结论徽标：`VERDICT: block` / `VERDICT: ok` */
let verdictLine = null;

/** 报告区 */
let report = null;

/** 是否正在跑一轮；同一面板不允许并发 */
let busy = false;

/** 这一轮开始的时刻，用来算耗时 */
let startedAt = 0;

/**
 * 初始化：注册右侧面板的一个标签页。
 *
 * 不注册顶部栏入口：顶部栏已经排满了一行，评审是低频动作，它该待在面板里（终端那样既要快捷
 * 又要随时看输出的才占一个入口）。要打开就直接切到评审标签。
 */
export function init() {
	injectStyle();
	addPanelTab({ id: PANEL_ID, symbol: "✓", label: "评审", build: buildPanel, order: 30 });

	/*
	 * 会话换了就把这一格换成新会话那一份（基准输入框 + 报告 + 结论徽标 + 状态行）：使用者
	 * 「旧的输入输出应该存在旧会话，新会话输入输出存在新会话」。正在跑评审时不换（跑完会写回报告，
	 * 换走了就写进别人的面板），等它跑完再各归各位。
	 */
	document.addEventListener("lk:session-changed", (event) => {
		if (busy) {
			return;
		}
		swapPanes(event.detail?.current ?? "");
	});
}

/**
 * 每个会话各留一份评审面板：基准输入框、报告内容、结论徽标与状态行。
 *
 * 与文件面板的编辑器快照同一套做法（存 HTML + 几个读得回来的字段），不为这个做状态重建。
 */
const panes = new Map();

/** 当前显示的这一份属于哪个会话 */
let paneKey = "";

function savePane() {
	if (report === null) {
		return;
	}
	panes.set(paneKey, {
		base: baseInput.value,
		reportHtml: report.innerHTML,
		verdictHidden: verdictLine.hidden,
		verdictClass: verdictLine.className,
		statusClass: state.className,
		statusGlyph: glyph.textContent,
		statusText: stateText.textContent,
	});
}

function loadPane() {
	baseInput.value = "";
	verdictLine.hidden = true;
	verdictLine.className = "lkx-review-verdict";
	setStatus("ready", "就绪：留空比对未提交的改动");
	const saved = panes.get(paneKey);
	if (saved === undefined) {
		setReport("评审结果会显示在这里：先跑一次，报告有几页也不影响，结论会固定在上面的徽标里。");
		return;
	}
	baseInput.value = saved.base;
	report.innerHTML = saved.reportHtml;
	verdictLine.hidden = saved.verdictHidden;
	verdictLine.className = saved.verdictClass;
	state.className = saved.statusClass;
	glyph.textContent = saved.statusGlyph;
	stateText.textContent = saved.statusText;
}

function swapPanes(key) {
	if (report === null || key === paneKey) {
		return;
	}
	savePane();
	paneKey = key;
	loadPane();
}

/** 注入本模块的样式；重复调用只注入一次 */
function injectStyle() {
	if (document.getElementById("lkx-review-style")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "lkx-review-style";
	style.textContent = STYLE;
	document.head.append(style);
}

/** 建面板：顶部一行（输入 + 按钮）、状态行、结论徽标、报告区，全部挂在壳给的容器里 */
function buildPanel(container) {
	container.classList.add("lkx-review");

	const bar = document.createElement("div");
	bar.className = "lkx-review-bar";
	baseInput = document.createElement("input");
	baseInput.className = "lkx-review-input";
	baseInput.type = "text";
	baseInput.spellcheck = false;
	baseInput.autocomplete = "off";
	baseInput.placeholder = BASE_PLACEHOLDER;
	baseInput.title = "比较基线，例如 main；留空则评审工作区相对 HEAD 的改动";
	baseInput.setAttribute("aria-label", "比较基线");
	// 回车等同于点「开始评审」：只跑评审，不提交任何对话。
	baseInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			start();
		}
	});
	startButton = document.createElement("button");
	startButton.type = "button";
	startButton.className = "lkx-review-start";
	startButton.textContent = "开始评审";
	startButton.addEventListener("click", () => start());
	bar.append(baseInput, startButton);

	state = document.createElement("div");
	state.className = "lkx-review-state ready";
	glyph = document.createElement("span");
	glyph.className = "lkx-review-glyph";
	stateText = document.createElement("span");
	stateText.className = "lkx-review-statustext";
	state.append(glyph, stateText);
	setStatus("ready", "就绪：留空比对未提交的改动");

	verdictLine = document.createElement("div");
	verdictLine.className = "lkx-review-verdict";
	verdictLine.hidden = true;

	report = document.createElement("div");
	report.className = "lkx-review-report";
	report.setAttribute("role", "region");
	report.setAttribute("aria-label", "评审报告");
	setReport("评审结果会显示在这里：先跑一次，报告有几页也不影响，结论会固定在上面的徽标里。");

	panel = container;
	panel.append(bar, state, verdictLine, report);
	// 面板第一次建出来时属于当时那个会话；之后跟着 lk:session-changed 换
	paneKey = app.activeId ?? "";
}

/**
 * 跑一轮评审。
 *
 * 与服务端的分工：服务端负责「一次只跑一轮」（回 409）与「有没有可评审的改动」（回 400），
 * 这里不再重复判断，照抄它给的那句话即可——两处各判一遍迟早会给出互相矛盾的说法。
 */
async function start() {
	if (busy) {
		setStatus("running", "已有一轮评审在跑，等它结束");
		return;
	}
	busy = true;
	startedAt = Date.now();
	baseInput.disabled = true;
	startButton.disabled = true;
	verdictLine.hidden = true;
	verdictLine.className = "lkx-review-verdict";
	setReport("评审中：几个评审者正在各跑一个角度，跑完由汇总者合成一篇报告。这一步可能要几分钟。");
	setStatus("running", `评审中 ${formatElapsed(0)}`);
	// 上一轮的仓库路径别留在这儿：这一轮还没结果，悬停却还说着上一轮的目录，最容易被当成事实。
	state.title = "";

	// 状态行每 500 毫秒报一次耗时：安静的几分钟里，界面得看得出它还在跑。
	const ticker = setInterval(() => {
		setStatus("running", `评审中 ${formatElapsed(Date.now() - startedAt)}`);
	}, 500);

	try {
		// 基线留空就传空串：服务端把空串当「没给」处理，于是比的是未提交的改动。
		const data = await api(REVIEW_PATH, { method: "POST", body: { base: baseInput.value.trim() } });
		const elapsed = formatElapsed(Date.now() - startedAt);
		const verdict = data.verdict === "block" ? "block" : "ok";
		showVerdict(verdict);
		setReport(data.report);
		// 失败的角度写在结论里（服务端已经说了一遍），状态行再点一次名，免得只看状态就以为全都跑完了。
		const failed = Array.isArray(data.failed) && data.failed.length > 0 ? ` · ${data.failed.join("、")}未完成` : "";
		setStatus(
			verdict === "block" ? "fail" : "ok",
			`${verdict === "block" ? "有 blocker" : "没有 blocker"} · ${countFiles(data.files)} · ${elapsed}${failed}`,
		);
		// 评的是哪个目录：网页上切换工作目录之后没有别的地方能确认这件事，所以挂在状态行的悬停提示里。
		if (typeof data.cwd === "string" && data.cwd !== "") {
			state.title = `评审的仓库目录：${data.cwd}`;
		}
	} catch (error) {
		const reason = error?.message ?? "未知错误";
		showVerdict(null);
		setReport(reason);
		// 409（已有一轮在跑）与 400（没有可评审的改动）都是服务端给的可读原因，原样显示。
		setStatus("fail", error?.status === 409 ? "已有一轮评审在跑" : reason);
	} finally {
		clearInterval(ticker);
		busy = false;
		baseInput.disabled = false;
		startButton.disabled = false;
	}
}

/**
 * 写结论徽标。
 *
 * 只认服务端给的两个值：`null`（这一轮没有结论）不显示。不自己从报告正文里找 `VERDICT:` 行——
 * 服务端的 `parseReviewVerdict` 才是判定依据，两处解析同一行迟早会不一致。
 */
function showVerdict(verdict) {
	if (verdict !== "block" && verdict !== "ok") {
		verdictLine.hidden = true;
		verdictLine.textContent = "";
		return;
	}
	verdictLine.className = `lkx-review-verdict ${verdict}`;
	verdictLine.textContent = `VERDICT: ${verdict}`;
	verdictLine.hidden = false;
	verdictLine.title = verdict === "block" ? "存在 blocker，先处理再合并" : "没有 blocker";
}

/** 渲染报告；内容来自模型，renderMarkdown 内部已做转义 */
function setReport(markdown) {
	report.innerHTML = renderMarkdown(markdown ?? "");
	report.scrollTop = 0;
}

/** 写状态（配色 + 符号 + 文字）；同一含义全用同一个符号，静态字符 */
function setStatus(kind, text) {
	state.className = `lkx-review-state ${kind}`;
	glyph.textContent = "";
	glyph.append(icon(kind === "running" ? "chevronRight" : kind === "fail" ? "close" : "check", 13));
	stateText.textContent = text;
}

/** 改动了几个文件；服务端没给或给了空数组时说「无改动」，不编数字 */
function countFiles(files) {
	const count = Array.isArray(files) ? files.length : 0;
	return count === 0 ? "无改动文件" : `${count} 个文件`;
}

/** 毫秒转 `12.3s` / `2 分 05 秒`；面板很窄，一分钟以内不写单位长尾 */
function formatElapsed(ms) {
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	return `${Math.floor(ms / 60_000)} 分 ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")} 秒`;
}
