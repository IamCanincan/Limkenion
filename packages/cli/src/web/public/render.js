/*
 * 对话区渲染：空状态、流式中的一轮、工具卡片、历史消息。
 *
 * 渲染策略：历史消息整体重绘；正在流式输出的那一轮只改对应 DOM 节点，并用
 * requestAnimationFrame 合并同一帧内的多次增量，避免每个 token 都跑一遍 Markdown。
 */

import { formatDuration, renderMarkdown, summarizeInput } from "./format.js";
import { icon } from "./icons.js";
import { openPreview } from "./preview.js";
import { el, state } from "./state.js";

/** 清掉空状态占位 */
function clearEmpty() {
	const empty = el.transcript.querySelector(".empty");
	if (empty) {
		empty.remove();
	}
}

/** 画出空状态 */
/*
 * 「跟随末尾」与「跳到最新」。
 *
 * 流式输出时每来一段就无条件 `scrollTop = scrollHeight` 会把用户正在进行的向上滚动顶回去——
 * 表现就是「运行过程中往上拖不动」。所以只在**用户贴在底部**时才自动跟随；他往上翻过之后就停下，
 * 右下角冒出「↓ 跳到最新」，点一下回到末尾并恢复跟随（这套做法与终端面板一致）。
 */
const PIN_THRESHOLD_PX = 32;

/** 手势之后多久内的 scroll 还算「用户滚的」 */
const GESTURE_WINDOW_MS = 400;

/** 用户是否贴在底部；他主动往上翻之后就不再自动跟随 */
let following = true;

/** 滚到底部并恢复跟随；smooth 只给「跳到最新」用，自动跟随一律瞬时（否则与用户抢） */
function scrollToBottom(smooth = false) {
	following = true;
	if (el.jumpLatest !== null) {
		el.jumpLatest.hidden = true;
	}
	if (smooth) {
		el.transcript.scrollTo({ top: el.transcript.scrollHeight, behavior: "smooth" });
		return;
	}
	el.transcript.scrollTop = el.transcript.scrollHeight;
	// 布局有可能在这一帧之后才落定（输入框上方的浮标刚占位、字体刚换上……），那一拍 scrollHeight
	// 才变到位。下一帧再钉一次，否则会「差一截」，看起来就像浮标压住了最后一行。
	requestAnimationFrame(() => {
		if (following) {
			el.transcript.scrollTop = el.transcript.scrollHeight;
		}
	});
}

/**
 * 自动跟随：只在用户还在底部时才滚；他自己翻上去了就别动他的位置。
 *
 * 导出给 app.js 用：输入框上方那排浮标改高度时（出现/消失、折行数变了）会给对话区加底部留白，
 * 留白一变滚动位置就"差一截"，得按同一个规则重新钉到底（没在跟随就什么都不做）。
 */
export function followBottom() {
	if (following) {
		scrollToBottom();
	}
}

/**
 * 最近一次「用户手势」的时间戳。
 *
 * 只有滚轮、触摸、按键、按下指针才算用户想翻——**光看 scroll 事件分不清是谁引起的**：
 * 我们自己滚到底（每追加一段都会滚）也会触发 scroll，窗口缩放、输入框上方浮标占位同样会。
 * 早期版本只看 scroll，于是连续追加时的竞态会把 followed 判成「用户翻上去了」，
 * 之后再也不自动跟随（表现：钉不到底、差一截）。真踩过。
 */
let gestureAt = 0;

/** 用户手势：滚轮 / 触摸 / 按键 / 在对话区按下指针（含拖滚动条） */
function noteGesture() {
	gestureAt = performance.now();
}

/** 滚动之后重新判断「还在不在底部」，并决定那颗按钮露不露 */
function syncFollow() {
	const distance = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight;
	if (distance <= PIN_THRESHOLD_PX) {
		following = true;
		if (el.jumpLatest !== null) {
			el.jumpLatest.hidden = true;
		}
		return;
	}
	// 不是用户手势引起的（我们自己滚的、布局变化挤出来的）→ 保持跟随，直接重新钉到底
	if (performance.now() - gestureAt > GESTURE_WINDOW_MS) {
		if (following) {
			scrollToBottom();
		}
		return;
	}
	following = false;
	if (el.jumpLatest !== null) {
		el.jumpLatest.hidden = false;
	}
}

/** 接上对话流的滚动监听与「跳到最新」按钮；由 app.js 启动时调一次 */
export function initTranscriptFollow() {
	el.transcript.addEventListener("scroll", syncFollow, { passive: true });
	for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
		el.transcript.addEventListener(type, noteGesture, { passive: true });
	}
	if (el.jumpLatest !== null) {
		// 图标 + 文字；原来那行是写死的「↓ 跳到最新」文本
		el.jumpLatest.textContent = "";
		el.jumpLatest.append(icon("arrowDown", 14));
		const jumpLabel = document.createElement("span");
		jumpLabel.textContent = "跳到最新";
		el.jumpLatest.append(jumpLabel);
		el.jumpLatest.addEventListener("click", () => scrollToBottom(true));
	}
	following = true;
}

