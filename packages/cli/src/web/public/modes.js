/*
 * 计划模式与审批模式开关。
 *
 * 按会话切换 strict/guide 与 auto/ask/readonly。
 *
 * 约定：DOM 与样式都由本模块自己创建（注入 <style>），不要改 index.html 与 app.css——
 * 这样多个功能并行开发时不会互相冲突。
 *
 * 形态从「输入框上方的一行分段控件」改成「顶部应用栏的两个 chip + 下拉」：
 * 分段控件挤在 .composer-box 里既多占一行，又和发送按钮抢位置，而顶部栏是外壳给所有功能的共享位置。
 * 两个 chip 常显当前档位（「计划 · 严格」「审批 · 只读」），点开才列出三档——
 * 「发送前一定看得见当前档位」这个前提没变，变的只是它不再占输入区的地。
 *
 * 事实来源是服务端：模式存在会话上、对后续每一次工具调用立刻生效，界面只是显示器。
 * 所以每次切换都以 POST 的返回值为准，另外按会话拉一次初值。
 */

import { api } from "./api.js";
import { addPanelTab, addTopBarAction } from "./features.js";
import { icon } from "./icons.js";
// 放行规则的读取与清空留在会话模块里（它才是会话状态的拥有者），这里只负责把它画进菜单。
import { clearApprovals } from "./sessions.js";
// 接口密钥那张卡片归 settings.js（密钥的读取/保存/打码都在它那儿），这里只把它挂进设置面板。
import { buildCredentialsCard } from "./settings.js";
import { state } from "./state.js";
import { setStatus } from "./ui.js";
import { buildVersionCard } from "./version.js";

/** 审批模式的分段：value 与服务端取值一一对应，label 给人看，hint 是按钮提示 */
const APPROVAL_OPTIONS = [
	{ value: "auto", label: "自动", hint: "工具调用全部放行" },
	{ value: "ask", label: "确认", hint: "写文件、执行命令前弹确认卡片" },
	{ value: "readonly", label: "只读", hint: "write / edit / bash 一律拒绝" },
];

/** 计划模式的分段 */
const PLAN_OPTIONS = [
	{ value: "off", label: "关", hint: "正常执行" },
	{ value: "strict", label: "严格", hint: "动手前只允许读，改动一律拒绝" },
	{ value: "guide", label: "引导", hint: "先给方案，靠提示词引导" },
];

/** 输出风格的分段：与命令行的 --style / /style 同一套取值与说法 */
const STYLE_OPTIONS = [
	{ value: "default", label: "默认", hint: "正常说明改了什么、验证了什么" },
	{ value: "concise", label: "简洁", hint: "先给结论，不复述过程" },
	{ value: "explanatory", label: "解释", hint: "说清为什么这么做与其中的取舍" },
];

/**
 * 每个分组「在决定什么」。
 *
 * 菜单里只写「计划模式 / 审批模式 / 输出风格」的话，用户得先知道严格与引导的区别才敢点；
 * 把这一组管什么写在标题旁边，九个档位就自解释了。
 */
const GROUP_NOTE = {
	planMode: "先出方案还是直接动手",
	approval: "动手前要不要问一句",
	style: "回答怎么讲",
	compaction: "上下文太长了怎么办",
};

