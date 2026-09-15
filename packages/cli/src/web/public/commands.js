/*
 * 输入框里的斜杠命令菜单。
 *
 * 命令行敲 `/commit 顺手改个错字` 会走 handleCommand：正文取自 <配置目录>/commands/commit.md，
 * `$ARGUMENTS` 替换成参数，再当成这一轮的指令发给模型。网页原先没有这一层，同一行文字会被原样
 * 发出去。本模块把「有哪些命令」摆出来，并且在提交前不做任何替换——展开一律在服务端
 * （runs.ts 的 expandSlashCommand），客户端只负责把 `/名字 ` 插进输入框，两边因此不会各写一套规则。
 *
 * 三件必须做对的事：
 * 1. **菜单挂在 body 上、position: fixed**：输入区所在的 .main 设了 overflow: hidden，
 *    留在它里面的定位菜单会被整个裁掉（顶部栏的模式菜单就这么废过一轮）。坐标按输入框的位置算，
 *    滚动（捕获阶段，才收得到对话区的滚动）与缩放时重算。
 * 2. **键盘要先拦下来**：外壳在 el.input 上绑了「Enter 发送」，本模块的监听必须挂在 document 的
 *    捕获阶段并在命中时 stopPropagation——否则 Enter 会先把命令当成提示词发出去。
 * 3. **只有内置命令会被直接执行**（`/clear` 交给侧栏那颗按钮，连二次确认一起复用）；
 *    自定义命令只插入文本，参数由用户接着敲，展开在服务端做。
 *
 * DOM 与样式都由本模块自己建（注入 <style>），类名统一 lkx-cmd 前缀，不改 index.html 与 app.css。
 * 样式只用 app.css 已有的 MD3 变量与 token，不加动画。
 */

import { api } from "./api.js";
import { clearContext } from "./sessions.js";
import { el } from "./state.js";
import { autoGrow } from "./ui.js";

/** 命令清单端点 */
const COMMANDS_PATH = "/api/commands";

/**
 * 网页里真有落点的内置命令。
 *
 * 只列 `/clear` 一条：审批 / 计划 / 风格已经是顶部栏的 chip，`/model`、`/rewind`、`/approvals`
 * 在侧栏各有一颗按钮。`/review` 没有列：真正开始评审的那个动作（review.js 的 start）没有对外导出，
 * 只把面板打开、还得用户自己再点一次「开始评审」，那不算把命令接通了。
 *
 * 命令行那份 HELP 在 repl.ts 里，它既不是导出的、又依赖 node:readline，浏览器不可能 import；
 * 与其抄一份会漂移的清单，不如让这里只放「网页确实能执行」的那一条。
 */
const BUILTINS = [
	{
		name: "clear",
		description: "清空上下文：模型忘掉之前的对话，会话文件仍保留",
		// 走会话模块那一个函数（不再去点侧栏那颗按钮——它已经收进会话行菜单了）。
		// 确认文案留在这里：斜杠命令是「打出来就执行」，更该问一句。
		run: () => {
			if (!window.confirm("清空上下文？模型会忘掉之前的对话，会话文件仍然保留。")) {
				return;
			}
			void clearContext();
		},
	},
];

