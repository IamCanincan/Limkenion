/*
 * 界面外壳：顶部应用栏 + 右侧面板。
 *
 * 之前每个功能都往侧栏和输入区挤，而那两处本来就满；上方与右侧反而是空的。这里把两块空间开出来，
 * 各功能只负责「注册」，不再自己造浮层——位置统一、样式统一，也不会互相覆盖。
 *
 * 布局：左侧会话栏（原样）｜中间「顶部栏 + 对话 + 输入区」｜右侧面板（默认收起，标签页切换）
 */

import { icon, SYMBOL_TO_ICON } from "./icons.js";

const STYLE = `/* lk-shell：顶部栏与右侧面板 */
/* 顶部栏永远是一行：flex-wrap: nowrap 禁止折行；overflow-x: auto 兜住"实在太窄"的情况——
   宁可让这一排入口自己横滚，也不让某个入口掉到第二行，更不让它被压成逐字折行的竖条。 */
.lk-topbar-slot { display: flex; flex-direction: column; flex: 0 0 auto; padding: var(--space-2) calc(32px + var(--scrollbar-width, 0px)) 0; }
/* 窄屏与合成器同档：合成器在 ≤860px 把左右内边距从 32 改成 18（见 app.css 的 .transcript, .composer），
   顶栏外层跟着改，两边才继续同宽同轴。断点必须与它一模一样——差 1px 就会在那一档错开 18px（踩过）。 */
@media (max-width: 860px) {
	.lk-topbar-slot { padding: var(--space-2) 18px 0; }
}
@media (max-width: 700px) {
	.lk-topbar-slot { padding: 6px 18px 0; }
}
/* width: 100% 是必须的：外层（.lk-topbar-slot）是 flex 列，而 flex 里 margin: auto 会阻止拉伸，
   顶栏于是按内容宽度撑开——360 下比输入框宽 111px（踩过）。 */
.lk-topbar { position: relative; display: flex; width: 100%; max-width: var(--content-width); margin: 0 auto; flex-wrap: nowrap; align-items: center; gap: var(--space-2); flex: 0 0 auto; min-width: 0; min-height: 46px; padding: var(--space-1); overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-pill); background: var(--surface-bar); backdrop-filter: blur(var(--blur-md)) saturate(var(--saturate-glass)); -webkit-backdrop-filter: blur(var(--blur-md)) saturate(var(--saturate-glass)); }
.lk-topbar-title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text-soft); font-size: var(--text-sm); }
.lk-topbar-spacer { flex: 1 1 auto; }
/* flex: 0 0 auto + white-space: nowrap：入口宽度由内容决定，既不参与收缩、也不逐字折行。
   少了这两条，主干区一窄（右面板打开、窗口又小）「尚无用量」那样的长标签就会拆成两行，
   整排入口高度参差、top 各不相同，看起来就是"顶部栏塌成了一竖列"。 */
.lk-topbar-item { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; white-space: nowrap; padding: 6px 10px; border: 1px solid transparent; border-radius: var(--radius-pill); background: transparent; color: var(--text-soft); font: inherit; font-size: var(--text-sm); cursor: pointer; }
/* 两端的按钮（侧栏 / 面板）拉伸到顶栏内高：这样它们的药丸半径 = 内高 ÷ 2，
   配合四边一致的内边距，两端圆弧就与顶栏两端的圆弧**共心**（使用者要求）。
   中间的入口保持原样：它们是普通药丸，不参与这件事。 */
.lk-topbar-item[data-lk-edge] { align-self: stretch; }
/* 窗口中等偏窄（≤1200px，例如开着面板的 1152）时顶栏会差 ~21px 溢出，最右的面板开关被挤出可视区。
   这时把「搜索」收成 ⌕（不动两端的侧栏/面板开关：它们要留在两端才谈得上共心）。 */
@media (max-width: 1200px) {
	.lk-topbar-item[data-lk-compact]:not([data-lk-edge]) > span:last-child { display: none; }
}

/*
 * 顶栏压缩到溢出时要有**能用鼠标拖**的滑块，但原生滑块不行（使用者两张截图）：
 *   - 它占在药丸底部，内容居中于"减掉滑块之后"的高度 → 上多下少（「上下距离不等」）；
 *   - 它压在药丸的圆角上，看着"超出了顶栏"。
 * 所以原生滑块统统藏掉（标准属性 + webkit 两套都写，免得 Chrome 认了其中一套漏了另一套），
 * 另放一条自绘的 4px 滑块（.lk-topbar-slider），只在真正溢出时露出，贴着药丸内底，
 * 拖动它或点轨道都能横移（见 initTopbarSlider）。
 */
.lk-topbar { scrollbar-width: none; }
.lk-topbar::-webkit-scrollbar { display: none; }
/* 独立在顶栏下面的一小条（不进顶栏的 DOM，不动它的结构）：40% 宽、居中，比顶栏短 */
.lk-topbar-slider { position: relative; width: 40%; max-width: 320px; height: 4px; margin: 5px auto 0; border-radius: var(--radius-pill); background: color-mix(in srgb, var(--text) 10%, transparent); cursor: pointer; }
.lk-topbar-slider[hidden] { display: none; }
.lk-topbar-slider-thumb { position: absolute; top: 0; bottom: 0; border-radius: var(--radius-pill); background: var(--border-strong); }
.lk-topbar-slider-thumb:hover { background: color-mix(in srgb, var(--accent) 70%, transparent); }

.lk-topbar-item:hover { background: var(--surface-3); }
.lk-topbar-item[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-text); }
/* 窗口不宽时（1280 这种：292 侧栏 + 400 面板只给主干区留 ~544px）把这一排收紧一点：
   间距与内边距各减几像素，七个入口正好排满一行，不必横滚、也不必缩写标签。
   1400 以上窗口够宽，保持原本的松紧度。 */
@media (max-width: 1400px) {
	.lk-topbar { gap: var(--space-1); }
	.lk-topbar-item { padding: 6px 8px; }
	.lk-topbar-title { margin-right: var(--space-2); }
}
/* 窄屏：顶栏四个入口（搜索 / 计划 / 审批 / 面板）按原宽度会溢出 ~59px，最右那颗被挤出可视区。
   面板开关收掉文字只留 ▤（它最右，符号也最好认，hover 有完整说明）；其余再各减一点内边距。 */
@media (max-width: 700px) {
	/* 顶栏这会儿是内嵌的药丸条：外边距与入口间距都收到最小，五个入口才放得下（实测差 8px） */
	.lk-topbar { padding: var(--space-1); gap: 0; }
	.lk-topbar-item[data-lk-compact] > span:last-child { display: none; }
	/* 3px：再收一点，五个入口在窄屏才不溢出（溢出会让最右那颗离开顶栏端头） */
	.lk-topbar-item { padding: 3px 3px; }
	/* 两端开关在窄屏只剩符号；图标也从 17 降到 16（桌面保持 17，窄屏优先放得下） */
	.lk-topbar-item[data-lk-edge] { padding: 3px 3px; }
	.lk-topbar-item[data-lk-edge] .lk-icon { width: 16px; height: 16px; }
}
/* 很窄的窗口（手机竖屏 460 这种）：三栏放不下。侧栏 292 + 面板最小内容宽 ~176 已经把
   主干区挤成 0，输入框会彻底消失。这里优先保对话：面板让位（display: none 压过 [hidden] 的
   display: flex），窗口一宽回来它照旧在。顶部栏则保持一行并自身横滚。 */
/* min-width: 0（原来的写法）是"主干区可以一直收窄"——但那样窗口一紧，对话就被压成一条（使用者截图）。
   现在改成**有下限**：440px 是"主干区还读得下去"的宽度（与 shell.js 的 PANEL_MIN_MAIN 同一个数）。
   放不下时由 .app 横向滚动兜底（见 app.css 的 .app），不再把对话压扁。
   overflow: hidden 仍是配套的第二半：主干区内部各块自己横滚，不许把整个页面撑宽。 */
/*
 * 下限是**软**的：有空间就给 440px（读得舒服），没空间就跟着让。
 * 硬写 440 会出事：620 宽 + 侧栏展开（292）时 292+440 = 732 > 620 → 整页冒出横向滚动条，
 * 它一出现就吃掉 ~9.45px 高度、输入框跳一下，高度变化又让判据翻转 → 来回抖
 * （使用者实测：composer 的 top 在 737.27 ↔ 746.73 之间反复跳，其余全部恒定）。
 * 侧栏那条自动收起仍按 440 判：够宽时收起侧栏，主干就真能拿到 440。
 */
.main { min-width: min(440px, calc(100vw - var(--lk-sidebar-width, 292px) - 40px)); overflow: hidden; }
/* 面板也有下限：正常由覆盖层判据保证主干区够宽；真到极限时宁可整页横向滚动，也不把面板压成一条。 */
.lk-panel { position: relative; display: flex; flex-direction: column; /* min-width 是压缩下限：再挤也要能读 */ min-width: 300px; flex: 0 0 var(--lk-panel-width, 420px); width: var(--lk-panel-width, 400px); min-width: 0; overflow: hidden; margin: 8px 8px 8px 0; border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--surface-glass-strong); backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass)); -webkit-backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass)); }
/* 面板左边缘的拖柄：与左侧栏那个同一套做法（平时透明、悬停/聚焦/拖动显一条强调色细线） */
/* 与卡片等长、压在左边那条描边上：面板本身 overflow: hidden，圆角会把它裁好 */
.lk-panel-resize { position: absolute; top: -1px; bottom: -1px; left: 0; width: 8px; z-index: 3; cursor: col-resize; touch-action: none; }
.lk-panel-resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 2px; background: transparent; }
.lk-panel-resize:hover::after,
.lk-panel-resize:focus-visible::after,
.lk-panel-resize[data-dragging="1"]::after { background: var(--accent); }
.lk-panel[hidden] { display: none; }
/* 窄窗媒体查询必须排在上面这些基础规则之后：同优先级下后来者胜，否则 display: flex 会把它盖掉。 */
/*
 * 放不下就变覆盖层：窗口减去侧栏与面板之后主干区不足 PANEL_MIN_MAIN 时，
 * shell.js 给面板加 data-lk-overlay="1"（原来只在 ≤700px 生效，靠媒体查询）。
 * 覆盖层形态下面板浮在对话之上、宽度由窗口决定，主干区因此不会被压扁。
 */
.lk-panel[data-lk-overlay="1"] {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 5;
		width: min(100vw, 420px);
		flex: 0 0 auto;
		margin: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-lg, 0 8px 28px rgba(0, 0, 0, 0.35));
	}
/* 覆盖层形态下面板宽度由窗口决定，拖柄没有意义（与左侧栏同一处理） */
.lk-panel[data-lk-overlay="1"] .lk-panel-resize {
	display: none;
}
/*
 * 面板头：四边都留 17px。
 * - 左与上：第一个标签（文件）的左端圆弧与卡片**左上角**共心——卡片圆角 32、标签帽半径 14（高 28 ÷ 2）、
 *   描边 1 → 内缩 32 − 14 − 1 = 17；
 * - 右：标签条铺满（space-between），最后一个标签（设置）的右端圆弧与卡片**右上角**共心，同样需要 17；
 * - 下：与上一致，标签在「顶边与分隔线」之间上下等距。
 * 四值写法：上 17、右 17、下 17、左 17（三值简写会把左边当成右边，踩过）。
 * 关面板用顶栏最右那颗开关或 Esc（头部原来的「✕」已按使用者要求去掉）。
 */
.lk-panel-head { display: flex; align-items: center; gap: var(--space-2); flex: 0 0 auto; padding: calc(var(--radius-xl) - 14px - 1px); border-bottom: 1px solid var(--border); }
/* 标签铺满整条：第一个贴左边、最后一个贴右边，两端才都能与卡片那两个角共心（
   面板够宽时 space-between 生效；面板被拖窄到放不下时自动退化成左压紧 + 横滚，与原来一致）。 */
.lk-panel-tabs { display: flex; align-items: center; justify-content: space-between; gap: 2px; flex: 1 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; }
/* 标签收紧一点：面板固定 400px 宽，六个标签（历史/设置/文件/终端/评审/体检）按原来的内边距会溢出
   55px，最后一个被切掉一半——看不见的标签等于没有。 */
.lk-panel-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; border: 1px solid transparent; border-radius: var(--radius-pill); background: transparent; color: var(--text-soft); font: inherit; font-size: var(--text-xs); white-space: nowrap; cursor: pointer; }
.lk-panel-tab:hover { background: var(--surface-3); }
.lk-panel-tab[aria-selected="true"] { background: var(--accent-soft); color: var(--accent-text); }
/* flex: 0 0 auto + margin-left: auto：无论标签条怎么滚，都跟它隔开 --space-2 并钉在最右。 */
/* 面板体统一内边距；三个功能的面板（终端 / 历史 / 文件）都在里面自己填满高度。 */
.lk-panel-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; padding: var(--space-4); overflow: auto; }`;

