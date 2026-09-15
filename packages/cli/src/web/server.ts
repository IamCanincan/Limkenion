/**
 * Web UI 的 HTTP 服务器。
 *
 * 只用 node:http，没有任何依赖。职责分三块：托管静态前端、暴露 JSON API、用 SSE 推送事件。
 * 路由层不认识 Agent，只跟 RunRegistry 打交道，因此传输与业务是分开的。
 *
 * 安全姿态与 dsh 的 web 宿主一致：默认只绑定回环地址，不带 TLS、不带认证。额外校验
 * Host 与 Origin 头——浏览器访问本机服务时会带上它们，校验能挡掉「恶意页面通过 DNS
 * rebinding 访问 127.0.0.1 上的本地服务」这类攻击。
 */

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describeError } from "limkenion-ai";
import { describeApprovalPrefix } from "limkenion-core";
import type { CommandRunner } from "../commands/self.ts";
import { getSessionsDir } from "../config.ts";
import { resolveApiKey as resolveCredential } from "../credentials.ts";
import { listAllSessionFiles, Session } from "../session.ts";
import type { SelfUpdateJob } from "./feature-version.ts";
import { runFeatureRoutes } from "./features.ts";
import {
	isRequestAllowed,
	isValidFolderName,
	readFilePreview,
	readJsonBody,
	sendJson,
	sendStatic,
	staticAssetName,
} from "./http.ts";
import { readLastSessionId, writeLastSessionId } from "./last-session.ts";
import type {
	DirCreateResponse,
	DirListResponse,
	ErrorResponse,
	RenameResponse,
	ReorderResponse,
	WebEvent,
} from "./protocol.ts";
import { RunRegistry } from "./registry.ts";
import { handleStateRoutes, type StateRouteContext, stateResponse } from "./routes/state.ts";
import type { Run, RunOptions } from "./runs.ts";

// 这两个是 index.ts 从本模块取用的对外导出面；实现已挪到 http.ts，这里只做转出，
// 免得调用方跟着搬家。
export { isRequestAllowed, readFilePreview };

/**
 * 默认监听端口。
 *
 * 这里是唯一来源：命令行选项没给端口时用它的也是这个值，避免两处各写一份数字。
 *
 * 选 4887 的三个理由：
 * 1. IANA 的服务名与端口注册表里 4887 是 Unassigned，不会有已注册服务来撞；
 * 2. 在 1024 以上，普通用户就能监听，不需要 root 或管理员权限；
 * 3. 低于各平台的临时端口区间（Linux 32768-60999，Windows/macOS 49152-65535），
 *    因此也不会跟出站连接的临时端口撞上。
 */
export const DEFAULT_WEB_PORT = 4887;

/** 目录选择器一次最多列出多少个子目录，免得在巨型目录上撑爆响应 */
const MAX_DIR_ENTRIES = 500;

/** SSE 心跳间隔，避免中间代理掐掉空闲连接 */
const HEARTBEAT_MS = 20_000;

/**
 * 启动时的工作目录：**最近用过的那个会话所在的目录**，一个会话都没有就用主目录。
 *
 * 从前这里一律留空（`cwd = ""`），于是每次重启进程、打开网页都先摆出「先选一个工作目录：点上面的
 * 『新建会话』」，得先选一次目录才看得见自己先前的会话（使用者：「每次重启进程后打开网页都是要我新建
 * 会话选目录，才能看到我先前的会话」）。目录本身就在会话文件头里，直接读磁盘上最新的那一个即可，
 * 不新增任何状态文件。
 *
 * 一个会话都没有（全新的安装）时用主目录兜底，让「启动进程」这件事本身就能用（使用者：「用户启动进程
 * 且没会话的时候，默认新建个会话，在 C:\Users\20653 工作」）：这里只负责给一个确定、又不至于太深的
 * 落点，新建会话那一步在界面上（首屏没有会话就直接建一个）。想换目录随时可以在会话菜单里换。
 */
function startupCwd(): string {
	let newest: { at: number; cwd: string } | null = null;
	for (const file of listAllSessionFiles(getSessionsDir())) {
		const session = Session.open(file);
		if (!session || session.header.cwd === "") {
			continue;
		}
		const at = session.updatedAt();
		if (newest === null || at > newest.at) {
			newest = { at, cwd: session.header.cwd };
		}
	}
	return newest?.cwd ?? homedir();
}

