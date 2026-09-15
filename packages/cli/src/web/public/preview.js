/*
 * 右侧文件预览面板。
 *
 * 这是界面上唯一的文件查看方式，入口在工具卡片的「预览文件」按钮上。只读，且服务端限长。
 */

import { api } from "./api.js";
import { shortenPath } from "./format.js";
import { el } from "./state.js";
import { setStatus } from "./ui.js";

/** 打开预览面板并载入文件内容 */
export async function openPreview(path) {
	try {
		const data = await api(`/api/file?path=${encodeURIComponent(path)}`);
		// 完整路径放在 title 里，面板上只显示尾部两段，够看清是哪个文件。
		el.previewPath.textContent = shortenPath(data.path, 2);
		el.previewPath.title = data.path;
		if (data.binary) {
			el.previewBody.textContent = "[二进制文件，无法预览]";
		} else if (data.truncated) {
			el.previewBody.textContent = `${data.content}\n\n[内容过长，已截断]`;
		} else {
			el.previewBody.textContent = data.content;
		}
		el.preview.hidden = false;
		// 预览一开就可能把主干挤扁：立刻重算覆盖层（动态 import 避免循环依赖）
		void import("./shell.js").then((module) => {
			module.noteLayoutOpened("preview");
			module.syncPanelOverlay();
		});
	} catch (error) {
		setStatus(`预览失败：${error.message}`);
	}
}

/** 关闭预览面板 */
/** 预览宽度：最小 320、最大 720，超出就夹住 */
const PREVIEW_MIN = 320;
const PREVIEW_MAX = 720;

/** 拖柄：改 --lk-preview-width（左边缘，所以往左拖是变宽） */
export function initPreviewResize() {
	const handle = document.querySelector(".preview-resize");
	const panel = el.preview;
	if (handle === null || panel === null) {
		return;
	}
	const apply = (width) => {
		panel.style.setProperty("--lk-preview-width", `${Math.round(width)}px`);
	};
	handle.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = panel.getBoundingClientRect().width;
		handle.setAttribute("data-dragging", "1");
		handle.setPointerCapture(event.pointerId);
		const move = (moveEvent) => {
			// 拖柄在左边：鼠标往左 = 变宽
			apply(Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, startWidth + (startX - moveEvent.clientX))));
		};
		const up = () => {
			handle.removeAttribute("data-dragging");
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up);
	});
	// 键盘：← 变宽、→ 变窄（与合成器那两条一致）
	handle.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
			return;
		}
		event.preventDefault();
		const step = event.key === "ArrowLeft" ? 40 : -40;
		const now = panel.getBoundingClientRect().width;
		apply(Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, now + step)));
	});
	// 双击复位
	handle.addEventListener("dblclick", () => {
		panel.style.removeProperty("--lk-preview-width");
	});
}

export function closePreview() {
	el.preview.hidden = true;
	void import("./shell.js").then((module) => module.syncPanelOverlay());
}