export function renderEmpty() {
	el.transcript.replaceChildren();
	const empty = document.createElement("div");
	empty.className = "empty";
	const line1 = document.createElement("p");
	line1.textContent = state.activeId ? "这个会话还没有消息。" : "还没有对话。";
	const line2 = document.createElement("p");
	line2.className = "hint";
	// 工作目录一定存在（服务端启动时给得出一个，首屏没有会话就直接建一个），所以这里只说下一步干什么。
	line2.textContent = "在下面输入任务，模型会调用 bash / read / write / edit 四个工具来完成它。";
	/*
	 * 再交代一句「在哪、用什么模型」：空会话正是需要方位感的时候，
	 * 有消息之后这两件事分别在侧栏与文件面板里，不必再占地方。
	 */
	const context = document.createElement("p");
	context.className = "hint";
	const modelName = el.model.options[el.model.selectedIndex]?.textContent?.trim() ?? "";
	context.textContent = `模型 ${modelName === "" ? "（读取中）" : modelName} · 工作目录 ${state.cwd}`;
	empty.append(line1, line2, context);
	el.transcript.append(empty);
}

/**
 * 开始一轮流式输出。
 *
 * 已经在流式输出时直接复用，避免重复插入节点；新一轮由 history 快照把 state.stream 清空。
 */
function beginStream() {
	if (state.stream) {
		return;
	}
	clearEmpty();

	const turn = document.createElement("div");
	turn.className = "turn assistant";

	const reasoningBox = document.createElement("details");
	reasoningBox.className = "reasoning";
	reasoningBox.hidden = true;
	const summary = document.createElement("summary");
	summary.textContent = "思考过程";
	const reasoningPre = document.createElement("pre");
	reasoningBox.append(summary, reasoningPre);

	const body = document.createElement("div");
	body.className = "assistant";

	const tools = document.createElement("div");

	turn.append(reasoningBox, body, tools);
	el.transcript.append(turn);
	followBottom(); // 新一轮开始：跟着末尾（除非用户自己翻上去了）

	state.stream = {
		turn,
		// 三个容易混的字段，刻意分开命名：
		//   reasoningBox 是折叠面板元素，reasoning 是思维链文本，
		//   reasoningText 是已经写进 DOM 的那份文本，用来跳过重复写。
		reasoningBox,
		reasoningPre,
		body,
		// tools 是装卡片的 DOM 容器，toolCards 是按调用 id 索引的卡片句柄，两者别混。
		tools,
		text: "",
		reasoning: "",
		reasoningText: "",
		pending: false,
		toolCards: new Map(),
	};
}

/** 用 rAF 合并同一帧内的多次增量 */
function schedulePaint() {
	if (state.stream?.pending) {
		return;
	}
	if (state.stream) {
		state.stream.pending = true;
	}
	requestAnimationFrame(() => {
		if (!state.stream) {
			return;
		}
		state.stream.pending = false;
		paintStream();
	});
}

/** 把缓冲写进 DOM */
function paintStream() {
	const stream = state.stream;
	if (!stream) {
		return;
	}
	if (stream.reasoning !== stream.reasoningText) {
		stream.reasoningText = stream.reasoning;
		stream.reasoningPre.textContent = stream.reasoning;
		stream.reasoningBox.hidden = stream.reasoning === "";
	}
	stream.body.innerHTML = renderMarkdown(stream.text);
	followBottom(); // 流式文本：只在用户还贴在底部时跟随
}

/** 收到一段正文增量 */
export function appendText(delta) {
	beginStream();
	state.stream.text += delta;
	schedulePaint();
}

/** 收到一段思维链增量 */
export function appendReasoning(delta) {
	beginStream();
	state.stream.reasoning += delta;
	schedulePaint();
}

/**
 * 用快照恢复进行中的一轮。
 *
 * 断线重连后服务端会重发 pending 快照，靠它把已经生成的部分重建出来。
 */
export function restoreTurn(turn) {
	beginStream();
	state.stream.text = turn.text;
	state.stream.reasoning = turn.reasoning;
	paintStream();
	for (const tool of turn.tools) {
		const card = addToolCard(tool);
		state.stream.toolCards.set(tool.id, card);
	}
}

/*
 * 工具行的固定符号，一律取自仓库约定的那一套，不新增字符：
 * 展开收起 `▸ ▾`、读取 `▤`、写入 `+`、编辑 `−`（与历史面板的增删同符）、
 * 搜索 `⌕`、终端 `⌗`。状态也同一套：运行中 `●`、完成 `✓`、失败 `✕`。
 */
// 工具行的前导图标：读=眼睛、写=文件加号、改=铅笔、搜=放大镜、命令=终端
const TOOL_GLYPHS = {
	read: "eye",
	write: "filePlus",
	edit: "pencil",
	grep: "search",
	glob: "search",
	bash: "terminal",
};

/*
 * 状态文案沿用原来的措辞：运行中 / 完成 / 失败 / 未完成，只把圆点换成了符号本身。
 * 终端面板的运行中用 `◐`，这里的 `●` 是同一含义的另一种画法——两处都不做动画。
 */
const TOOL_STATUS = {
	running: { text: "运行中", icon: "refresh", tone: "running" },
	ok: { text: "完成", icon: "check", tone: "ok" },
	error: { text: "失败", icon: "close", tone: "error" },
	pending: { text: "未完成", icon: "clock", tone: "running" },
};

/** 参数摘要的推荐长度：超过就截断，全量始终留在 title 里 */
const TOOL_SUMMARY_MAX = 60;

/**
 * 把服务端给的摘要压成折叠行上那一行文字。
 *
 * 摘要由**服务端按工具自陈下发**（core 里每个工具声明哪个字段最要紧），前端不认字段名。从前
 * 这里硬编码着 bash→command、read/write/edit→path、grep/glob→pattern、todo_write→todos、
 * present→files，加一个工具就要改一次这里；而 `job_*` / `subagent_*` / `goal_*` 因为没人记得改，
 * 一直显示成一坨 JSON。工具没声明摘要（历史里留着已删掉的工具）时退回整体 JSON，至少还有信息。
 */