let tabs = [];
let activeId = null;
let shell = null;

/** 建壳；只建一次，DOM 就绪前调用会返回 null */
function ensureShell() {
	if (shell !== null) {
		return shell;
	}
	const main = document.querySelector(".main");
	const app = document.querySelector(".app");
	if (!main || !app) {
		return null;
	}
	const style = document.createElement("style");
	style.textContent = STYLE;
	document.head.append(style);

	const topbar = document.createElement("div");
	topbar.className = "lk-topbar";
	const title = document.createElement("span");
	title.className = "lk-topbar-title";
	const spacer = document.createElement("span");
	spacer.className = "lk-topbar-spacer";
	topbar.append(title, spacer);
	/*
	 * 顶栏外面套一层与合成器同款的外层：右边多让出 --scrollbar-width，因为对话区自己有滚动条，
	 * 内容列是按"去掉滚动条之后"居中的，而顶栏在对话区外面。这样顶栏才和输入框卡片同宽同轴。
	 */
	const topSlot = document.createElement("div");
	topSlot.className = "lk-topbar-slot";
	// 自绘滑块：只在顶栏真的溢出时露出来（拖动它或点轨道都能横移）
	const slider = document.createElement("div");
	slider.className = "lk-topbar-slider";
	slider.hidden = true;
	const sliderThumb = document.createElement("div");
	sliderThumb.className = "lk-topbar-slider-thumb";
	slider.append(sliderThumb);
	// 滑块是顶栏的**兄弟**：单独出来，不改顶栏内部结构
	initTopbarSlider(topbar, slider, sliderThumb);
	topSlot.append(topbar, slider);
	main.prepend(topSlot);

	const panel = document.createElement("aside");
	panel.className = "lk-panel";
	panel.hidden = true;
	const head = document.createElement("div");
	head.className = "lk-panel-head";
	const tabStrip = document.createElement("div");
	tabStrip.className = "lk-panel-tabs";
	// 关面板用顶栏最右那颗「▤ 面板」开关（Esc 也行）；头部这里的 ✕ 按使用者的要求去掉了
	head.append(tabStrip);
	const body = document.createElement("div");
	body.className = "lk-panel-body";
	// 面板左边缘的拖柄（做法与左侧栏那个一致，见 initPanelResize）
	const resize = document.createElement("div");
	resize.className = "lk-panel-resize";
	resize.setAttribute("role", "separator");
	resize.setAttribute("aria-orientation", "vertical");
	resize.setAttribute("aria-label", "调整右侧面板宽度");
	resize.tabIndex = 0;
	resize.title = "拖动调整面板宽度（双击复位，键盘 ←/→ 也能调）";
	panel.append(head, body, resize);
	app.append(panel);
	initPanelResize(panel, resize);
	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !panel.hidden) {
			closePanel();
		}
	});

	shell = { topbar, panel, tabStrip, body, title };
	/*
	 * 两侧各一个开关，形状一样：左边收起侧栏、右边开合面板。
	 *
	 * 侧栏默认是打开的（它承载会话列表），关掉之后主干区独占整行；符号随状态翻（▾ 开着 / ▸ 收起），
	 * 与分组标题的展开收起同义。面板开关的说明见下面那一段。
	 */
	sidebarToggle = addTopBarAction({
		// 四分格（使用者指定的形状）。17px：这类图标线条细，15px 时显得比旁边小
		icon: "layout",
		iconSize: 17,
		label: "侧栏",
		title: "收起左侧栏（会话列表）",
		onClick: () => toggleSidebar(),
	});
	if (sidebarToggle !== null) {
		// 控制左边的开关就放在最左
		sidebarToggle.style.order = "-1";
		// 窄屏下只留 ▾ / ▸（与右侧面板那颗同一个处理）：顶栏窄，文字会把别的入口挤出去
		sidebarToggle.dataset.lkCompact = "1";
		// 它是顶栏最左那颗：拉伸到内高，圆弧才好与顶栏左端共心
		sidebarToggle.dataset.lkEdge = "1";
	}
	toggleButton = addTopBarAction({
		// 三条横（使用者指定的形状）
		icon: "lines",
		iconSize: 17,
		label: "面板",
		title: "打开右侧面板（文件 / 历史 / 终端 / 评审 / 体检 / 设置）",
		onClick: () => togglePanel(),
	});
	// order 把外壳先建的这一颗排到最右：读起来是「侧栏 → 搜索 → 计划 → 审批 → 面板」。
	if (toggleButton !== null) {
		toggleButton.style.order = "10";
		// 窄屏下只留 ▤（见 STYLE 里那条媒体查询）：它排在最右，收掉文字才不会把左边的入口挤出去。
		toggleButton.dataset.lkCompact = "1";
		// 它是顶栏最右那颗：同上
		toggleButton.dataset.lkEdge = "1";
	}
	syncToggle();
	syncSidebarToggle();
	syncPanelOverlay();
	window.addEventListener("resize", syncPanelOverlay);
	// 盯住三块：侧栏宽度可拖；面板与预览的显隐就是尺寸 0 ↔ 420，所以显隐也会触发。
	// 注意变量名是外层那个 shell，不是 root——写错会在 ensureShell 里抛 ReferenceError，
	// 而 addTopBarAction 是各功能模块在 init 里调的，一抛就把那个入口整个吞掉（搜索就这么"没了"，踩过）。
	const layoutNodes = [document.querySelector(".sidebar"), shell.panel, document.getElementById("preview")];
	for (const node of layoutNodes) {
		if (node !== null) {
			new ResizeObserver(syncPanelOverlay).observe(node);
		}
	}
	return shell;
}

