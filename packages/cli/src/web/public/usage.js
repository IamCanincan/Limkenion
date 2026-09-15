/*
 * 用量与缓存命中。
 *
 * 只显示**已发生的事实**：token 数与缓存命中率。不显示金额——那不是账单，是一份会过期的估算
 * （价格表要人工跟着官方页改、分时还按时区判断），早先做过一版又按使用者的要求撤掉了。
 *
 * 挂在输入框那行的状态药丸上（`.composer-actions` 里 `#status` 后面），**不进顶栏**：
 * 默认布局下侧栏 292 + 右侧面板 400，顶栏只剩 412px，本来就只剩 2px 余量，再加一颗读数就会把
 * 「面板」开关挤出可视区（实测：挂上之后内容宽 486 > 客户宽 412）。而状态那一行本来就是
 * 「这一轮发生了什么」的位置，也已经会折行，放这里不挤任何控件。
 *
 * 两个作用域，谁也不是自己攒的：
 *   - **最近一轮**：`done` 事件给的 `↑输入 ↓输出 · 上下文占用`。
 *   - **本会话累计**：`usage` 事件给的轮数与 token（随快照发一次，之后每轮更新一次）。
 *     累计刻意放在服务端：浏览器自己攒会在刷新页面时归零，两个标签页看同一个会话还会各攒一份，
 *     而它显示的是一句「本会话花了多少」。
 *
 * 缓存命中率还有个额外用处：它是我们自己提示词稳定性的体检。服务端按前缀命中上下文缓存，
 * 系统提示词只要每轮变一点点（日期、环境信息、注入内容），命中率就会掉、花费会翻几倍。
 * core 的 refreshSystemPrompt 特意在提示词没变时不改系统消息，命中率就是把那条设计的效果量出来。
 */

import { formatTokens, formatUsage } from "./format.js";
import { el, state } from "./state.js";

/** 本会话累计，来自服务端的 `usage` 事件 */
let session = { turns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cachedKnown: false };
/** 最近一轮的那一段文案；还没跑过任何一轮时为空 */
let turnText = "";
/** 悬停里补一句上一轮的上下文占用；拿不到上下文数据时为空 */
let contextText = "";
/** 上一轮的上下文占用百分比；没有数据时 null（用来判断余量还剩多少） */
let contextPercent = null;
/** 余量低到百分之多少就把药丸标成警告色（上下文这块只留最要紧的一档） */
const CONTEXT_LOW_REMAINING = 20;
/** 状态药丸；自己建 DOM，不改 index.html（那是共享文件） */
let pill = null;

/** 千分位：token 常常上万，不分组读不出来 */
function group(count) {
	return count.toLocaleString("zh-CN");
}

/** 命中率；服务端一次都没回报过 cachedTokens 时返回 null，避免显示 NaN% 或一个假的 0% */
function hitRate() {
	return session.cachedKnown && session.promptTokens > 0
		? Math.round((session.cachedTokens / session.promptTokens) * 100)
		: null;
}

/** 悬停时把话说全：药丸上只放得下几个数 */
function hint() {
	if (session.turns === 0) {
		// 一轮都没跑完时也别把余量那句吞掉：它说的是**当下这个上下文**，与「跑了多少轮」无关
		return `本会话还没有完成一轮${lowRemainingHint()}`;
	}
	const rate = hitRate();
	const head = `本会话 ${session.turns} 轮：输入 ${group(session.promptTokens)} · 输出 ${group(session.completionTokens)}`;
	const cache = rate === null ? "（服务端未回报缓存命中）" : ` · 缓存命中 ${group(session.cachedTokens)}（${rate}%）`;
	return head + cache + (contextText === "" ? "" : `\n${contextText}`) + lowRemainingHint();
}

/**
 * 余量不多时补一句「那该怎么办」。
 *
 * 只报警不给下一步等于制造焦虑：这里直接指出那个开关在哪（面板 →「设置」→ 压缩），
 * 提示要给出下一步，而不是只报一个数字。
 */
function lowRemainingHint() {
	if (!isLow()) {
		return "";
	}
	return `\n上下文余量只剩 ${100 - contextPercent}%：面板「设置」里把「压缩」打开，或者新开一个会话接着干。`;
}

/** 余量是不是不多了 */
function isLow() {
	return contextPercent !== null && 100 - contextPercent <= CONTEXT_LOW_REMAINING;
}

