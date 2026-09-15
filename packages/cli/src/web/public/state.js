/*
 * 全局状态与 DOM 引用。
 *
 * 前端没有框架，所有模块共享这一份 state 与 el：el 在启动时一次性查好，
 * 渲染路径上不再反复 document.getElementById。
 */

/**
 * 服务端会推送的事件类型，连 SSE 时要逐个 addEventListener。
 *
 * 这份名单必须与服务端的 `WEB_EVENT_TYPES`（web/protocol.ts）完全一致：少一个，那类事件在浏览器里
 * 就永远收不到——`approval` 曾经漏在这里，于是确认卡片只在刷新页面（快照里带着待确认调用）时才出现，
 * 实时那一份根本没显示过。compat.test.ts 里有一条契约测试盯着这两份名单。
 */
export const EVENT_TYPES = [
	"status",
	"text",
	"reasoning",
	"tool_start",
	"tool_end",
	"approval",
	"approval_result",
	"plan_review",
	"plan_review_result",
	"done",
	// 本会话累计用量：随快照发一次，之后每轮结束再发。
	"usage",
	"error",
	"notices",
	// 待办与目标：随快照发一次，之后每次工具跑完有变化再发。
	"facts",
	"history",
	"pending",
	// 会话当前的审批与计划模式：随快照发一次，之后每次切换再发。
	"modes",
];

/** 全局状态 */
export const state = {
	cwd: "",
	models: [],
	sessions: [],
	activeId: null,
	source: null,
	running: false,
	/** 当前这一轮开始的时刻，用完置空 */
	turnStartedAt: null,
	/** 进行中一轮的文本缓冲，用于增量渲染 */
	stream: null,
	/**
	 * 服务端下发的状态提示（上下文压缩、超窗救援、这一轮失败）。
	 *
	 * 它不随消息历史走，而是随快照全量重发，所以这里存一份、整体重绘；本地不清空，
	 * 免得「刷新页面就看不到刚才为什么失败」。
	 */
	notices: [],
	/**
	 * 当前会话的「总是允许」放行规则（`{tool, prefix, text}[]`）。
	 *
	 * 归会话模块拉取与清空，但它显示在顶栏那个模式菜单的审批段里——以前是侧栏一个常驻按钮，
	 * 现在并进菜单，所以把数据放在这里给两边共用。
	 */
	approvalRules: [],
};

/** 常用 DOM 节点 */
export const el = {
	sessionList: document.getElementById("session-list"),
	newSession: document.getElementById("new-session"),
	model: document.getElementById("model"),
	transcript: document.getElementById("transcript"),
	composerNotices: document.getElementById("composer-notices"),
	jumpLatest: document.getElementById("jump-latest"),
	composer: document.getElementById("composer"),
	input: document.getElementById("input"),
	status: document.getElementById("status"),
	stop: document.getElementById("stop"),
	send: document.getElementById("send"),
	preview: document.getElementById("preview"),
	previewPath: document.getElementById("preview-path"),
	previewBody: document.getElementById("preview-body"),
	previewClose: document.getElementById("preview-close"),
	picker: document.getElementById("picker"),
	pickerTitle: document.getElementById("picker-title"),
	pickerClose: document.getElementById("picker-close"),
	pickerNew: document.getElementById("picker-new"),
	pickerCreate: document.getElementById("picker-create"),
	pickerCreateName: document.getElementById("picker-create-name"),
	pickerCreateCancel: document.getElementById("picker-create-cancel"),
	pickerGoto: document.getElementById("picker-goto"),
	pickerPath: document.getElementById("picker-path"),
	pickerError: document.getElementById("picker-error"),
	pickerList: document.getElementById("picker-list"),
	pickerHint: document.getElementById("picker-hint"),
	pickerUp: document.getElementById("picker-up"),
	pickerConfirm: document.getElementById("picker-confirm"),
	settings: document.getElementById("settings"),
	settingsClose: document.getElementById("settings-close"),
	settingsForm: document.getElementById("settings-form"),
	settingsKey: document.getElementById("settings-key"),
	settingsNote: document.getElementById("settings-note"),
	settingsStorage: document.getElementById("settings-storage"),
	settingsStatus: document.getElementById("settings-status"),
	settingsClear: document.getElementById("settings-clear"),
};