/** 顶栏那个面板开关的按钮；由 ensureShell 建一次，closePanel/openPanel 负责同步它的 aria-pressed */
let toggleButton = null;

/** 顶栏那个侧栏开关；同样由 ensureShell 建一次 */
let sidebarToggle = null;

/** 侧栏（会话列表）现在是不是开着 */
export function sidebarOpen() {
	const sidebar = document.querySelector(".sidebar");
	return sidebar !== null && !sidebar.hidden;
}

/**
 * 右侧面板左边缘的拖柄：拖动改 `--lk-panel-width`。
 *
 * 与左侧栏那套一致（宽度不落盘、双击复位、键盘可调、窄屏隐藏），只有两点方向相反：
 * 面板贴右边缘，所以「指针的横坐标」要换算成 `窗口宽 - x`；键盘 ← 是**变宽**（手柄往左拖就是变宽）。
 */
function initPanelResize(panel, handle) {
	const DEFAULT_WIDTH = 420;
	const MIN_WIDTH = 280;
	// 上限跟着窗口走：面板最多 640，且给主干区留 420px——拉到 720 时对话区只剩 206px，输入框会挤成一条。
	const maxWidth = () => Math.max(MIN_WIDTH, Math.min(640, window.innerWidth - 420));

	function setPanelWidth(width) {
		const clamped = Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(width)));
		document.documentElement.style.setProperty("--lk-panel-width", `${clamped}px`);
		handle.setAttribute("aria-valuenow", String(clamped));
		return clamped;
	}
	const currentWidth = () => panel.getBoundingClientRect().width;

	let dragging = false;
	function onMove(event) {
		if (dragging) {
			setPanelWidth(window.innerWidth - event.clientX);
		}
	}
	function stopDrag() {
		if (!dragging) {
			return;
		}
		dragging = false;
		handle.dataset.dragging = "0";
		document.body.style.userSelect = "";
		document.body.style.cursor = "";
		document.removeEventListener("pointermove", onMove);
		document.removeEventListener("pointerup", stopDrag);
		document.removeEventListener("pointercancel", stopDrag);
	}
	handle.addEventListener("pointerdown", (event) => {
		dragging = true;
		handle.dataset.dragging = "1";
		document.body.style.userSelect = "none";
		document.body.style.cursor = "col-resize";
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", stopDrag);
		document.addEventListener("pointercancel", stopDrag);
		event.preventDefault();
	});
	handle.addEventListener("dblclick", () => setPanelWidth(DEFAULT_WIDTH));
	handle.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
			return;
		}
		event.preventDefault();
		// 手柄在面板左边：往左 = 变宽
		setPanelWidth(currentWidth() + (event.key === "ArrowLeft" ? 24 : -24));
	});
}

