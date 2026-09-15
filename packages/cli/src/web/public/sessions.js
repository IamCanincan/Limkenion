/*
 * 会话：切换、删除、SSE 事件分发，以及提交与停止。
 *
 * 与服务端的分工：POST 提交指令与操作，SSE 接收事件。history / pending 是状态快照，
 * 收到就整体重绘，因此前端不需要自己维护「增量与权威状态是否一致」，断线重连也不会错位。
 *
 * 列表怎么画（按工作区分组、每行的 ▾ 菜单、悬停预览卡）在 session-list.js 里；这个文件只提供
 * 它要用的数据操作：拉列表、切会话、删会话。两边靠动态 import 连接，避免顶层循环依赖。
 */

import { api } from "./api.js";
import { open as openPicker } from "./picker.js";
import {
	addApprovalCard,
	addPlanReviewCard,
	addToolCard,
	appendReasoning,
	appendText,
	appendUserMessage,
	renderEmpty,
	renderFacts,
	renderHistory,
	renderNotices,
	restoreTurn,
	settleApproval,
	settlePlanReview,
	updateToolCard,
} from "./render.js";
import { applyState, refreshSessions, rememberSession, renderSessions } from "./session-list.js";
import { EVENT_TYPES, el, state } from "./state.js";
import { autoGrow, markTurnStart, setRunning, setStatus } from "./ui.js";
import { applySession, noteTurn, resetUsage } from "./usage.js";

/** 「会话换了」事件名；面板模块（历史、文件）听它把自己那一格换成新会话的内容 */
const SESSION_EVENT = "lk:session-changed";

/**
 * 一轮还在跑的时候按回车排队的那一条。
 *
 * 跑着的时候输入框不锁（见 ui.js 的 setRunning），所以使用者可以先写下一条；回车把它排到这里，
 * 这一轮一结束就自动发出去（`flushQueue`）。只留一条：排第二条等于改主意，直接覆盖。
 */
let queued = "";

/**
 * 新建会话并切过去。
 *
 * 落点由服务端的「当前工作目录」决定（面板、终端、搜索看的也是它）：给某个会话换目录时那个值会
 * 跟着走，所以这里不必再自己算一遍、也不必建完再补一次「只给这个会话换目录」。
 *
 * 用列表的刷新结果而不是 POST 的返回值：POST 只回 id 与文件路径，而列表要的是
 * cwd / updatedAt / 条数这些摘要字段，多拼一份很容易与服务端对不上。
 */
export async function createSession() {
	if (state.cwd === "") {
		// 还没选工作目录：不猜（服务端也不会拿启动目录兜底），直接把选择器摆出来。
		setStatus("先选一个工作目录");
		openPicker();
		return;
	}
	const created = await api("/api/sessions", { method: "POST" });
	await refreshSessions();
	selectSession(created.id);
	el.input.focus();
}

/** 删除会话；行尾 ▾ 菜单里的「删除会话」也走这里 */
export async function deleteSession(id) {
	try {
		await api(`/api/sessions/${id}`, { method: "DELETE" });
		if (id === state.activeId) {
			state.activeId = null;
			closeStream();
			renderEmpty();
		}
		state.sessions = state.sessions.filter((session) => session.id !== id);
		renderSessions();
	} catch (error) {
		setStatus(`删除失败：${error.message}`);
	}
}

/**
 * 每个会话各留一份输入框草稿。
 *
 * 使用者：「旧面板未输入的数据都应保留」——切换会话时把当前这份存起来、把对面那份放回输入框，
 * 于是来回切不丢东西，也不会把 A 的草稿带到 B 里去。键用会话 id（还没建会话时是空串）。
 */
const drafts = new Map();

/** 把草稿从 `from` 换到 `to`：存下输入框里现存的，再把对面那份放回去 */
function swapDraft(from, to) {
	if (from === to) {
		return;
	}
	if (el.input.value === "") {
		drafts.delete(from);
	} else {
		drafts.set(from, el.input.value);
	}
	el.input.value = drafts.get(to) ?? "";
	autoGrow();
}

