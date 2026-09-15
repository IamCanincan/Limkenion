/*
 * 侧栏会话列表：按工作区分组、每行的 ▾ 菜单、悬停预览卡。
 *
 * 为什么单独成模块：这份列表要按工作区折叠、要挂一行一个的菜单、还要在悬停时弹一张卡，
 * 都塞进 sessions.js 会把「数据操作（新建/切换/删除/事件流）」和「这一块怎么画」搅在一起。
 * sessions.js 只保留数据与切换，画的部分全在这里，两个文件互不引用对方的状态。
 *
 * 约定：DOM 与样式都由本模块自己建（运行时注入 <style>），不改 index.html 与 app.css——
 * 那两处是外壳与别的功能共用的文件。
 *
 * 形态参考的是「工作区分组」的会话列表：一条工作区标题（文件夹符号 + 目录名 + 会话数）下面挂
 * 属于它的会话行，行上是「预览 + 相对时间」，行尾一个 ▾ 菜单（当前只放删除会话）。
 */

import { api } from "./api.js";
import { baseName, formatRelativeTime, formatTime } from "./format.js";
import { icon, SYMBOL_TO_ICON } from "./icons.js";
import { el, state } from "./state.js";
import { setStatus } from "./ui.js";

/**
 * 本模块的样式。
 *
 * 颜色只用 MD3 角色变量，字号/圆角/间距只用既有尺度；不加动画（状态切换直接变）。
 * 行本身沿用外壳的 .session-item（它已经有选中态、悬停态与左侧竖条），这里只补分组与卡片的部分。
 */
export const STYLE = /* css */ `
/* 分组头：收起/展开的 ▸▾ + 文件夹符号 + 目录名 + 会话数 */
/* 当前工作目录那一组给一点强调：切错工作区时最常出的错就是「在旧目录里新建会话」 */
/* 别的工作区用 secondary 色相：当前组是 primary、其它组是 secondary，
   一眼能分出「我在哪」而不是靠字重猜（MD3 的角色分工就是这么用的） */
/* 工作区名后面的「…」：菜单里是「新会话」与「删除」（使用者要求）。
   20px 的方圆形按钮，平时透明、悬停才显底色，与行尾那个 ▾ 同一套做法。 */
/*
 * 「…」的状态用**中性**色调，别在平整的分组头上贴色斑（使用者：「工作空间的按钮颜色很怪」）：
 *   悬停 --hover（rgba(34,25,27,.06)，主题感知）、按下把文字色兑 12% 当底、
 *   展开用 --accent-ring（半透明强调色）+ 强调色文字。都不用过渡动画，瞬时切换。
 */
/* 行尾那颗 ▾ 同样三态，且与「…」同一套中性色 */
.lk-row-menu:active { background: color-mix(in srgb, var(--text) 12%, transparent); color: var(--text); }
.lk-row-menu[aria-expanded="true"] { background: var(--accent-ring); color: var(--accent-text); }

/* 行：两层文字 + 右侧操作（.session-item 是两列网格，见 app.css） */
.lk-row-body { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
/*
 * 拖动排序的两个记号：被拖的那一行淡下去，落点用一条 2px 的强调色线（画在行的上/下沿）。
 * 都是瞬时切换的静态样式，没有过渡也没有动画（本仓库不加动画）。
 */
.session-item.dragging { opacity: .45; }
.session-item[data-drop] { position: relative; }
.session-item[data-drop]::after { content: ""; position: absolute; left: 0; right: 0; height: 2px; border-radius: var(--radius-pill); background: var(--accent); }
.session-item[data-drop="before"]::after { top: -1px; }
.session-item[data-drop="after"]::after { bottom: -1px; }
.lk-row-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 标题加粗、用正文色：层次的第一层 */
.lk-row-title { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text); font-size: var(--text-sm); font-weight: 600; }
/* 次要行：消息数与时间，淡淡的第二层 */
.lk-row-meta { color: var(--muted); font-size: var(--text-xs); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lk-row-menu { flex: 0 0 auto; align-self: stretch; width: 20px; display: flex; align-items: center; justify-content: center; border: 0; border-radius: var(--radius-pill); background: transparent; color: var(--muted); font: inherit; font-size: var(--text-sm); line-height: 1; cursor: pointer; }
.lk-row-menu:hover { background: var(--hover); color: var(--text); }
/* （展开态见上面第 52 行那条：与「…」同一套中性色，别在这里再写一条 --accent-soft 覆盖掉） */

/* ▾ 菜单：与模式菜单同一套路——挂在 body 上、fixed 定位，坐标每次打开时按行算。
   留在 .session-list 里会被它的 overflow-y: auto 裁掉（滚动容器里的绝对定位弹层都会）。 */
.lk-sess-menu { position: fixed; z-index: 40; display: flex; flex-direction: column; gap: var(--space-3); min-width: 240px; max-width: 320px; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-glass-strong); backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass)); -webkit-backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass)); box-shadow: var(--shadow-lg); }
/*
 * 菜单做成"卡片式"，与设置面板那些卡片同一套层次：
 *   小标题（粗）+ 说明（淡） / 药丸动作 / 后果说明行
 * 动作是药丸而不是列表行：主行动填强调色（与分段按钮的选中态同款），破坏性动作用危险色描边。
 */
.lk-sess-menu-head { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.lk-sess-menu-label { flex: 0 0 auto; color: var(--text); font-size: var(--text-sm); font-weight: 600; }
.lk-sess-menu-detail { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); font-size: var(--text-xs); }
/* 动作区：两列网格，四边都齐（原来是一行自动折行，药丸不等宽、边参差不齐）。
   单个动作占一格（重命名 / 工作目录），带 .lk-sess-menu-wide 的占一整行（清空上下文 / 删除会话）。 */
.lk-sess-menu-actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
.lk-sess-menu-item { justify-content: center; }
.lk-sess-menu-wide { grid-column: 1 / -1; }
.lk-sess-menu-item:hover { border-color: color-mix(in srgb, var(--accent) 30%, transparent); background: var(--hover); }
.lk-sess-menu-item.lk-primary { border-color: var(--accent); background: var(--accent); color: var(--accent-soft); }
.lk-sess-menu-item.lk-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--accent-soft); }
.lk-sess-menu-item.lk-primary .lk-sess-symbol { color: var(--accent-soft); }
.lk-sess-menu-item.lk-danger { border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.lk-sess-menu-item.lk-danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); }
/* 后果说明行：与设置卡片的"关：正常执行"同一档（--text-xs + muted） */
.lk-sess-menu-hint { color: var(--muted); font-size: var(--text-xs); line-height: 1.5; }
.lk-sess-menu-item { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border: 1px solid var(--border-strong); border-radius: var(--radius-pill); background: transparent; color: var(--text-soft); font: inherit; font-size: var(--text-sm); white-space: nowrap; cursor: pointer; }
.lk-sess-menu-item:hover { background: var(--surface-3); }
.lk-sess-menu-item.lk-danger { color: var(--danger); }
.lk-sess-menu-item.lk-danger:hover { background: var(--danger-soft); }
.lk-sess-symbol { flex: 0 0 auto; width: 12px; color: var(--muted); }
.lk-sess-menu-item.lk-danger .lk-sess-symbol { color: var(--danger); }
/* 就地改名：输入框 + 保存/取消。输入框用与其它控件同一套描边与圆角，不要另起一套。 */
.lk-sess-rename { display: flex; flex-direction: column; gap: var(--space-3); }
.lk-sess-rename input { width: 100%; min-width: 0; padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); font: inherit; font-size: var(--text-sm); }
.lk-sess-rename input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }

/* 悬停预览卡：同样挂 body + fixed，位置跟着行算，不会盖住视口外。
   宽度上限按视口收（min(300px, 100vw - 16px)），窄屏上卡片不会伸出右边。
   长预览最多占 132px 高、超出裁掉：卡是「扫一眼」，不是阅读区，不能盖满整个窗口。 */
.lk-sess-card { position: fixed; z-index: 30; display: flex; flex-direction: column; gap: 6px; max-width: min(300px, calc(100vw - 16px)); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-glass-strong); backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass)); -webkit-backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass)); box-shadow: var(--shadow-lg); pointer-events: none; }
.lk-sess-card-title { display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; color: var(--text); font-size: var(--text-sm); font-weight: 600; word-break: break-word; }
.lk-sess-card-time { color: var(--muted); font-size: var(--text-xs); }
.lk-sess-card-path { overflow: hidden; color: var(--muted); font-family: var(--font-mono); font-size: var(--text-xs); white-space: nowrap; text-overflow: ellipsis; }
/* 列表上方的筛选/排序条：一行小药丸，开着的那颗用强调色底表达（aria-pressed 也同步） */
.lk-sess-view { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0 0 var(--space-2); }
.lk-sess-view-btn {
	padding: 2px var(--space-2);
	border: 1px solid var(--border);
	border-radius: var(--radius-pill);
	background: transparent;
	color: var(--muted);
	font: inherit;
	font-size: var(--text-xs);
	cursor: pointer;
}
.lk-sess-view-btn:hover { border-color: color-mix(in srgb, var(--accent) 30%, transparent); background: var(--hover); }
.lk-sess-view-btn[aria-pressed="true"] { border-color: var(--accent); background: var(--accent); color: var(--accent-soft); }
`;