/** 本模块的样式；用一次就够。颜色与尺度只用 app.css 已有的 token */
const STYLE = /* css */ `
/* 菜单：挂在 body 上、fixed 定位。坐标由 position() 每次打开时按输入框的位置算，所以这里不写 top/left */
.lkx-cmd {
	position: fixed;
	z-index: 45;
	display: flex;
	flex-direction: column;
	max-height: min(320px, 45vh);
	padding: var(--space-1);
	border: 1px solid var(--border);
	border-radius: var(--radius-md);
	background: var(--surface-glass-strong);
	backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	-webkit-backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	box-shadow: var(--shadow-lg);
	overflow-y: auto;
}
.lkx-cmd[hidden] {
	display: none;
}

/* 分组标题：内置命令在前、自定义命令在后，两段各自有个小标题 */
.lkx-cmd-group {
	padding: var(--space-1) var(--space-2) 2px;
	color: var(--muted);
	font-size: var(--text-xs);
}

/* 一条命令：名字 + 参数提示 + 一句话说明。说明长了截断，不折行、不撑宽菜单 */
.lkx-cmd-item {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	width: 100%;
	padding: 6px 10px;
	border: 0;
	/* 与浮层同心：外层 --radius-md(24) − 间距 --space-1(4) = 20 */
	border-radius: calc(var(--radius-md) - var(--space-1));
	background: transparent;
	color: var(--text);
	font: inherit;
	font-size: var(--text-sm);
	text-align: left;
	cursor: pointer;
}
.lkx-cmd-item:hover {
	background: var(--surface-3);
}

/* 键盘当前位置：焦点一直在输入框里，菜单项拿不到 :focus，所以位置得自己画出来 */
.lkx-cmd-item[aria-selected="true"] {
	background: var(--accent-soft);
	color: var(--accent-text);
}

.lkx-cmd-name {
	flex: 0 0 auto;
	font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
	white-space: nowrap;
}
.lkx-cmd-hint {
	flex: 0 0 auto;
	color: var(--muted);
	font-size: var(--text-xs);
	white-space: nowrap;
}
.lkx-cmd-desc {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	color: var(--muted);
	font-size: var(--text-xs);
	white-space: nowrap;
	text-overflow: ellipsis;
}
.lkx-cmd-empty {
	padding: var(--space-2);
	color: var(--muted);
	font-size: var(--text-xs);
}
`;

/** 菜单根节点（挂在 body 上） */
let menu = null;

/** 全部候选：内置在前、自定义在后 */
let entries = [...BUILTINS.map((entry) => ({ ...entry, builtin: true }))];

/** 当前筛选出来的候选；cursor 是它在里面的下标 */
let filtered = [];

/** 键盘位置 */
let cursor = 0;

/** 菜单是否开着 */
let open = false;

/** 当前的筛选串（`/` 后面那一段），用来判断要不要把光标拨回第一条 */
let query = "";

/** 自定义命令的拉取状态：同时只拉一次，失败在菜单里留一行说明 */
let loading = false;

/** 拉取失败时的原因；空串表示上一次成功 */
let loadError = "";

/** Esc 收起时的输入值：同一个值不再自动弹出来，改一个字才重新考虑 */
let dismissed = null;