/**
 * 会话换了（选中别的、或当前那个没了）之后广播一条事件。
 *
 * 面板模块各自的「这一格显示的是哪个会话」都得跟着换：历史上要重拉那一轮的列表，文件面板要把
 * 编辑区换成那个会话的那一份（见 files.js）。工作目录**不在**这条事件里——换会话不动它。
 */
function announceSessionChange(previous, next) {
	document.dispatchEvent(
		new CustomEvent(SESSION_EVENT, { detail: { previous: previous ?? "", current: next ?? "" } }),
	);
}

/**
 * 切换会话：断开旧的事件流，连上新的。
 *
 * **不碰工作目录**：会话在哪个目录里干活来自它会话头（服务端按会话头构造 Run，找不到就跨目录按 id 找），
 * 所以点开一个别的工作区的会话只是「看那个会话」，不该把面板与新建会话的落点一起搬走——那是会话菜单里
 * 「工作目录」那条独立动作才做的事（它会把当前工作目录也挪过去，因为使用者要的就是"界面都看这个目录"）。
 *
 * **也不中断对面**：旧会话那一轮还在服务端跑（这里只断开浏览器这条事件流，没有 abort），切回去时
 * 快照会把进度带回来；终端面板那条命令同理，它是另一条连接。
 */
export async function selectSession(id) {
	if (id === null || id === undefined) {
		return;
	}
	// 已经是当前会话就不动：重连一次会白跑一遍历史快照，输入框里的草稿也白留着。
	if (state.activeId === id && state.source) {
		return;
	}
	const previous = state.activeId;
	swapDraft(previous ?? "", id);
	// 记下「上回看到哪儿」：进程重启/刷新之后首屏回到这一个（见 session-list.js 的 lastSessionId）
	rememberSession(id);
	state.activeId = id;
	state.stream = null;
	closeStream();
	renderEmpty();
	connect(id);
	renderSessions();
	announceSessionChange(previous, id);
	/*
	 * 会话在**别的工作目录**里时，把「当前工作目录」一起挪过去：文件面板、终端、搜索、体检看的都是它
	 * （使用者：「点击新会话，面板并没有刷新」——面板那一格得跟着会话走）。
	 *
	 * 走带 `session` 的那条路：服务端只改这一个会话与全局 cwd，**不重建运行注册表**，所以别的会话
	 * （哪怕正在生成）照跑。正在生成的那个会话会被 409 挡下（重写会话头与追加消息会撞车），那种情况
	 * 就保持原样——不为了挪面板把正在跑的一轮掀翻。
	 */
	const target = state.sessions.find((session) => session.id === id);
	if (target !== undefined && target.cwd !== "" && target.cwd !== state.cwd) {
		await api("/api/cwd", { method: "POST", body: { path: target.cwd, session: id } })
			.then((next) => applyState(next))
			.catch(() => {});
	}
	// 放行规则是「会话级」的，切过去要重新问一次，不能沿用上一个会话的数字。
	void refreshApprovals();
}

/** 丢掉当前会话的视图状态，回到空界面。切换工作目录后整套会话都换了，用它收尾 */
export function clearActiveSession() {
	const previous = state.activeId;
	swapDraft(previous ?? "", "");
	rememberSession(null);
	state.activeId = null;
	state.stream = null;
	closeStream();
	renderEmpty();
	announceSessionChange(previous, null);
	void refreshApprovals();
}

/** 断开当前的事件流 */
function closeStream() {
	if (state.source) {
		state.source.close();
		state.source = null;
	}
}