/** 启动参数 */
export interface WebServerOptions extends Omit<RunOptions, "resolveApiKey"> {
	/** 绑定地址，默认 127.0.0.1 */ host?: string;
	/** 端口，0 表示由系统分配 */
	port?: number;
	/** 命令行 `--api-key` 的值，优先级最高 */
	apiKeyFlag?: string;
	/** 覆盖密钥解析，仅用于测试 */
	resolveApiKey?: () => string;
	/**
	 * 起「分离安装进程」的替代实现，仅用于测试。
	 *
	 * 自更新的回滚会在服务端挂一个分离进程，它等这个服务退出后跑 `npm install -g <tgz>`
	 * ——测试里绝不能让它真的去装（那会动到跑测试的这台机器上装着的版本），所以留一个注入口。
	 */
	spawnInstaller?: (script: string, jobFile: string) => boolean;
	/**
	 * 跑构建命令的替代实现，仅用于测试（网页上的「更新」会跑门禁与打包，几分钟）。
	 */
	selfRunner?: CommandRunner;
	/**
	 * 网页上那个「更新」按钮的源码目录（`limkenion web --from <目录>`）。
	 *
	 * 不给就只在网页上提供回滚；更新要跑门禁与打包，得先知道源码在哪。
	 */
	selfSource?: string;
}

/** 启动结果 */
export interface WebServerHandle {
	/** 可访问的地址，例如 http://127.0.0.1:4887 */
	url: string;
	/** 实际监听的端口 */
	port: number;
	/** 关闭服务器并断开所有连接 */
	close(): Promise<void>;
}

/**
 * 长在 `/api/sessions/` 下面但**不是会话 id** 的子路径。
 *
 * 会话那条匹配必须把它们排开——靠**匹配器**排开，不靠路由顺序。路由顺序是隐形的：把
 * `/api/sessions/order` 判成「id 为 order 的会话」只需要有人调整一下表里的位置，而症状是
 * 「拖拽排序突然 404」，跟顺序两个字看不出关系。新增集合级子路径时往这里加一个词。
 */
const RESERVED_SESSION_SLUGS = new Set(["order"]);

/**
 * 匹配 `/api/sessions/<id>` 与 `/api/sessions/<id>/<动作>`。
 *
 * 没有动作时，id 位上出现保留字说明它是集合级路由，返回 null 交给后面那张表。
 */
function matchSessionRoute(pathname: string): { id: string; action: string } | null {
	const match =
		/^\/api\/sessions\/([A-Za-z0-9-]+)(\/(?:events|prompt|retry|abort|model|rename|approval|approvals|plan-review|clear|rewind|jobs|jobs\/[A-Za-z0-9-]+\/(?:kill|log)|subagents|subagents\/[^/]+\/stop))?$/.exec(
			pathname,
		);
	if (match === null) {
		return null;
	}
	const id = match[1] ?? "";
	const action = match[2] ?? "";
	if (action === "" && RESERVED_SESSION_SLUGS.has(id)) {
		return null;
	}
	return { id, action };
}