/** 本模块的样式；用一次就够。颜色只用 app.css 已有的 token，不写死色值、不加动画 */
export const STYLE = /* css */ `
/* 下拉容器：包住 chip 与它的菜单；relative 让菜单贴着 chip 定位 */
.lmk-modes {
	position: relative;
	display: inline-flex;
	align-items: center;
}

/* chip 外形沿用外壳的 .lk-topbar-item，这里只补「菜单开着」的状态 */
.lmk-modes-chip[aria-expanded="true"] {
	background: var(--accent-soft);
	color: var(--accent-text);
}

/* 当前档位直接写在 chip 上：不点开也知道现在是哪一档 */
.lmk-modes-value {
	color: var(--accent-text);
	font-weight: 600;
}

/* 窄屏（侧栏就占掉一大半）时 chip 上只留「模式」两个字：档位在菜单里带 ✓、chip 的 title 里也写着
   全的；为此把顶栏挤成横向滚动、让「面板」开关跑出可视区，那才是真的看不见东西。 */
@media (max-width: 700px) {
	.lmk-modes-value {
		display: none;
	}
	/* 箭头也收掉：460 这种宽度下顶栏本来就满，两颗 chip 的箭头要占 ~21px；
	   chip 本身仍然可点（title 里写着「点开切换」）。 */
	.lmk-modes-chip .lk-icon:first-child {
		display: none;
	}
}

/* 每一组一个**框**：计划 / 审批 / 风格各自一张卡片，边框把它们分开，
   用户一眼看到「这里有三件事要定」，而不是九行排在一起看不出层次。 */
.lmk-modes-card {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: var(--space-3);
	border: 1px solid var(--border);
	border-radius: calc(var(--radius-xl) - var(--space-4) - 1px);
	background: var(--surface-3);
}
.lmk-modes-card-head {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
}
.lmk-modes-card-title {
	color: var(--text);
	font-size: var(--text-sm);
	font-weight: 600;
}
.lmk-modes-card-note {
	color: var(--muted);
	font-size: var(--text-xs);
}

/* 分段按钮：三档并排，当前那档填强调色。宽窄由内容决定，等宽更整齐 */
.lmk-modes-segments {
	display: flex;
	/* 段与段之间留 8px：4px 时几个按钮看着连成一块（使用者反馈「太挤」） */
	gap: var(--space-2);
}
.lmk-modes-option {
	/* 按内容定宽（原来 flex: 1 会拉满整行，「关」这种短标签也被撑成整条 + 很长，使用者反馈「太长」）。
	   给一个最小宽度，短标签不至于瘦成一条；整排靠左排，右边留白。 */
	flex: 0 1 auto;
	min-width: 72px;
	/* 6px 上下：按钮高约 32px（原来 9px → 40px，使用者反馈「太大」） */
	padding: 6px 16px;
	/* 未选态安静但有形：清晰描边 + 透明底（原来 --border 那条细线几乎看不见，几个框发虚）。
	   重点放在选中态上——见下面的 [aria-checked="true"]。 */
	border: 1px solid var(--border-strong);
	border-radius: var(--radius-pill);
	background: transparent;
	color: var(--text-soft);
	font: inherit;
	font-size: var(--text-sm);
	/* 图标 + 文字横排居中（gap 管两者间距） */
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	cursor: pointer;
}
.lmk-modes-option:hover:not(:disabled) {
	background: var(--surface-3);
	border-color: color-mix(in srgb, var(--accent) 30%, transparent);
	color: var(--text);
}
.lmk-modes-option:active:not(:disabled) {
	background: var(--surface-4);
}
/* 当前档位：**实心**强调色 + 浅字（--accent 当底、--accent-soft 当字）。
   这一对在浅色主题下是"深枣红底 + 浅粉字"，深色主题下自动翻成"浅粉底 + 深枣红字"，两边都是高对比。
   原来用的是浅底 + 同色系字（--accent-soft / --accent-text），跟未选态糊在一起、看不出选了哪个。 */
.lmk-modes-option[aria-checked="true"] {
	border-color: var(--accent);
	background: var(--accent);
	color: var(--accent-soft);
	font-weight: 600;
}
.lmk-modes-option:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

/* 描述行：默认写当前档位是什么意思；悬停某一档时临时换成那一档的说明。
   min-height 固定一行高度，切换时不跳。 */
.lmk-modes-desc {
	min-height: 1.5em;
	color: var(--muted);
	font-size: var(--text-xs);
	line-height: 1.7;
}

/* 已放行规则也是自己一个框：它属于审批这件事，但不是「三选一」 */
.lmk-modes-rules-row {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	padding: 6px 8px;
	border: 1px solid var(--border);
	border-radius: var(--radius-xs);
	background: transparent;
	color: var(--text-soft);
	font: inherit;
	font-size: var(--text-sm);
	text-align: left;
	cursor: pointer;
}
.lmk-modes-rules-row:hover:not(:disabled) {
	background: var(--surface-2);
	color: var(--text);
}
.lmk-modes-rules-row:disabled {
	color: var(--muted);
	cursor: default;
}
.lmk-modes-rules-text {
	flex: 1 1 auto;
}

/* 弹层挂在 body 上、用 fixed 定位（见 buildPopover 里的说明：留在顶部栏里会被 overflow 裁掉）。
   坐标由 positionMenu 每次打开时按 chip 的位置算，所以这里不写 top/right。 */
.lmk-modes-menu {
	position: fixed;
	z-index: 40;
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-width: 268px;
	max-width: min(320px, calc(100vw - 16px));
	padding: var(--space-2);
	border: 1px solid var(--border);
	border-radius: var(--radius-md);
	background: var(--surface-glass-strong);
	backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	-webkit-backdrop-filter: blur(var(--blur-lg)) saturate(var(--saturate-glass));
	box-shadow: var(--shadow-lg);
}
.lmk-modes-menu[hidden] {
	display: none;
}

/* 设置面板：与顶部弹层同一套卡片，只是排成一列、跟着面板滚动 */
.lmk-settings {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	/* 面板体已经留了 16px：这里再加一层就等于把卡片推到 29px 外，
	   同心半径只能落到 3px（很难看）。留白只由面板体出，卡片的同心半径才是 15px。 */
	padding: 0;
	overflow-y: auto;
}
.lmk-settings-note {
	margin: 0;
	color: var(--muted);
	font-size: var(--text-xs);
	line-height: 1.8;
}
/* 「接口密钥」那张卡片里的动作行：与分段按钮同一套外形，两个按钮等分 */
.lmk-modes-actions {
	display: flex;
	gap: 4px;
}

/* 面板里的卡片比弹层里的宽松一点：这里横向空间是 400px */
.lmk-settings .lmk-modes-card {
	background: var(--surface-1);
}

/* 出错时 chip 标危险色，具体原因写进它的 title */
.lmk-modes-chip.lmk-modes-error {
	color: var(--danger);
}
`;

