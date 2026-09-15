/*
 * 接口密钥设置。
 *
 * 密钥只写进本机的 auth.json（0600）：服务端只回「配了没有、打码后长什么样、来自哪里」，
 * 明文永远不回页面，也不写进会话记录。保存后不需要重启——服务端每次生成前重新解析一次密钥。
 *
 * 界面分两处：设置面板里的「接口密钥」框（本模块建，由 modes.js 的 `buildSettingsPanel` 挂进去），
 * 与它打开的录入弹窗。以前那个框在侧栏底部，现在侧栏底部只留模型。
 */

import { api } from "./api.js";
import { icon } from "./icons.js";
import { el } from "./state.js";
import { setStatus } from "./ui.js";

/** 「图标 + 文字」里的文字那段；图标与文字之间的间距由按钮的 gap 管 */
function labelSpan(label) {
	const node = document.createElement("span");
	node.textContent = label;
	return node;
}

/** 密钥来源对应的说明 */
const SOURCE_TEXT = {
	flag: "来自启动参数 --api-key",
	env: "来自环境变量 DEEPSEEK_API_KEY",
	auth: "保存在本机 auth.json",
	none: "还没有配置",
};

/** 最近一次拿到的状态 */
let current = null;

/** 设置面板里那张卡片的节点引用；面板没建时是 null（它是懒建的） */
let card = null;

/** 更新设置面板里那一行（卡片还没建时什么都不做） */
function renderRow() {
	if (card === null) {
		return;
	}
	card.value.textContent = current.configured ? current.masked : "未配置";
	// 没密钥时整行标红，免得用户对着「发送」按钮猜为什么没反应。
	card.row.classList.toggle("missing", !current.configured);
	card.row.title = current.configured
		? `${current.masked}（${SOURCE_TEXT[current.source]}，点击修改）`
		: "点击填入 API Key";
}

/**
 * 建设置面板里的「接口密钥」框。
 *
 * 由 modes.js 的 `buildSettingsPanel` 调用（它也懒建：用户第一次打开「设置」标签时才建）。
 * 之所以放在这里而不是 modes.js 里：密钥的读取、保存、清除与打码规则都在本模块，
 * 搬走界面不该把逻辑也拆成两半。
 */
export function buildCredentialsCard() {
	const root = document.createElement("div");
	root.className = "lmk-modes-card";

	const head = document.createElement("div");
	head.className = "lmk-modes-card-head";
	const title = document.createElement("span");
	title.className = "lmk-modes-card-title";
	title.textContent = "接口密钥";
	const note = document.createElement("span");
	note.className = "lmk-modes-card-note";
	note.textContent = "存本机，明文不回页面";
	head.append(title, note);

	const row = document.createElement("button");
	row.type = "button";
	row.className = "path-button lmk-credentials-row";
	const value = document.createElement("span");
	value.className = "path-text";
	value.textContent = "读取中…";
	row.append(value);
	row.addEventListener("click", () => openSettings());

	const actions = document.createElement("div");
	actions.className = "lmk-modes-actions";
	const edit = document.createElement("button");
	edit.type = "button";
	edit.className = "lmk-modes-option";
	// 图标 + 文字（线性图标，见 icons.js）：文字符号与别的按钮对不齐，换成同一套图标
	edit.append(icon("pencil", 14));
	edit.append(labelSpan("修改"));
	edit.title = "填入或替换 API Key";
	edit.addEventListener("click", () => openSettings());
	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "lmk-modes-option";
	remove.append(icon("trash", 14));
	remove.append(labelSpan("清除"));
	remove.title = "忘掉本机保存的密钥（来自环境变量或启动参数时无处可清）";
	remove.addEventListener("click", (event) => {
		event.stopPropagation();
		void openClearConfirm();
	});
	actions.append(edit, remove);

	const desc = document.createElement("div");
	desc.className = "lmk-modes-desc";
	desc.textContent = "只影响本机这一份配置；填完之后下一次生成就会用它，不用重启。";

	root.append(head, row, actions, desc);
	card = { root, row, value, remove };
	void loadCredentials();
	return root;
}