/**
 * 收起 / 展开左侧栏。
 *
 * 用 `hidden` 属性而不是删节点：会话列表、分组折叠状态、正在跑的那一行都在里面，收起来只是看不见。
 * 不落盘（界面偏好一律不落盘），所以刷新之后回到默认的「打开」。
 */
export function toggleSidebar() {
	const sidebar = document.querySelector(".sidebar");
	if (sidebar === null) {
		return;
	}
	sidebar.hidden = !sidebar.hidden;
	syncSidebarToggle();
}

/** 把侧栏开关的符号与状态同步成侧栏真实的开合 */
function syncSidebarToggle() {
	if (sidebarToggle === null) {
		return;
	}
	const open = sidebarOpen();
	// 只在"从关到开"时登记打开顺序：每次 sync 都登记的话它会一直是最新的，永远轮不到它被顶掉
	if (open && !sidebarWasOpen) {
		noteLayoutOpened("sidebar");
	}
	sidebarWasOpen = open;
	// 四分格就一种形状（没有"左栏"可分），开关状态由 aria-pressed 的强调色表达，与面板那颗三条横一致
	sidebarToggle.setAttribute("aria-pressed", open ? "true" : "false");
	sidebarToggle.title = open ? "收起左侧栏（会话列表）" : "展开左侧栏（会话列表）";
}

