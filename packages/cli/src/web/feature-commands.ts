/*
 * 自定义斜杠命令清单：GET /api/commands
 *
 * 网页的输入框要在用户敲下 `/` 时把可用的命令列出来，命令来自与命令行同一个目录
 * （`<配置目录>/commands/*.md`，见 custom-commands.ts）。本模块只做「列清单」一件事：
 *
 * - 提示词正文（`body`）与文件路径不出这个端点：界面只需要「有什么命令、一句话说明、参数提示」，
 *   选中之后由服务端展开（runs.ts 的 `expandSlashCommand` → `buildCommandPrompt`），
 *   正文没必要过一趟浏览器，浏览器也就不会自己拼出一份与命令行不一样的提示词。
 * - 展开规则、`$ARGUMENTS` 的替换、没有占位符时把参数附在末尾，全部复用 custom-commands.ts，
 *   网页与命令行因此不会各有一套慢慢走偏的说法。
 *
 * 每次请求都重新读目录，不缓存：一条命令就是一个 Markdown 文件，读一遍很便宜，而用户往目录里
 * 新放一个文件后不必重启服务就能在菜单里看到它。
 */

import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { listCustomCommands } from "../custom-commands.ts";
import type { FeatureRoute } from "./features.ts";
import { sendJson } from "./http.ts";
import type { ErrorResponse } from "./protocol.ts";

/** 清单端点 */
const COMMANDS_PATH = "/api/commands";

/**
 * `GET /api/commands` 的响应。
 *
 * 形状定义在本模块而不是 protocol.ts：协议那份共享文件由多个功能并行改动，本功能自带的字段
 * 先留在自己这里（与 feature-doctor.ts / feature-files.ts 同一套做法）。前端是手写 JS，
 * 靠字段名对齐。
 */
export interface CommandsResponse {
	/** 命令清单：名称不含前导斜杠，按名称排序；`argumentHint` 只在写了元数据时才有 */
	commands: { name: string; description: string; argumentHint?: string }[];
}

/** 只认 GET /api/commands；命中就整条请求归这里管（包括方法不对），因此总是返回 true */
export const route: FeatureRoute = (_request, response, url, method) => {
	if (url.pathname !== COMMANDS_PATH) {
		// 不是本模块的路径：交给后面的功能路由。
		return false;
	}
	// 清单是只读的，没有请求体可读，因此没有 POST 的语义。
	if (method !== "GET") {
		sendJson(response, 405, { error: "命令清单只支持 GET /api/commands" } satisfies ErrorResponse);
		return true;
	}

	// 目录与命令行的 `commandsDir` 同一处（cli.ts：<配置目录>/commands）。
	const commands = listCustomCommands(join(getAgentDir(), "commands")).map((command) => {
		const entry: CommandsResponse["commands"][number] = {
			name: command.name,
			description: command.description,
		};
		if (command.argumentHint !== undefined) {
			entry.argumentHint = command.argumentHint;
		}
		return entry;
	});
	sendJson(response, 200, { commands } satisfies CommandsResponse);
	return true;
};
