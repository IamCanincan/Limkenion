/*
 * 子代理那颗 chip 与谱系下拉。
 *
 * 数据来自 `GET /api/sessions/:id/subagents`（按会话取，与 `jobs.js` 同一套：**轮询、不走 SSE**）。
 * 子代理是这个会话自己起的，所以切会话就换一批、会话没了就没有。
 *
 * 三条界面规矩（与后台任务那颗下拉一致，DSH 那边也是这么摆的）：
 *   - chip 上写「N subagents」，运行中时多一颗呼吸点（沿用侧栏那套 `.lmk-running` 的观感）；
 *   - 下拉是**树**：每行「标签 · 状态 · 耗时」，点整行**下钻**看它的完整结论（结论随列表一起下发，不再请求）；
 *   - 浮层挂 body + position: fixed（顶栏有横向滚动，挂在里面会被裁掉）。
 */

import { api } from "./api.js";
import { addTopBarAction } from "./features.js";
import { state } from "./state.js";

const LABELS = { running: "运行中", done: "已完成", failed: "失败", aborted: "已中断" };
const POLL_MS = 3000;

let chip = null;
let labelNode = null;
let menu = null;
let rows = [];
let timer = 0;
let open = false;
/** 展开看结论的那一行（点整行切换） */
let expanded = "";

function injectStyle() {
	if (document.getElementById("lksa-style") !== null) {
		return;
	}
	const style = document.createElement("style");
	style.id = "lksa-style";
	style.textContent = `
.lksa-menu {
	position: fixed;
	z-index: 40;
	display: flex;
	flex-direction: column;
	min-width: 300px;
	max-width: 380px;
	max-height: 60vh;
	overflow: auto;
	padding: var(--space-3);
	border: 1px solid var(--border);
	border-radius: var(--radius-md);
	background: var(--surface-glass-strong);
	backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	-webkit-backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	box-shadow: var(--shadow-lg);
}
.lksa-head { color: var(--muted); font-size: var(--text-xs); margin-bottom: var(--space-2); }
.lksa-empty { color: var(--muted); font-size: var(--text-xs); line-height: 1.7; }
.lksa-row {
	display: flex;
	flex-direction: column;
	gap: 2px;
	width: 100%;
	padding: var(--space-2) 0;
	border: 0;
	border-top: 1px solid var(--border);
	background: transparent;
	color: var(--text);
	font: inherit;
	text-align: left;
	cursor: pointer;
}
.lksa-row[data-status="done"], .lksa-row[data-status="aborted"] { opacity: 0.6; }
.lksa-row[data-status="failed"] .lksa-meta { color: var(--danger); }
.lksa-title { display: flex; gap: var(--space-2); align-items: center; min-width: 0; }
.lksa-label { flex: 1 1 auto; min-width: 0; }
.lksa-stop { flex: 0 0 auto; font-size: var(--text-xs); }
.lksa-label { flex: 0 0 auto; font-size: var(--text-base); }
.lksa-mark { flex: 0 0 auto; color: var(--muted); }
.lksa-row[data-status="running"] .lksa-mark { color: var(--accent-text); }
.lksa-meta { color: var(--muted); font-size: var(--text-xs); }
.lksa-text {
	margin-top: 2px;
	padding: var(--space-2);
	border-radius: var(--radius-xs);
	background: var(--surface-2);
	color: var(--text-soft);
	font-family: var(--font-mono);
	font-size: var(--text-xs);
	line-height: 1.6;
	white-space: pre-wrap;
	word-break: break-word;
}
`;
	document.head.append(style);
}

/** 一行的人话：状态 · 耗时（运行中的按现在算） */
function describe(row) {
	const seconds = Math.max(0, Math.round(((row.endedAt ?? Date.now()) - row.startedAt) / 1000));
	const parts = [LABELS[row.status] ?? row.status, `${seconds} 秒`];
	if (row.error !== "") {
		parts.push(row.error);
	}
	return parts.join(" · ");
}

