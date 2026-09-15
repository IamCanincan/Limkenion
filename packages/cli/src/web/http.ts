/**
 * Web 服务器的 HTTP 底座。
 *
 * 这里放的是与路由无关的东西：每个函数只看自己的入参，不碰 `WebServerOptions`、注册表或
 * 工作目录这些运行时状态。分开的理由有两个——server.ts 只剩下路由与闭包状态，读起来能一眼
 * 看清有哪些端点；这些校验与收发逻辑也能脱离服务器实例单独测试。
 *
 * 它对外的姿态与 server.ts 保持一致：默认只认回环 Host，不带 TLS、不带认证。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { looksBinary, parseJsonObject } from "limkenion-core";
import type { FileResponse } from "./protocol.ts";

/** 静态资源目录：无论是 src 还是 dist，`public/` 都在 server 文件旁边 */
const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");

/** 请求体上限，防止一个坏客户端把内存写满 */
const MAX_BODY_BYTES = 1_000_000;

/** 文件预览返回的最大字节数 */
const MAX_PREVIEW_BYTES = 200 * 1024;

/**
 * 前端资源的文件名白名单。
 *
 * 前端拆成了多个 ES module，逐个枚举太容易漏；这里改用正则，仍然只允许 `public/` 下的
 * 扁平文件名——不含 `/` 与 `\`，所以请求路径无法穿越到该目录之外。
 */
const STATIC_FILE_RE = /^\/[A-Za-z0-9._-]+\.(?:css|js|html|woff2)$/;

/** 静态资源的 content-type */
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".woff2": "font/woff2",
};

/** 校验 Host 与 Origin，挡住 DNS rebinding 与跨站请求 */
export function isRequestAllowed(request: IncomingMessage, boundHost: string): boolean {
	const hostHeader = request.headers.host;
	if (!hostHeader) {
		return false;
	}
	const requestHost = hostnameOf(hostHeader);
	const loopbackBound = isLoopbackHost(boundHost);

	// 只绑回环时，Host 头也必须是回环名字。攻击者用自己的域名解析到 127.0.0.1 时，
	// 浏览器发来的 Host 是攻击者的域名，会在这里被拒。
	if (loopbackBound && !isLoopbackHost(requestHost)) {
		return false;
	}

	// 非简单请求（POST/DELETE）带 Origin 时，必须与服务端自己的 Host 一致，挡住 CSRF。
	// curl 之类没有 Origin 的客户端不受影响。
	const origin = request.headers.origin;
	if (origin !== undefined) {
		let originHost: string;
		try {
			const parsed = new URL(origin);
			originHost = parsed.host;
		} catch {
			return false;
		}
		if (originHost !== hostHeader) {
			return false;
		}
	}
	return true;
}

/**
 * 把请求路径映射成 `public/` 下的文件名。
 *
 * 只有 `/` 与白名单命中的路径有对应文件，其余返回 null 交给后续路由（最终 404）。
 */
export function staticAssetName(pathname: string): string | null {
	if (pathname === "/") {
		return "index.html";
	}
	return STATIC_FILE_RE.test(pathname) ? pathname.slice(1) : null;
}

/**
 * 文件夹名是否可用。
 *
 * 挡的是路径分隔符、Windows 保留字符、控制字符，以及 `.` / `..` 这类会跳到别处的名字。
 * 末尾的空格与点在 Windows 上会被静默丢掉，与其创建出另一个名字，不如直接拒绝。
 */
export function isValidFolderName(name: string): boolean {
	if (name === "" || name === "." || name === "..") {
		return false;
	}
	if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
		return false;
	}
	return !/[ .]$/.test(name);
}

/** 从 Host 头里取出主机名，去掉端口与 IPv6 方括号 */
function hostnameOf(hostHeader: string): string {
	if (hostHeader.startsWith("[")) {
		const end = hostHeader.indexOf("]");
		return end === -1 ? hostHeader : hostHeader.slice(1, end);
	}
	const colon = hostHeader.lastIndexOf(":");
	return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

/** 是否是回环地址名 */
function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "0:0:0:0:0:0:0:1";
}