/** 启动 Web 服务器 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const host = options.host ?? "127.0.0.1";
	// 密钥在每次生成前解析：网页上刚保存的立刻生效，不用重启服务。
	const resolveKey = options.resolveApiKey ?? ((): string => resolveCredential(options.apiKeyFlag).key);
	// 工作目录可以在网页上改，所以它不是常量：改一次就换一整套会话（会话按目录存放）。
	let cwd = options.cwd === "" ? startupCwd() : options.cwd;
	let registry = new RunRegistry({ ...options, resolveApiKey: resolveKey, cwd });
	// 新建会话使用的默认模型，可通过 API 修改。
	let defaultModel = options.modelId;
	const streams = new Set<ServerResponse>();
	/**
	 * 网页上那次「更新」的进度。
	 *
	 * 归**这台服务器**所有（不是模块级全局）：它是运行状态，同一个进程里起两台服务器时不该共享。
	 */
	const selfUpdate: { job: SelfUpdateJob | null } = { job: null };

	/*
	 * 那几条与工作目录无关的端点要用的上下文。
	 *
	 * 可变状态一律是**取值函数**而不是捕获的值：`cwd` 与 `registry` 都会被重新赋值（切工作目录），
	 * 捕获的话切完之后拿到的是旧对象——症状是列表数据陈旧，而调用点看上去完全正常。
	 * 这三份可变状态的耦合只在这一个地方表达，调用点不必各写一遍。
	 */
	const stateRoutes: StateRouteContext = {
		getCwd: () => cwd,
		getRegistry: () => registry,
		getModel: () => defaultModel,
		setModel: (model) => {
			defaultModel = model;
		},
		apiKeyFlag: options.apiKeyFlag,
	};

	/**
	 * 一次请求在各张路由表之间传递的东西。
	 *
	 * 打成一只而不是每次都传四个参数：路由表里的 handler 只看这一只，加一个字段（比如将来的
	 * 请求体）不必改每一处的签名。
	 */
	interface RouteContext {
		request: IncomingMessage;
		response: ServerResponse;
		url: URL;
		method: string;
	}

	/** 一条集合级路由：路径精确匹配，允许的方法在表里列清 */
	interface CollectionRoute {
		/** 精确路径；不做模式匹配，模式匹配的路由只有「单个会话」那一条（见 `matchSessionRoute`） */
		path: string;
		/** 允许的方法；不在这里的方法一律 405，而不是掉到最后的 404 */
		methods: readonly string[];
		/** 回完（或已经回过响应）返回 true */
		handle(context: RouteContext): Promise<boolean>;
	}

	/**
	 * 「选工作目录」这一步本身：还没选目录时也要能用，所以它们排在那道 409 关卡**之前**。
	 */
	const directoryRoutes: readonly CollectionRoute[] = [
		{
			path: "/api/dirs",
			methods: ["GET", "POST"],
			async handle(context) {
				if (context.method === "GET") {
					sendDirectoryList(context.response, context.url.searchParams.get("path") ?? "");
				} else {
					await createDirectory(context.request, context.response);
				}
				return true;
			},
		},
		{
			path: "/api/cwd",
			methods: ["POST"],
			async handle(context) {
				await switchCwd(context.request, context.response);
				return true;
			},
		},
	];

	/**
	 * 需要先选好工作目录的集合级路由。
	 *
	 * 表里的顺序只决定「同一路径的多个方法谁先被问」，**不再决定跨路由的优先级**：
	 * `/api/sessions/order` 与 `/api/sessions/<id>` 的冲突由 `matchSessionRoute` 解决——它不把保留字
	 * 当会话 id。从前那是一条「必须先判 order，否则 order 会被当成 id」的隐形依赖，只靠注释提醒，
	 * 而注释拦不住「有人调整了一下顺序」。
	 */
	const workspaceRoutes: readonly CollectionRoute[] = [
		{
			path: "/api/sessions",
			methods: ["GET", "POST"],
			async handle(context) {
				if (context.method === "GET") {
					sendJson(context.response, 200, { sessions: registry.summaries() });
					return true;
				}
				const run = registry.create();
				sendJson(context.response, 201, { id: run.session.header.id, file: run.session.file });
				return true;
			},
		},
		{
			// 集合级子路径必须同时登记到 `RESERVED_SESSION_SLUGS`，否则会被当成会话 id
			path: "/api/sessions/order",
			methods: ["POST"],
			async handle(context) {
				const body = await readJsonBody(context.request);
				const ids = Array.isArray(body.ids)
					? body.ids.filter((item): item is string => typeof item === "string")
					: [];
				if (ids.length === 0) {
					sendJson(context.response, 400, { error: "缺少 ids 字段" } satisfies ErrorResponse);
					return true;
				}
				sendJson(context.response, 200, registry.reorderByIds(ids) satisfies ReorderResponse);
				return true;
			},
		},
		{
			path: "/api/file",
			methods: ["GET"],
			async handle(context) {
				sendJson(context.response, 200, readFilePreview(context.url.searchParams.get("path") ?? "", cwd));
				return true;
			},
		},
	];

	/**
	 * 按表跑一遍。
	 *
	 * 命中路径但方法不对时回 **405**：从前那种情况会一直掉到最后回 404「未知路径」，看起来像这个端点
	 * 不存在，而其实是方法用错了。功能路由（`web/feature-*.ts`）早就这么做，这里补齐。
	 */
	async function runCollectionRoutes(routes: readonly CollectionRoute[], context: RouteContext): Promise<boolean> {
		for (const route of routes) {
			if (route.path !== context.url.pathname) {
				continue;
			}
			if (!route.methods.includes(context.method)) {
				sendJson(context.response, 405, {
					error: `不支持的方法 ${context.method} ${route.path}`,
				} satisfies ErrorResponse);
				return true;
			}
			return route.handle(context);
		}
		return false;
	}

	const server = createServer((request, response) => {
		handleRequest(request, response).catch((error: unknown) => {
			// handler 出错不能让进程退出：尽力回一个 400，响应头已发出则直接断开。
			const message = describeError(error);
			if (!response.headersSent) {
				sendJson(response, 400, { error: message } satisfies ErrorResponse);
			} else {
				response.destroy();
			}
		});
	});

	/** 主路由 */
	async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!isRequestAllowed(request, host)) {
			sendJson(response, 403, { error: "拒绝访问：Host 或 Origin 校验失败" } satisfies ErrorResponse);
			return;
		}

		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const pathname = url.pathname;
		const method = request.method ?? "GET";
		const context: RouteContext = { request, response, url, method };

		// --- 静态资源 ---
		if (method === "GET") {
			const asset = staticAssetName(pathname);
			if (asset !== null && sendStatic(response, asset)) {
				return;
			}
		}

		/*
		 * --- 与工作目录无关的状态与凭据 ---
		 *
		 * 放在「还没选目录」那道 409 关卡**之前**：这几条正是没选目录时也要能用的。
		 * 实现搬去了 `routes/state.ts`——它们是全文件里仅有的、不碰可变 `cwd` / `registry` 的部分，
		 * 所以能整组搬走而不必给每个 handler 传一堆闭包。
		 */
		if (await handleStateRoutes(stateRoutes, request, response, url, method)) {
			return;
		}

		// --- 选工作目录这一步本身（同样在那道 409 关卡之前）---
		if (await runCollectionRoutes(directoryRoutes, context)) {
			return;
		}

		/*
		 * 还没有选工作目录：除了「选目录」本身与几条与目录无关的端点，其余一律 409 说清楚。
		 * 不拦的话，`resolve("")` 会退成进程启动目录——会话、文件面板、终端会一起在
		 * 一个用户从没选过的目录上干活，那正是这次要避免的事。
		 */
		if (cwd === "" && !isCwdIndependent(pathname)) {
			sendJson(response, 409, {
				error: "还没有选择工作目录：点上面的「新建会话」，它会先让你选一个",
			} satisfies ErrorResponse);
			return;
		}

		// --- 集合级路由：会话、排序、文件预览（表见文件上方）---
		if (await runCollectionRoutes(workspaceRoutes, context)) {
			return;
		}

		// --- 单个会话 ---
		const session = matchSessionRoute(pathname);
		if (session !== null) {
			await handleSessionRoute(request, response, session.id, session.action, method);
			return;
		}

		// --- 功能路由：搜索 / 历史 / 模式 / 文件 / 终端 / 评审 ---
		if (
			await runFeatureRoutes(request, response, url, method, {
				getCwd: () => cwd,
				registry,
				getModel: () => defaultModel,
				// 评审会自己造代理跑真实模型调用，测试注入的假 fetch 与自定义接口地址都得从这条路传下去。
				getBaseUrl: () => registry.resolveBaseUrl(),
				fetchImpl: options.fetchImpl,
				// 自更新那条路同理：测试里注入「起安装进程」的替身，别真去 npm install
				spawnInstaller: options.spawnInstaller,
				selfRunner: options.selfRunner,
				selfSource: options.selfSource,
				// 这台服务器自己的更新进度（模块级全局会让两台服务器、两条测试互相看到对方的状态）
				selfUpdate,
			})
		) {
			return;
		}

		sendJson(response, 404, { error: `未知路径 ${pathname}` } satisfies ErrorResponse);
	}

	/**
	 * 还没选工作目录时也放行的路径。
	 *
	 * 它**从 `directoryRoutes` 推出来**，不再是一份手抄的清单：那份清单与路由表是两处，漏一处就变成
	 * 「这条端点在没选目录时意外回 409」，而症状（点「新建会话」失败）跟「清单」两个字看不出关系。
	 * 状态、构建号、默认模型、密钥不在这里，因为 `routes/state.ts` 在那道 409 关卡**之前**就返回了。
	 */
	function isCwdIndependent(pathname: string): boolean {
		return directoryRoutes.some((route) => route.path === pathname);
	}

	/** 列出某个目录下的子目录，供网页上的工作目录选择器使用 */
	function sendDirectoryList(response: ServerResponse, requested: string): void {
		// 还没选目录时从用户主目录开始浏览：选目录这件事必须先有个落脚点，
		// 而主目录是唯一既确定又不至于太深的起点。
		const base = requested.trim() === "" ? (cwd === "" ? homedir() : cwd) : resolve(requested.trim());
		try {
			const dirs = readdirSync(base, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => ({ name: entry.name, path: join(base, entry.name) }))
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, MAX_DIR_ENTRIES);

			const parent = dirname(base);
			sendJson(response, 200, {
				path: base,
				parent: parent === base ? null : parent,
				dirs,
			} satisfies DirListResponse);
		} catch (error) {
			sendJson(response, 400, {
				error: `无法读取 ${base}：${describeError(error)}`,
			} satisfies ErrorResponse);
		}
	}

	/**
	 * 切换工作目录。
	 *
	 * 会话是按工作目录分开存放的，所以换目录等于换一整套会话：注册表整体重建，前端拿到新的
	 * 列表后自己重绘。有会话正在生成时拒绝，避免把跑到一半的回答悬在那里。
	 *
	 * 请求里带了 `session` 就是另一件事：只给那一个会话换目录（Run 用的是会话头里的 cwd），全局
	 * cwd 与注册表一概不动——重建会把别的会话正在跑的一轮连同订阅一起掀翻，而这里要的只是
	 * 「这个会话以后在别的目录里干活」。
	 */
	async function switchCwd(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJsonBody(request);
		const requested = typeof body.path === "string" ? body.path.trim() : "";
		if (requested === "") {
			sendJson(response, 400, { error: "缺少 path 字段" } satisfies ErrorResponse);
			return;
		}

		const target = resolve(requested);
		const info = statSync(target, { throwIfNoEntry: false });
		if (!info) {
			sendJson(response, 400, { error: `目录不存在：${target}` } satisfies ErrorResponse);
			return;
		}
		if (!info.isDirectory()) {
			sendJson(response, 400, { error: `不是目录：${target}` } satisfies ErrorResponse);
			return;
		}

		const sessionId = typeof body.session === "string" ? body.session.trim() : "";
		if (sessionId !== "") {
			const result = registry.setSessionCwd(sessionId, target);
			if (!result.ok) {
				// 会话不存在按 404、正在生成按 409：界面据此决定是提示「换个会话」还是「先停止」。
				sendJson(response, result.reason === "running" ? 409 : 404, {
					error: result.error,
				} satisfies ErrorResponse);
				return;
			}
			/*
			 * 顺手把「当前工作目录」也挪过去，**但不重建注册表**：面板、终端、搜索、体检都按它跑，
			 * 使用者刚给这个会话选了哪个目录，界面上就该看到哪个目录。与全局切换的区别是这里
			 * 只改一个值——不换注册表对象，别的会话（含正在生成的一轮）一概不受影响。
			 */
			cwd = target;
			registry.setDefaultCwd(target);
			sendJson(response, 200, stateResponse(stateRoutes));
			return;
		}

		if (registry.summaries().some((summary) => summary.running)) {
			sendJson(response, 409, { error: "有会话正在生成，先停止再切换目录" } satisfies ErrorResponse);
			return;
		}

		cwd = target;
		registry = new RunRegistry({ ...options, resolveApiKey: resolveKey, cwd });
		// 切目录也回一次完整的 StateResponse：客户端用同一份解析逻辑，不必区分「首次」还是「切换」
		sendJson(response, 200, stateResponse(stateRoutes));
	}

	/**
	 * 在指定目录下新建一个文件夹。
	 *
	 * 只建一层，不用 recursive：父目录不存在时应当报错，而不是悄悄造出一条路径来。
	 * 名称校验挡的是路径分隔符与 Windows 保留字符，避免传 `..\\..` 之类的东西绕过目录浏览。
	 */
	async function createDirectory(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJsonBody(request);
		const requested = typeof body.parent === "string" ? body.parent.trim() : "";
		const parent = requested === "" ? cwd : resolve(requested);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!isValidFolderName(name)) {
			sendJson(response, 400, { error: `文件夹名称不合法：${name}` } satisfies ErrorResponse);
			return;
		}

		const target = join(parent, name);
		try {
			mkdirSync(target);
			sendJson(response, 201, { path: target } satisfies DirCreateResponse);
		} catch (error) {
			sendJson(response, 400, {
				error: `新建文件夹失败：${describeError(error)}`,
			} satisfies ErrorResponse);
		}
	}

	/** 会话级路由 */
	async function handleSessionRoute(
		request: IncomingMessage,
		response: ServerResponse,
		id: string,
		action: string,
		method: string,
	): Promise<void> {
		if (method === "DELETE" && action === "") {
			const result = registry.removeById(id);
			if (result === "removed") {
				sendJson(response, 200, { removed: true });
			} else {
				const status = result === "running" ? 409 : 404;
				sendJson(response, status, {
					error: result === "running" ? "会话正在生成中，无法删除" : "会话不存在",
				} satisfies ErrorResponse);
			}
			return;
		}

		/*
		 * 改名只在文件头那一行上动手，不需要（也不该）为它建一个 Run，所以排在下面那段之前。
		 * 正在生成的会话不许改名：重写头是「读整个文件 → 改第一行 → 写回」，与正在追加的消息撞上
		 * 会把那一轮的内容丢掉（切目录那条路同样先拦 running）。
		 */
		if (method === "POST" && action === "/rename") {
			if (registry.summaries().some((summary) => summary.id === id && summary.running)) {
				sendJson(response, 409, { error: "会话正在生成，先停止再改名" } satisfies ErrorResponse);
				return;
			}
			const target = registry.findSession(id);
			if (!target) {
				sendJson(response, 404, { error: "会话不存在" } satisfies ErrorResponse);
				return;
			}
			const body = await readJsonBody(request);
			target.setTitle(typeof body.title === "string" ? body.title : "");
			sendJson(response, 200, { id, title: target.header.title ?? "" } satisfies RenameResponse);
			return;
		}

		/*
		 * 列表是跨工作区的，所以这里点到一个别的工作区的会话是正常操作。
		 *
		 * **不要顺手把服务端的全局 cwd 切过去**：`openById` 会按 id 跨目录找到它，Run 的 cwd 取自
		 * 会话头（工具、AGENTS.md、相对路径全跟着它走）。切全局 cwd 会把整套运行注册表重建，
		 * 同一进程里别的会话——包括正在生成的那一轮——会被一起掀翻，而这里只是要看一个会话。
		 */
		const run = registry.openById(id);
		if (!run) {
			sendJson(response, 404, { error: "会话不存在" } satisfies ErrorResponse);
			return;
		}

		if (method === "GET" && action === "/events") {
			/*
			 * 「上次所在的会话」就在这里记：浏览器切到某个会话时必然会连它的事件流，不必再加一个端点。
			 * 只在与已记下的不同时才落盘（SSE 会重连，同一条反复写没意义）。
			 */
			if (readLastSessionId() !== run.session.header.id) {
				writeLastSessionId(run.session.header.id);
			}
			openEventStream(request, response, run);
			return;
		}

		/*
		 * 后台任务：列表与收尾各一个端点。
		 *
		 * **不走 SSE**：作业状态是「界面按需拉一下」就够的信息（一次构建几十秒，轮询开销可以忽略），
		 * 而 SSE 那条路每加一种事件都要动两份名单（服务端 `WEB_EVENT_TYPES` 与浏览器 `EVENT_TYPES`）
		 * 再加一条契约测试。这里用最少的活动件：GET 拉列表、POST 收一条。
		 */
		if (method === "GET" && action === "/jobs") {
			sendJson(response, 200, { jobs: run.jobs.list() });
			return;
		}

		if (method === "POST" && action.startsWith("/jobs/") && action.endsWith("/kill")) {
			const jobId = decodeURIComponent(action.slice("/jobs/".length, -"/kill".length));
			const killed = run.jobs.kill(jobId);
			sendJson(response, 200, { id: jobId, killed });
			return;
		}

		// 日志尾巴：界面那颗日志查看器点开时拉一次，不把整份输出塞进浮层
		if (method === "GET" && action.startsWith("/jobs/") && action.endsWith("/log")) {
			const jobId = decodeURIComponent(action.slice("/jobs/".length, -"/log".length));
			// 行数固定用内核的默认值：这是给人看的尾巴，多一个 query 参数就多一处要对齐的东西
			const tail = run.jobs.readTail(jobId);
			if (tail === null) {
				sendJson(response, 404, { error: "没有这条任务的输出（或它还没产出）" } satisfies ErrorResponse);
				return;
			}
			sendJson(response, 200, { id: jobId, ...tail });
			return;
		}

		/*
		 * 子代理：与 jobs 同一套——按会话取、轮询、不走 SSE。
		 * 结论就在列表里（每行带着 text），所以不再单开一个「读一条」的端点：少一个端点就少一条契约要同步。
		 */
		if (method === "GET" && action === "/subagents") {
			sendJson(response, 200, { subagents: run.subagents.list() });
			return;
		}

		// 收掉一条子代理（界面那颗「停止」与模型自己的 subagent_stop 走同一条路）
		if (method === "POST" && action.startsWith("/subagents/") && action.endsWith("/stop")) {
			const label = decodeURIComponent(action.slice("/subagents/".length, -"/stop".length));
			sendJson(response, 200, { label, stopped: run.subagents.stop(label) });
			return;
		}

		if (method === "POST" && action === "/prompt") {
			const body = await readJsonBody(request);
			const text = typeof body.text === "string" ? body.text : "";
			if (text.trim() === "") {
				sendJson(response, 400, { error: "缺少 text 字段" } satisfies ErrorResponse);
				return;
			}
			if (run.running) {
				sendJson(response, 409, { error: "该会话正在生成中" } satisfies ErrorResponse);
				return;
			}
			// 不 await：生成过程通过 SSE 推送，HTTP 请求立即返回，否则一个长回答会挂住请求。
			void run.prompt(text).catch((error: unknown) => {
				// 模型与工具的常规失败已经作为 error 事件播出去了；能走到这里说明是运行器
				// 自身的异常。既要记下来，也要让界面知道，否则「生成中」会一直挂着。
				const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
				process.stderr.write(`会话生成异常：${detail}\n`);
				run.reportError(`生成异常：${detail.split("\n")[0] ?? detail}`);
			});
			sendJson(response, 202, { accepted: true });
			return;
		}

		if (method === "POST" && action === "/retry") {
			if (run.running) {
				sendJson(response, 409, { error: "该会话正在生成中" } satisfies ErrorResponse);
				return;
			}
			// 与 /prompt 一样：不 await，结果通过 SSE 推送。
			void run.retry().catch((error: unknown) => {
				const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
				process.stderr.write(`会话重试异常：${detail}\n`);
				run.reportError(`重试异常：${detail.split("\n")[0] ?? detail}`);
			});
			sendJson(response, 202, { accepted: true });
			return;
		}

		if (method === "POST" && action === "/plan-review") {
			const body = await readJsonBody(request);
			// 批准要明确写 true；其余（包括字段缺失）一律当「退回」，并把反馈原样带回给模型。
			// 退回时反馈不能为空——空反馈等于让模型猜，core 那边也要求它是一句可读的意见。
			const approved = body.approved === true;
			const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
			if (!approved && feedback === "") {
				sendJson(response, 400, { error: "退回方案时要写一句反馈" } satisfies ErrorResponse);
				return;
			}
			const accepted = run.resolvePlanReview(approved ? { approved: true } : { approved: false, feedback });
			if (!accepted) {
				sendJson(response, 409, { error: "当前没有等待评审的方案" } satisfies ErrorResponse);
				return;
			}
			sendJson(response, 200, { approved });
			return;
		}

		if (method === "GET" && action === "/approvals") {
			// 命令行有 /approvals，网页也得有：点了「总是允许」之后看不见也撤不掉的白名单，
			// 等于把一次判断变成永久的默认值。
			const rules = run.approvals().map((rule) => ({
				tool: rule.tool,
				prefix: rule.prefix,
				text: describeApprovalPrefix(rule.tool, rule.prefix),
			}));
			sendJson(response, 200, { rules });
			return;
		}

		if (method === "POST" && action === "/approvals") {
			// 清空用 POST 而不是 DELETE：动作是「忘掉全部」，不是删掉某一条。
			sendJson(response, 200, { cleared: run.clearApprovals() });
			return;
		}

		if (method === "POST" && action === "/clear") {
			try {
				run.clear();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 409, { error: message } satisfies ErrorResponse);
				return;
			}
			sendJson(response, 200, { cleared: true });
			return;
		}

		if (method === "POST" && action === "/rewind") {
			// 回滚是破坏性操作，但目的正是「撤销」，所以不再要求二次确认。
			const result = run.rewind();
			if (!result) {
				sendJson(response, 409, { error: "没有可回滚的轮次" } satisfies ErrorResponse);
				return;
			}
			sendJson(response, 200, {
				seq: result.seq,
				restored: result.restored.length,
				removed: result.removed.length,
				skipped: result.skipped,
			});
			return;
		}

		if (method === "POST" && action === "/approval") {
			const body = await readJsonBody(request);
			// 只认明确写 true 的答复，其余（包括字段缺失）都当拒绝。`remember` 表示「本会话总是允许」，
			// 只在确实允许时才有意义；记什么由内核决定，这里只是把用户的意图传下去。
			const approved = body.approved === true;
			const remember = approved && body.remember === true;
			const accepted = run.resolveApproval(approved, remember);
			if (!accepted) {
				sendJson(response, 409, { error: "当前没有等待确认的工具调用" } satisfies ErrorResponse);
				return;
			}
			sendJson(response, 200, { approved, remember });
			return;
		}

		if (method === "POST" && action === "/abort") {
			run.abortRun();
			sendJson(response, 200, { aborted: true });
			return;
		}

		if (method === "POST" && action === "/model") {
			const body = await readJsonBody(request);
			const model = typeof body.model === "string" ? body.model.trim() : "";
			if (model === "") {
				sendJson(response, 400, { error: "缺少 model 字段" } satisfies ErrorResponse);
				return;
			}
			run.setModel(model);
			sendJson(response, 200, { model });
			return;
		}

		sendJson(response, 405, { error: `不支持的方法 ${method} ${action}` } satisfies ErrorResponse);
	}

	/** 打开 SSE 连接：先发快照，再转发后续事件 */
	function openEventStream(request: IncomingMessage, response: ServerResponse, run: Run): void {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
			// 关掉 nginx 之类的缓冲，否则增量会被攒着一起发。
			"x-accel-buffering": "no",
		});
		// 先写一个注释行，让浏览器立刻认为连接已建立。
		response.write(": connected\n\n");

		const send = (event: WebEvent): void => {
			response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		};
		for (const event of run.snapshot()) {
			send(event);
		}

		const unsubscribe = run.subscribe(send);
		const heartbeat = setInterval(() => {
			response.write(": ping\n\n");
		}, HEARTBEAT_MS);
		streams.add(response);

		const cleanup = (): void => {
			clearInterval(heartbeat);
			unsubscribe();
			streams.delete(response);
		};
		request.on("close", cleanup);
		response.on("close", cleanup);
		response.on("error", cleanup);
	}

	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(options.port ?? DEFAULT_WEB_PORT, host, () => {
			server.off("error", rejectPromise);
			resolvePromise();
		});
	});

	const address = server.address() as AddressInfo | null;
	const port = address?.port ?? options.port ?? DEFAULT_WEB_PORT;
	// IPv6 地址在 URL 里必须加方括号。
	const urlHost = host.includes(":") ? `[${host}]` : host;

	return {
		url: `http://${urlHost}:${port}`,
		port,
		async close(): Promise<void> {
			// 先等正在跑的一轮收尾再关：只 abort 不等，工具起的子进程可能还占着工作目录，
			// 调用方紧接着删目录就会撞上 EBUSY（测试里正是这么用的）。
			await registry.abortAllAndWait();
			for (const stream of streams) {
				stream.end();
			}
			streams.clear();
			await new Promise<void>((resolvePromise) => {
				server.close(() => resolvePromise());
				// 保持连接（含 SSE）会阻止 close 回调，主动断开它们。
				server.closeAllConnections();
			});
			/*
			 * 服务器自己不再占着工作目录了，但被这次关闭打断的那些请求还在收尾：它们手里可能有一个
			 * 刚被 kill 的 git 或工具子进程，进程退出到句柄真正释放之间有一小段窗口。这一刻就把
			 * 目录删掉会撞上 EBUSY（Windows 上尤其明显）。等一拍再返回，代价是几毫秒。
			 */
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
		},
	};
}
