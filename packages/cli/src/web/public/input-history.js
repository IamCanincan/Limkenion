/*
 * 历史输入：把这一会话里发过的输入列出来，悬停看全文、点一条就跳到对话里的那一条。
 *
 * 数据直接从对话流里取——`.turn.user` 就是一条用户输入，界面上已经渲染出来的东西就是唯一事实，
 * 不必再问服务端要一遍；「跳转」也只是滚动到那个节点并高亮一下。
 *
 * 浮层与预览卡都挂在 body 上、用 fixed 定位（见 AGENTS.md：顶栏与对话区都有 overflow，
 * 挂在里面会被裁掉），坐标每次打开时按那颗按钮算。样式必须用 lkx- 前缀：模块样式是运行时注入的，
 * 短类名会和别的模块撞车。
 */

import { icon } from "./icons.js";

const STYLE = /* css */ `
/* 输入框动作行里那颗「历史输入」：与「跳到最新」「上下文压缩」同一套药丸外形 */
.lkx-inputs-chip {
	flex: 0 0 auto;
	padding: 3px 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius-pill);
	background: var(--surface-3);
	color: var(--muted);
	font: inherit;
	font-size: var(--text-xs);
	white-space: nowrap;
	cursor: pointer;
}
.lkx-inputs-chip:hover {
	border-color: var(--border-strong);
	color: var(--text);
}
/* 很窄的窗口：动作行放不下文字，只留 ▸（条数在 title 里） */
@media (max-width: 700px) {
	.lkx-inputs-chip-label {
		display: none;
	}
}
.lkx-inputs-chip[aria-expanded="true"] {
	background: var(--accent-soft);
	color: var(--accent-text);
}

/* 清单：与命令菜单同一种浮层（挂 body、fixed、毛玻璃） */
.lkx-inputs {
	position: fixed;
	z-index: 45;
	display: flex;
	flex-direction: column;
	max-height: min(340px, 50vh);
	padding: var(--space-1);
	border: 1px solid var(--border);
	border-radius: var(--radius-md);
	background: var(--surface-glass-strong);
	backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	-webkit-backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	box-shadow: var(--shadow-lg);
	overflow-y: auto;
}
.lkx-inputs[hidden] {
	display: none;
}

/* 头部两段：粗标签 + 淡说明（与设置卡片、两个菜单同一套层次） */
.lkx-inputs-head {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	min-width: 0;
	padding: var(--space-1) var(--space-2) 2px;
}
.lkx-inputs-label {
	flex: 0 0 auto;
	color: var(--text);
	font-size: var(--text-sm);
	font-weight: 600;
}
.lkx-inputs-detail {
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	color: var(--muted);
	font-size: var(--text-xs);
}

/* 一条输入：序号 + 预览。与浮层留白同心（24 - 4 = 20） */
.lkx-inputs-item {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	width: 100%;
	padding: 6px 10px;
	border: 0;
	border-radius: calc(var(--radius-md) - var(--space-1));
	background: transparent;
	color: var(--text);
	font: inherit;
	font-size: var(--text-sm);
	text-align: left;
	cursor: pointer;
}
.lkx-inputs-item:hover {
	background: var(--surface-3);
}
/* 焦点一直留在按钮上时条目拿不到 :focus，所以当前位置自己画 */
.lkx-inputs-item[aria-selected="true"] {
	background: var(--accent-soft);
	color: var(--accent-text);
}
.lkx-inputs-index {
	flex: 0 0 auto;
	color: var(--muted);
	font-family: var(--font-mono, ui-monospace, monospace);
	font-size: var(--text-xs);
}
.lkx-inputs-body {
	display: flex;
	flex: 1 1 auto;
	flex-direction: column;
	gap: 1px;
	min-width: 0;
}
.lkx-inputs-preview {
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}
/* 第二行：这条输入得到的回答（截断预览，全文在悬停卡片里） */
.lkx-inputs-answer {
	min-width: 0;
	overflow: hidden;
	color: var(--muted);
	font-size: var(--text-xs);
	white-space: nowrap;
	text-overflow: ellipsis;
}

/* 悬停预览卡：显示那条输入的全文，长了就自己滚 */
.lkx-inputs-card {
	position: fixed;
	z-index: 46;
	display: flex;
	flex-direction: column;
	gap: 6px;
	max-width: min(420px, calc(100vw - 16px));
	max-height: min(260px, 40vh);
	padding: var(--space-3);
	border: 1px solid var(--border);
	border-radius: var(--radius-md);
	background: var(--surface-glass-strong);
	backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	-webkit-backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	box-shadow: var(--shadow-lg);
	overflow-y: auto;
	pointer-events: none;
}
.lkx-inputs-card[hidden] {
	display: none;
}
/* 卡片里的两个小标题：输入 / 回答 */
.lkx-inputs-card-label {
	color: var(--muted);
	font-size: var(--text-xs);
}
.lkx-inputs-card-answer {
	color: var(--text-soft);
	font-size: var(--text-sm);
	line-height: var(--leading);
	word-break: break-word;
	white-space: pre-wrap;
}
.lkx-inputs-card-text {
	color: var(--text);
	font-size: var(--text-sm);
	line-height: var(--leading);
	word-break: break-word;
	white-space: pre-wrap;
}
.lkx-inputs-card-hint {
	color: var(--muted);
	font-size: var(--text-xs);
}

/* 跳过去之后把那条标出来（不用动画，纯静态高亮，2.4 秒后自己摘掉） */
.turn-flash {
	outline: 2px solid var(--accent);
	outline-offset: 3px;
	border-radius: var(--radius-md);
}
`;