/** 读取请求体并解析成对象，空体当空对象 */
export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk as Uint8Array);
		size += buffer.byteLength;
		if (size > MAX_BODY_BYTES) {
			throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`);
		}
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf-8").trim();
	if (text === "") {
		return {};
	}
	// 与别处不同：请求体坏了必须报错，不能悄悄当成空对象。
	const parsed = parseJsonObject(text);
	if (parsed === null) {
		throw new Error("请求体必须是 JSON 对象");
	}
	return parsed;
}

/**
 * 返回静态资源。
 *
 * 文件不存在时返回 false 而不是报错：路径没命中就说明请求的不是资源，让调用方继续
 * 走后面的路由，最终正常回 404。
 */
export function sendStatic(response: ServerResponse, name: string): boolean {
	let content: Buffer;
	try {
		content = readFileSync(join(ASSET_DIR, name));
	} catch {
		return false;
	}
	response.writeHead(200, {
		"content-type": CONTENT_TYPES[extname(name)] ?? "application/octet-stream",
		"content-length": content.byteLength,
		// 本地工具，资源很小；禁用缓存可以让改动刷新页面即可生效。
		"cache-control": "no-store",
	});
	response.end(content);
	return true;
}

/**
 * 读取文件用于右侧预览。
 *
 * 相对路径以工作目录为基准；不做越权限制，因为这个 agent 本来就能访问整台机器，
 * 但只读且限长。
 */
export function readFilePreview(requestPath: string, cwd: string): FileResponse {
	if (requestPath.trim() === "") {
		return { path: "", content: "", truncated: false, binary: false };
	}
	const absolute = isAbsolute(requestPath) ? requestPath : resolve(cwd, requestPath);
	// throwIfNoEntry: false 让不存在的路径返回 undefined，比 try/catch 更直接。
	const info = statSync(absolute, { throwIfNoEntry: false });
	if (!info) {
		return { path: requestPath, content: "", truncated: false, binary: false };
	}
	if (info.isDirectory()) {
		return { path: requestPath, content: `[目录] ${absolute}`, truncated: false, binary: false };
	}
	const buffer = readFileSync(absolute);
	// 整个文件一起判：binary 这个标志是在承诺「这个文件不是文本」，只扫预览窗口就会把后半段
	// 带 NUL 的文件说成文本。与 read / grep 的判据一致，都由 looksBinary 负责。
	if (looksBinary(buffer)) {
		return { path: requestPath, content: "", truncated: false, binary: true };
	}
	const truncated = buffer.byteLength > MAX_PREVIEW_BYTES;
	return {
		path: requestPath,
		content: buffer.subarray(0, MAX_PREVIEW_BYTES).toString("utf-8"),
		truncated,
		binary: false,
	};
}

/** 返回 JSON */
/**
 * 静态资源的"版本号"：资源目录里最新的 mtime。
 *
 * 用途：页面加载时拿到一个值，之后每几秒问一次；变了就说明服务端换了新构建
 * （本地工具没有指纹文件名，浏览器又长期开着标签页——只靠 SSE 更新内容的话，
 * JS 还是打开那一刻的旧版本，使用者会"看到旧界面"却以为改动没生效，真踩过）。
 */
export function assetsBuildId(): string {
	let newest = 0;
	let entries: string[] = [];
	try {
		entries = readdirSync(ASSET_DIR);
	} catch {
		return "0";
	}
	for (const entry of entries) {
		try {
			const stat = statSync(join(ASSET_DIR, entry));
			if (stat.mtimeMs > newest) {
				newest = stat.mtimeMs;
			}
		} catch {}
	}
	return String(Math.round(newest));
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = Buffer.from(JSON.stringify(body), "utf-8");
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": payload.byteLength,
		"cache-control": "no-store",
	});
	response.end(payload);
}