/**
 * 顶栏的自绘滑块：溢出才显示；宽度/位置按 scrollWidth 换算；拖动与点轨道都同步 scrollLeft。
 * 每次滚动/尺寸变化都重算（顶栏内容会随窗口与面板开合变化）。
 */
function initTopbarSlider(bar, slider, thumb) {
	const sync = () => {
		const overflow = bar.scrollWidth - bar.clientWidth;
		if (overflow <= 1) {
			slider.hidden = true;
			return;
		}
		slider.hidden = false;
		const track = slider.clientWidth;
		const ratio = bar.clientWidth / bar.scrollWidth;
		const thumbWidth = Math.max(24, Math.round(track * ratio));
		thumb.style.width = `${thumbWidth}px`;
		const movable = track - thumbWidth;
		// 位置 = 滚动进度 × 可移动距离；scrollLeft 增大 = 内容往左走 = thumb 往右，
		// 与拖 thumb（右移 → scrollLeft 增大）和滚轮同向。
		const progress = overflow === 0 ? 0 : bar.scrollLeft / overflow;
		thumb.style.left = `${Math.round(movable * progress)}px`;
	};
	bar.addEventListener("scroll", sync, { passive: true });
	window.addEventListener("resize", sync);
	new ResizeObserver(sync).observe(bar);
	// 拖动滑块
	thumb.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		thumb.setPointerCapture(event.pointerId);
		const startX = event.clientX;
		const startLeft = bar.scrollLeft;
		const track = slider.clientWidth;
		const thumbWidth = thumb.getBoundingClientRect().width;
		const movable = Math.max(1, track - thumbWidth);
		const move = (moveEvent) => {
			const delta = ((moveEvent.clientX - startX) / movable) * (bar.scrollWidth - bar.clientWidth);
			bar.scrollLeft = startLeft + delta;
		};
		const up = () => {
			thumb.removeEventListener("pointermove", move);
			thumb.removeEventListener("pointerup", up);
		};
		thumb.addEventListener("pointermove", move);
		thumb.addEventListener("pointerup", up);
	});
	// 点轨道：翻一屏
	slider.addEventListener("pointerdown", (event) => {
		if (event.target === thumb) {
			return;
		}
		const box = slider.getBoundingClientRect();
		bar.scrollLeft += event.clientX < box.left + box.width / 2 ? -bar.clientWidth : bar.clientWidth;
	});
	sync();
}

