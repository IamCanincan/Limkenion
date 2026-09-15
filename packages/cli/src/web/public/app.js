/*
 * Limkenion Web UI 入口。
 *
 * 手写原生 JS，没有构建步骤，没有依赖。这里只做两件事：初始化界面、把 DOM 事件接到
 * 各个模块上；具体逻辑分别在 state / api / render / sessions / session-list / preview /
 * theme / picker 里。
 */

import { api } from "./api.js";
import { initFeatures } from "./features.js";
import { initInputHistory } from "./input-history.js";
import { init as initJobs } from "./jobs.js";
import { initPicker } from "./picker.js";
import { closePreview, initPreviewResize } from "./preview.js";
import { appendError, followBottom, initTranscriptFollow } from "./render.js";
import { applyState } from "./session-list.js";
import { createSession, stop, submit } from "./sessions.js";
import { initSettings, loadCredentials } from "./settings.js";
import { openPanel } from "./shell.js";
import { el, state } from "./state.js";
import { init as initSubagents } from "./subagents.js";
import { initTheme } from "./theme.js";
import { init as initTodoDock } from "./todo-dock.js";
import { autoGrow, setStatus } from "./ui.js";

/*
 * applyState 从会话列表模块引入：那里面是「工作区头部 + 分组列表」一整套装配逻辑，
 * 首屏与切换工作目录后都走它。这里不再自己装一遍界面，免得两处走样。
 */

/** 切换模型：既改当前会话，也改新建会话的默认值 */
async function changeModel() {
	if (state.activeId) {
		await api(`/api/sessions/${encodeURIComponent(state.activeId)}/model`, {
			method: "POST",
			body: { model: el.model.value },
		}).catch(() => {});
	}
	await api("/api/model", { method: "POST", body: { model: el.model.value } }).catch(() => {});
}

/**
 * 代码块的复制按钮。
 *
 * 用事件代理而不是给每个按钮挂监听：代码块会随历史整体重绘，逐块绑定挂一次漏一次。
 */
function initCopyButtons() {
	el.transcript.addEventListener("click", (event) => {
		const button = event.target.closest?.(".code-copy");
		if (!button) {
			return;
		}
		const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
		void navigator.clipboard
			?.writeText(code)
			.then(() => {
				button.textContent = "已复制";
				setTimeout(() => {
					button.textContent = "复制";
				}, 1400);
			})
			.catch(() => {
				button.textContent = "复制失败";
			});
	});
}

// 「新建会话」= 新建一个会话并切过去。工作目录在会话的 ▾ 菜单里换（没有目录时这一步会先让你选一个）。
el.newSession.addEventListener("click", () => void createSession());
el.composer.addEventListener("submit", (event) => {
	event.preventDefault();
	void submit();
});
el.stop.addEventListener("click", () => void stop());
el.input.addEventListener("input", autoGrow);
el.input.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		void submit();
		return;
	}
	// Esc 中断当前这一轮：输入框聚焦时才算（弹层/选择器各自的 Esc 在别处，各管各的）
	if (event.key === "Escape" && state.running) {
		event.preventDefault();
		void stop();
	}
});
el.model.addEventListener("change", () => void changeModel());
el.previewClose.addEventListener("click", closePreview);

/**
 * 侧栏右边缘的拖柄：拖动改宽度。
 *
 * 宽度只活在这个页面里（不写 localStorage）：本仓库的界面偏好一律不落盘，刷新即回默认——
 * 主题跟随系统、面板开合也一样。双击复位，键盘 ←/→ 每次 24px，都走同一个 setSidebarWidth。
 */