/** 收起过的工作区；只活在这一次页面里，不写 localStorage（刷新即回到全展开） */

/** 最近一次列表重绘用过的摘要，供预览卡与菜单按 id 查 */
let current = [];

/** 当前开着的 ▾ 菜单；同时只允许开一个 */
let menu = null;

/** 一张悬停预览卡；同时只显示一张 */
let card = null;

/**
 * 已经「逻辑收起」但还在等延迟删除的那张卡。
 *
 * 必须单独记着：`card` 那时已经是 null，一旦新的卡要显示，就只能靠这个引用把旧节点真正删掉
 * （否则它永远留在 body 上，快速划几次就堆一片）。
 */
let pendingRemoval = null;

/** 挂起预览卡的定时器（收起有一小段延迟，不然鼠标划过就闪） */
let hoverTimer = 0;

/** 正在被拖动的那一行（会话 id）；没在拖就是 null。拖放的两个 handler 都靠它 */
let dragId = null;

/** 会话列表重绘后派发的事件；别的模块（总览）靠它把标记补回去 */
const LIST_EVENT = "lk:sessions-rendered";

/**
 * 工作目录变了之后派发的事件；名单与 files.js 里的同名常量一致。
 *
 * 文件面板记着「这棵树是照着哪个目录建的」，只在**重新显示**时对一次（见 files.js 的 reanchor）。
 * 换目录时面板往往正开着，那时它收不到「该重来」的信号，树就停在旧目录上——这条事件补的就是这一下。
 */
const CWD_EVENT = "lk:cwd-changed";

/**
 * 会话摘要的缺省值。
 *
 * 字段是从服务端一份 JSON 来的，缺字段就退回一个能渲染的值：列表不该因为少一个 `updatedAt`
 * 就整块空掉。`cwd` 缺失时并到当前工作目录那一组，`updatedAt` 缺失时退回创建时间。
 */
function normalize(raw) {
	const session = raw ?? {};
	const createdAt = typeof session.createdAt === "string" ? session.createdAt : "";
	const created = Date.parse(createdAt);
	return {
		id: String(session.id ?? ""),
		createdAt,
		cwd: typeof session.cwd === "string" && session.cwd !== "" ? session.cwd : state.cwd,
		updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Number.isFinite(created) ? created : 0,
		messageCount: Number.isFinite(session.messageCount) ? session.messageCount : 0,
		preview: typeof session.preview === "string" ? session.preview : "",
		// 使用者起的名字；没起过就是空串，显示时退回预览
		title: typeof session.title === "string" ? session.title : "",
		// 使用者拖出来的次序；没拖过就是 null（服务端据此退回按修改时间排）
		order: Number.isFinite(session.order) ? session.order : null,
		running: session.running === true,
		// 「在等你点一下」（工具确认 / 方案评审）：与「在跑」分开，行上的状态点把它排在前面
		waiting: session.waiting === true,
	};
}

