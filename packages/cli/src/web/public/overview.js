/*
 * 多会话状态总览。
 *
 * 列出各会话的进度与花费，可并行运行。
 *
 * 约定：DOM 与样式都由本模块自己创建（注入 <style>），不要改 index.html 与 app.css——
 * 这样多个功能并行开发时不会互相冲突。
 *
 * 形态参考 Open WebUI / LibreChat 的历史列表：每行「标题 + 最近时间」，正在跑的加一个
 * 脉动小圆点，悬停能看到进度。列表本身的渲染归 session-list.js，这里只做两件事：更新顶部栏
 * 标题里的「N 个会话 · M 个在跑」汇总，加上给正在跑的行补一个标记类。
 *
 * 汇总原先是在会话列表上方插一行文字，现在改用外壳的 setTopBarTitle：那行字占的是侧栏里
 * 最值钱的一段纵向空间，而顶部栏中间本来就是空的，写在那儿既不挤列表也不用滚动就能看见。
 *
 * 「并行」在本模块里的含义：服务端每个会话是一个独立的 Run，切换会话只是换个事件流，
 * 不会中断别的会话——所以这里的 M 是「后台同时有几个在跑」，不是「当前这个在不在跑」。
 *
 * 列表按工作区分组之后，行不再按数组顺序排（组内按 updatedAt 倒序、当前工作区那一组还在最前），
 * 所以这里不再靠「列表顺序 = 摘要倒序」认 id：列表模块把会话 id 写在行的 data-session-id 上，
 * 并且每次重绘都会派发事件，这里按 id 贴标记即可。
 */

import { api } from "./api.js";
import { setTopBarTitle } from "./features.js";
import { formatTime } from "./format.js";

/** 两次统计之间的最小间隔：切换会话与每轮结束都会来问一次，太密没必要 */
const MIN_REFRESH_MS = 1000;

/** 会话列表重绘后派发的事件；名单与 session-list.js 里的 LIST_EVENT 一致 */
const LIST_EVENT = "lk:sessions-rendered";

/** 本模块的样式；用一次就够 */
export const STYLE = /* css */ `
/* 正在跑的会话行：整行一圈强调色 + 左边一条竖条。
   列表里已经有一个闪烁的 .dot，这里再补一层，是因为「哪个会话在跑」要看整行而不是一个小点；
   竖条的位置与 .session-item.active::before 对齐，两者可以同时出现而不打架。 */
.session-item.lmk-running {
	border-color: var(--accent-ring);
	background: color-mix(in srgb, var(--accent) 9%, transparent);
}

.session-item.lmk-running::after {
	content: "";
	position: absolute;
	left: 5px;
	top: 13px;
	bottom: 13px;
	width: 3px;
	border-radius: var(--radius-pill);
	background: var(--accent);
}

/* 在跑的行：左边那条竖条自己呼吸（只改 opacity，不动位置）。
   **挂在伪元素上，不是那个圆点**：那一行里根本没有 .dot（从前那条 .session-item.lmk-running .dot
   规则一直是空转的），挂上去等于没有动画。 */
.session-item.lmk-running::after {
	animation: lk-pulse 1.3s var(--ease-standard) infinite;
}

@keyframes lk-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.35;
	}
}

/* 在等你点一下的行：警告色，且**比「在跑」优先**（在跑的会话不用你管，在等你的不点就停在那儿）。
   两条同时成立时这条写在后面，用警告色盖住成功色。 */
.session-item.lmk-waiting {
	border-color: color-mix(in srgb, var(--warn) 45%, transparent);
	background: color-mix(in srgb, var(--warn) 10%, transparent);
}

.session-item.lmk-waiting::after {
	content: "";
	position: absolute;
	left: 5px;
	top: 13px;
	bottom: 13px;
	width: 3px;
	border-radius: var(--radius-pill);
	background: var(--warn);
}

.session-item.lmk-waiting .dot {
	background: var(--warn);
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 22%, transparent);
}
`;

/** 上一次统计的时刻，用于节流 */
let lastRefresh = 0;

/** 最近一次拿到的摘要；列表重绘时靠它在不重新发请求的情况下把标记补回去 */
let latest = [];

