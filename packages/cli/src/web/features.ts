/*
 * 功能路由注册表。
 *
 * 每个功能把自己的路由注册进来，\`server.ts\` 只调用一次 \`runFeatureRoutes\`——这样加功能不必
 * 改共享的请求分发代码，多人（或多 agent）并行开发时也不会互相踩。
 *
 * 约定：返回 \`true\` 表示这个请求我已经处理并回复了；返回 \`false\` 就交给下一个。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CommandRunner } from "../commands/self.ts";
import type { SelfUpdateJob } from "./feature-version.ts";
import type { RunRegistry } from "./registry.ts";

/** 功能路由能拿到的运行环境 */
export interface FeatureContext {
	/** 当前工作目录（切换目录后会变，所以取的是函数） */
	getCwd: () => string;
	/** 会话注册表，按会话做事的接口都在这里 */
	registry: RunRegistry;
	/** 默认模型 id */
	getModel: () => string;
	/** 当前生效的接口地址；没给就是官方地址 */
	getBaseUrl: () => string | undefined;
	/**
	 * 覆盖 fetch，仅用于测试。
	 *
	 * 评审要直接造代理跑模型调用，测试里得有地方注入假 fetch；不给时走真实网络。
	 * 只有评审用得上它，但放在上下文里而不是让功能自己去翻启动参数——功能路由拿不到 `WebServerOptions`。
	 */
	fetchImpl?: typeof fetch;
	/**
	 * 起「分离安装进程」的替代实现，仅用于测试。
	 *
	 * 自更新的回滚会挂一个分离进程等这个服务退出后 `npm install -g <tgz>`；测试里不能让它真装。
	 * 与 `fetchImpl` 同一个理由：不注入就没法既测到这条路、又不碰本机装着的版本。
	 */
	spawnInstaller?: (script: string, jobFile: string) => boolean;
	/**
	 * 跑 `npm run check` / `npm run release:package` 的替代实现，仅用于测试。
	 *
	 * 网页上那个「更新」按钮真的会跑门禁与打包（几分钟）——验收脚本只该验界面，不该等它，
	 * 更不该在这台机器上真装东西。
	 */
	selfRunner?: CommandRunner;
	/**
	 * 自更新的源码目录（`limkenion web --from <目录>`）。
	 *
	 * 从**启动参数**来，不从请求体来：网页只能更新这台机器上已经指定的那个源码目录，
	 * 不然一个 POST 就能让服务在任意目录里跑构建脚本。
	 */
	selfSource?: string;
	/**
	 * 这一次更新的进度。
	 *
	 * 由 `startWebServer` 为**这台服务器**建一份（不是模块级全局）：它是运行状态，
	 * 跨服务器实例共享会让两条测试互相看到对方的「正在更新」，线上也没有理由共享。
	 */
	selfUpdate: { job: SelfUpdateJob | null };
}

/** 一个功能路由 */
export type FeatureRoute = (
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	method: string,
	context: FeatureContext,
) => Promise<boolean> | boolean;

const routes: FeatureRoute[] = [];

/** 注册一个功能路由；模块加载时调用 */
export function registerFeatureRoute(route: FeatureRoute): void {
	routes.push(route);
}

/** 依次问每个功能路由；任何一个认领了就返回 true */
export async function runFeatureRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	method: string,
	context: FeatureContext,
): Promise<boolean> {
	for (const route of routes) {
		if (await route(request, response, url, method, context)) {
			return true;
		}
	}
	return false;
}

import { route as commandsRoute } from "./feature-commands.ts";
import { route as doctorRoute } from "./feature-doctor.ts";
import { route as filesRoute } from "./feature-files.ts";
import { route as historyRoute } from "./feature-history.ts";
import { route as modesRoute } from "./feature-modes.ts";
import { route as reviewRoute } from "./feature-review.ts";
// 各功能模块在这里挂上自己的路由（模块本身负责实现）。
import { route as searchRoute } from "./feature-search.ts";
import { route as terminalRoute } from "./feature-terminal.ts";
import { route as versionRoute } from "./feature-version.ts";

registerFeatureRoute(searchRoute);
registerFeatureRoute(historyRoute);
registerFeatureRoute(modesRoute);
registerFeatureRoute(filesRoute);
registerFeatureRoute(terminalRoute);
registerFeatureRoute(reviewRoute);
registerFeatureRoute(doctorRoute);
registerFeatureRoute(commandsRoute);
registerFeatureRoute(versionRoute);