/** 当前已知的模式值；失败时用它把 chip 与菜单回退到服务端实际生效的档位 */
let current = { approval: "auto", planMode: "off", style: "default", compaction: true };

/** 上一次 GET 过的会话 id：同一个会话不必反复拉 */
let syncedId = null;

/** 顶栏那两颗 chip 与它们的弹层 */
const popovers = [];

/** 当前开着的那一个弹层；同时只允许开一个 */
let opened = null;

/** 界面上所有分段按钮的卡片副本（顶栏弹层 + 设置面板）：paint() 按字段刷它们 */
const cardStates = [];

/** 设置面板里那行放行规则；面板还没建时是 null */
let rulesButton = null;
let rulesText = null;

/** 字段 → 中文名，界面文案与提示都用它，免得两处各写一遍 */
function fieldName(field) {
	if (field === "approval") {
		return "审批";
	}
	if (field === "style") {
		return "风格";
	}
	return field === "compaction" ? "压缩" : "计划";
}

/** 字段 → 该档位「是什么」的说法：模式与风格的说法不一样（风格不是安全边界） */
function kindOf(field) {
	if (field === "style") {
		return "输出风格";
	}
	return field === "compaction" ? "上下文压缩" : `${fieldName(field)}模式`;
}

/**
 * 字段当前值在界面上的表示。
 *
 * 三个模式字段是字符串，压缩在服务端是布尔值，界面上用 on / off 两个档位表示——
 * 分段按钮的 `data-lmk-value` 一律是字符串，比较必须走这里，否则布尔值永远匹配不上。
 */
function valueOfField(field) {
	return field === "compaction" ? compactionValue() : String(current[field]);
}

/**
 * 建**一个** chip + 它的下拉菜单，菜单里分三段（计划 / 审批 / 风格）外加一段放行规则。
 *
 * 以前这里是三个独立 chip：顶栏本来就只有一格空间，三个开关把「N 个会话」标题都挤没了，
 * 而且它们回答的是同一个问题——「这一轮怎么跑」。合成一个菜单之后顶栏只剩「搜索 / 模式 / 面板」，
 * 当前状态继续写在 chip 上（`关·自动·默认`），点开就能改，不需要先想「这个开关在哪个 chip 里」。
 */