function renderMenu() {
	if (menu === null) {
		return;
	}
	menu.replaceChildren();
	const head = document.createElement("div");
	head.className = "lksa-head";
	const running = rows.filter((row) => row.status === "running").length;
	head.textContent = rows.length === 0 ? "这个会话还没有子代理" : `${rows.length} 个子代理 · ${running} 个在跑`;
	menu.append(head);
	if (rows.length === 0) {
		const empty = document.createElement("div");
		empty.className = "lksa-empty";
		empty.textContent = "模型用 subagent_start 把「过程很长、结论很短」的活交出去时会出现在这里。";
		menu.append(empty);
		return;
	}
	// 运行中的在前；同状态按起始时刻
	const ordered = [...rows].sort((left, right) => {
		const diff = Number(right.status === "running") - Number(left.status === "running");
		return diff !== 0 ? diff : left.startedAt - right.startedAt;
	});
	for (const row of ordered) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "lksa-row";
		item.dataset.status = row.status;
		item.setAttribute("aria-expanded", String(expanded === row.label));
		const title = document.createElement("span");
		title.className = "lksa-title";
		const mark = document.createElement("span");
		mark.className = "lksa-mark";
		mark.textContent =
			row.status === "running" ? "◐" : row.status === "done" ? "✓" : row.status === "aborted" ? "✕" : "!";
		const label = document.createElement("span");
		label.className = "lksa-label";
		label.textContent = row.label;
		title.append(mark, label);
		if (row.status === "running") {
			// 每行一个真的停止按钮：子代理是独立的模型循环，不收掉它会一直烧 token
			const stop = document.createElement("button");
			stop.type = "button";
			stop.className = "btn ghost small lksa-stop";
			stop.textContent = "■ 停止";
			stop.title = "收掉这条子代理（它的模型循环会中断）";
			stop.addEventListener("click", async (event) => {
				// 整行是可点的（点开看结论），别让停止按钮顺带把结论展开
				event.stopPropagation();
				stop.disabled = true;
				try {
					await api(
						`/api/sessions/${encodeURIComponent(state.activeId)}/subagents/${encodeURIComponent(row.label)}/stop`,
						{ method: "POST" },
					);
				} catch {
					// 收不掉（刚跑完之类）不用报错：下一次轮询会把真实状态带回来
				}
				await refresh();
			});
			title.append(stop);
		}
		const meta = document.createElement("span");
		meta.className = "lksa-meta";
		meta.textContent = describe(row);
		item.append(title, meta);
		if (expanded === row.label) {
			const text = document.createElement("span");
			text.className = "lksa-text";
			text.textContent = row.status === "done" ? row.text : row.error === "" ? "（还没有结论）" : row.error;
			item.append(text);
		}
		item.addEventListener("click", () => {
			expanded = expanded === row.label ? "" : row.label;
			renderMenu();
			position();
		});
		menu.append(item);
	}
}

function position() {
	if (menu === null || chip === null) {
		return;
	}
	const anchor = chip.getBoundingClientRect();
	const box = menu.getBoundingClientRect();
	const margin = 8;
	const left = Math.min(
		Math.max(anchor.right - box.width, margin),
		Math.max(window.innerWidth - box.width - margin, margin),
	);
	const below = anchor.bottom + 4;
	const top =
		below + box.height <= window.innerHeight - margin ? below : Math.max(anchor.top - box.height - 4, margin);
	menu.style.left = `${Math.round(left)}px`;
	menu.style.top = `${Math.round(top)}px`;
}

function close() {
	open = false;
	if (menu !== null) {
		menu.remove();
		menu = null;
	}
}

function show() {
	if (menu !== null) {
		close();
		return;
	}
	open = true;
	menu = document.createElement("div");
	menu.className = "lksa-menu";
	menu.setAttribute("role", "dialog");
	menu.setAttribute("aria-label", "子代理");
	document.body.append(menu);
	renderMenu();
	position();
	// 先摆一次再量：尺寸要等它进文档才算得出来
	position();
}

/** 拉一次；下拉开着时顺带重绘 */
export async function refresh() {
	if (!state.activeId) {
		rows = [];
		if (chip !== null) {
			chip.hidden = true;
		}
		renderMenu();
		return;
	}
	try {
		const data = await api(`/api/sessions/${encodeURIComponent(state.activeId)}/subagents`);
		rows = Array.isArray(data.subagents) ? data.subagents : [];
	} catch {
		// 拉不到就当没有：这是辅助信息，不值得打扰使用者
		rows = [];
	}
	if (chip !== null) {
		// 没有子代理时整颗收起：顶栏在窄屏要横向滚动，不留空按钮占位
		chip.hidden = rows.length === 0;
		const running = rows.filter((row) => row.status === "running").length;
		const text = `${rows.length} subagents`;
		if (labelNode !== null) {
			labelNode.textContent = text;
		}
		chip.title = running > 0 ? `${text}（${running} 个在跑）` : `${text}：模型委派出去的活，点开看各自的结论`;
		if (running > 0) {
			chip.classList.add("lksa-live");
		} else {
			chip.classList.remove("lksa-live");
		}
	}
	renderMenu();
}

export function init() {
	injectStyle();
	chip = addTopBarAction({
		label: "subagents",
		title: "子代理：模型把「过程很长、结论很短」的活交出去跑",
		onClick: () => {
			if (!open) {
				void refresh();
			}
			show();
		},
	});
	chip.hidden = true;
	chip.classList.add("lksa-chip");
	// 标签那一格：addTopBarAction 建好按钮后，文字在最后一个 span 里
	labelNode = chip.querySelector("span:last-of-type");
	document.addEventListener("pointerdown", (event) => {
		if (menu === null) {
			return;
		}
		if (menu.contains(event.target) || chip.contains(event.target)) {
			return;
		}
		close();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && menu !== null) {
			close();
		}
	});
	window.addEventListener("resize", () => position());
	window.addEventListener("scroll", () => position(), true);
	timer = setInterval(() => void refresh(), POLL_MS);
	void refresh();
	document.addEventListener("lk:session-changed", () => void refresh());
}

/** 停掉轮询（测试与卸载场景） */
export function stopPolling() {
	if (timer !== 0) {
		clearInterval(timer);
		timer = 0;
	}
}