/** 「清除」按钮：先问一次，再走与弹窗里同一段逻辑 */
async function openClearConfirm() {
	if (!card || card.remove.disabled) {
		setStatus("当前密钥来自环境变量或启动参数，网页里没有可清除的");
		return;
	}
	if (!window.confirm("清除本机保存的 API Key？之后要重新填一个才能生成。")) {
		return;
	}
	await clear();
	renderRow();
}

/** 更新弹窗里的说明与按钮状态 */
function renderNote() {
	el.settingsNote.textContent = current.configured
		? `当前生效：${current.masked} · ${SOURCE_TEXT[current.source]}`
		: "还没有可用的密钥，填一个才能开始生成。";
	el.settingsStorage.textContent = `存储方式：${current.storage}`;
	// 环境变量与命令行参数优先级更高，此时这里保存的不会生效，也谈不上「清除」。
	el.settingsClear.disabled = !current.stored || (current.source !== "auth" && current.source !== "none");
	el.settingsClear.title = el.settingsClear.disabled ? "当前密钥来自环境变量或启动参数，网页里没有可清除的" : "";
	if (card !== null) {
		card.remove.disabled = el.settingsClear.disabled;
		card.remove.title = el.settingsClear.title || "忘掉本机保存的密钥";
	}
}

function showStatus(text, kind) {
	el.settingsStatus.textContent = text;
	el.settingsStatus.className = `modal-status ${kind}`;
	el.settingsStatus.hidden = false;
}

function hideStatus() {
	el.settingsStatus.hidden = true;
	el.settingsStatus.textContent = "";
}

/** 用服务端返回的状态刷新界面 */
function apply(state) {
	current = state;
	renderRow();
	renderNote();
}

/** 打开设置弹窗 */
export function openSettings() {
	hideStatus();
	el.settings.hidden = false;
	el.settingsKey.value = "";
	el.settingsKey.focus();
}

/** 关闭设置弹窗 */
function closeSettings() {
	el.settings.hidden = true;
	el.settingsKey.value = "";
	hideStatus();
}

/** 保存网页里填的密钥 */
async function save() {
	const key = el.settingsKey.value.trim();
	if (key === "") {
		showStatus("密钥不能为空", "error");
		return;
	}
	try {
		apply(await api("/api/credentials", { method: "POST", body: { key } }));
		el.settingsKey.value = "";
		showStatus("已保存，下一次生成就会用它", "ok");
		setStatus("就绪");
	} catch (error) {
		showStatus(error.message, "error");
	}
}

/** 清除本地保存的密钥 */
async function clear() {
	try {
		apply(await api("/api/credentials", { method: "DELETE" }));
		showStatus("已清除本地保存的密钥", "ok");
	} catch (error) {
		showStatus(error.message, "error");
	}
}

/** 拉取当前状态并渲染；读不到就当作未配置 */
export async function loadCredentials() {
	try {
		apply(await api("/api/credentials"));
	} catch {
		current = { configured: false, masked: "(未设置)", source: "none", stored: false };
		renderRow();
		renderNote();
	}
	if (!current.configured) {
		setStatus("未配置 API Key，到右侧面板的「设置」里填一个");
	}
}

/** 绑定设置弹窗的事件（卡片自己绑自己的；这里只管弹窗） */
export function initSettings() {
	el.settingsClose.addEventListener("click", closeSettings);
	el.settingsForm.addEventListener("submit", (event) => {
		event.preventDefault();
		void save();
	});
	el.settingsClear.addEventListener("click", () => void clear());
	el.settings.addEventListener("click", (event) => {
		if (event.target === el.settings) {
			closeSettings();
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !el.settings.hidden) {
			closeSettings();
		}
	});
}