/**
 * 按 cwd 分组。
 *
 * 组内按 updatedAt 倒序（最近动过的在上面）；当前工作目录那一组永远排第一，
 * 其余组按「组内最新的一条」倒序——同一个目录刚用过，它就该浮上来。
 */

/**
 * 行的显示名。
 *
 * 优先用使用者起的名字（改名之后就该显示那个），其次是首条用户消息的预览；还没说过话、也没起过名的
 * 会话给一条安静的说明，不能留一片空白——那看起来像列表坏了。
 */
function displayName(session) {
	if (session.title !== "") {
		return session.title;
	}
	return session.preview !== "" ? session.preview : "（还没有对话）";
}

/** 把 /api/state 或 /api/cwd 的返回值装配到界面上 */
export function applyState(initial) {
	const cwdChanged = typeof initial.cwd === "string" && initial.cwd !== state.cwd;
	state.cwd = initial.cwd;
	state.models = initial.models;
	state.sessions = Array.isArray(initial.sessions) ? initial.sessions.map(normalize) : [];
	// 「上次所在的会话」由服务端记（agent 目录里的小 JSON），换端口、换浏览器都一致
	state.lastSessionId = typeof initial.lastSessionId === "string" ? initial.lastSessionId : "";

	el.model.replaceChildren();
	for (const model of initial.models) {
		const option = document.createElement("option");
		option.value = model.id;
		// 下拉里显示人类可读名称，id 只作为提交值。
		option.textContent = model.name === "" ? model.id : model.name;
		el.model.append(option);
	}
	el.model.value = initial.model;

	// 刚选了别的会话（可能在别的工作区）时 state.activeId 已经有值：这时不能再改选，
	// 否则「点哪条开哪条」会被随后的「默认选最近的一条」覆盖掉。
	state.activeId = activeStillThere() ? state.activeId : null;
	renderSessions();
	// 目录换了要让开着的文件面板重建那棵树（它自己也只在重新显示时对一次）
	if (cwdChanged) {
		document.dispatchEvent(new CustomEvent(CWD_EVENT));
	}
	// 刚在「新建会话」那一步选完目录、还没建出会话：说清下一步是什么，否则界面看起来什么都没发生
	// （「还没有工作目录」那种状态已经不存在：服务端启动时一定给得出一个，见 server.ts 的 startupCwd）。
	if (state.cwd !== "" && state.sessions.length === 0) {
		setStatus("工作目录已选好，点「新建会话」开始");
	}
	if (state.activeId !== null) {
		void import("./sessions.js").then((module) => module.selectSession(state.activeId));
		return;
	}
	// 首屏默认落在**上次所在的那个会话**上（使用者：「limkenion进程重新打开后要记住上次所在的会话」）；
	// 那个会话没了（删了）就退回「最近更新的那个」。
	const remembered = state.sessions.find((session) => session.id === lastSessionId());
	const recent = remembered ?? [...state.sessions].sort((left, right) => right.updatedAt - left.updatedAt)[0];
	if (recent) {
		void import("./sessions.js").then((module) => module.selectSession(recent.id));
	} else {
		/*
		 * 一个会话都没有（全新的安装）就直接建一个，不让使用者先去选目录再点「新建会话」——使用者要的是
		 * 「启动进程且没会话的时候，默认新建个会话」。落点是服务端给的当前工作目录（没有会话时是主目录），
		 * 想换随时在会话菜单里换。
		 */
		void import("./sessions.js").then((module) => module.createSession());
	}
}

/**
 * 上次所在的会话 id。
 *
 * **由服务端记**（agent 目录里的 `web-state.json`，`/api/state` 随每次状态一起下发）：浏览器存储以 origin
 * 为作用域，换一个端口重新打开 `limkenion web` 就丢了。服务端在浏览器连上某个会话的事件流时记一笔，
 * 这里只负责首屏挑默认会话之前读一次；读不到（老服务端、还没记过）就退回「最近更新的那个」。
 */
function lastSessionId() {
	return typeof state.lastSessionId === "string" ? state.lastSessionId : "";
}

/**
 * 记下当前所在的会话：只更新本地这一份，**落盘由服务端负责**（浏览器连上该会话的事件流时它会写
 * `web-state.json`，见 `server.ts`）。这里同步本地状态是为了刚切完会话、状态还没刷回来时，
 * 挑默认会话的逻辑拿到的是新值而不是上一次的。
 */
export function rememberSession(id) {
	state.lastSessionId = id === null || id === undefined ? "" : id;
}

/**
 * 列表上方的筛选与排序（先给判据，再给内容）。
 *
 * 三个开关，都只在这一次页面里有效——界面偏好一律不落盘（本仓库的规矩，刷新即回默认）：
 * **只看当前目录**（会话是跨目录平铺的，多工作区时用得上）、**只看进行中**（跑着的会话可能被埋在下面）、
 * **按创建时间**（默认仍是服务端排好的「拖过的按你排的，没拖过的按最近使用」）。
 */
const view = { here: false, running: false, waiting: false, created: false };

/** 造这条筛选/排序条；按钮都用 aria-pressed 表达开没开，不靠颜色猜 */
function buildViewBar() {
	const bar = document.createElement("div");
	bar.className = "lk-sess-view";
	const make = (label, key, title) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "lk-sess-view-btn";
		button.textContent = label;
		button.title = title;
		button.setAttribute("aria-pressed", "false");
		button.addEventListener("click", () => {
			view[key] = !view[key];
			button.setAttribute("aria-pressed", view[key] ? "true" : "false");
			renderSessions();
		});
		return button;
	};
	bar.append(
		make("当前目录", "here", "只看当前工作目录里的会话"),
		make("进行中", "running", "只看正在跑的会话"),
		make("等我", "waiting", "只看在等你点一下的会话（工具确认 / 方案评审）"),
		make("按创建时间", "created", "按创建时间排（默认按你拖的次序与最近使用）"),
	);
	return bar;
}

