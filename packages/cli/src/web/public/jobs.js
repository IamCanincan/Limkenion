/*
 * 后台任务那颗下拉。
 *
 * 数据来自服务端的 `GET /api/sessions/:id/jobs`（按会话取），**按需轮询**而不是走 SSE——作业状态
 * 是「界面隔几秒看一眼」就够的信息，而 SSE 每加一种事件都要动两份名单再加一条契约测试（那份名单
 * 是 `protocol.ts` 的 `WEB_EVENT_TYPES` 与 `state.js` 的 `EVENT_TYPES`，成对的）。
 *
 * 三条界面规矩：
 *   - **存活行在前、终态行保留但弱化**：终态那行的输出文件是失败的唯一证据，不能跑完就消失；
 *   - 每行一个**真正的停止按钮**（DSH 的作业列表是只读的，那是它内核契约的短板，不学）；
 *   - 浮层挂 body + position: fixed（顶栏有横向滚动，挂在里面会被裁掉）。
 */

import { api } from "./api.js";
import { addTopBarAction } from "./features.js";
import { state } from "./state.js";

const LABELS = { running: "运行中", done: "已完成", failed: "失败", killed: "已停止" };
const POLL_MS = 3000;

let button = null;
let menu = null;
let jobs = [];
let timer = 0;
let open = false;

function injectStyle() {
	if (document.getElementById("lkj-jobs-style") !== null) {
		return;
	}
	const style = document.createElement("style");
	style.id = "lkj-jobs-style";
	style.textContent = `
.lkj-menu {
	position: fixed;
	z-index: 40;
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-width: 280px;
	max-width: 360px;
	padding: var(--space-3);
	border: 1px solid var(--border);
	border-radius: var(--radius-md);
	background: var(--surface-glass-strong);
	backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	-webkit-backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	box-shadow: var(--shadow-lg);
}
.lkj-head { color: var(--muted); font-size: var(--text-xs); }
.lkj-row {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-2) 0;
	border-top: 1px solid var(--border);
}
.lkj-row[data-status="done"], .lkj-row[data-status="killed"] { opacity: 0.6; }
/* 失败行**不**弱化：它是最该被看见的那一行，改用危险色标出结论（弱化就没人在意了） */
.lkj-row[data-status="failed"] .lkj-meta { color: var(--danger); }
.lkj-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.lkj-cmd { color: var(--text); font-family: var(--font-mono); font-size: var(--text-xs); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lkj-meta { color: var(--muted); font-size: var(--text-xs); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lkj-stop { flex: 0 0 auto; font-size: var(--text-xs); }
.lkj-empty { color: var(--muted); font-size: var(--text-xs); }
/* 日志尾巴：等宽、可横滚、限高（与面板里的 diff 同一套读法） */
.lkj-log {
	max-height: 200px;
	margin: 6px 0 0;
	padding: var(--space-2);
	border-radius: var(--radius-xs);
	background: var(--surface-2);
	color: var(--text-soft);
	font-family: var(--font-mono);
	font-size: var(--text-xs);
	line-height: 1.6;
	overflow: auto;
	white-space: pre;
}
.lkj-log-btn { flex: 0 0 auto; font-size: var(--text-xs); }
`;
	document.head.append(style);
}

/** 把一条记录压成一行 meta：状态 · 耗时 · 退出码 · 截断 */
function describe(job) {
	const seconds = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
	const parts = [LABELS[job.status] ?? job.status, `${seconds} 秒`];
	if (job.exitCode !== null && job.exitCode !== undefined) {
		parts.push(`退出码 ${job.exitCode}`);
	}
	if (job.truncated) {
		parts.push("输出已截断");
	}
	return parts.join(" · ");
}