function buildToolSummary(tool) {
	const raw =
		typeof tool.summary === "string" && tool.summary.trim() !== "" ? tool.summary : summarizeInput(tool.input);
	// 摘要里的换行会把单行撑成多行，先压成空格再截断。
	const flat = raw.replace(/\s+/g, " ").trim();
	return { text: flat.length > TOOL_SUMMARY_MAX ? `${flat.slice(0, TOOL_SUMMARY_MAX)}…` : flat, full: flat };
}

/** 把状态写进行右侧那一格；符号、颜色、文案一起变 */
function applyToolStatus(card, kind) {
	const status = TOOL_STATUS[kind] ?? TOOL_STATUS.pending;
	// 状态标记也换成线性图标（原来 ● ✓ ✕ 是文字符号，笔重和别人对不齐）
	card.statusSymbol.textContent = "";
	card.statusSymbol.append(icon(status.icon, 13));
	card.stateTag.className = `tool-status ${status.tone}`;
	card.stateText.textContent = status.text;
}

/**
 * 构造一张工具卡片并挂到 target 上。
 *
 * target 既可以是当前流式轮次的工具容器，也可以是一段正在拼装的历史消息。
 *
 * 版式是一行制：左边「▸ 符号 工具名 等宽摘要」，右边「状态符号 耗时」。
 * 点这一行展开详情，详情体本身没变（参数 / 输出 / 预览文件），
 * 既能扫得快，也不丢任何原先能看到的信息。
 */
/**
 * 交付物卡片：`present` 列的那几件画成可点的卡片。
 *
 * 一次只铺 4 张（DSH 也是这个数），其余折在「还有 N 件」里——交付物一多就变成目录，那不如让人去文件面板看。
 * 整卡可点：点哪里都等于「在右侧面板预览它」（次要那行悬停时换成提示，鼠标不用猜）。
 */
const PRESENT_VISIBLE = 4;

function presentCards(container, files) {
	const list = files.filter((file) => file && typeof file.path === "string" && file.path !== "");
	if (list.length === 0) {
		return;
	}
	const block = document.createElement("div");
	block.className = "present-block";
	const render = (expanded) => {
		block.replaceChildren();
		const shown = expanded ? list : list.slice(0, PRESENT_VISIBLE);
		for (const file of shown) {
			const card = document.createElement("button");
			card.type = "button";
			card.className = "present-card";
			card.title = file.path;
			const glyph = document.createElement("span");
			glyph.className = "present-glyph";
			glyph.append(icon("file", 14));
			const text = document.createElement("span");
			text.className = "present-text";
			const name = document.createElement("span");
			name.className = "present-name";
			name.textContent = file.path.split(/[\\/]/).pop() ?? file.path;
			const note = document.createElement("span");
			note.className = "present-note";
			note.textContent = file.note === "" ? file.path : file.note;
			text.append(name, note);
			card.append(glyph, text);
			card.addEventListener("click", () => void openPreview(file.path));
			block.append(card);
		}
		if (list.length > PRESENT_VISIBLE) {
			const more = document.createElement("button");
			more.type = "button";
			more.className = "present-more";
			more.textContent = expanded ? "收起" : `还有 ${list.length - PRESENT_VISIBLE} 件`;
			more.addEventListener("click", () => render(!expanded));
			block.append(more);
		}
	};
	render(false);
	container.append(block);
}