/** 当前选中的会话是否还在这份列表里 */ function activeStillThere() {
	return state.activeId !== null && state.sessions.some((session) => session.id === state.activeId);
}

/** 拉一次会话列表并重绘 */
export async function refreshSessions() {
	const data = await api("/api/sessions");
	state.sessions = Array.isArray(data.sessions) ? data.sessions.map(normalize) : [];
	renderSessions();
}

/** 派发「列表重绘了」：总览靠它把「正在跑」的标记补到新行上 */
function announce() {
	document.dispatchEvent(new CustomEvent(LIST_EVENT));
}

/** 重绘整份列表 */
export function renderSessions() {
	current = state.sessions;
	// 行的节点会被整行换掉，菜单与预览卡上的引用就失效了：先收掉，重绘后再按 id 还原菜单。
	// 预览卡必须**立即**丢弃（不是交给延迟删除）：重绘时鼠标往往还停在某一行上，
	// 那张卡没人再来删，就会一张张留在 body 上。
	// 「菜单开着」只在这一处读一次：closeMenu 之后 menu 就是 null，别的关闭路径不会留下还原的记号
	// （从前留着一个 anchorId 不清，于是关掉菜单后只要列表再重绘一次菜单就自己冒出来——换完工作目录真踩过）。
	const keepAnchor = menu === null ? null : menu.sessionId;
	closeMenu();
	dropCards();

	el.sessionList.replaceChildren();
	/*
	 * 平铺（使用者：「还原为原来一段段会话」）：不再按工作区分组，全部会话排成一条条。
	 * 服务端的 summaries() 本来就是**跨全部工作目录**的，而且**顺序也在那边排定了**
	 * （拖过序的按使用者排的，没拖过的按最近使用）：这里照单渲染，绝不自己再排一遍——
	 * 两边各排一次，迟早会不一致。
	 * 不是当前工作目录的，行内 meta 会标出工作区名（见 sessionRow），否则同名会话分不清。
	 */
	const wanted = current.filter(
		(session) =>
			(view.here ? session.cwd === state.cwd : true) &&
			(view.running ? session.running : true) &&
			(view.waiting ? session.waiting : true),
	);
	// 「按创建时间」是使用者显式选的另一种排法；默认仍然是服务端排好的那一种
	const flat = view.created
		? [...wanted].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
		: wanted;
	if (flat.length === 0) {
		const empty = document.createElement("div");
		empty.className = "session-preview";
		empty.textContent = current.length === 0 ? "还没有会话" : "没有符合条件的会话：上面的筛选条可以点掉";
		el.sessionList.append(empty);
		announce();
		return;
	}
	for (const session of flat) {
		el.sessionList.append(sessionRow(session));
	}
	announce();
	// 菜单开着的时候列表重绘了：锚点行还在的话，就把菜单还原到新行上。
	if (keepAnchor !== null) {
		const anchor = findRowMenu(keepAnchor);
		if (anchor !== null) {
			openMenu(anchor, sessionById(anchor.dataset.sessionId));
		}
	}
}

/**
 * 侧栏左下角那一行「工作目录」已按使用者要求撤掉：目录只在会话行的 ▾ 菜单里选，
 * 侧栏底部只剩「模型」。这里不再有 renderCwd。
 */

/** 一个工作区分组头 */

/** 工作区级菜单（「…」）：新会话 / 删除。两个动作都作用于整个工作区，不是某一行。 */

/** 一行会话：预览 + 相对时间 + ▾ 菜单 */
function sessionRow(session) {
	const item = document.createElement("div");
	item.className = "session-item";
	item.dataset.sessionId = session.id;
	item.tabIndex = 0;
	if (session.id === state.activeId) {
		item.classList.add("active");
	}
	if (session.running) {
		// 整行强调色由总览补上（它认 data-session-id），这里先把状态交给它。
		item.classList.add("lmk-running");
	}
	if (session.waiting) {
		// 同上：在等你点一下的行，样式与悬停说明都由总览模块负责（它排在「在跑」之前）
		item.classList.add("lmk-waiting");
	}
	// 悬停提示给完整路径：行上只有目录名，同名目录（两个仓库都叫 src）得能分辨。
	item.title = session.cwd;

	/*
	 * 卡片式三层（与设置面板那些卡片同一套层次）：
	 *   加粗标题（首条输入）/ 次要行（N 条消息 · 相对时间）/ 右侧操作
	 */
	const body = document.createElement("div");
	body.className = "lk-row-body";

	const top = document.createElement("div");
	top.className = "lk-row-top";

	const title = document.createElement("span");
	title.className = "lk-row-title";
	title.textContent = displayName(session);

	const meta = document.createElement("div");
	meta.className = "lk-row-meta";
	// 空会话没有消息数，就只写时间
	const relative = formatRelativeTime(session.updatedAt);
	// 平铺之后不同工作区的会话混在一起：不是当前目录的，把工作区名标在行内，否则同名会话分不清
	const workspace = session.cwd && session.cwd !== state.cwd ? baseName(session.cwd) : "";
	const head = session.messageCount > 0 ? `${session.messageCount} 条消息 · ${relative}` : relative;
	meta.textContent = workspace === "" ? head : `${workspace} · ${head}`;

	const more = document.createElement("button");
	more.type = "button";
	more.className = "lk-row-menu";
	more.dataset.sessionId = session.id;
	more.append(icon("dots", 14));
	more.title = "更多操作";
	more.setAttribute("aria-haspopup", "true");
	more.setAttribute("aria-expanded", "false");
	more.addEventListener("click", (event) => {
		// 菜单按钮长在行里，不拦住的话点它会顺手把这个会话切过去。
		event.stopPropagation();
		if (menu !== null && menu.sessionId === session.id) {
			closeMenu();
			return;
		}
		openMenu(more, session);
	});

	top.append(title);
	body.append(top, meta);
	// ▾ 放在行这一层并拉满行高：它到上/下/右边的距离因此相等
	item.append(body, more);

	item.addEventListener("click", () => {
		void import("./sessions.js").then((module) => module.selectSession(session.id));
	});
	item.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void import("./sessions.js").then((module) => module.selectSession(session.id));
			return;
		}
		// 键盘也能排序：Alt + ↑/↓ 把这一行往上/下挪一格（拖动是鼠标那条路，这是它的等价路径）
		if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
			event.preventDefault();
			moveSession(session.id, event.key === "ArrowUp" ? -1 : 1);
		}
	});
	attachRowDrag(item, session);
	item.addEventListener("mouseenter", () => showPreview(item, session));
	item.addEventListener("mouseleave", () => hidePreview());
	item.addEventListener("focusin", () => showPreview(item, session));
	item.addEventListener("focusout", () => hidePreview());
	return item;
}