/** 清单浮层 */
let menu = null;

/** 悬停预览卡 */
let card = null;

/** 动作行里那颗按钮 */
let chip = null;

/** 按钮上的文字（窄屏下整块藏起来，只留 ▸） */
let chipLabel = null;

/** 当前列出的输入（点击/回车时按序号取回节点） */
let targets = [];

/** 键盘当前位置 */
let cursor = 0;

/** 悬停多久才弹预览卡：太快会「一路闪」，太慢又等得烦 */
const HOVER_DELAY_MS = 260;

/** 列表里回答预览留多少字（一行放得下的量级） */
const ANSWER_ROW_CHARS = 80;

/** 卡片里回答预览留多少字（再长就自己在卡片里滚） */
const ANSWER_CARD_CHARS = 600;

/** 上一次渲染的内容签名：一样就不重建（滚动位置也就不会丢） */
let renderedSignature = "";

/** 是否打开着 */
let open = false;

/** 卡片收起用的定时器：鼠标从条目移到卡片上时要能取消 */
let cardTimer = 0;

/** 高亮摘除用的定时器 */
let flashTimer = 0;

/**
 * 收集这一会话里的用户输入。
 *
 * 只认 `.turn.user`：交接摘要、说明文件变更那类「不是用户说的话」走的是另一种节点，本来就该排除。
 * 返回按出现顺序（旧 → 新）。
 */
function collectTurns() {
	const transcript = document.getElementById("transcript");
	const children = [...(transcript?.children ?? [])];
	const entries = [];
	children.forEach((node, index) => {
		if (!node.classList.contains("user") || !node.classList.contains("turn")) {
			return;
		}
		// 回答 = 紧随其后的那一个 .turn.assistant 里的正文（思考过程与工具卡不算「回答」）。
		// 走到下一条用户输入就停：一轮里可能有若干节点，别把下一轮的回答算到这一条头上。
		let answer = "";
		for (let i = index + 1; i < children.length; i += 1) {
			const next = children[i];
			if (next.classList.contains("turn") && next.classList.contains("user")) {
				break;
			}
			if (next.classList.contains("turn") && next.classList.contains("assistant")) {
				answer = (next.querySelector(".assistant")?.textContent ?? "").trim();
				break;
			}
		}
		entries.push({
			turn: node,
			text: (node.querySelector(".bubble")?.textContent ?? node.textContent ?? "").trim(),
			answer,
		});
	});
	return entries;
}

/** 回答预览：压平空白、太长截断（列表里一行、卡片里一段） */
function answerSnippet(answer, limit) {
	const flat = answer.replace(/\s+/g, " ").trim();
	if (flat === "") {
		return "";
	}
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 一行预览：把换行压成空格，免得一条输入把清单撑开 */
function oneLine(text) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat === "" ? "（空输入）" : flat;
}