/** 顶部栏右侧加一个动作按钮 */
export function addTopBarAction({ symbol = "", icon: iconName, iconSize = 15, label, title = "", onClick }) {
	const root = ensureShell();
	if (root === null) {
		return null;
	}
	const button = document.createElement("button");
	button.type = "button";
	button.className = "lk-topbar-item";
	button.title = title || label;
	const topIcon = iconName ?? SYMBOL_TO_ICON[symbol];
	if (topIcon !== undefined) {
		button.append(icon(topIcon, iconSize));
	} else if (symbol !== "") {
		const glyph = document.createElement("span");
		glyph.setAttribute("aria-hidden", "true");
		glyph.textContent = symbol;
		button.append(glyph);
	}
	const text = document.createElement("span");
	text.textContent = label;
	button.append(text);
	button.addEventListener("click", onClick);
	root.topbar.append(button);
	return button;
}

/**
 * 侧栏底部加一个会话级动作（与「回滚上一轮」「清空上下文」同一排）。
 *
 * 为什么要有这个入口：顶栏已经在窄屏下横向滚动，再往里塞开关会把控件挤出可视区；而侧栏底部那排
 * 本来就是「作用在当前会话上的动作」。插件因此不必去改 index.html——那是共享文件。
 *
 * 返回按钮元素，调用方自己改文案/状态（`textContent`、`disabled`）。
 */
export function addSidebarAction({ symbol = "", label, title = "", onClick }) {
	const root = ensureShell();
	if (root === null) {
		return null;
	}
	const foot = document.querySelector(".sidebar-foot");
	if (!foot) {
		return null;
	}
	const button = document.createElement("button");
	button.type = "button";
	button.className = "btn ghost small";
	button.title = title || label;
	const sideIcon = SYMBOL_TO_ICON[symbol];
	if (sideIcon !== undefined) {
		button.append(icon(sideIcon, 15));
	}
	const text = document.createElement("span");
	text.textContent = sideIcon === undefined && symbol !== "" ? `${symbol} ${label}` : label;
	button.append(text);
	button.addEventListener("click", onClick);
	foot.append(button);
	return button;
}

/** 顶部栏左侧的标题（会话摘要之类） */ export function setTopBarTitle(text) {
	const root = ensureShell();
	if (root !== null) {
		root.title.textContent = text;
	}
}

/** 注册右侧面板的一个标签页；build 只在它第一次被显示时调用 */
/**
 * 加一个右侧面板标签。
 *
 * `order` 决定标签条里的先后（小的在前，默认 100）：常用的文件 / 历史 / 终端在前，
 * 「设置」这种偶尔才开的排最后——标签位置本身就是在告诉用户哪个常用。
 */
export function addPanelTab({ id, symbol, icon: iconName, label, build, order = 100 }) {
	const root = ensureShell();
	if (root === null) {
		return;
	}
	const button = document.createElement("button");
	button.type = "button";
	button.className = "lk-panel-tab";
	button.title = label;
	// 面板标签：认识的老符号换成线性图标，剩下的照原样写文字（label 与图标之间由 CSS 的 gap 管）
	button.textContent = "";
	// 显式 icon 优先（同一个符号在不同语境下该用不同图标，例如 ↺ 在菜单里是「回滚」、在标签上是「历史」）
	const tabIcon = iconName ?? SYMBOL_TO_ICON[symbol];
	if (tabIcon !== undefined) {
		button.append(icon(tabIcon, 14));
	}
	const tabLabel = document.createElement("span");
	tabLabel.textContent = tabIcon === undefined && symbol !== "" ? `${symbol} ${label}` : label;
	button.append(tabLabel);
	button.dataset.lkOrder = String(order);
	button.addEventListener("click", () => openPanel(id));
	root.tabStrip.append(button);
	sortTabs();

	const container = document.createElement("div");
	container.hidden = true;
	root.body.append(container);
	tabs = tabs.filter((tab) => tab.id !== id).concat({ id, button, container, built: false, build });
	if (activeId === null) {
		activeId = id;
	}
}