/*
 * 拖动排序：拖行本身（行是整块的拖拽把手），落点用一条 2px 的强调色线表示。
 *
 * 不用 HTML5 那套 draggable 也能做，但原生 drag 事件最省事：它自带「按住→移动→松开」的语义、
 * 会自动画拖影，触摸与鼠标都走同一条路。落点判断按「指针在哪一行的上半还是下半」算，
 * 因此往上拖与往下拖都只有一个插入位置，不会出现「拖到同一行的两个意思」。
 */
function attachRowDrag(item, session) {
	item.draggable = true;
	item.addEventListener("dragstart", (event) => {
		dragId = session.id;
		closeMenu();
		hidePreview();
		item.classList.add("dragging");
		event.dataTransfer.effectAllowed = "move";
		// 有些浏览器不给 dataTransfer 也能拖，但设一下最稳（拖动内容也就能被别处读）
		event.dataTransfer.setData("text/plain", session.id);
	});
	item.addEventListener("dragend", () => {
		dragId = null;
		clearDropMarks();
		item.classList.remove("dragging");
	});
}

/** 清掉落点那条线 */
function clearDropMarks() {
	for (const row of el.sessionList.querySelectorAll("[data-drop]")) {
		row.removeAttribute("data-drop");
	}
}

/** 指针落在哪一行的哪一侧；返回 null 表示这次不算有效落点 */
function dropTargetAt(clientY) {
	const rows = [...el.sessionList.querySelectorAll(".session-item")].filter((row) => row.dataset.sessionId !== dragId);
	for (const row of rows) {
		const box = row.getBoundingClientRect();
		if (clientY < box.top + box.height / 2) {
			return { row, after: false };
		}
	}
	const last = rows[rows.length - 1];
	return last === undefined ? null : { row: last, after: true };
}

/**
 * 把某一行挪到新的位置并存盘。
 *
 * 先按新顺序重绘（拖动要立刻有反馈），再把整份 id 列表发给服务端；服务端说有几个正在生成的
 * 会话没写（那些不能动头部），就以服务端那份为准重拉一次。
 */
async function moveSession(id, delta) {
	const rows = [...state.sessions];
	const from = rows.findIndex((session) => session.id === id);
	const to = from + delta;
	if (from === -1 || to < 0 || to >= rows.length) {
		return;
	}
	const next = [...rows];
	next.splice(to, 0, ...next.splice(from, 1));
	await saveOrder(next);
}

/** 按新顺序重绘 + 存盘；失败或服务端跳过了几个就以服务端那份为准 */
async function saveOrder(next) {
	state.sessions = next;
	renderSessions();
	try {
		const result = await api("/api/sessions/order", { method: "POST", body: { ids: next.map((s) => s.id) } });
		if (result.skipped > 0) {
			setStatus(`已排序；${result.skipped} 个正在生成的会话没动`);
			await refreshSessions();
			return;
		}
		setStatus("已按你排的顺序记下");
	} catch (error) {
		setStatus(`排序失败：${error.message}`);
		await refreshSessions();
	}
}

/** 按 id 取当前的摘要 */
function sessionById(id) {
	return current.find((session) => session.id === id);
}

/** 找某一行的 ▾ 按钮 */
function findRowMenu(id) {
	for (const node of el.sessionList.querySelectorAll(".lk-row-menu")) {
		if (node.dataset.sessionId === id) {
			return node;
		}
	}
	return null;
}

/**
 * 打开某一行的菜单。
 *
 * 菜单挂在 body 上、用 fixed 定位：`.session-list` 是 `overflow-y: auto` 的滚动容器，
 * 留在里面的绝对定位弹层会被整个裁掉（DOM 里查得到、屏幕上一像素看不到）。
 *
 * 现在菜单里是这一行的动作：重命名 / 工作目录 / 清空上下文 / 删除会话。原来侧栏底部那几个常驻按钮
 * （回滚上一轮、清空上下文、已放行）摊成一排，占地方又不好看出「作用在哪个会话上」；收进行菜单之后
 * 既是「针对这一行」的语义（不再依赖"当前选中的会话"），侧栏底部也只剩模型。
 * **回滚不在这里**：它连同逐轮 diff 一起在右侧面板的「历史」标签里（使用者：「会话中的回滚也移至
 * 历史板块中」）——撤之前该看得见要撤掉什么，菜单里只有一个「回滚上一轮」等于闭着眼睛撤。
 */