/** 把浮层摆到按钮上方（上面放不下就翻到下面），左右夹在视口内 */
function position() {
	if (chip === null || menu === null) {
		return;
	}
	const anchor = chip.getBoundingClientRect();
	const margin = 8;
	const width = Math.min(Math.max(anchor.width, 320), window.innerWidth - margin * 2);
	menu.style.width = `${Math.round(width)}px`;
	const height = menu.getBoundingClientRect().height;
	const left = Math.min(Math.max(anchor.left, margin), Math.max(window.innerWidth - width - margin, margin));
	const above = anchor.top - height - 6;
	const top = above >= margin ? above : anchor.bottom + 6;
	menu.style.left = `${Math.round(left)}px`;
	menu.style.top = `${Math.round(
		Math.min(Math.max(top, margin), Math.max(window.innerHeight - height - margin, margin)),
	)}px`;
}

/** 把预览卡摆到条目右侧（右边放不下就翻到左侧），上下夹在视口内 */
function positionCard(item) {
	const rect = item.getBoundingClientRect();
	const margin = 8;
	const width = card.getBoundingClientRect().width;
	const height = card.getBoundingClientRect().height;
	const right = rect.right + 10;
	const left = right + width <= window.innerWidth - margin ? right : Math.max(rect.left - width - 10, margin);
	const top = Math.min(Math.max(rect.top, margin), Math.max(window.innerHeight - height - margin, margin));
	card.style.left = `${Math.round(left)}px`;
	card.style.top = `${Math.round(top)}px`;
}

/** 悬停某一条时显示全文预览 */
function showCard(item, entry) {
	window.clearTimeout(cardTimer);
	card.replaceChildren();
	const label = (text) => {
		const node = document.createElement("div");
		node.className = "lkx-inputs-card-label";
		node.textContent = text;
		return node;
	};
	const input = document.createElement("div");
	input.className = "lkx-inputs-card-text";
	input.textContent = entry.text;
	const answer = document.createElement("div");
	answer.className = "lkx-inputs-card-answer";
	const snippet = answerSnippet(entry.answer, ANSWER_CARD_CHARS);
	answer.textContent = snippet === "" ? "（还没有回答）" : snippet;
	const hint = document.createElement("div");
	hint.className = "lkx-inputs-card-hint";
	hint.textContent = "点这一条跳到对话里的那一条";
	card.append(label("输入"), input, label("回答"), answer, hint);
	card.hidden = false;
	positionCard(item);
}

/** 收起预览卡：留一点延迟，鼠标从条目滑到卡片上时不闪 */
function hideCard() {
	window.clearTimeout(cardTimer);
	cardTimer = window.setTimeout(() => {
		card.hidden = true;
	}, 120);
}

/**
 * 刷新清单内容与按钮上的条数。
 *
 * 两件必须小心的事：
 * 1. **内容没变就别重建**：对话流一直在动（流式输出每来一段就是一个 mutation），每次都
 *    `replaceChildren` 会把列表的滚动位置清回顶部——表现就是「滑块拖不动、一拖就弹回去」。
 *    所以先比一个签名，没变就原样返回。
 * 2. **真变了也要留住滚动位置**：重建前后把 `scrollTop` 还原，用户停在哪儿就还在哪儿。
 */