/** 顶栏上直接放的字段：干活时最常切的这两件，各自一颗 chip + 弹层；设置面板里不再重复一份 */
const TOP_BAR_FIELDS = ["planMode", "approval"];
/**
 * 设置面板里的字段（顺序就是显示顺序）。
 *
 * **只有「设一次」的那些**：风格与压缩。计划与审批已经常显在顶栏那两颗 chip 上，面板里再放一份
 * 就是同一个开关两个入口（使用者：「这两个顶栏有了，面板里的删了好了」）。
 */
const SETTINGS_FIELDS = ["style", "compaction"];

/**
 * 建一块卡片：标题 + 这一件在决定什么 + 分段按钮 + 当前这档什么意思。
 *
 * 同一个字段可能在两处出现（顶栏的 chip 弹层与设置面板），所以每次都新建一块，
 * 并把 {field, desc, buttons} 记进 cardStates，paint() 按字段把所有副本一起刷新。
 */
function buildCard(field) {
	const card = document.createElement("div");
	card.className = "lmk-modes-card";

	const head = document.createElement("div");
	head.className = "lmk-modes-card-head";
	const title = document.createElement("span");
	title.className = "lmk-modes-card-title";
	title.textContent = fieldName(field);
	const note = document.createElement("span");
	note.className = "lmk-modes-card-note";
	note.textContent = GROUP_NOTE[field] ?? "";
	head.append(title, note);

	const segments = document.createElement("div");
	segments.className = "lmk-modes-segments";
	segments.setAttribute("role", "radiogroup");
	segments.setAttribute("aria-label", `${fieldName(field)}（${GROUP_NOTE[field] ?? ""}）`);

	const desc = document.createElement("div");
	desc.className = "lmk-modes-desc";

	const buttons = [];
	for (const option of optionsOf(field)) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "lmk-modes-option";
		button.setAttribute("role", "radio");
		button.dataset.lmkField = field;
		button.dataset.lmkValue = option.value;
		button.title = option.hint;
		// 原始档位名存进 dataset：刷新时要按选中与否加/去前面的 ✓（见 paintModes）
		button.dataset.lmkLabel = option.label;
		button.textContent = option.label;
		button.addEventListener("click", () => void submit(field, option.value));
		// 悬停/聚焦时描述行换成这一档的说明：想比较时用鼠标扫一遍，选完回到当前档位。
		const preview = () => {
			desc.textContent = `${option.label}：${option.hint}`;
		};
		const restore = () => {
			desc.textContent = describeCurrent(field);
		};
		button.addEventListener("pointerenter", preview);
		button.addEventListener("focus", preview);
		button.addEventListener("pointerleave", restore);
		button.addEventListener("blur", restore);
		segments.append(button);
		buttons.push(button);
	}

	card.append(head, segments, desc);
	cardStates.push({ field, desc, buttons });
	return card;
}

/**
 * 顶栏上的一颗 chip + 它自己的弹层（里面只有这一个字段的框）。
 *
 * 原来所有字段挤在一个「模式」弹层里：九行排在一起看不出层次，现在常用的两件各自成一颗 chip、
 * 状态写在 chip 上（`计划 严格`），点开只有一块框；其余的进设置面板。
 */