function renderMenu() {
	if (menu === null) {
		return;
	}
	menu.replaceChildren();
	const head = document.createElement("div");
	head.className = "lkj-head";
	const running = jobs.filter((job) => job.status === "running").length;
	head.textContent = jobs.length === 0 ? "这个会话还没有后台任务" : `${jobs.length} 条 · ${running} 条在跑`;
	menu.append(head);
	if (jobs.length === 0) {
		const empty = document.createElement("div");
		empty.className = "lkj-empty";
		empty.textContent = "模型用 job_start 起后台任务（构建、整包测试、本地服务）时会出现在这里。";
		menu.append(empty);
		return;
	}
	// 存活行在前，终态行按结束顺序跟在后面
	const ordered = [...jobs].sort(
		(left, right) => Number(right.status === "running") - Number(left.status === "running"),
	);
	for (const job of ordered) {
		const row = document.createElement("div");
		row.className = "lkj-row";
		row.dataset.status = job.status;
		const body = document.createElement("div");
		body.className = "lkj-body";
		const command = document.createElement("div");
		command.className = "lkj-cmd";
		command.textContent = job.command;
		command.title = job.command;
		const meta = document.createElement("div");
		meta.className = "lkj-meta";
		meta.textContent = `${describe(job)} · 输出 ${job.outputPath}`;
		meta.title = `输出文件：${job.outputPath}`;
		body.append(command, meta);
		row.append(body);
		if (job.status === "running") {
			const stop = document.createElement("button");
			stop.type = "button";
			stop.className = "btn ghost small lkj-stop";
			stop.textContent = "■ 停止";
			stop.title = "收掉这条任务（连同它起的子进程一起）";
			stop.addEventListener("click", async () => {
				stop.disabled = true;
				try {
					await api(
						`/api/sessions/${encodeURIComponent(state.activeId)}/jobs/${encodeURIComponent(job.id)}/kill`,
						{
							method: "POST",
						},
					);
				} catch {
					// 收不掉（任务刚结束之类）不用报错：下一次轮询会把真实状态带回来
				}
				await refresh();
			});
			row.append(stop);
		}
		// 日志：跑着的和跑完的都能看（失败之后看尾巴才是最常见的用法）。
		// 点一下拉一次 `/jobs/<id>/log`（服务端只回尾巴，按系统代码页解码），再点收起。
		const log = document.createElement("button");
		log.type = "button";
		log.className = "btn ghost small lkj-log-btn";
		log.textContent = "▸ 日志";
		log.title = "看这条任务输出的尾巴（最近若干行）";
		log.addEventListener("click", async () => {
			const shown = row.querySelector(".lkj-log");
			if (shown !== null) {
				shown.remove();
				log.textContent = "▸ 日志";
				return;
			}
			log.textContent = "▾ 日志";
			const block = document.createElement("pre");
			block.className = "lkj-log";
			block.textContent = "读取中…";
			row.append(block);
			position();
			try {
				const data = await api(
					`/api/sessions/${encodeURIComponent(state.activeId)}/jobs/${encodeURIComponent(job.id)}/log`,
				);
				const tail = typeof data?.text === "string" ? data.text.trimEnd() : "";
				block.textContent =
					tail === "" ? "（还没有输出）" : `${data.truncated === true ? "… 只给尾巴：" : ""}${tail}`;
			} catch (error) {
				block.textContent = error instanceof Error ? `读不到输出：${error.message}` : "读不到输出";
			}
			position();
		});
		row.append(log);
		menu.append(row);
	}
}

/** 按锚点摆一次；顶栏会横向滚动、窗口会缩放，所以每次打开与滚动都重算 */
function position() {
	if (menu === null || button === null) {
		return;
	}
	const anchor = button.getBoundingClientRect();
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
	menu.className = "lkj-menu";
	menu.setAttribute("role", "dialog");
	menu.setAttribute("aria-label", "后台任务");
	document.body.append(menu);
	renderMenu();
	position();
	// 先摆一次再量：尺寸要等它进文档才算得出来
	position();
}

/** 拉一次作业列表；下拉开着时顺带重绘（按会话取，切会话后自然换一批） */
export async function refresh() {
	if (!state.activeId) {
		jobs = [];
		if (button !== null) {
			button.hidden = true;
		}
		renderMenu();
		return;
	}
	try {
		const data = await api(`/api/sessions/${encodeURIComponent(state.activeId)}/jobs`);
		jobs = Array.isArray(data.jobs) ? data.jobs : [];
	} catch {
		// 拉不到就当没有：这是辅助信息，不值得打扰使用者
		jobs = [];
	}
	if (button !== null) {
		// 没有作业时整颗收起：顶栏在窄屏要横向滚动，不留空按钮占位
		button.hidden = jobs.length === 0;
	}
	renderMenu();
}

export function init() {
	injectStyle();
	button = addTopBarAction({
		symbol: "⌗",
		icon: "terminal",
		label: "后台任务",
		title: "后台任务（构建、整包测试这类先跑着的活）",
		onClick: () => {
			if (!open) {
				void refresh();
			}
			show();
		},
	});
	button.hidden = true;
	// 点别处 / Esc / 滚动 / 缩放都收起（判断「点的是不是自己」用 contains：按钮里还有符号和文字的 span）
	document.addEventListener("pointerdown", (event) => {
		if (menu === null) {
			return;
		}
		if (menu.contains(event.target) || button.contains(event.target)) {
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
	// 轮询：与侧栏总览同一个节流档（3 秒），只在有会话时发请求
	timer = setInterval(() => void refresh(), POLL_MS);
	void refresh();
	// 切会话立刻换一批（事件名与 sessions.js 的 SESSION_EVENT 一致）
	document.addEventListener("lk:session-changed", () => void refresh());
}

/** 关服务前收尾用（测试与卸载场景） */
export function stopPolling() {
	if (timer !== 0) {
		clearInterval(timer);
		timer = 0;
	}
}
