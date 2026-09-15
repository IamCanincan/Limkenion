/*
 * 待办 dock：输入框上方那条清单与目标。
 *
 * 内核本来就有 `todo_write` / `todo_read` 两个工具（`packages/core/src/todos.ts`），对话流里也有它们的
 * 工具行——但「现在还剩哪几项」得往上翻着找。这里把当前清单贴在输入框上方，与 DSH 的 dock 栈同一个
 * 位置：同一处聚合，不污染历史。
 *
 * 数据来源是**服务端的会话事实**（`facts` 事件，随连接快照重发；`render.js` 收到后转成 `lk:facts`
 * 广播）。不解析工具入参：那条路在上下文压缩之后会断——被折进摘要的工具调用再也扫不到，dock 会在
 * 跑到一半时清空。换会话时快照重发，这里自动跟着换。
 * 只读：要改清单是由模型调 `todo_write` 来改的，界面上不提供手动编辑（那会让「谁改的」说不清）。
 */

import { el } from "./state.js";

/** render.js 广播事实时用的事件名 */
const EVENT = "lk:facts";

/** dock 里最多列几项，其余合成一行「还有 N 项」 */
const MAX_ROWS = 6;

let root = null;
let head = null;
let items = null;
let goalLine = null;

/** 注入样式：类名带前缀，颜色只用既有 MD3 角色变量 */
function injectStyle() {
	if (document.getElementById("lkt-todo-style") !== null) {
		return;
	}
	const style = document.createElement("style");
	style.id = "lkt-todo-style";
	style.textContent = `
/* 输入框上方那条待办；没有待办时整块不占地方 */
.lkt-dock {
	flex: 0 0 auto;
	margin: 0 0 var(--space-2);
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border);
	border-radius: var(--radius-md);
	background: var(--surface-2);
	color: var(--text-soft);
	font-size: var(--text-xs);
	line-height: 1.7;
}
.lkt-head { color: var(--muted); font-weight: 600; }
.lkt-row { display: flex; gap: var(--space-2); align-items: baseline; min-width: 0; }
.lkt-mark { flex: 0 0 auto; width: 1em; color: var(--muted); }
.lkt-row[data-status="in_progress"] { color: var(--text); }
.lkt-row[data-status="in_progress"] .lkt-mark { color: var(--accent-text); }
.lkt-row[data-status="completed"] { color: var(--muted); text-decoration: line-through; }
.lkt-row[data-status="completed"] .lkt-mark { color: var(--ok); }
.lkt-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lkt-more { color: var(--muted); }
/* 目标那一行：比待办强调一点（它是「现在在干什么」，不是待办里的一条） */
.lkt-goal { color: var(--text); font-weight: 600; margin-bottom: 2px; }
`;
	document.head.append(style);
}

/** 画一份清单；空清单等于整块收起 */
function render(todos) {
	if (root === null) {
		return;
	}
	const list = Array.isArray(todos) ? todos.filter((item) => item && typeof item.content === "string") : [];
	root.hidden = list.length === 0;
	items.replaceChildren();
	if (list.length === 0) {
		return;
	}
	const done = list.filter((item) => item.status === "completed").length;
	const doing = list.filter((item) => item.status === "in_progress").length;
	const pending = list.length - done - doing;
	// 零值分段省略：一句「0 已完成」只是噪声
	const parts = [];
	if (done > 0) {
		parts.push(`${done} 已完成`);
	}
	if (doing > 0) {
		parts.push(`${doing} 进行中`);
	}
	if (pending > 0) {
		parts.push(`${pending} 待处理`);
	}
	head.textContent = `待办 · ${parts.join(" · ")}`;
	for (const item of list.slice(0, MAX_ROWS)) {
		const row = document.createElement("div");
		row.className = "lkt-row";
		row.dataset.status = item.status ?? "pending";
		const mark = document.createElement("span");
		mark.className = "lkt-mark";
		// 符号沿用仓库那一套：确认 ✓、进行中 ◐；待办不加符号（不为了凑满一列而造新符号）
		mark.textContent = item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "";
		const text = document.createElement("span");
		text.className = "lkt-text";
		text.textContent = item.content;
		text.title = item.content;
		row.append(mark, text);
		items.append(row);
	}
	if (list.length > MAX_ROWS) {
		const more = document.createElement("div");
		more.className = "lkt-more";
		more.textContent = `… 还有 ${list.length - MAX_ROWS} 项`;
		items.append(more);
	}
}

/** 目标那行的人话状态（与 core 的 goals.ts 同一套说法） */
const GOAL_LABELS = { active: "进行中", paused: "已暂停", blocked: "受阻", idle: "未运行" };

/** 画目标那一行；没有目标就不占地方 */
function renderGoal(goal) {
	if (root === null) {
		return;
	}
	if (goal === null || goal === undefined || typeof goal.content !== "string" || goal.content === "") {
		goalLine.hidden = true;
		return;
	}
	goalLine.hidden = false;
	goalLine.textContent = `目标 · ${GOAL_LABELS[goal.status] ?? "未运行"}：${goal.content}`;
	goalLine.title = goalLine.textContent;
}

export function init() {
	injectStyle();
	const frame = el.composer?.querySelector(".composer-frame");
	if (frame === null || frame === undefined) {
		return;
	}
	root = document.createElement("div");
	root.className = "lkt-dock";
	root.hidden = true;
	root.setAttribute("role", "status");
	root.setAttribute("aria-label", "目标与待办");
	head = document.createElement("div");
	head.className = "lkt-head";
	goalLine = document.createElement("div");
	goalLine.className = "lkt-goal";
	goalLine.hidden = true;
	items = document.createElement("div");
	root.append(goalLine, head, items);
	// 贴在输入框卡片正上方（与「↓ 跳到最新」那排浮标同一区域，但不吃点击）
	frame.before(root);
	// 一次事实一起画：待办与目标谁先到都不该让整块闪一下
	document.addEventListener(EVENT, (event) => {
		const todos = Array.isArray(event.detail?.todos) ? event.detail.todos : [];
		renderGoal(event.detail?.goal ?? null);
		render(todos);
		// 有目标时 dock 要露出来（哪怕待办是空的）；两样都没有才整块收起
		root.hidden = todos.length === 0 && goalLine.hidden;
	});
}