function buildPopoverChip(field) {
	const wrap = document.createElement("div");
	wrap.className = "lmk-modes";

	const chip = addTopBarAction({
		// 符号统一用 ▾：它表示「点开有东西」，与搜索的 ⌕ 一样是纯文本符号，不引图标依赖。
		symbol: "▾",
		label: fieldName(field),
		title: `${kindOf(field)}（点开切换）`,
	});
	if (chip === null) {
		return wrap;
	}
	chip.classList.add("lmk-modes-chip");
	chip.setAttribute("aria-haspopup", "true");
	chip.setAttribute("aria-expanded", "false");
	// 当前档位接在名字后面，所以自己插一个节点，而不是重写整条 label。
	// 外壳给的动作按钮是 [符号, 文字]，文字一定是最后一个子节点，于是档位 append 在它后面。
	const value = document.createElement("span");
	value.className = "lmk-modes-value";
	chip.append(value);

	const menu = document.createElement("div");
	menu.className = "lmk-modes-menu";
	menu.hidden = true;
	menu.setAttribute("aria-label", kindOf(field));
	menu.append(buildCard(field));

	/*
	 * chip 已经在顶部栏里，而 wrap 还是游离的。顺序必须是「先占位、再放回」：
	 * 先把 wrap 换到 chip 的位置上，再把 chip 放进 wrap——反过来先把 chip 挪进 wrap 的话，
	 * chip 已经成了 wrap 的子节点，replaceWith 就成了「用祖先替换后代」，浏览器直接拒。
	 */
	chip.replaceWith(wrap);
	wrap.append(chip);
	/*
	 * 弹层**不能**留在 wrap 里：wrap 在顶部栏内，而顶部栏为了窄屏可横向滚动设了
	 * `overflow-x: auto`——绝对定位的弹层会被这个 overflow 整个裁掉，表现得就是「点了没选项」
	 * （DOM 里查得到、屏幕上一像素都看不见，elementFromPoint 在它中心命中的是底下的对话区）。
	 * 挂到 body 上并用 fixed 定位，既不受祖先 overflow 影响，也不跟着顶栏一起滚。
	 */
	document.body.append(menu);
	popovers.push({ field, chip, value, menu });
	return wrap;
}

/**
 * 设置面板：把「设一次」的那几件与放行规则、接口密钥放在一处。
 *
 * 干活时最常切的计划与审批**只在顶栏**（那两颗 chip 常显当前档位、点开就能改），面板里不再重复；
 * 面板只收风格、压缩、放行规则、接口密钥。面板本身带滚动，窄屏下也不会挤。
 */
function buildSettingsPanel(container) {
	const root = document.createElement("div");
	root.className = "lmk-settings";

	const note = document.createElement("p");
	note.className = "lmk-settings-note";
	note.textContent =
		"这里放「设一次」的东西：风格、压缩、放行规则、接口密钥，以及这份装的是哪一版。计划与审批常显在顶栏那两颗 chip 上。";
	root.append(note);

	for (const field of SETTINGS_FIELDS) {
		root.append(buildCard(field));
	}

	// 放行规则：命令行有 /approvals，网页得看得见、撤得掉；它不是三选一，所以单独一块。
	const rulesCard = document.createElement("div");
	rulesCard.className = "lmk-modes-card";
	const rulesHead = document.createElement("div");
	rulesHead.className = "lmk-modes-card-head";
	const rulesTitle = document.createElement("span");
	rulesTitle.className = "lmk-modes-card-title";
	rulesTitle.textContent = "已放行规则";
	const rulesNote = document.createElement("span");
	rulesNote.className = "lmk-modes-card-note";
	rulesNote.textContent = "点过「总是允许」的操作";
	rulesHead.append(rulesTitle, rulesNote);
	rulesButton = document.createElement("button");
	rulesButton.type = "button";
	rulesButton.className = "lmk-modes-rules-row";
	rulesButton.dataset.lmkRules = "1";
	rulesText = document.createElement("span");
	rulesText.className = "lmk-modes-rules-text";
	const rulesTick = document.createElement("span");
	rulesTick.setAttribute("aria-hidden", "true");
	rulesButton.append(rulesText, rulesTick);
	rulesButton.addEventListener("click", () => void clearApprovalsFromMenu());
	rulesCard.append(rulesHead, rulesButton);
	root.append(rulesCard);

	// 接口密钥也归这里：它是「设一次」的偏好，侧栏底部只留模型。
	// 卡片由 settings.js 建（密钥的读取/保存/打码规则都在那边），这里只给它一个位置。
	root.append(buildCredentialsCard());

	// 版本与自更新：这条信息终端一直有（`limkenion self status`），网页原来看不到。
	// 同样是只读的一张卡，放在最后——它不属于「设一次」的偏好，属于「这份装的是哪一版」。
	root.append(buildVersionCard());

	container.append(root);
	paint();
}

