/*
 * 工作目录选择器。
 *
 * 浏览器里拿不到原生的目录选择框（`<input type="file" webkitdirectory>` 只给相对路径），
 * 所以这里自己列一层目录：进子目录、退回上一级、直接粘绝对路径，也可以就地新建文件夹。
 *
 * 确认后走哪条路取决于**有没有选中会话**：
 *   - 选中了：`POST /api/cwd { path, session }`，只给这一个会话换目录。服务端不重建注册表，
 *     别的会话（哪怕正在生成）一概不受影响——这就是「一个会话里换工作目录」的做法；
 *   - 没选中：`POST /api/cwd { path }`，换服务端的全局工作目录（整套会话跟着换），
 *     也就是「新建会话会落在哪里」。
 * 弹窗标题会把这次要改的是谁写出来，免得用户以为是另一件事。
 */

import { api } from "./api.js";
import { el, state } from "./state.js";
import { setStatus } from "./ui.js";

/** 正在浏览的目录，确认时提交的就是它 */
let browsing = "";

/** 上一级目录；已经在根目录时为 null */
let parent = null;

/** 选定目录后由 app.js 注入：(新状态, 会话 id 或空串) */
let onChanged = null;

/** 这次要改谁：某一行的「工作目录」点进来时是那个会话的 id，否则按当前上下文决定 */
let explicitTarget = null;

/**
 * 这次动手改的是哪个会话；返回空串表示改服务端的全局工作目录。
 *
 * 两条来源：会话行菜单点进来的（`open(id)`，明确指定），以及左下角那一行点进来的
 * （改当前选中的会话；没选中会话就是全局目录）。
 */
function targetSession() {
	return explicitTarget ?? (state.activeId === null ? "" : state.activeId);
}

/** 某个会话在列表里的显示名，只用于标题；空会话的标题是「(还没有对话)」这类占位，就退回中性说法 */
function titleOf(id) {
	const session = state.sessions.find((candidate) => candidate.id === id);
	const title = typeof session?.title === "string" && session.title !== "" ? session.title : (session?.preview ?? "");
	return title === "" || title.startsWith("(") ? "当前会话" : title;
}

/** 浏览的起点：那个会话自己的目录，否则全局目录 */
function startDir() {
	const id = targetSession();
	const session = id === "" ? null : state.sessions.find((candidate) => candidate.id === id);
	return session !== null && typeof session.cwd === "string" && session.cwd !== "" ? session.cwd : state.cwd;
}

/** 出错时的提示条 */
function showError(message) {
	el.pickerError.textContent = message;
	el.pickerError.hidden = false;
}

function hideError() {
	el.pickerError.hidden = true;
	el.pickerError.textContent = "";
}

/** 拉取并渲染某个目录；path 传空字符串表示「服务端当前的工作目录」 */
async function browse(path) {
	hideError();
	try {
		render(await api(`/api/dirs?path=${encodeURIComponent(path)}`));
	} catch (error) {
		showError(error.message);
	}
}

function render(data) {
	browsing = data.path;
	parent = data.parent;
	el.pickerPath.value = data.path;
	el.pickerHint.textContent = `${data.dirs.length} 个子目录`;
	el.pickerUp.disabled = parent === null;

	el.pickerList.replaceChildren();
	if (data.dirs.length === 0) {
		const empty = document.createElement("div");
		empty.className = "modal-empty";
		empty.textContent = "（没有子目录）";
		el.pickerList.append(empty);
		return;
	}
	for (const dir of data.dirs) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "modal-item";
		item.textContent = dir.name;
		item.title = dir.path;
		item.addEventListener("click", () => void browse(dir.path));
		el.pickerList.append(item);
	}
}

/** 展开新建文件夹的输入行 */
function openCreate() {
	hideError();
	el.pickerCreate.hidden = false;
	el.pickerCreateName.value = "";
	el.pickerCreateName.focus();
}

/** 收起新建文件夹的输入行 */
function closeCreate() {
	el.pickerCreate.hidden = true;
	el.pickerCreateName.value = "";
}

/** 在当前浏览的目录里新建文件夹，成功后刷新列表 */
async function createFolder() {
	const name = el.pickerCreateName.value.trim();
	if (name === "") {
		showError("文件夹名称不能为空");
		return;
	}
	hideError();
	try {
		const created = await api("/api/dirs", { method: "POST", body: { parent: browsing, name } });
		closeCreate();
		// 重新列一遍，新文件夹就在列表里，点一下就能进去。
		await browse(browsing);
		el.pickerHint.textContent = `已新建 ${created.path}`;
	} catch (error) {
		showError(error.message);
	}
}

/** 确认切换；成功后把新状态与「改的是谁」交给调用方收尾 */
async function confirm() {
	hideError();
	const session = targetSession();
	try {
		const next = await api("/api/cwd", {
			method: "POST",
			body: session === "" ? { path: browsing } : { path: browsing, session },
		});
		close();
		/*
		 * 先写切换结果，再把状态行交给 applyState：它在「还没选目录 / 还没建出会话」这两种情况下有一句
		 * 更该说的话（「工作目录已选好，点「新建会话」开始」），这条切换结果不该把它盖掉（踩过）。
		 */
		setStatus(session === "" ? `工作目录已切到 ${browsing}` : `这个会话的工作目录已切到 ${browsing}`);
		onChanged?.(next, session);
	} catch (error) {
		showError(error.message);
	}
}

/** 打开选择器；传会话 id 表示「只改这一个会话的目录」（会话行菜单里的入口） */
export async function open(sessionId = null) {
	explicitTarget = typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
	el.picker.hidden = false;
	closeCreate();
	const id = targetSession();
	el.pickerTitle.textContent = id === "" ? "选择工作目录（新建会话会落在这里）" : `切换「${titleOf(id)}」的工作目录`;
	await browse(startDir());
}

/** 关闭选择器 */
export function close() {
	el.picker.hidden = true;
	// 目标只对这一次打开有效：关掉之后左下角那一行再点开，又回到「当前上下文」那条默认规则。
	explicitTarget = null;
	closeCreate();
	hideError();
}

/** 绑定选择器自身的 DOM 事件；changed 在目录切换成功后收到新的 /api/state 结果 */
export function initPicker(changed) {
	onChanged = changed;

	el.pickerClose.addEventListener("click", close);
	el.pickerNew.addEventListener("click", openCreate);
	el.pickerCreateCancel.addEventListener("click", closeCreate);
	el.pickerCreate.addEventListener("submit", (event) => {
		event.preventDefault();
		void createFolder();
	});
	el.pickerUp.addEventListener("click", () => {
		if (parent !== null) {
			void browse(parent);
		}
	});
	el.pickerConfirm.addEventListener("click", () => void confirm());
	el.pickerGoto.addEventListener("submit", (event) => {
		event.preventDefault();
		void browse(el.pickerPath.value.trim());
	});
	// 点遮罩关闭；点内容区不关。
	el.picker.addEventListener("click", (event) => {
		if (event.target === el.picker) {
			close();
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || el.picker.hidden) {
			return;
		}
		// 正在填新文件夹名时，Esc 先收输入行，再按一次才关整个弹窗。
		if (!el.pickerCreate.hidden) {
			closeCreate();
			return;
		}
		close();
	});
}