function initSidebarResize() {
	const handle = document.querySelector(".sidebar-resize");
	if (!handle) {
		return;
	}
	const DEFAULT_WIDTH = 292;
	const MIN_WIDTH = 200;
	// 上限跟着窗口走：侧栏最多占一半，剩下的是对话区
	const maxWidth = () => Math.max(MIN_WIDTH, Math.min(520, Math.round(window.innerWidth / 2)));

	function setSidebarWidth(width) {
		const clamped = Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(width)));
		document.documentElement.style.setProperty("--lk-sidebar-width", `${clamped}px`);
		handle.setAttribute("aria-valuenow", String(clamped));
		return clamped;
	}
	const currentWidth = () => document.querySelector(".sidebar").getBoundingClientRect().width;

	let dragging = false;

	/** 拖动过程中的移动与松手都听在 document 上：指针一旦离开那条 8px 的窄边（拖快一点就会），
	 *  挂在拖柄自己身上就收不到后续事件了。 */
	function onMove(event) {
		if (!dragging) {
			return;
		}
		// 侧栏贴左边缘，所以指针的横坐标就是它该有的宽度
		setSidebarWidth(event.clientX);
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
		// 拖动时别选中文字、也别让光标在正文上变回箭头
		document.body.style.userSelect = "none";
		document.body.style.cursor = "col-resize";
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", stopDrag);
		document.addEventListener("pointercancel", stopDrag);
		event.preventDefault();
	});
	handle.addEventListener("dblclick", () => setSidebarWidth(DEFAULT_WIDTH));
	handle.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
			return;
		}
		event.preventDefault();
		setSidebarWidth(currentWidth() + (event.key === "ArrowRight" ? 24 : -24));
	});
	setSidebarWidth(currentWidth());
}

/**
 * 对话区宽度的拖柄：改的是 `--content-width`，消息、工具卡、确认卡与输入框共用这一个值，
 * 所以拖一下它们一起变（这也是「对话内容与输入框对齐」的实现方式：同一个 token）。
 *
 * 三件事：
 * - 左右各一条，内容列是居中的，所以指针的横坐标先换算成「离中线多远」再乘 2；
 * - **默认就是最长**（使用者要的）：启动时直接拉到主干区允许的上限，双击也是回到最长；
 *   用户自己拖窄之后就以他的选择为准，窗口再变也不动它（`pinnedToMax` 记这件事）。
 * - 不落盘，刷新回最长。
 */
function initContentResize() {
	const handles = [...document.querySelectorAll(".composer-resize")];
	if (handles.length === 0) {
		return;
	}
	// 下限别设太高：1280 开着面板时主干只有 ~516，上限（主干 −48）还不到 560，
	// 上下限撞在一起就变成「拖了没反应」。360 既能拖出明显差别，也还放得下一句话。
	const MIN_WIDTH = 360;
	// 上限跟着主干区走，两侧各留 24px，别把拖柄顶出可视区
	const maxWidth = () => {
		const main = document.querySelector(".main");
		const available = main === null ? window.innerWidth : main.getBoundingClientRect().width;
		return Math.max(MIN_WIDTH, Math.min(1600, Math.round(available - 48)));
	};

	// 还没被用户拖过：宽度跟着「最长」走（启动、窗口缩放都跟着变）
	let pinnedToMax = true;

	function setContentWidth(width) {
		const clamped = Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(width)));
		document.documentElement.style.setProperty("--content-width", `${clamped}px`);
		for (const node of handles) {
			node.setAttribute("aria-valuenow", String(clamped));
		}
		return clamped;
	}
	const currentWidth = () => document.querySelector(".composer-box").getBoundingClientRect().width;

	let dragging = null;
	function onMove(event) {
		if (dragging === null) {
			return;
		}
		const box = document.querySelector(".composer-box").getBoundingClientRect();
		const center = box.left + box.width / 2;
		// 内容是**居中**排的，两条拖柄方向相反：
		//   右边那条：宽 = 2 × (x − 中线)，往右拖变宽；
		//   左边那条：宽 = 2 × (中线 − x)，往**左**拖才变宽。
		// 两条用同一个式子的话，左拖柄往左拖只会算出负数、被夹到下限——表现就是「拉不动」（真踩过）。
		const outward = dragging.classList.contains("composer-resize-left") ? -1 : 1;
		pinnedToMax = false;
		setContentWidth((event.clientX - center) * 2 * outward);
	}
	function stopDrag() {
		if (dragging === null) {
			return;
		}
		dragging.dataset.dragging = "0";
		dragging = null;
		document.body.style.userSelect = "";
		document.body.style.cursor = "";
		document.removeEventListener("pointermove", onMove);
		document.removeEventListener("pointerup", stopDrag);
		document.removeEventListener("pointercancel", stopDrag);
	}
	for (const handle of handles) {
		handle.addEventListener("pointerdown", (event) => {
			dragging = handle;
			handle.dataset.dragging = "1";
			document.body.style.userSelect = "none";
			document.body.style.cursor = "col-resize";
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", stopDrag);
			document.addEventListener("pointercancel", stopDrag);
			event.preventDefault();
		});
		handle.addEventListener("dblclick", () => {
			pinnedToMax = true;
			setContentWidth(maxWidth());
		});
		handle.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
				return;
			}
			event.preventDefault();
			pinnedToMax = false;
			// 与拖动一致：右拖柄上 → 变宽；左拖柄上 ← 才是变宽
			const step = handle.classList.contains("composer-resize-left") ? -40 : 40;
			setContentWidth(currentWidth() + (event.key === "ArrowRight" ? step : -step));
		});
	}
	// 默认拉到最长。之后主干区**宽度一变**就跟着重算（只要用户还没自己拖过）：
	// 窗口缩放、侧栏拖动、面板开合都会改主干宽度，单听 window 的 resize 会漏掉后两者。
	setContentWidth(maxWidth());
	const main = document.querySelector(".main");
	if (main !== null && typeof ResizeObserver === "function") {
		new ResizeObserver(() => {
			if (pinnedToMax) {
				setContentWidth(maxWidth());
			}
		}).observe(main);
		return;
	}
	window.addEventListener("resize", () => {
		if (pinnedToMax) {
			setContentWidth(maxWidth());
		}
	});
}