function openMenu(anchor, session) {
	closeMenu();
	anchor.setAttribute("aria-expanded", "true");
	if (session === undefined) {
		return;
	}

	const node = document.createElement("div");
	node.className = "lk-sess-menu";
	node.setAttribute("role", "menu");
	node.setAttribute("aria-label", `会话「${displayName(session)}」的操作`);
	node.dataset.sessionId = session.id;

	const rename = menuItem("重命名", "✎", "给这个会话起个名字；留空就退回显示首条消息", false);
	rename.addEventListener("click", (event) => {
		event.stopPropagation();
		openRenameForm(session);
	});
	const cwdItem = menuItem("工作目录", "▤", "换这个会话的工作目录（只影响它，别的会话不受影响）", false);
	cwdItem.addEventListener("click", (event) => {
		event.stopPropagation();
		closeMenu();
		void import("./picker.js").then((module) => module.open(session.id));
	});
	const clear = menuItem("清空上下文", "⌫", "让模型忘掉之前的对话；会话文件仍然保留", false);
	clear.addEventListener("click", (event) => {
		event.stopPropagation();
		closeMenu();
		void clearContextOf(session);
	});
	const remove = menuItem("删除会话", "✕", "删除这个会话文件，不能撤销", true);
	remove.addEventListener("click", (event) => {
		event.stopPropagation();
		closeMenu();
		void import("./sessions.js").then((module) => module.deleteSession(session.id));
	});
	/*
	 * 卡片式：标题 / 动作药丸 / 后果说明（跟着鼠标走）。
	 *
	 * 动作排成两列网格（使用者：「会话的菜单界面也整理一下」）：重命名与工作目录各占一格、等宽，
	 * 清空上下文与删除会话各占一整行。原来是「一行 flex 自动折行」，三个不等宽的药丸折出来的
	 * 左右边参差不齐；网格之后四边都是齐的。删除仍然单独一行——它不可撤销，不该和日常动作挤在一起。
	 */
	const items = [rename, cwdItem, clear, remove];
	clear.classList.add("lk-sess-menu-wide");
	remove.classList.add("lk-sess-menu-wide");
	const hint = menuHint(items, "回滚在右侧面板的「历史」里：那里有逐轮 diff，撤之前先看要撤掉什么");
	node.append(menuHead("会话", displayName(session)), menuActions(rename, cwdItem, clear, remove), hint);

	document.body.append(node);
	/*
	 * 尺寸先钉死再量位置：那句说明跟着鼠标换，长一句短一句会让整块卡片忽宽忽窄、忽高忽低，翻上翻下的判断
	 * 也会跟着用错高度（使用者：「会话的操作菜单不要动来动去」）。宽度取最长那句的宽度（再由 CSS 的
	 * min/max-width 夹住），高度在**定好宽度之后**量，这样换行到几行也是固定的。
	 */
	const hintTexts = [
		...items.map((item) => item.title),
		"回滚在右侧面板的「历史」里：那里有逐轮 diff，撤之前先看要撤掉什么",
	];
	lockMenuSize(node, hint, hintTexts);
	menu = { node, anchor, sessionId: session.id, buttons: items, focused: 0, width: 0, height: 0 };
	// 先显示再量：hidden 时尺寸是 0，位置就算不出来。
	positionMenu();
	rename.focus();
}

/**
 * 把卡片与说明行的尺寸钉死：宽度取这些文字里最宽的那一句，高度取定好宽度之后最高的一次。
 *
 * 量的时候卡片已经在文档里，所以量得到；量完把说明行还原成第一句（调用者给的那句兜底说明）。
 */
function lockMenuSize(node, hint, texts) {
	let widest = 0;
	for (const text of texts) {
		hint.textContent = text;
		widest = Math.max(widest, node.getBoundingClientRect().width);
	}
	node.style.width = `${Math.round(widest)}px`;
	let tallest = 0;
	for (const text of texts) {
		hint.textContent = text;
		tallest = Math.max(tallest, hint.offsetHeight);
	}
	hint.textContent = texts[texts.length - 1];
	hint.style.height = `${tallest}px`;
}

/**
 * 就地改名：把菜单卡片换成「输入框 + 保存 / 取消」。
 *
 * 不用 `window.prompt`：与「新建文件夹」同一套理由——原生弹框在网页里既突兀又不可控（不能校验、
 * 不能提示留空是什么意思）。输入框预填当前显示名，回车保存、Esc 取消。
 */
function openRenameForm(session) {
	const node = menu?.node;
	if (!node) {
		return;
	}
	const form = document.createElement("form");
	form.className = "lk-sess-rename";
	const input = document.createElement("input");
	input.type = "text";
	input.value = session.title !== "" ? session.title : session.preview;
	input.placeholder = "会话名；留空则退回显示首条消息";
	input.maxLength = 80;
	const row = document.createElement("div");
	row.className = "lk-sess-menu-actions";
	const save = document.createElement("button");
	save.type = "submit";
	save.className = "lk-sess-menu-item lk-primary";
	save.textContent = "✓ 保存";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "lk-sess-menu-item";
	cancel.textContent = "取消";
	cancel.addEventListener("click", () => closeMenu());
	row.append(save, cancel);
	form.append(input, row);
	node.replaceChildren(menuHead("重命名", displayName(session)), form);
	positionMenu();
	input.focus();
	input.select();

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const title = input.value.trim();
		try {
			await api(`/api/sessions/${encodeURIComponent(session.id)}/rename`, { method: "POST", body: { title } });
			closeMenu();
			await refreshSessions();
			setStatus(title === "" ? "已取消命名，改回显示首条消息" : `已改名为「${title}」`);
		} catch (error) {
			setStatus(`改名失败：${error.message}`);
		}
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closeMenu();
		}
	});
}

/** 菜单顶部的小标题：粗标签 + 淡说明（与设置卡片「审批 动手前要不要问一句」同一套） */
function menuHead(label, detail) {
	const node = document.createElement("div");
	node.className = "lk-sess-menu-head";
	const strong = document.createElement("span");
	strong.className = "lk-sess-menu-label";
	strong.textContent = label;
	const weak = document.createElement("span");
	weak.className = "lk-sess-menu-detail";
	weak.textContent = detail;
	weak.title = detail;
	node.append(strong, weak);
	return node;
}

