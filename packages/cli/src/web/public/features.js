import {
	addPanelTab,
	addSidebarAction,
	addTopBarAction,
	closePanel,
	openPanel,
	panelOpen,
	setTopBarTitle,
} from "./shell.js";
/*
 * 前端功能聚合。
 *
 * 每个功能自带 DOM 与样式（运行时注入 <style>），因此不用改 index.html 与 app.css——
 * 加功能不会碰到别人的文件，也不会因为样式散在各处而互相覆盖。
 */

import { init as initCommands } from "./commands.js";
import { init as initDoctor } from "./doctor.js";
import { init as initFiles } from "./files.js";
import { init as initHistory } from "./history.js";
import { init as initModes } from "./modes.js";
import { init as initOverview } from "./overview.js";
import { init as initReview } from "./review.js";
import { init as initSearch } from "./search.js";
import { init as initSessionList } from "./session-list.js";
import { init as initTerminal } from "./terminal.js";
import { init as initUsage } from "./usage.js";

/** 启动全部功能模块；单个模块出错不影响其它模块与主流程 */
// 外壳 API 从这里转发给各功能模块：位置统一，谁也不必自己造浮层或改 index.html。
export { addPanelTab, addSidebarAction, addTopBarAction, closePanel, openPanel, panelOpen, setTopBarTitle };

export function initFeatures() {
	for (const [name, init] of [
		// 斜杠命令菜单排在前面：它属于输入区，先建好，用户一进来敲 `/` 就有东西可看。
		["斜杠命令", initCommands],
		// 会话列表的「工作区」头部随它一起建起来：侧栏顶部那块地方是它的。
		["会话列表", initSessionList],
		["搜索", initSearch],
		["历史", initHistory],
		["模式", initModes],
		["用量", initUsage],
		["文件", initFiles],
		["总览", initOverview],
		["终端", initTerminal],
		["评审", initReview],
		["体检", initDoctor],
	]) {
		try {
			init();
		} catch (error) {
			console.error(`[${name}] 初始化失败`, error);
		}
	}
}