/**
 * 量出对话区滚动条的宽度，写进 `--scrollbar-width`。
 *
 * 对话区要滚，输入框不滚：不补上这点宽度差，两边的可用宽度就差 10px，内容列与输入框永远对不齐。
 */
function measureScrollbar() {
	const transcript = document.querySelector(".transcript");
	if (transcript === null) {
		return;
	}
	// both-edges 会在两侧各留一条，所以这里只取一条的宽度
	const width = (transcript.offsetWidth - transcript.clientWidth) / 2;
	document.documentElement.style.setProperty("--scrollbar-width", `${Math.max(0, width)}px`);
}

/**
 * 「服务端换了新构建就自动刷新」。
 *
 * 本地工具没有指纹文件名，浏览器又可能长期开着标签页——页面内容靠 SSE 一直在更新，
 * 看起来是"活的"，但 JS 还是打开那一刻那一份：改了界面却看到旧样子（真踩过好几次）。
 * 这里在启动时记下 build id，每 5 秒比对一次；不一致且当前空闲（输入框空着）就刷新。
 */
let loadedBuild = null;

function watchBuild(build) {
	loadedBuild = build ?? null;
	// 也挂到 window 上：控制台里粘一行就能对比"页面是哪一份构建、服务端是哪一份"
	// （排查"看到旧界面"时用过：fetch('/api/build').then(r=>r.json()).then(b=>console.log(window.__lkBuild, b.build))）
	window.__lkBuild = loadedBuild;
}

/**
 * 有新版本就露一颗药丸，点了才刷新。
 *
 * 为什么不用"自动刷新"：门槛放宽会在我打字时把页面刷掉，收紧又会"改了没生效"——
 * 连续几轮都是这个坑（页面靠 SSE 一直活着，JS 却还是旧的）。让使用者看得见、自己决定最稳。
 */
let buildPill = null;

function showBuildPill() {
	if (buildPill !== null) {
		return;
	}
	const node = document.createElement("button");
	node.type = "button";
	node.className = "build-pill";
	node.textContent = "↺ 有新版本，点这里刷新";
	node.title = "服务端换了新构建，刷新后生效";
	node.addEventListener("click", () => location.reload());
	document.body.append(node);
	buildPill = node;
}

async function checkBuild() {
	if (loadedBuild === null) {
		return;
	}
	try {
		const answer = await fetch("/api/build", { cache: "no-store" });
		if (!answer.ok) {
			return;
		}
		const { build } = await answer.json();
		if (typeof build === "string" && build !== loadedBuild) {
			showBuildPill();
		}
	} catch {
		// 服务端暂时不可用（重启中）：下一轮再问
	}
}