/** 当前档位那一行的说明文案（`严格：动手前只允许读…`），描述行的默认内容就是它 */
function describeCurrent(field) {
	const picked = optionsOf(field).find((option) => option.value === valueOfField(field));
	const label = picked?.label ?? valueOfField(field);
	return `${label}：${picked?.hint ?? ""}`;
}

/**
 * 把菜单摆到 chip 正下方（下方放不下就翻到上方），右对齐且不越出视口。
 *
 * 用 fixed 定位就必须自己跟着 chip 的位置走：顶部栏可以横向滚动、窗口可以缩放，
 * 菜单不能停在一个旧坐标上。
 */
function positionMenu(entry) {
	const chip = entry.chip.getBoundingClientRect();
	const menu = entry.menu.getBoundingClientRect();
	const width = menu.width;
	const height = menu.height;
	const margin = 8;
	const left = Math.min(Math.max(chip.right - width, margin), Math.max(window.innerWidth - width - margin, margin));
	const below = chip.bottom + 6;
	const top = below + height <= window.innerHeight - margin ? below : Math.max(chip.top - height - 6, margin);
	entry.menu.style.left = `${Math.round(left)}px`;
	entry.menu.style.top = `${Math.round(top)}px`;
}

/** 收起下拉 */
function closeMenus() {
	for (const entry of popovers) {
		entry.menu.hidden = true;
		entry.chip.setAttribute("aria-expanded", "false");
	}
	opened = null;
}

/**
 * 压缩开关也是同一套：分段按钮 + 一句后果说明。
 *
 * 它以前是侧栏底部的「压缩：开」一个词——关掉意味着上下文只会一直变长直到撞上窗口上限，
 * 这种后果不该只写在悬停提示里。现在并进模式弹层的第四块框，与其它三块长得一样。
 */
const COMPACTION_OPTIONS = [
	{ value: "on", label: "开", hint: "超阈值时先裁旧工具输出，再写一份交接摘要" },
	{ value: "off", label: "关", hint: "上下文只会一直变长，直到撞上窗口上限" },
];

/** 服务端的 compaction 是布尔值，界面上用 on/off 两个字符串档位表示 */
function compactionValue() {
	return current.compaction === false ? "off" : "on";
}

/** chip 点击：开着就收起，收起就打开 */
function toggleMenu(entry) {
	if (opened === entry) {
		closeMenus();
		return;
	}
	closeMenus();
	entry.menu.hidden = false;
	// 先显示再量：hidden 时尺寸为 0，位置就算不出来。
	positionMenu(entry);
	entry.chip.setAttribute("aria-expanded", "true");
	opened = entry;
}

/**
 * 把当前档位画到顶栏 chip、各处卡片与设置面板上。
 *
 * error 非空时把原因写进 chip 的 title（并标危险色）：搬到顶部栏之后原来的状态行没有了，
 * 但「为什么没改成」这条信息不能丢；下一次成功的切换或重新拉取会把它恢复成常态。
 */
function paint(error = "") {
	const running = state.running === true;
	for (const entry of popovers) {
		const picked = optionsOf(entry.field).find((option) => option.value === valueOfField(entry.field));
		const label = picked?.label ?? valueOfField(entry.field);
		// chip 上只写这一件的当前档位（`计划 严格`）——顶栏一格就那么大，完整说法进 title。
		entry.value.textContent = label;
		const summary = `${kindOf(entry.field)}：${label}（${picked?.hint ?? ""}）`;
		entry.chip.title = error === "" ? `${summary}\n点开切换` : `${summary}\n${error}`;
		entry.chip.classList.toggle("lmk-modes-error", error !== "");
	}
	// 卡片可能同时存在于顶栏弹层与设置面板里，所以按 cardStates 全部刷一遍。
	for (const card of cardStates) {
		for (const button of card.buttons) {
			const chosen = button.dataset.lmkValue === valueOfField(button.dataset.lmkField);
			// 分段按钮用 aria-checked（radiogroup），选中态由 CSS 的强调色表达；
			// 描述行里还会把档位名写出来，所以不只靠颜色。
			button.setAttribute("aria-checked", String(chosen));
			// 选中的那颗前面加 ✓（MD3 分段控件的做法）：不靠颜色也能一眼看出选了哪个
			const label = button.dataset.lmkLabel ?? button.textContent;
			// 勾也用图标：文字 ✓ 的笔重和别的图标对不齐
			button.textContent = "";
			if (chosen) {
				button.append(icon("check", 13));
			}
			const chosenLabel = document.createElement("span");
			chosenLabel.textContent = label;
			button.append(chosenLabel);
			// 正在生成时置灰：服务端此时会回 409，先让控件本身表达「现在改不了」。
			button.disabled = running;
		}
		card.desc.textContent = describeCurrent(card.field);
	}
	paintRules(running, error);
}