function refresh() {
	const turns = collectTurns();
	// 显示顺序是**新的在上**（用时只关心刚发的那几条，不该每次都滚到底）
	const shown = [...turns].reverse();
	targets = shown;
	// 默认**不**选中：一上来就把某一条画成高亮，看着像「它跟别的不一样」
	cursor = -1;
	if (chip === null || menu === null) {
		return;
	}
	// 没有输入时不显示这颗按钮：空按钮比没有按钮更让人费解
	chip.hidden = turns.length === 0;
	if (chipLabel !== null) {
		chipLabel.textContent = `历史输入 ${turns.length}`;
	}
	chip.title = turns.length === 0 ? "这一会话还没有输入" : `这一会话的 ${turns.length} 条输入（点开可跳到任意一条）`;
	// 内容没变就原样留着（连滚动位置一起）：流式输出时对话流一直在动，重建会把滚动清回顶部
	const signature = signatureOf(turns);
	if (signature === renderedSignature && menu.childElementCount > 0) {
		return;
	}
	renderedSignature = signature;
	const previousScroll = menu.scrollTop;
	menu.replaceChildren();
	const head = document.createElement("div");
	/*
	 * 头部两段（与设置卡片、两个菜单同一套）：粗标签 + 淡说明。
	 * "点一条跳过去"这类操作提示放说明里；每一项的 title 里也有。
	 */
	head.className = "lkx-inputs-head";
	const headLabel = document.createElement("span");
	headLabel.className = "lkx-inputs-label";
	headLabel.textContent = "历史输入";
	const headDetail = document.createElement("span");
	headDetail.className = "lkx-inputs-detail";
	headDetail.textContent = `${turns.length} 条 · 新的在上，点一条跳到对话里的那一条`;
	head.append(headLabel, headDetail);
	menu.append(head);
	shown.forEach((entry, index) => {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "lkx-inputs-item";
		item.setAttribute("aria-selected", "false");
		const order = document.createElement("span");
		order.className = "lkx-inputs-index";
		// 序号按**时间顺序**给（最早的是 1）：列表倒序显示，但「第 3 条」永远指同一条
		order.textContent = String(turns.length - index);
		const body = document.createElement("span");
		body.className = "lkx-inputs-body";
		const preview = document.createElement("span");
		preview.className = "lkx-inputs-preview";
		preview.textContent = oneLine(entry.text);
		body.append(preview);
		// 第二行是回答的一部分：列表里就能看出「问了什么、回了什么」
		const answer = document.createElement("span");
		answer.className = "lkx-inputs-answer";
		const snippet = answerSnippet(entry.answer, ANSWER_ROW_CHARS);
		answer.textContent = snippet === "" ? "答：（还没有回答）" : `答：${snippet}`;
		body.append(answer);
		item.append(order, body);
		// 按住鼠标时别让输入框失焦（与其他浮层一致）
		item.addEventListener("mousedown", (event) => event.preventDefault());
		item.addEventListener("mouseenter", () => {
			setCursor(index);
			// 预览卡要「有点意图」才弹：鼠标扫过列表时不该一路闪。
			// 而且只在这两行**确实被截断**时才弹——短输入行里本来就看得全，弹出来是噪音。
			window.clearTimeout(cardTimer);
			const truncated = preview.scrollWidth > preview.clientWidth + 1 || answer.scrollWidth > answer.clientWidth + 1;
			if (!truncated) {
				hideCard();
				return;
			}
			cardTimer = window.setTimeout(() => showCard(item, entry), HOVER_DELAY_MS);
		});
		item.addEventListener("mouseleave", hideCard);
		item.addEventListener("click", () => jump(index));
		menu.append(item);
	});
	menu.scrollTop = previousScroll;
	syncCursor();
}

/** 内容签名：条数 + 每条输入与回答的长度。变了才重建，避免流式输出时反复清空列表 */
function signatureOf(turns) {
	return `${turns.length}|${turns.map((entry) => `${entry.text.length}:${entry.answer.length}`).join(",")}`;
}

/** 把键盘当前位置画出来 */
function syncCursor() {
	if (menu === null) {
		return;
	}
	[...menu.querySelectorAll(".lkx-inputs-item")].forEach((item, index) => {
		item.setAttribute("aria-selected", index === cursor ? "true" : "false");
		if (index === cursor) {
			item.scrollIntoView({ block: "nearest" });
		}
	});
}

function setCursor(index) {
	cursor = Math.max(0, Math.min(targets.length - 1, index));
	syncCursor();
}

/** 跳到第 index 条输入：滚动到它、标出来，然后收起浮层 */
function jump(index) {
	const entry = targets[index];
	// 没有选中（光标在 -1）时回车不该有任何动作，更不该把菜单关掉
	if (entry === undefined) {
		return;
	}
	closeMenu();
	// 跳过去之后就不再自动跟随末尾了：滚动事件会让 follow 状态自己算对，这里只需要别把它顶回去。
	entry.turn.scrollIntoView({ block: "center" });
	window.clearTimeout(flashTimer);
	for (const node of document.querySelectorAll(".turn-flash")) {
		node.classList.remove("turn-flash");
	}
	entry.turn.classList.add("turn-flash");
	// 静态高亮，纯状态切换（没有 transition）：2.4 秒后自己摘掉，不留痕迹
	flashTimer = window.setTimeout(() => {
		entry.turn.classList.remove("turn-flash");
	}, 2400);
}