setInterval(() => void checkBuild(), 5000);

/*
 * 目录选完之后一律整体重绘：服务端回的 `cwd` 就是「当前工作目录」——选中会话时它只挪那一个会话的
 * 目录、不重建注册表，但**会把当前工作目录一起挪过去**，所以面板、终端、新建会话的落点都跟着变，
 * 客户端不必分两条路走。
 */
initPicker(applyState);
initSettings();
initTheme();
// 输入框上方那条待办清单（数据来自服务端的会话事实，见 todo-dock.js）
initTodoDock();
// 后台任务那颗下拉（按会话轮询 /api/sessions/:id/jobs）
initJobs();
// 子代理那颗 chip 与谱系下拉（按会话轮询 /api/sessions/:id/subagents）
initSubagents();
initCopyButtons();
// 预览浮层左边缘那条拖柄（拖动改 --lk-preview-width）
initPreviewResize();
/**
 * 盯着输入框上方那排浮标：它出现/消失、折行数变了都会改高度，而它就排在对话区下面——
 * 对话区高度一变，滚动位置就"差一截"。这里只做一件事：跟着重新钉到底
 * （用户自己往上翻过的话，followBottom 什么都不做）。
 */
function initBadgesSpace() {
	const badges = document.querySelector(".composer-badges");
	if (badges === null || typeof ResizeObserver !== "function") {
		return;
	}
	const observer = new ResizeObserver(() => {
		// 不比较「浮标高度有没有变」：浮标高度没变、但**对话区自身**尺寸变了（窗口缩放、面板开合）
		// 同样需要重钉，比高度会把那种情况提前 return 掉（踩过）。
		// observer 只在尺寸真的变化时触发，所以这里不用担心空转。
		followBottom();
		// 下一拍再钉一次：布局有可能这一帧之后才落定
		requestAnimationFrame(() => followBottom());
	});
	observer.observe(badges);
	const transcript = document.getElementById("transcript");
	if (transcript !== null) {
		observer.observe(transcript);
	}
}

initSidebarResize();
initContentResize();
initBadgesSpace();
// 对话流的「跟随末尾 / 跳到最新」：流式输出时不再把用户正在进行的向上滚动顶回去
initTranscriptFollow();
// 历史输入：列出这一会话发过的输入，悬停看全文、点一条跳到对话里的那一条
initInputHistory();
measureScrollbar();
window.addEventListener("resize", measureScrollbar);

api("/api/state")
	.then((initial) => {
		// 记下这次加载的构建版本：之后与 /api/build 比对，不一致就自动刷新
		watchBuild(initial.build);
		return applyState(initial);
	})
	.catch((error) => {
		setStatus(`初始化失败：${error.message}`);
		appendError(error.message);
	});
// 密钥状态单独拉一次：它由服务端按「命令行 > 环境变量 > 本地凭据文件」解析，
// 与界面状态无关，没配密钥时也要能正常打开界面。
void loadCredentials();

// 各功能模块自己建 DOM、自己注入样式，这里只统一启动一次。
initFeatures();

/*
 * 右侧面板默认展开（与左侧栏一样）。
 *
 * 两个门槛，缺一个都会变成「默认帮倒忙」：
 * - 窄屏（≤700px）面板是**覆盖层**，默认展开会直接盖住对话；
 * - 再宽一点但三栏挤不下时也不能开：900px 下侧栏 240 + 面板 420 会把主干挤到 136px（实测），
 *   那还不如不开。要求开完还剩得下 MIN_MAIN_WIDTH 的对话区。
 * 默认落在「文件」那一栏——看代码是这里最常干的事，其余按需切。
 */
const MIN_MAIN_WIDTH = 440;
const PANEL_DEFAULT_WIDTH = 420;
const sidebarWidth = document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0;
if (window.innerWidth > 700 && window.innerWidth - sidebarWidth - PANEL_DEFAULT_WIDTH >= MIN_MAIN_WIDTH) {
	openPanel("files");
}