/** 画「已放行规则」那一行：没有规则时置灰，有规则时可点（点了就全忘掉） */
function paintRules(running, error) {
	if (rulesButton === null || rulesText === null) {
		return;
	}
	const rules = Array.isArray(state.approvalRules) ? state.approvalRules : [];
	rulesText.textContent = rules.length === 0 ? "本会话没有放行规则" : `已放行 ${rules.length} 条 · 点击全部忘掉`;
	rulesButton.disabled = running || rules.length === 0;
	rulesButton.title =
		rules.length === 0
			? "本会话还没有「总是允许」的规则"
			: `本会话已放行：\n${rules.map((rule) => `· ${rule.text}`).join("\n")}${error === "" ? "" : `\n${error}`}`;
	const rulesGlyph = rulesButton.lastElementChild;
	rulesGlyph.textContent = "";
	if (rules.length > 0) {
		rulesGlyph.append(icon("close", 13));
	}
}

/** 从菜单里清空放行规则（先问一次） */
async function clearApprovalsFromMenu() {
	if (!window.confirm("忘掉本会话的全部「总是允许」规则？之后这些操作会重新逐次确认。")) {
		return;
	}
	await clearApprovals();
	paint();
}

/** 字段 → 该字段的候选档位 */
function optionsOf(field) {
	if (field === "approval") {
		return APPROVAL_OPTIONS;
	}
	if (field === "style") {
		return STYLE_OPTIONS;
	}
	return field === "compaction" ? COMPACTION_OPTIONS : PLAN_OPTIONS;
}

/** 按当前会话拉一次模式；没有会话时退回默认值 */
async function sync() {
	const id = state.activeId;
	if (!id) {
		current = { approval: "auto", planMode: "off", style: "default", compaction: true };
		paint();
		return;
	}
	try {
		const result = await api(`/api/sessions/${encodeURIComponent(id)}/modes`);
		current = {
			approval: result.approval,
			planMode: result.planMode,
			style: result.style,
			compaction: result.compaction !== false,
		};
		paint();
	} catch (error) {
		// 拉不到不是切换失败，别用危险色吓人：只是这条状态暂时不可信。
		paint(`模式读取失败：${error.message}`);
	}
}

/** 会话切换后同步；同一会话不重复拉 */
function syncIfNeeded() {
	if (syncedId === state.activeId) {
		return;
	}
	syncedId = state.activeId;
	void sync();
}

/**
 * 切换一个模式并提交。
 *
 * 先本地生效再发请求：用户最常问的是「我点到了没有」。返回的是服务端生效后的值，
 * 所以失败时用返回或重新拉取把它纠正回来，界面不会停在「以为改了」的状态。
 */