/** 动作行：把药丸横排起来 */
function menuActions(...items) {
	const node = document.createElement("div");
	node.className = "lk-sess-menu-actions";
	node.append(...items);
	return node;
}

/** 后果说明行：跟着鼠标/焦点走（把当前那一项的 title 写出来，与设置卡片的说明行同一档） */
function menuHint(items, fallback) {
	const node = document.createElement("div");
	node.className = "lk-sess-menu-hint";
	node.textContent = fallback;
	for (const item of items) {
		const show = () => {
			node.textContent = item.title;
		};
		item.addEventListener("mouseenter", show);
		item.addEventListener("focus", show);
		item.addEventListener("mouseleave", () => {
			node.textContent = fallback;
		});
	}
	return node;
}

/** 造一行菜单项：符号 + 文字；danger 的用危险色 */
function menuItem(label, symbolText, title, danger) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "lk-sess-menu-item";
	if (danger) {
		button.classList.add("lk-danger");
	}
	button.setAttribute("role", "menuitem");
	button.title = title;
	const symbol = document.createElement("span");
	symbol.className = "lk-sess-symbol";
	symbol.setAttribute("aria-hidden", "true");
	const symbolIcon = SYMBOL_TO_ICON[symbolText];
	if (symbolIcon === undefined) {
		symbol.textContent = symbolText;
	} else {
		symbol.append(icon(symbolIcon, 13));
	}
	const text = document.createElement("span");
	text.textContent = label;
	button.append(symbol, text);
	return button;
}

/** 清空某个会话的上下文（会话文件保留），与命令行的 /clear 同一套语义 */
async function clearContextOf(session) {
	if (session.running) {
		setStatus("正在生成中，先停止再清空");
		return;
	}
	if (!window.confirm("清空这个会话的上下文？模型会忘掉之前的对话，会话文件仍然保留。")) {
		return;
	}
	setStatus("正在清空上下文…");
	try {
		await api(`/api/sessions/${encodeURIComponent(session.id)}/clear`, { method: "POST" });
		setStatus("已清空上下文，会话文件仍保留");
		await refreshSessions();
	} catch (error) {
		setStatus(`清空失败：${error.message}`);
	}
}

/** 收起菜单 */
function closeMenu() {
	if (menu === null) {
		return;
	}
	const { node, anchor } = menu;
	menu = null;
	node.remove();
	if (anchor.isConnected) {
		anchor.setAttribute("aria-expanded", "false");
	}
}

/**
 * 把菜单摆到 ▾ 的正下方（下面放不下就翻到上面），右边夹在视口内。
 *
 * fixed 定位就得自己跟着锚点走：列表可以滚动、窗口可以缩放，菜单不能停在一个旧坐标上。
 * 尺寸只量一次，之后滚动时平移——滚动里再量会强制重排，一滚一卡。
 */
function positionMenu() {
	if (menu === null) {
		return;
	}
	const anchor = menu.anchor.getBoundingClientRect();
	const node = menu.node;
	if (menu.width === 0) {
		const box = node.getBoundingClientRect();
		menu.width = box.width;
		menu.height = box.height;
	}
	const margin = 8;
	const left = Math.min(
		Math.max(anchor.right - menu.width, margin),
		Math.max(window.innerWidth - menu.width - margin, margin),
	);
	const below = anchor.bottom + 4;
	const top =
		below + menu.height <= window.innerHeight - margin ? below : Math.max(anchor.top - menu.height - 4, margin);
	node.style.left = `${Math.round(left)}px`;
	node.style.top = `${Math.round(top)}px`;
}

/** 按当前悬停的行摆预览卡；左右与上下都夹在视口内 */
function positionCard(node, anchor) {
	const box = node.getBoundingClientRect();
	const margin = 8;
	const left = Math.min(Math.max(anchor.right + 10, margin), Math.max(window.innerWidth - box.width - margin, margin));
	const top = Math.min(Math.max(anchor.top, margin), Math.max(window.innerHeight - box.height - margin, margin));
	node.style.left = `${Math.round(left)}px`;
	node.style.top = `${Math.round(top)}px`;
}

/** 悬停 / 聚焦预览卡：预览（标题）、条数、相对时间、绝对时间、工作目录 */
function showPreview(row, session) {
	// 同一行的重复 mouseenter（子节点之间移动也会冒）不必重建卡。
	if (card !== null && card.sessionId === session.id && card.row === row) {
		window.clearTimeout(hoverTimer);
		return;
	}
	hidePreview(true);
	/*
	 * 延迟移除中的那一张也要显式收掉。
	 *
	 * hidePreview(false) 把节点交给 120ms 的定时器，此时 card 已经是 null；紧接着的这次
	 * showPreview 若只 clearTimeout，就等于**取消了那张卡的删除**，于是它会永远留在 body 上
	 * ——快速在两行之间划过几次，卡片就无限堆叠（真出过这个 bug）。
	 */
	if (pendingRemoval !== null) {
		pendingRemoval.remove();
		pendingRemoval = null;
	}
	const node = document.createElement("div");
	node.className = "lk-sess-card";
	node.dataset.sessionId = session.id;
	// 会话没有名字，卡上的标题就是那条预览；正文不再重复一遍，多给一行绝对时间——
	// 相对时间只说「多久以前」，真要找某一轮时还得有个确定的时刻。
	const title = document.createElement("div");
	title.className = "lk-sess-card-title";
	title.textContent = displayName(session);
	const stats = document.createElement("div");
	stats.className = "lk-sess-card-time";
	stats.textContent = `${session.messageCount} 条 · ${formatRelativeTime(session.updatedAt)} · ${formatTime(session.createdAt)}`;
	const path = document.createElement("div");
	path.className = "lk-sess-card-path";
	path.textContent = session.cwd;
	path.title = session.cwd;
	node.append(title, stats, path);
	document.body.append(node);
	card = { node, row, sessionId: session.id };
	positionCard(node, row.getBoundingClientRect());
}

