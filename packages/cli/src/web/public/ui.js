/*
 * 状态栏与输入框的视觉状态。
 *
 * 单独成模块是为了打破循环依赖：会话模块要改状态栏，而状态栏不需要知道任何会话逻辑。
 */

import { el, state } from "./state.js";

/** 更新底部状态栏文案 */
export function setStatus(text) {
	el.status.textContent = text;
	// 药丸按内容定宽、放不下就省略（路径类状态经常放不下），全文留在 title 上，悬停能看全。
	el.status.title = text;
}

/** 记下这一轮开始的时刻（状态栏的「用时」在别处用） */
export function markTurnStart() {
	state.turnStartedAt = Date.now();
}

/** 输入框自己的提示语；生成中会临时换成「这一轮能做什么」，跑完换回来 */
const INPUT_PLACEHOLDER = el.input.placeholder;

/** 生成中的秒表；没有转圈动画，用秒数表示它还在动 */
let elapsedTimer = 0;

/** 生成中每秒刷一次状态行 */
function startElapsed() {
	stopElapsed();
	const startedAt = Date.now();
	const tick = () => {
		setStatus(`生成中… 已 ${Math.round((Date.now() - startedAt) / 1000)} 秒（Esc 中断）`);
	};
	tick();
	elapsedTimer = setInterval(tick, 1000);
}

function stopElapsed() {
	if (elapsedTimer !== 0) {
		clearInterval(elapsedTimer);
		elapsedTimer = 0;
	}
}

/**
 * 切换「生成中」的界面状态。
 *
 * 提示语随状态变：跑起来时输入框换成「Enter 排队 / Esc 中断」，
 * 跑完换回原来那句；状态行报秒数，让人知道它还在动——本仓库不加动画，所以用秒数而不是转圈。
 */
export function setRunning(running) {
	state.running = running;
	document.body.classList.toggle("running", running);
	el.stop.hidden = !running;
	el.send.disabled = running;
	/*
	 * **输入框不锁**：一轮跑几分钟是常态，锁上就等于「这段时间你什么都写不了」。留着可以先写下一条，
	 * 回车把它排到这一轮后面（见 sessions.js 的 submit），发送按钮仍然禁用。
	 */
	if (running) {
		el.input.placeholder = "生成中…（Enter 把下一条排队，Esc 中断）";
		startElapsed();
	} else {
		el.input.placeholder = INPUT_PLACEHOLDER;
		stopElapsed();
	}
	syncSend();
}

/**
 * 发送按钮的文案与可用状态跟着「这一轮在不在跑 + 输入框里有没有字」走。
 *
 * **一颗按钮只描述它这次点击真会做的事**（DSH 的输入条就是这么做的）：空闲时是「发送」，
 * 跑着且输入框里有草稿时是「排队」——点了会把这条排到这一轮后面。只有「跑着且什么都没写」
 * 时才禁用，那种情况下这颗按钮确实无事可做。
 */
export function syncSend() {
	const draft = el.input.value.trim() !== "";
	const willQueue = state.running && draft;
	el.send.textContent = willQueue ? "排队" : "发送";
	el.send.disabled = state.running && !draft;
	el.send.title = willQueue ? "这一轮还在跑：这条排到它后面，结束自动发" : "发送（Enter）";
}

/** 输入框随内容长高，最多 12 行 */
export function autoGrow() {
	el.input.style.height = "auto";
	el.input.style.height = `${Math.min(el.input.scrollHeight, 12 * 24)}px`;
	// 输入内容变了（或刚发完清空），发送按钮的说法跟着变
	syncSend();
}