/** 建立 SSE 连接并注册各类事件 */
function connect(id) {
	// 换会话先清空：快照里的 usage 紧接着就会把**这个**会话的累计填回来，中间那一瞬不该显示上一个会话的数。
	resetUsage();
	const source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
	state.source = source;
	for (const type of EVENT_TYPES) {
		source.addEventListener(type, (event) => {
			// 浏览器自己的连接错误也用 error 这个类型冒出来，那种事件没有 data；不区分的话
			// 会把 undefined 交给 JSON.parse。EventSource 会自行重连，重连成功后服务端会重发
			// 快照，这里只需提示一句。
			if (typeof event.data !== "string") {
				if (state.source === source) {
					setStatus("连接中断，正在重连…");
				}
				return;
			}
			handleEvent(JSON.parse(event.data));
		});
	}
}

/** 分发一条服务端事件 */
function handleEvent(event) {
	switch (event.type) {
		case "history":
			// 这里**不能**清用量：每轮结束服务端都会广播一次 history，清掉的话药丸刚显示就被抹了。
			// 会话累计随快照的 usage 事件走，真正的「换会话归零」在 connect() 里。
			state.stream = null;
			renderHistory(event.messages, event.cards);
			// 提示区不跟着消息走，重绘之后要重新贴回对话末尾。
			renderNotices(state.notices, requestRetry);
			return;
		case "pending":
			// 快照里的进行中一轮：重建现场。
			if (event.turn.text || event.turn.reasoning || event.turn.tools.length > 0 || event.turn.approval) {
				restoreTurn(event.turn);
			}
			// 待确认的调用也要画回来：刷新页面不该把「等你点一下」变成「永远卡住」。
			// 服务端还在等这个答复，卡片丢了它就只能在超时后按拒绝处理。
			if (event.turn.approval) {
				renderApprovalCard(event.turn.approval);
			}
			// 待评审的方案同理：服务端还在等这个结论，卡片丢了模型只能等到超时被退回。
			if (event.turn.planReview) {
				renderPlanReviewCard(event.turn.planReview);
			}
			return;
		case "facts":
			// 待办与目标：服务端从工具层的状态直接转手，界面不解析任何工具入参。
			renderFacts(event);
			return;
		case "status":
			setRunning(event.running);
			return;
		case "text":
			appendText(event.delta);
			return;
		case "reasoning":
			appendReasoning(event.delta);
			return;
		case "tool_start": {
			const card = addToolCard({
				id: event.id,
				name: event.name,
				input: event.input,
				// 摘要、路径与交付物都由服务端按工具自陈下发，前端不再按工具名猜字段
				summary: event.summary,
				path: event.path ?? null,
				deliverables: event.deliverables ?? [],
				status: "running",
				content: "",
				ms: 0,
			});
			state.stream.toolCards.set(event.id, card);
			return;
		}
		case "tool_end": {
			const card = state.stream?.toolCards.get(event.id);
			if (card) {
				updateToolCard(card, {
					status: event.isError ? "error" : "ok",
					content: event.content,
					ms: event.ms,
				});
			}
			return;
		}
		case "approval":
			// 卡片上的按钮直接回执给服务端，运行层在等这个答复。
			renderApprovalCard(event);
			return;
		case "approval_result":
			settleApproval(event.approved);
			// 答「总是允许」会让内核多记一条规则；这里刷新一下侧栏那个计数。
			if (event.approved) {
				void refreshApprovals();
			}
			return;
		case "plan_review":
			// 计划模式下模型提交了方案：卡片上「按方案执行」会回执给服务端，模型在等这个结论。
			renderPlanReviewCard(event);
			return;
		case "plan_review_result":
			settlePlanReview(event.approved);
			return;
		case "usage":
			// 本会话累计（快照里一次 + 每轮结束一次），由服务端攒。
			applySession(event);
			return;
		case "done":
			// 用量三个字段都是事实，服务端没拿到就是 null；由用量模块决定显示哪几个、什么时候隐藏。
			noteTurn(event.usage, event.contextTokens, event.contextWindow);
			setStatus("完成");
			setRunning(false);
			void refreshSessions();
			flushQueue();
			return;
		case "error":
			// 具体的说明由随后的 notices 事件给出（它才是那份「看得见、刷新也在」的记录）；
			// 这里只把状态栏收尾，免得一直停在「生成中」。
			setStatus("出错");
			setRunning(false);
			flushQueue();
			return;
		case "notices":
			// 全量列表：存一份再整体重绘，刷新页面与断线重连都靠它把提示贴回来。
			state.notices = Array.isArray(event.items) ? event.items : [];
			renderNotices(state.notices, requestRetry);
			return;
		default:
			return;
	}
}