/** 注入本模块的样式；重复调用只注入一次 */
function injectStyle() {
	if (document.getElementById("lkx-cmd-style")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "lkx-cmd-style";
	style.textContent = STYLE;
	document.head.append(style);
}

/** 建菜单容器；只建一次，之后只换里面的条目 */
function buildMenu() {
	menu = document.createElement("div");
	menu.className = "lkx-cmd";
	menu.hidden = true;
	menu.setAttribute("role", "listbox");
	menu.setAttribute("aria-label", "斜杠命令");
	/*
	 * 菜单不能留在输入区里：.main 为了不让顶部栏与输入区撑宽窗口设了 overflow: hidden，
	 * 挂在里面的浮层会被裁掉。挂到 body 上再 fixed 定位，才既不受祖先 overflow 影响，
	 * 也不跟着对话区一起滚。
	 */
	document.body.append(menu);
}

/** 按当前输入重新筛选、重画、重摆位置 */
function refresh() {
	const next = menu === null ? "" : el.input.value.slice(1).toLowerCase();
	if (next !== query) {
		query = next;
		// 筛选条件一变就把光标拨回第一条：换了关键词还停在旧下标上，按回车选中的不是看到的那条。
		cursor = 0;
	}
	filtered = entries.filter((entry) => entry.name.toLowerCase().startsWith(query));
	if (cursor >= filtered.length) {
		cursor = Math.max(filtered.length - 1, 0);
	}
	render();
	position();
}

/** 重画条目：分组标题 + 每一条命令 */
function render() {
	menu.replaceChildren();
	if (filtered.length === 0) {
		const empty = document.createElement("div");
		empty.className = "lkx-cmd-empty";
		empty.textContent = loadError === "" ? "没有匹配的命令" : `自定义命令读取失败：${loadError}`;
		menu.append(empty);
		return;
	}
	let group = "";
	filtered.forEach((entry, index) => {
		const label = entry.builtin ? "内置命令" : "自定义命令";
		if (label !== group) {
			group = label;
			const head = document.createElement("div");
			head.className = "lkx-cmd-group";
			head.textContent = label;
			menu.append(head);
		}

		const item = document.createElement("button");
		item.type = "button";
		item.className = "lkx-cmd-item";
		item.setAttribute("role", "option");
		item.setAttribute("aria-selected", String(index === cursor));
		item.title = entry.description;

		const name = document.createElement("span");
		name.className = "lkx-cmd-name";
		name.textContent = `/${entry.name}`;
		item.append(name);
		if (entry.argumentHint !== undefined && entry.argumentHint !== "") {
			const hint = document.createElement("span");
			hint.className = "lkx-cmd-hint";
			hint.textContent = entry.argumentHint;
			item.append(hint);
		}
		const desc = document.createElement("span");
		desc.className = "lkx-cmd-desc";
		desc.textContent = entry.description;
		item.append(desc);

		// 先按住 mousedown：不然输入框当场失焦，光标位置也就丢了（点击本身照常派发）。
		item.addEventListener("mousedown", (event) => event.preventDefault());
		item.addEventListener("click", () => accept(index));
		menu.append(item);
	});

	// 上一次拉清单失败时在末尾补一行：内置那几条照旧能用，但用户得知道自定义那一段这次没读到。
	if (loadError !== "") {
		const failed = document.createElement("div");
		failed.className = "lkx-cmd-empty";
		failed.textContent = `自定义命令读取失败：${loadError}`;
		menu.append(failed);
	}
}

/**
 * 把菜单摆到输入框正上方（上面放不下就翻到下面），左右夹在视口内。
 *
 * fixed 定位就得自己跟着输入框走：对话区会滚动、窗口会缩放，菜单不能停在旧坐标上。
 */
function position() {
	const anchor = el.input.getBoundingClientRect();
	const margin = 8;
	// 宽度跟输入框一致（夹一个下限，免得窄屏下压成一条），说明太长时靠 ellipsis 截断。
	const width = Math.min(Math.max(anchor.width, 260), window.innerWidth - margin * 2);
	menu.style.width = `${Math.round(width)}px`;
	// 先定宽再量高：宽度会影响条目折行，进而影响真实高度。
	const height = menu.getBoundingClientRect().height;
	const left = Math.min(Math.max(anchor.left, margin), Math.max(window.innerWidth - width - margin, margin));
	const above = anchor.top - height - 6;
	const top = above >= margin ? above : anchor.bottom + 6;
	menu.style.left = `${Math.round(left)}px`;
	menu.style.top = `${Math.round(Math.min(Math.max(top, margin), Math.max(window.innerHeight - height - margin, margin)))}px`;
}

/** 打开菜单并刷新内容；自定义命令会顺手重新拉一次，好让新放进目录的文件当场出现 */
function openMenu() {
	if (!open) {
		open = true;
		menu.hidden = false;
	}
	refresh();
	void loadCustom();
}

/** 收起菜单 */
function closeMenu() {
	if (!open) {
		return;
	}
	open = false;
	menu.hidden = true;
}

/**
 * 拉一次自定义命令清单。
 *
 * 失败不打断输入（命令菜单少一段而已）：原因记下来，下次打开时在菜单里写一行，比弹个错误框安静。
 * 同时只允许一个请求在飞，连续敲 `/` 不会堆起一串。
 */
async function loadCustom() {
	if (loading) {
		return;
	}
	loading = true;
	try {
		const data = await api(COMMANDS_PATH);
		const list = Array.isArray(data.commands) ? data.commands : [];
		const customs = list
			.map((command) => ({
				name: typeof command.name === "string" ? command.name : "",
				description: typeof command.description === "string" ? command.description : "",
				argumentHint: typeof command.argumentHint === "string" ? command.argumentHint : "",
				builtin: false,
			}))
			.filter((entry) => entry.name !== "");
		entries = [...BUILTINS.map((entry) => ({ ...entry, builtin: true })), ...customs];
		loadError = "";
	} catch (error) {
		loadError = error?.message ?? "未知错误";
	} finally {
		loading = false;
	}
	// 拉取期间菜单可能已经被收起或又敲了几个字：只在还开着时重画。
	if (open) {
		refresh();
	}
}

/** 用一段文本替换输入框内容，并把光标放到末尾 */
function setInput(value) {
	el.input.value = value;
	el.input.setSelectionRange(value.length, value.length);
	autoGrow();
	el.input.focus();
}

/**
 * 选中一条命令。
 *
 * 内置命令直接执行（`/clear` 会弹它自己的二次确认）；自定义命令只插入 `/名字 `——参数留给用户敲，
 * 回车发送之后由服务端展开 `$ARGUMENTS`。
 */
function accept(index) {
	const entry = filtered[index];
	if (entry === undefined) {
		return;
	}
	closeMenu();
	if (entry.builtin) {
		// 命令已经执行了，输入框里的 `/clear` 留着只会让人以为还要再发一次。
		setInput("");
		entry.run();
		return;
	}
	dismissed = null;
	// 插入「/名字 」并留一个尾随空格：参数由用户接着敲，回车发送后由服务端展开 $ARGUMENTS。
	setInput(`/${entry.name} `);
}

/** 移动键盘位置；到头折回另一头，按着不动不会停在边界上没反应 */
function move(step) {
	if (filtered.length === 0) {
		return;
	}
	cursor = (cursor + step + filtered.length) % filtered.length;
	const items = menu.querySelectorAll(".lkx-cmd-item");
	items[cursor]?.setAttribute("aria-selected", "true");
	items.forEach((item, index) => {
		if (index !== cursor) {
			item.setAttribute("aria-selected", "false");
		}
	});
	// 条目多到要滚时，键盘选中的那条得跟在视口里（instant，不做动画）。
	items[cursor]?.scrollIntoView({ block: "nearest" });
}

/**
 * 输入事件：只在「输入框以 `/` 开头、且斜杠后面还没有空白或第二个斜杠」时弹菜单。
 *
 * 敲了空格（开始写参数）或第二个斜杠（`/etc/hosts` 这种路径）就收起——那时候用户要的已经不是菜单了。
 */
function onInput() {
	const value = el.input.value;
	if (value === dismissed) {
		closeMenu();
		return;
	}
	dismissed = null;
	if (!/^\/[^\s/]*$/.test(value)) {
		closeMenu();
		return;
	}
	openMenu();
}

/**
 * 键盘。
 *
 * 挂在 document 的捕获阶段：外壳在 el.input 上绑了「Enter 发送」，同一节点上的监听按注册顺序跑，
 * 本模块注册得比它晚，只有在捕获阶段并且 stopPropagation 才拦得住。
 */
function onKeyDown(event) {
	if (event.target !== el.input) {
		return;
	}
	if (!open) {
		// 菜单已经收起（比如按过 Esc），但输入框里正好只剩一条内置命令：它也不该被当成提示词发出去。
		if (event.key === "Enter" && !event.shiftKey) {
			const typed = el.input.value.trim();
			const builtin = BUILTINS.find((entry) => `/${entry.name}` === typed);
			if (builtin !== undefined) {
				event.preventDefault();
				event.stopPropagation();
				setInput("");
				builtin.run();
			}
		}
		return;
	}
	if (event.key === "ArrowDown") {
		event.preventDefault();
		event.stopPropagation();
		move(1);
		return;
	}
	if (event.key === "ArrowUp") {
		event.preventDefault();
		event.stopPropagation();
		move(-1);
		return;
	}
	if (event.key === "Enter" || event.key === "Tab") {
		// Tab 也当接受：菜单里能一路敲完，不必回到鼠标。
		event.preventDefault();
		event.stopPropagation();
		accept(cursor);
		return;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		dismissed = el.input.value;
		closeMenu();
	}
}

/** 初始化：建菜单、绑事件、先拉一次自定义命令 */
export function init() {
	injectStyle();
	buildMenu();

	el.input.addEventListener("input", onInput);
	document.addEventListener("keydown", onKeyDown, true);

	// 点空白处收起。用 composedPath 判断「点的是不是这个菜单」：菜单挂在 body 上，
	// 单看 target 的父链说不清，而事件本身带完整路径。
	document.addEventListener("click", (event) => {
		if (open && !event.composedPath().includes(menu)) {
			closeMenu();
		}
	});

	// 菜单是 fixed 定位，得自己跟着输入框走：对话区滚动、窗口缩放都会让旧坐标失效。
	// 用捕获阶段听 scroll，才能同时收到内部容器（对话区、输入框自己的滚动）。
	const follow = () => {
		if (open) {
			position();
		}
	};
	window.addEventListener("scroll", follow, true);
	window.addEventListener("resize", follow);

	void loadCustom();
}