/**
 * 重画药丸。
 *
 * 有最近一轮就显示那一轮的 token 与占用，否则退成「本会话 N 轮」——刷新页面之后最近一轮没了，
 * 但会话累计还在，不该整块消失（那是这个会话真花掉的钱）。
 */
function render() {
	if (pill === null) {
		return;
	}
	const rate = hitRate();
	const parts = [];
	if (turnText !== "") {
		parts.push(turnText);
	} else if (session.turns > 0) {
		// 刷新页面之后最近一轮的那段没有了，但会话累计还在：先把「本会话多少轮」说出来，
		// 别让药丸只剩一个命中率百分比。
		parts.push(`本会话 ${session.turns} 轮`);
	}
	if (rate !== null) {
		parts.push(`缓存 ${rate}%`);
	}
	const text = parts.join(" · ");
	pill.textContent = text;
	pill.hidden = text === "";
	pill.title = hint();
	// 余量不多时换警告色：颜色是「提醒」，具体剩多少与怎么办在悬停里
	pill.classList.toggle("lku-low", isLow());
}

/** 最近一轮结束：只记这一轮的数字（会话累计由服务端的 usage 事件负责） */
export function noteTurn(usage, contextTokens, contextWindow) {
	const elapsed = state.turnStartedAt === null ? 0 : Date.now() - state.turnStartedAt;
	state.turnStartedAt = null;
	turnText = formatUsage(usage, contextWindow ?? 0, elapsed, contextTokens ?? undefined);
	contextText =
		typeof contextTokens === "number" && contextTokens > 0 && (contextWindow ?? 0) > 0
			? `上一轮上下文占用 ${((contextTokens / contextWindow) * 100).toFixed(1)}%（${formatTokens(contextTokens)} / ${formatTokens(contextWindow)}）`
			: "";
	contextPercent =
		typeof contextTokens === "number" && contextTokens > 0 && (contextWindow ?? 0) > 0
			? Math.min(100, (contextTokens / contextWindow) * 100)
			: null;
	render();
}

/** 本会话累计（随快照与每轮结束由服务端发来） */
export function applySession(event) {
	const usage = event?.usage ?? {};
	session = {
		turns: typeof event?.turns === "number" ? event.turns : 0,
		promptTokens: numberOrZero(usage.promptTokens),
		completionTokens: numberOrZero(usage.completionTokens),
		cachedTokens: numberOrZero(usage.cachedTokens),
		cachedKnown: typeof usage.cachedTokens === "number",
	};
	render();
}

function numberOrZero(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 还没连上任何会话时把药丸清空，免得把上一个会话的数带过来 */
export function resetUsage() {
	session = { turns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cachedKnown: false };
	turnText = "";
	contextText = "";
	contextPercent = null;
	render();
}

/** 注入自己的样式：类名带前缀，颜色只用既有 MD3 角色变量 */
function injectStyle() {
	const style = document.createElement("style");
	style.textContent = `
/* 输入框那行里的用量药丸；一轮都没跑过、也没有会话累计时整块隐藏。
   挤不下时省略而不是横向溢出：这一行在窄屏会折行，药丸自己不该撑破卡片。 */
.lku-usage {
	flex: 0 1 auto;
	min-width: 0;
	max-width: 100%;
	overflow: hidden;
	text-overflow: ellipsis;
	padding: var(--space-1) var(--space-3);
	border: 1px solid var(--border);
	border-radius: var(--radius-pill);
	background: var(--surface-2);
	color: var(--muted);
	font-family: var(--font-mono);
	font-size: var(--text-xs);
	white-space: nowrap;
}
/* 上下文余量不多了：换成警告色。颜色只是「提醒」，剩多少与怎么办写在悬停里（hint()）。 */
.lku-low {
	border-color: color-mix(in srgb, var(--warn) 45%, transparent);
	color: var(--warn);
}
`;
	document.head.append(style);
}

export function init() {
	injectStyle();

	// DOM 自己建，不动 index.html——那是共享文件，多个功能一起改必然互相覆盖。
	if (el.status === null) {
		return;
	}
	pill = document.createElement("span");
	pill.className = "lku-usage";
	pill.hidden = true;
	pill.title = "本会话还没有完成一轮";
	el.status.after(pill);
}