function buildToolCard(tool, target) {
	const card = document.createElement("div");
	card.className = "tool";

	const head = document.createElement("div");
	head.className = "tool-row";
	head.setAttribute("role", "button");
	head.tabIndex = 0;
	head.setAttribute("aria-expanded", "false");

	// 三角由 CSS 按展开状态给：▸ 收起、▾ 展开，展开时不靠 JS 换字符。
	const caret = document.createElement("span");
	caret.className = "tool-caret";
	const glyph = document.createElement("span");
	glyph.className = "tool-glyph";
	glyph.textContent = "";
	glyph.append(icon(TOOL_GLYPHS[tool.name] ?? "file", 13));
	const name = document.createElement("span");
	name.className = "tool-name";
	name.textContent = tool.name;
	const args = document.createElement("span");
	args.className = "tool-args";
	const summary = buildToolSummary(tool);
	args.textContent = summary.text;
	// 截断的摘要必须能看全：完整值始终在 title 里。
	args.title = summary.full;

	const statusSymbol = document.createElement("span");
	statusSymbol.className = "tool-symbol";
	const duration = document.createElement("span");
	duration.className = "tool-duration";
	const stateTag = document.createElement("span");
	stateTag.className = "tool-status";
	const stateText = document.createElement("span");
	stateTag.append(statusSymbol, stateText);
	head.append(caret, glyph, name, args, stateTag, duration);

	const body = document.createElement("div");
	body.className = "tool-body";
	body.hidden = true;
	const inputLabel = document.createElement("div");
	inputLabel.className = "tool-label";
	inputLabel.textContent = "参数";
	const inputPre = document.createElement("pre");
	inputPre.textContent = JSON.stringify(tool.input, null, 2);
	const outputLabel = document.createElement("div");
	outputLabel.className = "tool-label";
	outputLabel.textContent = "输出";
	const outputPre = document.createElement("pre");
	outputPre.textContent = tool.content ?? "";
	body.append(inputLabel, inputPre, outputLabel, outputPre);

	// 只读预览入口只在工具自陈「这次碰哪个文件」时给：路径是哪个字段由工具自己说，
	// 界面不认 `path` 这个字段名（从前认它，工具换个字段名预览入口就悄悄没了）。
	if (typeof tool.path === "string" && tool.path !== "") {
		const previewPath = tool.path;
		const previewButton = document.createElement("button");
		previewButton.className = "tool-preview";
		previewButton.type = "button";
		previewButton.textContent = "预览文件";
		previewButton.addEventListener("click", (event) => {
			// 卡片自己就是展开开关，按钮的点击不能顺带把详情收起来。
			event.stopPropagation();
			void openPreview(previewPath);
		});
		body.append(previewButton);
	}

	const toggle = () => {
		body.hidden = !body.hidden;
		head.setAttribute("aria-expanded", body.hidden ? "false" : "true");
	};
	head.addEventListener("click", toggle);
	// 键盘也能开合：这一行是个按钮，不是纯装饰。
	head.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			toggle();
		}
	});

	card.append(head, body);
	target.append(card);
	// 交付物：工具自陈「这次交付了哪几件」，就在工具行下面铺一排卡片
	// （历史重建与流式新增都走这里）。不自陈的工具（绝大多数）什么都不铺。
	if (Array.isArray(tool.deliverables) && tool.deliverables.length > 0) {
		presentCards(target, tool.deliverables);
	}

	const handle = {
		id: tool.id,
		name: tool.name,
		card,
		body,
		head,
		statusSymbol,
		stateTag,
		stateText,
		duration,
		outputPre,
		truncation: null,
		failure: null,
	};
	// 状态用同一份数据推导，流式新增与历史重建不会出现两种说法。
	applyToolStatus(handle, TOOL_STATUS[tool.status] ? tool.status : "pending");
	// 历史重建时结果已经在 tool.content 里，标记要在建卡时就补上（流式那条走 updateToolCard）
	markTruncation(handle, tool.content ?? "");
	if (tool.status === "error") {
		// 与流式那条一致：失败不自动展开，但把结果首行摆在行上
		showFailureLine(handle, tool.content ?? "");
	}
	return handle;
}

/** 在当前流式轮次里插入一张工具卡片 */
export function addToolCard(tool) {
	beginStream();
	const card = buildToolCard(tool, state.stream.tools);
	followBottom(); // 工具卡：同上
	return card;
}

/**
 * 把「会话事实」广播给输入框上方那两行 dock（`todo-dock.js` 听）。
 *
 * 事实由服务端下发（`facts` 事件，也随连接快照重发），界面不解析任何工具的入参。
 * 从前这里是认 `todo_write` / `goal_write` 两个名字、读它们字段的，于是「哪个工具会改这两样」
 * 的知识在浏览器里也有一份（新增一个会写事实的工具，界面就漏了）；更要紧的是那份知识只在
 * 历史里有效——上下文一压缩，那条工具调用就进了摘要，dock 会在跑到一半时凭空清空。
 */
export function renderFacts(facts) {
	document.dispatchEvent(
		new CustomEvent("lk:facts", {
			detail: { todos: Array.isArray(facts?.todos) ? facts.todos : [], goal: facts?.goal ?? null },
		}),
	);
}

/** 更新已存在的工具卡片 */
export function updateToolCard(card, patch) {
	applyToolStatus(card, patch.status === "error" ? "error" : "ok");
	card.outputPre.textContent = patch.content;
	markTruncation(card, patch.content ?? "");
	if (patch.status === "error") {
		// 失败**不自动展开**（照 DSH 的做法）：折叠着也要看得出哪儿错了，所以把结果首行拎到行上；
		// 想看全文点一下。从前是自动摊开——一条失败的输出动辄几十行，会把正在看的位置顶跑。
		showFailureLine(card, patch.content ?? "");
	}
	// 耗时是追加在后缀里的一块，不覆盖「N 行」那类先到的信息；包一层 span，
	// 免得裸文本节点与「N 行」贴在一起（flex 的 gap 只作用在元素之间）。
	const spent = document.createElement("span");
	spent.textContent = formatDuration(patch.ms);
	card.duration.append(spent);
}

/** 失败时在折叠行的摘要后面补一小截结果首行（超长截断，全文仍在展开里） */
function showFailureLine(card, content) {
	const line = content.split("\n").find((text) => text.trim() !== "") ?? "";
	if (line === "" || card.failure !== null) {
		return;
	}
	const node = document.createElement("span");
	node.className = "tool-failure";
	node.textContent = line.length > 60 ? `${line.slice(0, 60)}…` : line;
	node.title = line;
	card.failure = node;
	card.head.insertBefore(node, card.stateTag);
}

/**
 * 内核在输出里留的截断标记（`core` 的 bash / read / search 各写一种，字符串稳定）。
 *
 * 这些标记本来就在输出正文里，但输出默认是折叠的——「被砍过」这件事不该藏在折叠里，
 * 所以在摘要行上补一枚小标签。
 */
const TRUNCATION_MARKS = [
	{ mark: "[输出超过", label: "已截断", title: "输出超过上限，命令已终止：模型看到的也是这一段" },
	{ mark: "[输出过长已截断]", label: "已截断", title: "输出过长，只保留了前面一段" },
	{ mark: "[内容过长已截断]", label: "已截断", title: "内容过长，只保留了前面一段" },
	{ mark: "已显示到第", label: "未显示完", title: "还有内容没显示：正文里给了继续读取的 offset" },
	{ mark: "继续读取请用 offset", label: "未显示完", title: "还有内容没显示：正文里给了继续读取的 offset" },
];