/** 按 order 重排标签按钮（DOM 顺序 = 视觉顺序；新加的标签可能落在中间） */
function sortTabs() {
	const root = ensureShell();
	if (root === null) {
		return;
	}
	const sorted = [...root.tabStrip.children].sort(
		(left, right) => Number(left.dataset.lkOrder ?? 100) - Number(right.dataset.lkOrder ?? 100),
	);
	for (const button of sorted) {
		root.tabStrip.append(button);
	}
}

/** 打开面板并切标签；不传 id 就打开当前标签 */
export function openPanel(id = null) {
	const root = ensureShell();
	if (root === null) {
		return;
	}
	if (id !== null) {
		activeId = id;
	}
	root.panel.hidden = false;
	noteLayoutOpened("panel");
	// 面板一开就可能需要变覆盖层，立刻重算一次（别等 resize）
	syncPanelOverlay();
	syncToggle();
	for (const tab of tabs) {
		const active = tab.id === activeId;
		tab.button.setAttribute("aria-selected", active ? "true" : "false");
		tab.container.hidden = !active;
		if (active && !tab.built) {
			tab.built = true;
			try {
				tab.build(tab.container);
			} catch (error) {
				console.error(`[面板] ${tab.id} 构建失败`, error);
			}
		}
	}
}

/**
 * 面板开关：开着就收起，收起就打开（打开时回到上次那个标签）。
 *
 * 顶栏只留这一个入口：历史 / 文件 / 终端 / 评审 / 体检 本来都是面板自己的标签，
 * 在顶栏再各挂一个入口等于同一件事有两个地方可点，窄屏下还会把别的入口挤出去。
 */
export function togglePanel() {
	if (panelOpen()) {
		closePanel();
		return;
	}
	openPanel();
}

/** 收起面板 */
export function closePanel() {
	const root = ensureShell();
	if (root !== null) {
		root.panel.hidden = true;
		syncPanelOverlay();
	}
	syncToggle();
}

/** 把顶栏那个面板开关的状态同步成面板真实的开合 */
/**
 * 面板要不要变成覆盖层。
 *
 * 判据是"主干区还够不够宽"：窗口减去侧栏与面板之后不足 PANEL_MIN_MAIN 就变覆盖层——
 * 覆盖层浮在对话之上，主干区因此不会被三块挤成一条（使用者：「每一个横向拉伸的模块都应有一个压缩限制」）。
 * 侧栏宽度可拖，所以除了窗口缩放，也盯着侧栏的尺寸。
 */
const PANEL_MIN_MAIN = 440;
const PANEL_OVERLAY_BELOW = 700;

/**
 * 右侧可开合的三块（侧栏 / 预览 / 面板）的**打开顺序**。
 *
 * 同屏最多 3 块——含永远在的对话区，所以右侧最多两块。开新的一块就关掉最早那块；
 * 侧栏默认开着，因此"三个同屏"时先收起的就是侧栏（使用者要求）。
 */
const sideOrder = [];

/** 右侧最多两块（加上对话区正好三块） */
const MAX_SIDE_MODULES = 2;

/** 某一块被打开时调用：记进顺序，超了就关掉最早那块 */
export function noteLayoutOpened(id) {
	const index = sideOrder.indexOf(id);
	if (index >= 0) {
		sideOrder.splice(index, 1);
	}
	sideOrder.push(id);
	while (sideOrder.length > MAX_SIDE_MODULES) {
		closeLayoutModule(sideOrder.shift());
	}
}

/** 按 id 关掉一块（用各自的现成入口，不改状态机） */
function closeLayoutModule(id) {
	if (id === "sidebar") {
		const sidebar = document.querySelector(".sidebar");
		if (sidebar !== null && !sidebar.hidden) {
			sidebar.hidden = true;
			syncSidebarToggle();
		}
		return;
	}
	if (id === "preview") {
		void import("./preview.js").then((module) => module.closePreview());
		return;
	}
	if (id === "panel") {
		closePanel();
	}
}

let autoCollapsedSidebar = false;

/** 上一次侧的侧栏开合：用来只在"从关到开"时登记打开顺序 */
let sidebarWasOpen = false;

/** 侧栏收起前的宽度：收起后实测是 0，判据要用"它本来多宽"，否则会"收起→够宽→展开"来回抖（踩过） */
let lastSidebarWidth = 292;

/** 上一次自动收侧栏时的窗口宽度：同一次尺寸下只自动收一次，用户手动展开后不再抢着收 */
let lastAutoCollapseWidth = -1;