/**
 * 重试上一轮。
 *
 * 交给服务端的 /retry 而不是把输入框里的文字再发一遍：失败时用户消息已经进了历史，
 * 重发一遍会在会话记录里多出一条重复的指令。
 */
async function requestRetry() {
	if (state.running || !state.activeId) {
		return;
	}
	setRunning(true);
	setStatus("重试中…");
	try {
		await api(`/api/sessions/${encodeURIComponent(state.activeId)}/retry`, { method: "POST" });
	} catch (error) {
		setStatus(`重试失败：${error.message}`);
		setRunning(false);
	}
}

/**
 * 画出确认卡片，并把用户的答复回执给服务端。
 *
 * 卡片负责收集「允许 / 本会话总是允许 / 拒绝」，真正的结论以服务端返回的 approval_result 为准；
 * 用户连点时以先落地的那个为准，所以这里先本地收尾。前缀要不要给、给什么由服务端决定，卡片只在
 * 有前缀时多画一个按钮。
 */
function renderApprovalCard(event) {
	addApprovalCard(
		{
			tool: event.tool,
			input: event.input,
			reason: event.reason,
			// 正文、「看起来不可逆」与「整份替换哪个文件」都由服务端随事件给（工具自陈），卡片只负责画
			detail: event.detail,
			destructive: event.destructive === true,
			change: event.change ?? null,
			suggestedPrefix: event.suggestedPrefix ?? null,
		},
		(approved, remember = false) => {
			settleApproval(approved, remember);
			void api(`/api/sessions/${encodeURIComponent(state.activeId)}/approval`, {
				method: "POST",
				body: { approved, remember },
			}).catch((error) => {
				setStatus(`确认失败：${error.message}`);
			});
		},
	);
}

/**
 * 画出方案评审卡片，并把结论回执给服务端。
 *
 * 与工具确认同一套路：只有「批准」需要明确同意，退回必须带一句反馈（服务端也会拒空反馈）。
 */
function renderPlanReviewCard(event) {
	addPlanReviewCard({ plan: event.plan }, (verdict) => {
		settlePlanReview(verdict.approved);
		void api(`/api/sessions/${encodeURIComponent(state.activeId)}/plan-review`, {
			method: "POST",
			body: verdict,
		}).catch((error) => {
			setStatus(`评审失败：${error.message}`);
		});
	});
}

/** 清空上下文：保留会话文件，只让模型忘掉之前的对话（与命令行的 /clear 一致） */
export async function clearContext() {
	if (!state.activeId) {
		setStatus("还没有会话");
		return;
	}
	if (state.running) {
		setStatus("正在生成中，先停止再清空");
		return;
	}
	setStatus("正在清空上下文…");
	try {
		await api(`/api/sessions/${encodeURIComponent(state.activeId)}/clear`, { method: "POST" });
		setStatus("已清空上下文，会话文件仍保留");
	} catch (error) {
		setStatus(`清空失败：${error.message}`);
	}
}

/**
 * 刷新当前会话的放行规则。
 *
 * 命令行有 `/approvals`，网页也得看得见：点过「总是允许」之后没有入口能查看或收回的白名单，
 * 等于把一次判断变成永久的默认值。数据存在 `state.approvalRules` 里，由顶栏的模式菜单渲染
 * （以前是侧栏一个常驻按钮，现在并进「审批」那一段）。没有会话或请求失败时退回空数组，
 * 不显示上一次的数字。
 */
export async function refreshApprovals() {
	if (!state.activeId) {
		state.approvalRules = [];
		return;
	}
	try {
		const data = await api(`/api/sessions/${encodeURIComponent(state.activeId)}/approvals`);
		state.approvalRules = Array.isArray(data.rules) ? data.rules : [];
	} catch {
		state.approvalRules = [];
	}
}