/** 结果里带截断标记时，在工具行上补一枚标签（同一条只补一次） */
function markTruncation(card, content) {
	if (card.truncation !== null) {
		return;
	}
	const hit = TRUNCATION_MARKS.find((item) => content.includes(item.mark));
	if (hit === undefined) {
		return;
	}
	const chip = document.createElement("span");
	chip.className = "tool-flag";
	chip.textContent = hit.label;
	chip.title = hit.title;
	card.truncation = chip;
	// 插在「状态」之前：先看结果，再看被砍了没有，最后是耗时
	card.head.insertBefore(chip, card.stateTag);
}

/**
 * 从权威消息列表整体重绘对话。
 *
 * `cards` 是服务端随快照下发的「工具调用 id → 这一次调用在界面上要用的东西」（摘要、路径、交付物）：
 * 历史里只有原始消息，而这三件都是工具自陈的，前端算不出来。少了它就会「刚跑完显示命令原文，
 * 刷新一次变成 JSON」，预览入口与交付物卡片也会一起消失。
 *
 * 待办与目标**不在这里扫**：它们由服务端随快照的 `facts` 事件下发（见 `renderFacts`）。
 */
export function renderHistory(messages, cards = {}) {
	clearEmpty();
	el.transcript.replaceChildren();

	// 工具结果单独在 ToolMessage 里，先建索引，渲染助理消息时再关联回对应的调用。
	const results = new Map();
	for (const message of messages) {
		if (message.role === "tool") {
			for (const result of message.results) {
				results.set(result.toolCallId, result);
			}
		}
	}

	for (const message of messages) {
		if (message.role === "user") {
			const note = systemNoteOf(message.content);
			// 内核会往历史里插两种「不是用户说的话」的用户消息，它们不该画成用户气泡：
			// 交接摘要与说明文件变更告知。前缀在 core 里定义（HANDOFF_PREFIX / 告知语），
			// 这里只认前缀，不解析内容。
			el.transcript.append(note === null ? userTurn(message.content) : systemNoteRow(note, message.content));
			continue;
		}
		if (message.role !== "assistant") {
			continue;
		}
		if (message.content === "" && message.toolCalls.length === 0 && !message.reasoning) {
			continue;
		}

		const turn = document.createElement("div");
		turn.className = "turn assistant";
		if (message.reasoning) {
			const details = document.createElement("details");
			details.className = "reasoning";
			const summary = document.createElement("summary");
			summary.textContent = "思考过程";
			const pre = document.createElement("pre");
			pre.textContent = message.reasoning;
			details.append(summary, pre);
			turn.append(details);
		}
		const body = document.createElement("div");
		body.className = "assistant";
		body.innerHTML = renderMarkdown(message.content);
		turn.append(body);

		for (const call of message.toolCalls) {
			const result = results.get(call.id);
			let input = {};
			try {
				input = JSON.parse(call.arguments);
			} catch {
				input = { raw: call.arguments };
			}
			// 状态由 buildToolCard 一处推导；这里只补它推不出来的耗时。
			const info = cards[call.id] ?? {};
			const card = buildToolCard(
				{
					id: call.id,
					name: call.name,
					input,
					// 摘要、路径、交付物都随快照下发（工具自陈），前端不认任何字段名
					summary: info.summary ?? "",
					path: info.path ?? null,
					deliverables: info.deliverables ?? [],
					status: result ? (result.isError ? "error" : "ok") : "pending",
					content: result?.content ?? "",
					ms: 0,
				},
				turn,
			);
			if (result && typeof result.ms === "number" && result.ms > 0) {
				// 历史里的 write 行已经带了「N 行」，耗时接在后面而不是把它顶掉。
				const spent = document.createElement("span");
				spent.textContent = formatDuration(result.ms);
				card.duration.append(spent);
			}
		}
		el.transcript.append(turn);
	}

	if (el.transcript.childElementCount === 0) {
		renderEmpty();
		return;
	}
	scrollToBottom(); // 切会话：直接到底
}

/** 本地先画一条用户消息，等服务端快照回来会整体重绘，不会重复 */
export function appendUserMessage(text) {
	clearEmpty();
	el.transcript.append(userTurn(text));
	scrollToBottom(); // 刚发出一条消息：直接到底
}

/** 构造一条用户消息 */
function userTurn(text) {
	const turn = document.createElement("div");
	turn.className = "turn user";
	const bubble = document.createElement("div");
	bubble.className = "bubble";
	bubble.textContent = text;
	turn.append(bubble);
	return turn;
}

/**
 * 历史里那两种「不是用户说的话」。
 *
 * 前缀与 core 里的常量一一对应（`HANDOFF_PREFIX`、说明文件变更告知语）。改那边的话这里要跟着改，
 * 所以两边都写了注释指路。
 */
const SYSTEM_NOTES = [
	{ prefix: "[此前对话的交接摘要]", kind: "compaction", label: "上下文压缩：此前对话的交接摘要" },
	{ prefix: "[项目说明已更新]", kind: "instructions", label: "项目说明已更新" },
];

/** 这条用户消息是不是内核插进来的状态说明；不是就返回 null */
function systemNoteOf(content) {
	return SYSTEM_NOTES.find((note) => content.startsWith(note.prefix)) ?? null;
}

