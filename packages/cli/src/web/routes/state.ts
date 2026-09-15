/**
 * 与「当前工作目录」无关的那几条端点：全局状态、构建号、默认模型、接口密钥。
 *
 * 从 `server.ts` 拆出来的依据不是行数，而是**依赖**：这几条是全文件里仅有的、不碰可变 `cwd` /
 * `registry` 的部分——凭据与模型列表只依赖导入与启动参数，所以它们能整组搬走而不必给每个 handler
 * 传一堆闭包。剩下那些与目录、会话有关的仍旧留在 `server.ts`（它们要读写的正是那两个可变量）。
 *
 * 搬走还有一个附带好处：`/api/credentials` 的三条分支（查、存、清）与它们的两个辅助函数
 * 现在挨在一起，而不再与四十条别的路由挤在同一个函数体里。
 *
 * 约定与功能路由一致：返回 `true` 表示这个请求我已经回完了，返回 `false` 就交给下一个。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { listModelIds, resolveModel } from "limkenion-ai";
import {
	clearApiKey,
	keyStorageDescription,
	maskKey,
	readStoredApiKey,
	resolveApiKey as resolveCredential,
	storeApiKey,
} from "../../credentials.ts";
import { assetsBuildId, readJsonBody, sendJson } from "../http.ts";
import { readLastSessionId } from "../last-session.ts";
import type { CredentialsResponse, ErrorResponse, ModelOption, StateResponse } from "../protocol.ts";
import type { RunRegistry } from "../registry.ts";

/** 这几条端点要用到的东西；可变的那三份一律做成取值函数 */
export interface StateRouteContext {
	/** 工作目录可以在网页上改，所以取的是函数；`/api/state` 用它决定要不要列会话 */
	getCwd(): string;
	/**
	 * 会话注册表。
	 *
	 * 取的是函数而不是对象：切工作目录时整个注册表会被**重新赋值**（`server.ts` 的 switchCwd），
	 * 捕获旧对象的话，切完之后这里拿到的还是那个已经被换掉的注册表——症状是列表数据陈旧，
	 * 而调用点看上去完全正常。
	 */
	getRegistry(): RunRegistry;
	/** 新建会话的默认模型，网页上能改 */
	getModel(): string;
	setModel(model: string): void;
	/** 命令行 `--api-key` 的值：凭据状态要如实说「生效的是哪一把」 */
	apiKeyFlag: string | undefined;
}

/**
 * 组装一份 `StateResponse`。
 *
 * 有三处要回这个形状：`GET /api/state`，以及切工作目录成功/换全局目录成功的两个响应（客户端用同一份
 * 解析逻辑，不必区分「首次」还是「切换」）。抄三遍的下场是加一个字段时漏掉其中一处，而界面上只表现
 * 为「切过目录之后这个字段没了」。
 */
export function stateResponse(context: StateRouteContext): StateResponse {
	const cwd = context.getCwd();
	return {
		cwd,
		model: context.getModel(),
		models: modelOptions(),
		// 还没选目录时没有「当前工作目录的会话」这回事，如实回空表
		sessions: cwd === "" ? [] : context.getRegistry().summaries(),
		lastSessionId: readLastSessionId(),
		// 页面把它记下来，之后与 /api/build 比对：不一致就说明服务端换了构建
		build: assetsBuildId(),
	};
}

/**
 * 处理这几条端点；不是它们管的就返回 false。
 *
 * 调用方要在「还没选工作目录」那道 409 关卡**之前**调它——这几条正是没选目录时也要能用的。
 */
export async function handleStateRoutes(
	context: StateRouteContext,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	method: string,
): Promise<boolean> {
	const pathname = url.pathname;

	if (method === "GET" && pathname === "/api/state") {
		sendJson(response, 200, stateResponse(context));
		return true;
	}

	// 静态资源的版本号：客户端每隔几秒问一次，变了就自动刷新（见 app.js）
	if (method === "GET" && pathname === "/api/build") {
		sendJson(response, 200, { build: assetsBuildId() });
		return true;
	}

	if (method === "POST" && pathname === "/api/model") {
		const body = await readJsonBody(request);
		const model = typeof body.model === "string" ? body.model.trim() : "";
		if (model === "") {
			sendJson(response, 400, { error: "缺少 model 字段" } satisfies ErrorResponse);
			return true;
		}
		context.setModel(model);
		sendJson(response, 200, { model });
		return true;
	}

	if (pathname === "/api/credentials") {
		if (method === "GET") {
			sendJson(response, 200, credentialsState(context.apiKeyFlag));
			return true;
		}
		if (method === "POST") {
			await saveCredential(request, response, context.apiKeyFlag);
			return true;
		}
		if (method === "DELETE") {
			clearApiKey();
			sendJson(response, 200, credentialsState(context.apiKeyFlag));
			return true;
		}
	}

	return false;
}

/** 可选模型：带上名称与上下文上限，界面据此显示占用比例与中文名 */
function modelOptions(): ModelOption[] {
	return listModelIds().map((id) => {
		const model = resolveModel(id);
		return { id, name: model.name, contextWindow: model.contextWindow };
	});
}

/**
 * 当前的密钥状态。
 *
 * 只回打码后的预览，明文密钥永远不出服务端——它不是给页面显示用的，页面只需要知道
 * 「配了没有、用的是哪一把、来自哪里」。
 */
function credentialsState(apiKeyFlag: string | undefined): CredentialsResponse {
	const resolved = resolveCredential(apiKeyFlag);
	return {
		configured: resolved.key !== "",
		masked: maskKey(resolved.key),
		source: resolved.source,
		stored: readStoredApiKey() !== "",
		storage: keyStorageDescription(),
	};
}

/** 保存网页里填的密钥 */
async function saveCredential(
	request: IncomingMessage,
	response: ServerResponse,
	apiKeyFlag: string | undefined,
): Promise<void> {
	const body = await readJsonBody(request);
	const key = typeof body.key === "string" ? body.key.trim() : "";
	if (key === "") {
		sendJson(response, 400, { error: "密钥不能为空" } satisfies ErrorResponse);
		return;
	}
	if (key.length > 512 || /\s/.test(key)) {
		sendJson(response, 400, { error: "密钥格式不对：不该有空白字符，也不该这么长" } satisfies ErrorResponse);
		return;
	}
	storeApiKey(key);
	sendJson(response, 200, credentialsState(apiKeyFlag));
}