/**
 * 写顶部栏标题。
 *
 * 只在真有会话在跑或在等你时才报那两个数：0 是常态，把「· 0 个在跑」也写上去只是噪声；
 * 「在等你」排在前面——那件事不点就一直停着（DSH 的状态点优先级也是这么定的）。
 */
function paint(total, running, waiting) {
	const parts = [`${total} 个会话`];
	if (waiting > 0) {
		parts.push(`${waiting} 个在等你`);
	}
	if (running > 0) {
		parts.push(`${running} 个在跑`);
	}
	setTopBarTitle(parts.join(" · "));
}

/**
 * 给正在跑的会话行补标记。
 *
 * 认的是行上的 data-session-id（会话列表模块写的）：分组之后行不再按「摘要倒序」排，
 * 靠顺序认 id 会张冠李戴；id 是会话自己的身份，怎么分组、怎么排都不会错。
 *
 * 悬停提示也在这里补：摘要里只有条数与时间，没有轮数与花费（那要逐行读会话文件），
 * 所以提示给的是「N 条消息 · 时间」，不编造拿不到的数字。
 */
function markRunning(sessions) {
	latest = Array.isArray(sessions) ? sessions : [];
	const byId = new Map(latest.map((session) => [session.id, session]));
	const running = new Set(latest.filter((session) => session.running).map((session) => session.id));
	const waiting = new Set(latest.filter((session) => session.waiting).map((session) => session.id));
	for (const item of document.querySelectorAll(".session-item")) {
		const id = item.dataset.sessionId;
		const session = byId.get(id);
		const isWaiting = waiting.has(id);
		const isRunning = running.has(id);
		item.classList.toggle("lmk-running", isRunning);
		item.classList.toggle("lmk-waiting", isWaiting);
		// title 每次都要写回：列表模块给的是完整工作区路径，跑起来或等你点一下时换成说明，
		// 只写一半的话「跑完」之后那行会一直挂着旧提示。**「在等你」比「在跑」优先**：
		// 在跑的会话不用你管，在等你的不点就停在那儿。
		const stats = session ? `${session.messageCount} 条消息 · ${formatTime(session.createdAt)}` : "";
		if (isWaiting) {
			item.title = `在等你点一下：${stats}（工具确认或方案评审，点开这个会话去答复）`;
		} else if (isRunning) {
			item.title = `正在生成：${stats}（点击查看，不会中断它）`;
		} else if (session && typeof session.cwd === "string") {
			item.title = session.cwd;
		}
	}
}

/**
 * 拉一次会话列表并刷新总览。
 *
 * 用节流 + 列表重绘事件而不是订阅每一次变化：/api/sessions 返回的就是同一份权威摘要（含 running），
 * 拿它统计不会出现两处状态不一致；而列表每次重绘都会派事件，标记能在重绘后立刻补回去，
 * 不必等下一次轮询。
 */
export async function refresh(force = false) {
	const now = Date.now();
	if (!force && now - lastRefresh < MIN_REFRESH_MS) {
		return;
	}
	lastRefresh = now;
	try {
		const data = await api("/api/sessions");
		const sessions = Array.isArray(data.sessions) ? data.sessions : [];
		markRunning(sessions);
		paint(
			sessions.length,
			sessions.filter((session) => session.running).length,
			sessions.filter((session) => session.waiting).length,
		);
	} catch {
		// 拉不到就保持上一次的数字：总览是辅助信息，不值得为此打扰用户。
	}
}

/** 初始化：绑事件，并把汇总交给顶部栏标题 */
export function init() {
	const style = document.createElement("style");
	style.textContent = STYLE;
	document.head.append(style);

	// 标题先给一个占位：第一次 refresh 回来之前的这段时间里，顶部栏不该是空的。
	setTopBarTitle("0 个会话");
	// 会话列表重绘（分组折叠、改名、归档、切工作区都会重绘）之后把标记补回去。
	// 列表已经把 id 写在行上了，用最近一次的摘要就够了，不用为了这件事再发一次请求。
	document.addEventListener(LIST_EVENT, () => markRunning(latest));

	// 每轮结束、切换会话都会刷新一次；再叠一个低频轮询，兜住「另一个标签页里跑起来」
	// 这类本页收不到通知的变化。
	setInterval(() => void refresh(), 3000);
	void refresh(true);
}