/**
 * 把状态说明画成一条安静的注记。
 *
 * 交接摘要可能很长（它是模型写的整段总结），所以折起来：标题一行说清「这是什么」，
 * 想细看再展开——直接铺开会把整轮对话挤下去。
 */
function systemNoteRow(note, content) {
	const row = document.createElement("div");
	row.className = `note note-${note.kind}`;
	const details = document.createElement("details");
	const summary = document.createElement("summary");
	const symbol = document.createElement("span");
	symbol.className = "note-symbol";
	symbol.append(icon(note.kind === "compaction" ? "scissors" : "pulse", 13));
	const label = document.createElement("span");
	label.textContent = note.label;
	summary.append(symbol, label);
	const body = document.createElement("pre");
	// 交接摘要那一条带前缀行，去掉它只留正文；别的注记原样显示。
	body.textContent = content.startsWith(note.prefix) ? content.slice(note.prefix.length).trim() : content;
	details.append(summary, body);
	row.append(details);
	return row;
}

/**
 * 画服务端的运行提示（压缩、超窗救援、失败）。
 *
 * 分两块放，按「要不要动手」：
 * - **失败**（带 ↺ 重试）留在对话末尾：它是要处理的事，放在最后一行、刷新与重连后仍然在，
 *   用户回头还能看到「刚才为什么失败」。
 * - **压缩 / 救援**这类「这一轮悄悄做了什么」的说明放**输入框里**（`.composer-notices`）：
 *   它是背景状态、不是对话内容，通栏挂在对话上方只会把正文往下挤（使用者就是这么提的）。
 *
 * 可重试的失败给一个「重试」按钮——分类由服务端给出，界面不猜错误文案。
 *
 * 失败区容器自己建、每次重绘时追加到对话末尾：它属于对话渲染的一部分，不必在 index.html 里预留节点。
 */
export function renderNotices(items, onRetry) {
	renderInfoNotices(items.filter((item) => item.kind !== "error"));
	renderErrorNotices(
		items.filter((item) => item.kind === "error"),
		onRetry,
	);
}

/**
 * 「这一轮悄悄做了什么」：贴着输入框右下角的一枚药丸。
 *
 * 压缩可能发生**多次**（服务端只对「连续且完全相同」的提示去重，第二次压缩的数字不一样就会再来一条），
 * 一条条铺出来会把输入框那一行挤爆。所以多条时合成一枚：正文用**最近**那条（刚发生的事最要紧），
 * 右边缀「共 N 次」，完整列表放 title 里，鼠标停一下能看全。
 */
function renderInfoNotices(items) {
	const host = el.composerNotices;
	if (host === null) {
		return;
	}
	host.replaceChildren();
	host.hidden = items.length === 0;
	if (items.length === 0) {
		return;
	}
	const latest = items[items.length - 1];
	const row = document.createElement("div");
	row.className = "notice notice-info";
	// title 最多列最近 8 条：它只是「看全」的兜底，不该长到无处可读
	const shown = items.slice(-8);
	row.title =
		shown.map((item) => item.text).join("\n") + (items.length > shown.length ? `\n…共 ${items.length} 条` : "");
	const symbol = document.createElement("span");
	symbol.className = "notice-symbol";
	symbol.append(icon("scissors", 13));
	const text = document.createElement("span");
	text.className = "notice-text";
	text.textContent = latest.text;
	row.append(symbol, text);
	if (items.length > 1) {
		const count = document.createElement("span");
		count.className = "notice-count";
		count.textContent = `共 ${items.length} 次`;
		row.append(count);
	}
	host.append(row);
}

/** 失败与重试：对话末尾那一块 */
function renderErrorNotices(items, onRetry) {
	const host = noticesHost();
	host.replaceChildren();
	if (items.length === 0) {
		host.hidden = true;
		return;
	}
	host.hidden = false;
	for (const item of items) {
		const row = document.createElement("div");
		row.className = `notice notice-${item.kind}`;
		const symbol = document.createElement("span");
		symbol.className = "notice-symbol";
		symbol.append(icon("close", 13));
		const text = document.createElement("span");
		text.className = "notice-text";
		text.textContent = item.text;
		row.append(symbol, text);
		if (item.retryable === true && typeof onRetry === "function") {
			const retry = document.createElement("button");
			retry.type = "button";
			retry.className = "btn ghost small";
			retry.textContent = "";
			retry.append(icon("refresh", 13));
			const retryLabel = document.createElement("span");
			retryLabel.textContent = "重试";
			retry.append(retryLabel);
			retry.title = item.retryAfterMs === undefined ? "重发这一轮" : "重发这一轮（服务端建议稍等一下）";
			retry.addEventListener("click", () => onRetry());
			row.append(retry);
		}
		host.append(row);
	}
	el.transcript.append(host);
	followBottom(); // 失败提示落在末尾：不打断正在翻看历史的人
}

/** 提示区的容器；对话被整体重绘时会从文档里摘掉，所以每次检查连通性再复用 */
let noticeHost = null;

function noticesHost() {
	if (noticeHost === null || !noticeHost.isConnected) {
		noticeHost = document.createElement("div");
		noticeHost.className = "notice-list";
	}
	return noticeHost;
}

/**
 * 记一条**本地**错误并画出来（全局异常、初始化失败、提交失败等）。
 *
 * 与服务端下发的运行提示走同一块区域：界面上「出问题了」只有一种样子，不会一半在对话流里、
 * 一半在提示区。本地提示不进服务端那份列表，刷新页面就没了——它说的本来就是「此刻这个页面
 * 出了什么事」，而不是这一轮运行的历史。
 */
