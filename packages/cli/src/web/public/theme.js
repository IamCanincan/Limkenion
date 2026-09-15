/*
 * 主题：直接跟随系统，不提供手动切换。
 *
 * 系统偏好是唯一来源。prefers-color-scheme 一变就跟着变，页面不存任何选择，
 * 所以也不存在「上次选了浅色所以现在不跟」的情况。
 *
 * index.html 的 <head> 里有一段内联脚本，作用是在首次绘制前就把 data-theme 定下来，
 * 否则浅色系统的用户会先看到一帧深色。改这里的判定逻辑时记得同步那三行。
 */

/** 系统的浅色偏好；不支持 matchMedia 时按深色处理，与 index.html 的默认值一致 */
const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)");

/** 系统当前偏好的主题 */
function systemTheme() {
	return prefersLight?.matches ? "light" : "dark";
}

/** 把生效的主题写到 <html>，并让滚动条、表单控件这类原生界面一起跟着变 */
function paint(theme) {
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
}

/** 启动时跟随系统，并订阅它的变化 */
export function initTheme() {
	paint(systemTheme());

	prefersLight?.addEventListener("change", () => {
		paint(systemTheme());
	});
}