/** 忘掉本会话的全部放行规则（先问一次） */
export async function clearApprovals() {
	if (!state.activeId) {
		setStatus("还没有会话");
		return;
	}
	try {
		const result = await api(`/api/sessions/${encodeURIComponent(state.activeId)}/approvals`, { method: "POST" });
		await refreshApprovals();
		setStatus(result.cleared > 0 ? `已忘掉 ${result.cleared} 条放行规则` : "本会话没有放行规则");
	} catch (error) {
		setStatus(`清除失败：${error.message}`);
	}
}

/**
 * 把排队的那一条发出去。
 *
 * 一轮收尾（`done` / `error`）时调用：放回输入框再走一次 `submit()`，发送失败怎么处理、要不要先建会话、
 * 状态行怎么写全都与手动发送一致，不在两条路上各写一遍。
 */
function flushQueue() {
	if (queued === "") {
		return;
	}
	const next = queued;
	queued = "";
	renderQueue();
	el.input.value = next;
	autoGrow();
	void submit();
}

/**
 * 排队中的那一条要有块看得见的地方。
 *
 * 光靠状态行一句「排在后面」不够：状态行会被别的提示顶掉。所以照着 DSH 的 dock 栈做法，
 * 在输入框上方那排浮标里贴一枚小标（点一下取消排队），与「↓ 跳到最新」同一套样式。
 */
let queueBadge = null;

function renderQueue() {
	if (queueBadge === null) {
		if (el.jumpLatest === null || el.jumpLatest === undefined) {
			return;
		}
		queueBadge = document.createElement("button");
		queueBadge.type = "button";
		queueBadge.className = "transcript-jump";
		queueBadge.addEventListener("click", () => {
			queued = "";
			renderQueue();
			setStatus("已取消排队的那一条");
		});
		el.jumpLatest.before(queueBadge);
	}
	queueBadge.hidden = queued === "";
	queueBadge.textContent = queued === "" ? "" : "1 条排队中 · 点一下取消";
	queueBadge.title = "这一轮结束后会自动发出这条";
}

/** 提交一条指令 */
export async function submit() {
	const text = el.input.value.trim();
	if (text === "" || state.running) {
		/*
		 * 跑着的时候回车不等于没反应：把这条**排到后面**，这一轮结束自动发出去（输入框不再锁上，
		 * 所以「先写好、回车排队」是可行的）。空回车才什么都不做。
		 */
		if (text !== "" && state.running) {
			queued = text;
			el.input.value = "";
			autoGrow();
			renderQueue();
			setStatus("这一轮还在跑：这条排在后面，结束自动发");
		}
		return;
	}
	if (!state.activeId) {
		// 没有会话时会先建一个；而建会话要求已经选好工作目录（见 createSession）。
		if (state.cwd === "") {
			setStatus("先选一个工作目录");
			openPicker();
			return;
		}
		await createSession();
	}
	el.input.value = "";
	autoGrow();
	setRunning(true);
	markTurnStart();
	setStatus("生成中…");
	// 本地先画出用户消息，等服务端 history 快照回来会整体重绘，不会重复。
	appendUserMessage(text);

	try {
		await api(`/api/sessions/${encodeURIComponent(state.activeId)}/prompt`, {
			method: "POST",
			body: { text },
		});
	} catch (error) {
		// 提交本身失败（网络、404、409）走状态栏就够了：这一轮根本没跑起来，
		// 不该在对话流里留下一条「运行提示」——那是给「跑起来但失败了」用的。
		setRunning(false);
		setStatus(`发送失败：${error.message}`);
	}
}

/** 请求中断当前生成 */
export async function stop() {
	if (!state.activeId) {
		return;
	}
	setStatus("正在停止…");
	await api(`/api/sessions/${encodeURIComponent(state.activeId)}/abort`, { method: "POST" }).catch(() => {});
}