export function appendError(message) {
	state.notices = [...state.notices, { id: -Date.now(), kind: "error", text: message }];
	renderNotices(state.notices, null);
}

/** 当前等待确认的卡片，同一时刻只可能有一次工具调用在等 */
let pendingApproval = null;

/**
 * 画一张确认卡片：工具名、参数、原因，以及按钮。
 *
 * 卡片就放在对话流里，与工具卡片同源——用户看到的顺序与模型实际做的事一致。
 * `suggestedPrefix` 是内核给出的「本会话总是允许」前缀：有它才多画一个「总是允许」按钮，
 * 并且把这个前缀写成一句话摆出来——用户是照着这句话点下去的，含糊的按钮文案等于没有文案。
 * 没有前缀（越界写入、危险命令）时按钮就只有两个，用户也就不会以为这类操作能被记住。
 *
 * 卡片里要看清「到底批什么」：终端弹层常为键盘效率省掉 cwd 与 diff，我们这边有地方就不省——
 * 正文由工具自陈（`detail`：命令原文、要写入的内容、改哪几处），再加一行工作目录与（整份替换时的）前后对比。
 */
export function addApprovalCard(
	{ tool, input, reason, detail, destructive = false, suggestedPrefix = null, change = null },
	onRespond,
) {
	clearEmpty();
	const card = document.createElement("div");
	card.className = "approval";

	const head = document.createElement("div");
	head.className = "approval-head";
	const title = document.createElement("span");
	title.className = "approval-title";
	title.textContent = `需要确认：${tool}`;
	const state = document.createElement("span");
	state.className = "approval-state";
	state.textContent = "等待中";
	head.append(title, state);

	const detailBox = document.createElement("pre");
	detailBox.className = "approval-detail";
	/*
	 * 正文里那一大段（命令原文、要写入的内容、改哪几处）由**服务端随事件给**，而且是工具自陈的
	 * （core 的 `describeApproval`）。前端从前按工具名读入参字段来拼这段字，于是「哪个字段最要紧」
	 * 的知识在这里也有一份，加一个工具就要改两处——而 `edit` 那处读的还是两个**不存在**的字段名
	 * （`old_string` / `new_string`），所以确认卡片上一直是一坨 JSON。
	 *
	 * 工具没自陈正文时退回一行 JSON：至少还有信息，而不是空着。
	 */
	const body = typeof detail === "string" && detail.trim() !== "" ? detail : summarizeInput(input);
	detailBox.textContent = [`原因：${reason}`, `工作目录：${activeCwd()}（命令与相对路径都按它算）`, body]
		.filter((line) => line !== "")
		.join("\n");

	const actions = document.createElement("div");
	actions.className = "approval-actions";
	const deny = document.createElement("button");
	deny.type = "button";
	deny.className = "btn ghost small";
	deny.textContent = "拒绝";
	const allow = document.createElement("button");
	allow.type = "button";
	allow.className = "btn primary small";
	allow.textContent = "允许";
	deny.addEventListener("click", () => onRespond(false));
	allow.addEventListener("click", () => onRespond(true));
	actions.append(deny, allow);

	let always = null;
	if (typeof suggestedPrefix === "string") {
		always = document.createElement("button");
		always.type = "button";
		always.className = "btn ghost small";
		always.textContent = "本会话总是允许";
		always.title = describePrefix(tool, suggestedPrefix);
		always.addEventListener("click", () => onRespond(true, true));
		actions.append(always);
	}

	card.append(head, detailBox);
	/*
	 * 工具说这次要整份替换某个文件时，审批卡上尽量给出「前后对比」：
	 * 确认弹层只列目标文件是不够的：改了什么必须看得见，我们这边有地方就补上。
	 *
	 * 对比是**服务端算好发过来的**（工具自陈 `fileReplacement`，差异用 `diff.ts` 那一份算法：
	 * 与「历史」面板同一套行号与段头）。界面不再去拉一次文件内容、也不再自己「去掉首尾相同的行」
	 * ——那是同一个算法的第二份实现，两侧画出来的东西对不上。
	 */
	if (change !== null && Array.isArray(change?.sections)) {
		appendApprovalDiff(card, change);
	}
	/*
	 * 破坏性提示放正文之后：先看清原文，再看到这句提醒。
	 *
	 * 「看起来不可逆」是**工具自陈**的（`isDestructive`；bash 用的是内核那条危险命令启发式）。
	 * 前端从前自己抄了一份正则清单，与内核 `permissions/danger.ts` 是同一件事的两份拷贝——
	 * 改一处另一处不会跟着变。现在只有一份。
	 */
	if (destructive) {
		const warn = document.createElement("div");
		warn.className = "approval-warn";
		warn.textContent = "⚠ 这次调用看起来不可逆。这是启发式判断，请照着上面的原文自己核一遍。";
		card.append(warn);
	}
	card.append(actions);
	el.transcript.append(card);
	followBottom(); // 确认卡
	pendingApproval = { card, state, actions, deny, allow, always };
}

/*
 * 从前这里住着三段按工具名读入参的逻辑：破坏性命令的正则清单、确认卡片的正文拼装、以及
 * 「取出 edit 要展示的替换对」。它们现在都在**工具自己**那边（core 的 `describeApproval` /
 * `isDestructive`），服务端随 approval 事件把 `detail` 与 `destructive` 一起发过来。
 *
 * 留这段注释是为了让「它去哪了」有迹可循：直接删干净的话，下一个人只会看到卡片正文不知从哪来。
 */