export function syncPanelOverlay() {
	const root = ensureShell();
	if (root === null) {
		return;
	}
	const sidebar = document.querySelector(".sidebar");
	let sidebarWidth = sidebar === null ? 0 : sidebar.getBoundingClientRect().width;
	const preview = document.getElementById("preview");
	const panelOpen = !root.panel.hidden;
	const previewOpen = preview !== null && !preview.hidden;
	const panelWidth = panelOpen ? root.panel.getBoundingClientRect().width || 420 : 0;
	const previewWidth = previewOpen && preview !== null ? preview.getBoundingClientRect().width || 420 : 0;
	// 够不够宽：窗口减去侧栏，再减去**所有开着的右侧模块**，剩下的给主干区
	const fits = (used) => window.innerWidth - sidebarWidth - used >= PANEL_MIN_MAIN;
	const narrowScreen = window.innerWidth <= PANEL_OVERLAY_BELOW;
	/*
	 * 先一起算：两个都开着时若加起来放不下，就**先让预览浮起来**（它是次要的），
	 * 再看面板单独放不放得下。原来各判各的，于是"每个都刚好放得下、合起来主干只剩几十像素"。
	 */
	const bothFit = fits(panelWidth + previewWidth);
	// 预览次要：两个加起来放不下就先让它浮起来
	const previewOverlay = previewOpen && (narrowScreen || !bothFit);
	// 面板：看它单独（或与浮起来之前的预览一起）还放不放得下
	const panelOverlay = panelOpen && (narrowScreen || !fits(panelWidth) || (!previewOpen && !bothFit));
	/*
	 * 「有新版本」药丸要跟"右下角那张卡片"的圆角同心。卡片有列/浮层两种形态，
	 * 它到视口右下角的距离不同（实测 50 / 40），所以这里算出真实值交给 CSS。
	 */
	const rightCards = [root.panel, preview].filter((node) => node !== null && !node.hidden);
	const rightCard = rightCards.length > 0 ? rightCards[rightCards.length - 1] : null;
	const cardRect = rightCard === null ? null : rightCard.getBoundingClientRect();
	const cardRadius =
		rightCard === null ? 32 : Number.parseFloat(getComputedStyle(rightCard).borderBottomRightRadius) || 32;
	const cornerInset =
		cardRect === null
			? 10 + cardRadius
			: Math.min(window.innerWidth - cardRect.right, window.innerHeight - cardRect.bottom) + cardRadius;
	document.documentElement.style.setProperty("--lk-card-corner-inset", `${Math.round(cornerInset)}px`);

	root.panel.dataset.lkOverlay = panelOverlay ? "1" : "0";
	if (preview !== null) {
		preview.dataset.lkOverlay = previewOverlay ? "1" : "0";
	}
	/*
	 * 两个都浮起来时，别让它们都贴 right: 0（会完全叠在一起，使用者截图）。
	 * 窗口放得下并排就给预览让出面板那一份宽度，放不下就保持 0（预览压在上面、可单独关掉）。
	 */
	/*
	 * 侧栏：窗口太窄时自动收起——不然侧栏 292 + 主干下限 440 = 732 在 620 宽的窗口里根本装不下，
	 * 只能横向滚动或把内容挤扁（使用者窗口是 620 CSS px，踩过）。
	 * 只收"我们自动收的"那一次：用户自己收起来的不动，宽回来才自动展开。
	 */
	const sidebarNode = document.querySelector(".sidebar");
	if (sidebarNode !== null) {
		const measuredSidebar = sidebarNode.getBoundingClientRect().width;
		if (measuredSidebar > 0) {
			lastSidebarWidth = measuredSidebar;
		}
		// 收起状态下 measured 是 0：此时判据要用它本来的宽度
		sidebarWidth = sidebarNode.hidden ? lastSidebarWidth : measuredSidebar;
		const widthChanged = window.innerWidth !== lastAutoCollapseWidth;
		if (widthChanged && window.innerWidth - sidebarWidth < PANEL_MIN_MAIN) {
			// 只在窗口尺寸变化时自动收一次：用户手动展开之后不再抢着收（否则变成跟用户抢）
			lastAutoCollapseWidth = window.innerWidth;
			if (!sidebarNode.hidden) {
				sidebarNode.hidden = true;
				autoCollapsedSidebar = true;
			}
		} else if (widthChanged && autoCollapsedSidebar) {
			sidebarNode.hidden = false;
			autoCollapsedSidebar = false;
		}
	}
	const occupied = panelOverlay ? panelWidth + 16 : 0;
	const roomForBoth = window.innerWidth >= panelWidth + previewWidth + 32;
	document.documentElement.style.setProperty(
		"--lk-overlay-stack",
		panelOverlay && previewOverlay && roomForBoth ? `${Math.round(occupied)}px` : "0px",
	);
}

function syncToggle() {
	if (toggleButton !== null) {
		// 面板开关是三條横，形状不随状态变；开着时靠 aria-pressed 的强调色表达
		toggleButton.setAttribute("aria-pressed", panelOpen() ? "true" : "false");
	}
}

/** 面板是否开着，供顶部按钮同步 aria-pressed */
export function panelOpen() {
	const root = ensureShell();
	return root !== null && !root.panel.hidden;
}