function openMenu() {
	if (chip === null || menu === null) {
		return;
	}
	refresh();
	if (targets.length === 0) {
		return;
	}
	open = true;
	menu.hidden = false;
	chip.setAttribute("aria-expanded", "true");
	position();
}

function closeMenu() {
	hideCard();
	if (!open || menu === null || chip === null) {
		return;
	}
	open = false;
	menu.hidden = true;
	chip.setAttribute("aria-expanded", "false");
}

/** 接上按钮、浮层与全局事件；由 app.js 启动时调一次 */
export function initInputHistory() {
	// 优先挂到输入框上方那排浮标里（与「跳到最新」「上下文压缩」同一行）；
	// 找不到就退回动作行——入口不能因为宿主换了就消失。
	const host = document.querySelector(".composer-badges") ?? document.querySelector(".composer-actions");
	const status = document.getElementById("status");
	if (host === null) {
		return;
	}
	const style = document.createElement("style");
	style.textContent = STYLE;
	document.head.append(style);

	chip = document.createElement("button");
	chip.type = "button";
	chip.className = "lkx-inputs-chip";
	const chipSymbol = document.createElement("span");
	chipSymbol.className = "lkx-inputs-chip-symbol";
	chipSymbol.append(icon("clock", 13));
	chipLabel = document.createElement("span");
	chipLabel.className = "lkx-inputs-chip-label";
	chip.setAttribute("aria-expanded", "false");
	chip.setAttribute("aria-haspopup", "true");
	chip.hidden = true;
	chip.addEventListener("click", () => {
		if (open) {
			closeMenu();
			return;
		}
		openMenu();
	});
	chip.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			closeMenu();
			chip.blur();
			return;
		}
		if (!open) {
			if (event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				openMenu();
			}
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			// 还没选中时按 ↑ 从最后一条开始（最近发的那条）
			setCursor(cursor < 0 ? targets.length - 1 : cursor - 1);
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setCursor(cursor < 0 ? 0 : cursor + 1);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			jump(cursor);
		}
	});
	chip.append(chipSymbol, chipLabel);
	// 浮标容器里排在「跳到最新」之后；退回动作行时排在状态之后
	if (host.classList.contains("composer-actions")) {
		status.after(chip);
	} else {
		host.append(chip);
	}

	menu = document.createElement("div");
	menu.className = "lkx-inputs";
	menu.hidden = true;
	document.body.append(menu);

	card = document.createElement("div");
	card.className = "lkx-inputs-card";
	card.hidden = true;
	document.body.append(card);

	// 点别处、按 Esc、滚动或改窗口大小都收起：浮层是 fixed 的，位置一变就会飘在错的地方
	document.addEventListener("click", (event) => {
		if (!open) {
			return;
		}
		// 用 contains 而不是 ===：按钮里还有符号与文字两个 span，点在它们身上时 event.target 不是按钮本身
		// （窄屏下文字藏起来、按钮只剩符号，点击几乎必然落在 span 上，用 === 会「刚打开就自己关掉」）。
		const path = event.composedPath();
		if (path.includes(chip) || path.includes(menu)) {
			return;
		}
		closeMenu();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			closeMenu();
		}
	});
	// 浮层是 fixed 定位，坐标会失效：滚动与缩放时**重定位**（跟命令菜单同一套做法），
	// 而不是关掉——流式输出时对话区一直在滚，关掉等于「刚打开就没了」。
	const follow = () => {
		hideCard();
		if (open) {
			position();
		}
	};
	window.addEventListener("scroll", follow, true);
	window.addEventListener("resize", follow);
	// 对话重绘（切会话、续写）之后条数与内容都会变，跟着刷新一次
	const transcript = document.getElementById("transcript");
	new MutationObserver(() => {
		if (open) {
			// refresh() 自己会比签名：内容没变时它什么都不做，滚动位置也就不动
			refresh();
			position();
			return;
		}
		// 收起状态下只需要把按钮上的条数对上
		if (chip !== null) {
			const count = document.querySelectorAll("#transcript .turn.user").length;
			chip.hidden = count === 0;
			if (chipLabel !== null) {
				chipLabel.textContent = `历史输入 ${count}`;
			}
		}
	}).observe(transcript ?? document.body, { childList: true, subtree: true });
}