/** 这个会话真正在用的工作目录：工具与相对路径都按它算（会话可能在别的工作区） */
function activeCwd() {
	const active = state.sessions.find((session) => session.id === state.activeId);
	return active?.cwd !== undefined && active.cwd !== "" ? active.cwd : state.cwd;
}

/**
 * 把服务端算好的前后对比摆进审批卡。
 *
 * 画法与「历史」面板同一口径（统一 diff：`@@` 段头 + 每行一个符号），只是这里挤在卡片里，
 * 所以不铺行号两列、也不做横向滚动容器——行号在段头里已经写清楚了。
 * `sections` 为空时只摆服务端给的原因（新文件、二进制、太大、与磁盘一致），
 * 让「为什么这里没有对比」有句话，而不是空着一块。
 */
function appendApprovalDiff(card, change) {
	const block = document.createElement("pre");
	block.className = "approval-diff";
	const lines = [];
	if (change.sections.length > 0) {
		lines.push(`改动片段（− 磁盘上这一份 / + 将要写入，共 +${change.added ?? 0} −${change.removed ?? 0}）：`);
		for (const section of change.sections) {
			if (typeof section?.header === "string" && section.header !== "") {
				lines.push(section.header);
			}
			for (const line of section?.lines ?? []) {
				// 符号沿用仓库那一套：增 `+`、删 `−`（与历史面板的 diff 同符）。
				const sign = line.tag === "+" ? "+" : line.tag === "-" ? "−" : " ";
				lines.push(`${sign} ${line.text ?? ""}`);
			}
		}
	}
	if (typeof change.note === "string" && change.note !== "") {
		lines.push(change.note);
	}
	if (lines.length === 0) {
		return;
	}
	block.textContent = lines.join("\n");
	card.append(block);
}

/** 前缀的人话说明；措辞与 CLI 的确认提示保持一致，免得两边说法不一样 */
function describePrefix(tool, prefix) {
	if (tool !== "bash") {
		return prefix === ""
			? "本会话不再询问「写入工作目录内任何位置」"
			: `本会话不再询问「写入 ${prefix}/ 及其子目录」`;
	}
	return `本会话不再询问「执行以「${prefix}」开头的单条命令」`;
}

/** 收尾：把卡片标成结论，并禁用按钮；remember 表示这是「本会话总是允许」 */
export function settleApproval(approved, remember = false) {
	if (!pendingApproval) {
		return;
	}
	const { state, deny, allow, always, card } = pendingApproval;
	state.textContent = approved ? (remember ? "已允许（本会话）" : "已允许") : "已拒绝";
	card.classList.add(approved ? "approved" : "denied");
	deny.disabled = true;
	allow.disabled = true;
	if (always) {
		always.disabled = true;
	}
	pendingApproval = null;
}

/** 当前等待评审的方案卡片 */
let pendingPlan = null;

/**
 * 画一张方案评审卡片：方案全文 + 反馈输入框 + 两个按钮。
 *
 * 方案是模型写的整段文字，可能很长，所以放进一个可滚动的框里，而不是把后面的对话挤下去。
 * 退回必须带反馈（服务端也会拒空的），所以「退回修改」在没写字之前是禁用的——让用户点了才发现
 * 「要写反馈」是白点一次。
 */
export function addPlanReviewCard({ plan }, onRespond) {
	clearEmpty();
	const card = document.createElement("div");
	card.className = "approval plan";

	const head = document.createElement("div");
	head.className = "approval-head";
	const title = document.createElement("span");
	title.className = "approval-title";
	title.textContent = "方案待评审";
	const stateTag = document.createElement("span");
	stateTag.className = "approval-state";
	stateTag.textContent = "等待中";
	head.append(title, stateTag);

	const body = document.createElement("pre");
	body.className = "approval-detail plan-body";
	body.textContent = plan;

	const feedback = document.createElement("textarea");
	feedback.className = "plan-feedback";
	feedback.rows = 2;
	feedback.placeholder = "要改的话写在这里，然后点「退回修改」";

	const actions = document.createElement("div");
	actions.className = "approval-actions";
	const reject = document.createElement("button");
	reject.type = "button";
	reject.className = "btn ghost small";
	reject.textContent = "退回修改";
	reject.disabled = true;
	const approve = document.createElement("button");
	approve.type = "button";
	approve.className = "btn primary small";
	approve.textContent = "按方案执行";
	feedback.addEventListener("input", () => {
		reject.disabled = feedback.value.trim() === "";
	});
	reject.addEventListener("click", () => onRespond({ approved: false, feedback: feedback.value.trim() }));
	approve.addEventListener("click", () => onRespond({ approved: true }));
	actions.append(reject, approve);

	card.append(head, body, feedback, actions);
	el.transcript.append(card);
	followBottom(); // 方案卡
	pendingPlan = { card, stateTag, approve, reject, feedback };
}

/** 收尾：把评审卡片标成结论并禁用；批准之后模型会开始动手，界面上的档位由服务端同步 */
export function settlePlanReview(approved) {
	if (!pendingPlan) {
		return;
	}
	const { card, stateTag, approve, reject, feedback } = pendingPlan;
	stateTag.textContent = approved ? "已批准" : "已退回";
	card.classList.add(approved ? "approved" : "denied");
	approve.disabled = true;
	reject.disabled = true;
	feedback.disabled = true;
	pendingPlan = null;
}