/** 收起预览卡；鼠标划过时给一小段延迟，避免在两行之间闪 */
function hidePreview(immediate = false) {
	if (card === null) {
		/*
		 * 没有当前卡，但可能有一张正在走那 120ms 的延迟删除。
		 *
		 * 这里**不能**先无条件 clearTimeout：鼠标从侧栏移向对话区时会连发 pointerover，
		 * 第二次进来看到 card 已是 null 就把定时器清了，那张节点就再也没人删——页面上一张张留着
		 * （预览卡堆叠就是这么来的）。延迟收起时保持原定时器；立即收起时把它一并删掉。
		 */
		if (immediate && pendingRemoval !== null) {
			window.clearTimeout(hoverTimer);
			hoverTimer = 0;
			pendingRemoval.remove();
			pendingRemoval = null;
		}
		return;
	}
	window.clearTimeout(hoverTimer);
	hoverTimer = 0;
	const node = card.node;
	card = null;
	if (immediate) {
		node.remove();
		return;
	}
	pendingRemoval = node;
	hoverTimer = window.setTimeout(() => {
		if (pendingRemoval === node) {
			pendingRemoval = null;
		}
		node.remove();
	}, 120);
}

/**
 * 列表重绘时把卡与待删节点一并收掉。
 *
 * 重绘后原有的行元素已经不在文档里（`card.row` 成了孤儿），留着卡只会指向一个不存在的位置；
 * 更要紧的是别让"待删"的那张跨过重绘继续挂着。
 */
function dropCards() {
	window.clearTimeout(hoverTimer);
	if (card !== null) {
		card.node.remove();
		card = null;
	}
	if (pendingRemoval !== null) {
		pendingRemoval.remove();
		pendingRemoval = null;
	}
}

/** 绑定本模块的全局事件：自己注入 <style>，不碰 index.html 与 app.css */
export function init() {
	const style = document.createElement("style");
	style.textContent = STYLE;
	document.head.append(style);
	// 列表上方的筛选/排序条：插在列表前面（`renderSessions` 会 replaceChildren 列表本身，
	// 所以这一条不能住在列表里面）
	el.sessionList.before(buildViewBar());

	/*
	 * 拖放排序：dragover / drop 挂在列表容器上（行是它的子节点，事件冒泡上来）。
	 * dragover 里必须 preventDefault，否则浏览器认为「这儿不接受放下」，drop 根本不会来。
	 */
	el.sessionList.addEventListener("dragover", (event) => {
		if (dragId === null) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const target = dropTargetAt(event.clientY);
		clearDropMarks();
		target?.row.setAttribute("data-drop", target.after ? "after" : "before");
	});
	el.sessionList.addEventListener("drop", (event) => {
		if (dragId === null) {
			return;
		}
		event.preventDefault();
		const marked = el.sessionList.querySelector(".session-item[data-drop]");
		const after = marked?.getAttribute("data-drop") === "after";
		const id = dragId;
		dragId = null;
		clearDropMarks();
		if (marked === null || marked === undefined) {
			return;
		}
		const next = state.sessions.filter((session) => session.id !== id);
		const moved = state.sessions.find((session) => session.id === id);
		const at = next.findIndex((session) => session.id === marked.dataset.sessionId);
		if (moved === undefined || at === -1) {
			return;
		}
		next.splice(after ? at + 1 : at, 0, moved);
		void saveOrder(next);
	});
	el.sessionList.addEventListener("dragleave", (event) => {
		// 只在真的离开列表时清线：行与行之间的移动也会冒 dragleave
		if (!el.sessionList.contains(event.relatedTarget)) {
			clearDropMarks();
		}
	});

	// 点别处收起菜单。用 composedPath 判断「点的是不是这个菜单」：菜单挂在 body 上，
	// 单看 target 的父链说不清，而事件本身带完整路径。
	document.addEventListener("click", (event) => {
		if (menu !== null && !event.composedPath().includes(menu.node)) {
			closeMenu();
		}
	});
	// Esc：先收菜单，再收预览卡。
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") {
			return;
		}
		if (menu !== null) {
			// 别让外壳的 Esc（关右侧面板）跟着一起动手：用户按一次只该收起一样东西。
			// 外壳那一条也挂在同一层，只 stopPropagation 拦不住同一节点上的监听器。
			event.stopImmediatePropagation();
			closeMenu();
			return;
		}
		hidePreview(true);
	});
	// 菜单的键盘操作：↑/↓ 移动。Enter 不在这里管——菜单项是 <button>，焦点在它身上时
	// 浏览器本来就会按一次 click，自己再触发一遍会走两次。
	document.addEventListener("keydown", (event) => {
		if (menu === null || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) {
			return;
		}
		// 正在就地改名时别抢 ↑/↓：那是在输入框里移动光标，不是换菜单项
		const target = event.target;
		if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
			return;
		}
		event.preventDefault();
		const step = event.key === "ArrowDown" ? 1 : -1;
		const total = menu.buttons.length;
		menu.focused = (menu.focused + step + total) % total;
		menu.buttons[menu.focused]?.focus();
	});
	// 悬停时鼠标移出侧栏（移到对话区）就不再显示预览卡。
	document.addEventListener("pointerover", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		if (target === null || target.closest(".session-item") === null) {
			hidePreview();
		}
	});
	// 弹层是 fixed 定位，得自己跟着锚点走：列表滚动、窗口缩放都会让旧坐标失效。
	// 用捕获阶段听 scroll，才能同时收到内部容器（会话列表）的滚动。
	const follow = () => {
		positionMenu();
		if (card !== null) {
			if (card.row.isConnected) {
				positionCard(card.node, card.row.getBoundingClientRect());
			} else {
				hidePreview(true);
			}
		}
	};
	window.addEventListener("scroll", follow, true);
	window.addEventListener("resize", follow);
}
