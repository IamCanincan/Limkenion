/**
 * 图标库：24×24 网格上的线性图标（圆头描边、`currentColor`）。
 *
 * 为什么不继续用 `▤ ↺ ⌫` 这类文字符号：它们来自不同字体，**笔重、基线、圆角都对不齐**——
 * 一排按钮放在一起就看得出参差（使用者：「不能像有这样的图标吗？太难看了」）。这里统一：
 * 同一网格、同一描边宽度、同一套圆头圆角，颜色继承 `currentColor`，所以主题切换自动跟上。
 *
 * 用法：`icon("plus")` → 一个 SVG 元素（默认 14px）。需要别的尺寸传第二个参数。
 * 只画路径，不做位图，也不引第三方库。
 */

/** 线性图标的路径表（24×24）；数组表示一个图标由多段组成 */
const PATHS = {
	plus: ["M12 5v14", "M5 12h14"],
	minus: ["M5 12h14"],
	close: ["M6 6l12 12", "M18 6L6 18"],
	check: ["M4.5 12.5l5 5L19.5 7"],
	chevronDown: ["M6 9.5l6 6 6-6"],
	chevronRight: ["M9.5 6l6 6-6 6"],
	chevronUp: ["M6 14.5l6-6 6 6"],
	refresh: ["M3.5 12a8.5 8.5 0 1 0 2.6-6.1", "M3.5 4.5V10h5.5"],
	arrowDown: ["M12 5v14", "M6 13l6 6 6-6"],
	// 「上下文压缩」是"裁掉旧输出"：剪刀比圆点贴切得多
	scissors: ["M6.5 6.5a2.5 2.5 0 1 0 .01 0z", "M6.5 17.5a2.5 2.5 0 1 0 .01 0z", "M8.8 8.8L20 20", "M8.8 15.2L20 4"],
	trash: ["M4 7h16", "M9.5 7V4h5v3", "M6.5 7l1 13h9l1-13", "M10.5 11v6", "M13.5 11v6"],
	folder: ["M3 7.5A2 2 0 0 1 5 5.5h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
	// 打开的文件夹（工作区展开时用）：上面一条掀开的盖 + 下面一个斜的口袋
	folderOpen: [
		"M3 7.5A2 2 0 0 1 5 5.5h3.5l2 2H18a2 2 0 0 1 2 2v1.5",
		"M3 9.5h18l-2.2 8a2 2 0 0 1-1.9 1.5H5.1a2 2 0 0 1-1.9-1.5z",
	],
	file: ["M6.5 3.5h7l4.5 4.5v12h-11.5z", "M13.5 3.5V8H18"],
	clock: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", "M12 7.5V12l3 2"],
	terminal: ["M5 7.5l4.5 4.5L5 16.5", "M12.5 16.5H19"],
	eye: [
		"M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z",
		"M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
	],
	filePlus: ["M6.5 3.5h7l4.5 4.5v12h-11.5z", "M13.5 3.5V8H18", "M12 11.5v6", "M9 14.5h6"],
	dot: ["M12 5.5a6.5 6.5 0 1 0 .01 0z"],
	warn: ["M12 4.5l8.5 15h-17z", "M12 10v4", "M12 16.6v.4"],
	review: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", "M8.5 12.3l2.4 2.4 4.6-5"],
	pulse: ["M3 12.5h3.5l2-6 4 12 2.2-6H21"],
	// 四分格（圆角方框 + 一竖一横）：侧栏开关用它（使用者给的形状）
	layout: [
		"M3.5 6.5A2 2 0 0 1 5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
		"M10 4.5v15",
		"M3.5 10h17",
	],
	// 三条横（hamburger）：面板开关用它
	lines: ["M4 7h16", "M4 12h16", "M4 17h16"],
	sliders: [
		"M4 7h16",
		"M4 12h16",
		"M4 17h16",
		"M9 7a1.6 1.6 0 1 0 .01 0z",
		"M15 12a1.6 1.6 0 1 0 .01 0z",
		"M8 17a1.6 1.6 0 1 0 .01 0z",
	],
	search: ["M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z", "M15.8 15.8L20 20"],
	sidebar: ["M3.5 6.5A2 2 0 0 1 5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z", "M9.5 4.5v15"],
	// 虚线 = 那一栏收起来了（顶栏两颗开关的开/合两态）
	sidebarOff: [
		"M3.5 6.5A2 2 0 0 1 5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
		"M9.5 7v2.5",
		"M9.5 12v2.5",
		"M9.5 17v0.5",
	],
	panel: ["M3.5 6.5A2 2 0 0 1 5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z", "M14.5 4.5v15"],
	panelOff: [
		"M3.5 6.5A2 2 0 0 1 5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
		"M14.5 7v2.5",
		"M14.5 12v2.5",
		"M14.5 17v0.5",
	],
	pencil: ["M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z", "M14.5 6.5l3 3"],
	dots: ["M6 12a1.4 1.4 0 1 0 .01 0z", "M12 12a1.4 1.4 0 1 0 .01 0z", "M18 12a1.4 1.4 0 1 0 .01 0z"],
};

/** `●` 这类实心点：单独用填充画，不参与描边 */
const FILLED = new Set(["dots", "dot"]);

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 造一个图标元素。
 *
 * @param name 图标名（见 PATHS）
 * @param size 边长（px），默认 14
 */
export function icon(name, size = 14) {
	const paths = PATHS[name];
	const node = document.createElementNS(SVG_NS, "svg");
	node.setAttribute("viewBox", "0 0 24 24");
	node.setAttribute("width", String(size));
	node.setAttribute("height", String(size));
	node.setAttribute("aria-hidden", "true");
	node.classList.add("lk-icon");
	if (paths === undefined) {
		// 名字打错时给个可见的空位，而不是静默什么都不画
		node.setAttribute("data-lk-icon-missing", name);
		return node;
	}
	for (const d of paths) {
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("d", d);
		if (FILLED.has(name)) {
			path.setAttribute("fill", "currentColor");
			path.setAttribute("stroke", "none");
		}
		node.append(path);
	}
	return node;
}

/**
 * 文字符号 → 图标名。
 *
 * 面板标签是各功能模块用 `addPanelTab({ symbol: "▤" })` 注册的，符号是写死在字符串里的。
 * 与其改一圈 API，不如在这里做一层映射：认识的老符号换成图标，不认识的照原样显示文字。
 */
export const SYMBOL_TO_ICON = {
	"✕": "close",
	"▸": "chevronRight",
	"▾": "chevronDown",
	"+": "plus",
	"−": "minus",
	"↺": "refresh",
	"✓": "check",
	"⌫": "trash",
	"⌕": "search",
	"▤": "folder",
	"⌗": "terminal",
	"⚙": "sliders",
	"…": "dots",
	"●": "pulse",
	"↓": "arrowDown",
};

/** 需要描边的图标统一走这条：线性、圆头、继承文字颜色（尺寸由 width/height 控制） */
export const ICON_CSS = `
.lk-icon { flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; vertical-align: -0.15em; }
`;