async function submit(field, value) {
	const id = state.activeId;
	if (!id) {
		paint("先选一个会话，模式是按会话存的");
		setStatus("先选一个会话，模式是按会话存的");
		return;
	}
	// 压缩在界面上是 on / off 两个档位，服务端要的是布尔值
	const payload = field === "compaction" ? { compaction: value === "on" } : { [field]: value };
	current = { ...current, [field]: field === "compaction" ? value === "on" : value };
	paint();
	try {
		const result = await api(`/api/sessions/${encodeURIComponent(id)}/modes`, {
			method: "POST",
			body: payload,
		});
		current = {
			approval: result.approval,
			planMode: result.planMode,
			style: result.style,
			compaction: result.compaction !== false,
		};
		paint();
		setStatus(`${kindOf(field)}已生效`);
		// 成了就收起：开着会挡住顶部栏右侧的其它入口。
		closeMenus();
	} catch (error) {
		await sync();
		if (error.status === 409) {
			// 服务端的原话更能说明「为什么不行」，照它显示。
			paint(`正在生成中，先停止或等这一轮结束（${error.message}）`);
			setStatus("生成中不能切换模式");
			return;
		}
		paint(`切换失败：${error.message}`);
		setStatus(`切换模式失败：${error.message}`);
	}
}

/** 应用服务端推来的模式快照，见 apply */
function applyValues(approval, planMode, style, compaction) {
	current = { approval, planMode, style, compaction: compaction !== false };
	syncedId = state.activeId;
	paint();
}

/**
 * 应用服务端广播的 modes 事件。
 *
 * 目前主路径是轮询（会话模块没有对外的事件出口，为此改它不划算），这个函数留给接上
 * SSE 的 modes 事件的一方：拿到就贴上去，比轮询更即时。
 */
export function apply(event) {
	if (typeof event?.approval !== "string" || typeof event?.planMode !== "string") {
		return;
	}
	applyValues(
		event.approval,
		event.planMode,
		typeof event.style === "string" ? event.style : "default",
		event.compaction !== false,
	);
}

/** 初始化：注册三个顶部栏 chip、建下拉、绑事件 */
export function init() {
	// 自己注入样式：约定不改 app.css，多个功能并行时也就不会互相覆盖。
	const style = document.createElement("style");
	style.textContent = STYLE;
	document.head.append(style);

	// 顶栏只放常用的两件：计划（先出方案还是直接动手）与审批（动手前要不要问一句）——
	// 它们常显当前档位，所以设置面板里不再重复一份。
	// 风格、压缩、放行规则、接口密钥这些「设一次」的东西进设置面板（外壳的右侧面板一个标签）。
	// chip 由 addTopBarAction 建，所以它落在顶部栏右侧那一排里，不再碰输入区。
	for (const field of TOP_BAR_FIELDS) {
		buildPopoverChip(field);
	}
	// 符号 ⚙ 是 AGENTS.md 固定符号集里为「设置」加的那一个；order 90 把它排在标签条最末：
	// 位置本身在说「这是偶尔才开的那一个」。
	addPanelTab({ id: "settings", symbol: "⚙", label: "设置", build: buildSettingsPanel, order: 90 });
	// 展开/收起统一在这里绑：弹层要等全都建好才知道该收起哪一个。
	for (const entry of popovers) {
		entry.chip.addEventListener("click", () => toggleMenu(entry));
	}

	// 点空白处收起。用 composedPath 判断「点的是不是这个下拉」：菜单挂在 body 上，
	// 单看 target 的父链说不清，而事件本身带完整路径。
	document.addEventListener("click", (event) => {
		if (
			opened !== null &&
			!event.composedPath().includes(opened.chip) &&
			!event.composedPath().includes(opened.menu)
		) {
			closeMenus();
		}
	});
	// 菜单是 fixed 定位，得自己跟着 chip 走：顶部栏横向滚动、窗口缩放都会让旧坐标失效。
	// 用捕获阶段听 scroll，才能同时收到内部容器（顶部栏、对话区）的滚动。
	const follow = () => {
		if (opened !== null) {
			positionMenu(opened);
		}
	};
	window.addEventListener("scroll", follow, true);
	window.addEventListener("resize", follow);

	// Esc 收起。外壳的 Esc 是关右侧面板，这里只在自己的下拉开着时动手。
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && opened !== null) {
			closeMenus();
		}
	});

	// 会话或运行状态一变就同步一次。用轮询而不是订阅事件：会话模块没有对外的事件出口，
	// 而按 id 去重的 GET 只有几个字段，代价可以忽略。
	setInterval(syncIfNeeded, 1000);
	paint();
	syncIfNeeded();
}
