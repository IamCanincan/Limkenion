/*
 * 文件树与内嵌查看/编辑：GET /api/files?path=、GET /api/file-content?path=、POST /api/file-content
 *
 * 和别的功能路由不同，这三个端点直接读写用户的工作目录，所以「路径夹紧」是硬边界而不是体验
 * 优化：每次读写都要先证明目标确实落在当前工作目录内，越界一律 400。
 *
 * 夹紧不再由本模块自己实现：统一走 core 的 `clampPathToWorkspace`（realpath + 相对路径判定），
 * 与工具审批用的是同一份实现。为什么不能只做字符串前缀比较（符号链接、Windows 大小写、
 * `C:\a` 与 `C:\ab` 的假命中），理由写在 packages/core/src/paths.ts 里，这里不重复第二份。
 *
 * 三个响应的形状定义在本模块而不是 protocol.ts：协议的共享文件由多个功能并行改动，本功能自带
 * 的字段先留在自己这里，接口稳定后再谈合并。
 */

import { type Dirent, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { describeError } from "limkenion-ai";
import { clampPathToWorkspace, looksBinary, sliceByBytes } from "limkenion-core";
import type { FeatureRoute } from "./features.ts";
import { readJsonBody, sendJson } from "./http.ts";
import type { ErrorResponse } from "./protocol.ts";

/**
 * 列目录时跳过的名字。
 *
 * `.git` 是版本库内部结构、`node_modules` 动辄几万项、`dist`/`release` 是构建产物：它们对「找源
 * 码改一改」没有用，列出来只会把真正的源码挤到屏幕外。比较时统一转小写，因为 Windows 与 macOS
 * 的文件系统大小写不敏感，`Node_Modules` 和 `node_modules` 在那边是同一个目录。
 */
const SKIPPED_NAMES = new Set([".git", "node_modules", "dist", "release"]);

/** 单个目录最多返回多少项：请求数量上限，免得巨型目录把响应和界面一起撑爆 */
const MAX_ENTRIES = 500;

/**
 * 单次读取返回的最大字节数（200KB）。
 *
 * 这里不用 `MAX_OUTPUT_BYTES`：那个 50KB 是「工具输出给模型看」的预算，而这里是给人改代码用的，
 * 改到一半被截断的文件不能保存（保存会用半截内容覆盖整份文件），所以窗口要明显更大。
 */
const MAX_CONTENT_BYTES = 200 * 1024;

/** 文件树里的一项 */
export interface FileTreeEntry {
	/** 文件或目录名，不含路径 */
	name: string;
	/** 是否为目录（跟随符号链接：指向目录的链接算目录） */
	dir: boolean;
	/** 字节数；目录固定为 0 */
	size: number;
}

/** `GET /api/files` 的响应 */
export interface FilesResponse {
	/** 被列出的目录，绝对路径（已解析符号链接） */
	path: string;
	/** 一层内容：目录在前、文件在后，各自按名称排序；到上限时截断 */
	entries: FileTreeEntry[];
	/**
	 * 这一层里被跳过的项数（`.git`、`node_modules`、`dist`、`release`）。
	 *
	 * 界面上要说明「已隐藏 N 项」，这个数只能在服务端数——被跳过的名字根本没进 entries，
	 * 客户端无从得知它们存在，静默丢掉会让人以为目录里就这么多东西。
	 */
	hidden: number;
}

/** `GET /api/file-content` 的响应 */
export interface FileContentResponse {
	/** 实际读到的文件，绝对路径（相对路径由服务端解析，所以基准由服务端给出） */
	path: string;
	/** 文本内容；二进制文件为空串 */
	content: string;
	/** 是否因超过 200KB 被截断 */
	truncated: boolean;
	/** 是否为二进制文件（此时 content 为空） */
	binary: boolean;
	/**
	 * 读取时的修改时间，单位毫秒。
	 *
	 * 它是保存时的乐观并发基准：调用方把读到的值原样回传，服务端就能发现「打开之后文件被外部
	 * 改过」。网页上没有别的地方能撤销一次覆盖，所以这个字段不是装饰。
	 */
	mtimeMs: number;
}

/** `POST /api/file-content` 的响应 */
export interface FileWriteResponse {
	/** 实际写入的文件，绝对路径 */
	path: string;
	/** 写入的字节数（UTF-8 计） */
	bytes: number;
	/** 写入后的修改时间，供调用方作为下一次保存的基准；读不到时为 null */
	mtimeMs: number | null;
}

/** 三个文件接口的路由；返回 false 表示这些端点不归本模块管 */
export const route: FeatureRoute = async (request, response, url, method, context) => {
	if (url.pathname === "/api/files" && method === "GET") {
		listDirectory(response, url.searchParams.get("path") ?? "", context.getCwd());
		return true;
	}
	if (url.pathname === "/api/file-content") {
		if (method === "GET") {
			readFileContent(response, url.searchParams.get("path") ?? "", context.getCwd());
			return true;
		}
		if (method === "POST") {
			await writeFileContent(request, response, context.getCwd());
			return true;
		}
	}
	return false;
};

/** 列出目录的一层内容 */
function listDirectory(response: ServerResponse, requested: string, cwd: string): void {
	const target = clampPathToWorkspace(requested, cwd);
	if (!target.ok) {
		sendJson(response, 400, { error: target.error } satisfies ErrorResponse);
		return;
	}

	let dirents: Dirent[];
	try {
		dirents = readdirSync(target.path, { withFileTypes: true });
	} catch (error) {
		sendJson(response, 400, {
			error: `无法读取目录 ${target.path}：${describeError(error)}`,
		} satisfies ErrorResponse);
		return;
	}

	const entries: FileTreeEntry[] = [];
	let hidden = 0;
	for (const dirent of dirents) {
		if (SKIPPED_NAMES.has(dirent.name.toLowerCase())) {
			hidden += 1;
			continue;
		}
		const full = join(target.path, dirent.name);
		// stat 而不是只看 dirent：既是为了拿文件大小（列表要显示），也是为了跟随符号链接——
		// dirent.isDirectory() 对链接恒为 false，不 stat 的话「指向目录的链接」会被当成文件，
		// 点开只会拿到一句「这是目录」。断链拿到 undefined，当成 0 字节的文件即可。
		const info = statSync(full, { throwIfNoEntry: false });
		const dir = info?.isDirectory() ?? false;
		entries.push({ name: dirent.name, dir, size: dir ? 0 : (info?.size ?? 0) });
	}

	// 目录在前、文件在后，组内按名称排序；先排序再截断，这样每次刷新看到的是同一批。
	entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
	sendJson(response, 200, {
		path: target.path,
		entries: entries.slice(0, MAX_ENTRIES),
		hidden,
	} satisfies FilesResponse);
}

/** 读一个文本文件，超长截断、二进制只报类型 */
function readFileContent(response: ServerResponse, requested: string, cwd: string): void {
	const target = clampPathToWorkspace(requested, cwd);
	if (!target.ok) {
		sendJson(response, 400, { error: target.error } satisfies ErrorResponse);
		return;
	}

	const info = statSync(target.path, { throwIfNoEntry: false });
	if (!info) {
		sendJson(response, 404, { error: `文件不存在：${target.path}` } satisfies ErrorResponse);
		return;
	}
	if (info.isDirectory()) {
		sendJson(response, 400, { error: `这是目录，不是文件：${target.path}` } satisfies ErrorResponse);
		return;
	}

	let buffer: Buffer;
	try {
		buffer = readFileSync(target.path);
	} catch (error) {
		sendJson(response, 400, { error: `读取失败：${describeError(error)}` } satisfies ErrorResponse);
		return;
	}

	// 二进制判定必须看整个文件（理由见 core/text.ts）：只看开头会把「后半段带 NUL」的文件说成
	// 文本，编辑器一保存就把 NUL 抹掉——那是丢数据，比拒绝打开糟糕得多。
	if (looksBinary(buffer)) {
		sendJson(response, 200, {
			path: target.path,
			content: "",
			truncated: false,
			binary: true,
			mtimeMs: info.mtimeMs,
		} satisfies FileContentResponse);
		return;
	}

	const truncated = buffer.byteLength > MAX_CONTENT_BYTES;
	// 截断时只解码前 200KB：一个几百 MB 的文本文件不该让服务端先造出等长的字符串。解码后再过一遍
	// sliceByBytes 收边界，避免按字节切出半个多字节字符（解码时它已经变成替换字符了）。
	const window = truncated ? buffer.subarray(0, MAX_CONTENT_BYTES) : buffer;
	sendJson(response, 200, {
		path: target.path,
		content: sliceByBytes(window.toString("utf-8"), MAX_CONTENT_BYTES),
		truncated,
		binary: false,
		mtimeMs: info.mtimeMs,
	} satisfies FileContentResponse);
}

/** 写入文件；覆盖是不可逆的，所以先夹紧路径，越界一律拒绝 */
async function writeFileContent(request: IncomingMessage, response: ServerResponse, cwd: string): Promise<void> {
	const body = await readJsonBody(request);
	const requested = typeof body.path === "string" ? body.path.trim() : "";
	if (requested === "") {
		sendJson(response, 400, { error: "缺少 path 字段" } satisfies ErrorResponse);
		return;
	}
	const content = body.content;
	if (typeof content !== "string") {
		sendJson(response, 400, { error: "缺少 content 字段，或者它不是字符串" } satisfies ErrorResponse);
		return;
	}

	// 顺序很重要：先夹紧再落盘。夹紧给出的就是最终要写的真实路径，中途不再重新解析，
	// 免得给「检查完到写入之间把目录换成链接」留一道缝。
	const target = clampPathToWorkspace(requested, cwd);
	if (!target.ok) {
		sendJson(response, 400, { error: target.error } satisfies ErrorResponse);
		return;
	}
	const info = statSync(target.path, { throwIfNoEntry: false });
	if (info?.isDirectory()) {
		sendJson(response, 400, { error: `这是目录，不能写入：${target.path}` } satisfies ErrorResponse);
		return;
	}

	// 乐观并发：调用方把打开时的 mtime 带回来，这里比对当下的值。不一致就说明文件在打开之后被
	// 别的进程改过（编辑器、git、另一个标签页都算），直接写下去等于无声地抹掉那些改动——按 409
	// 退回去，让调用方决定覆盖还是丢弃。不传这个字段就照旧写，命令行调用不受影响。
	const expected = body.expectedMtimeMs;
	if (typeof expected === "number") {
		if (!info) {
			sendJson(response, 409, {
				error: `文件在打开后已被外部删除：${target.path}`,
			} satisfies ErrorResponse);
			return;
		}
		if (info.mtimeMs !== expected) {
			sendJson(response, 409, {
				error: `文件在打开后已被外部修改：${target.path}`,
			} satisfies ErrorResponse);
			return;
		}
	}

	try {
		writeFileSync(target.path, content, "utf-8");
	} catch (error) {
		sendJson(response, 400, { error: `写入失败：${describeError(error)}` } satisfies ErrorResponse);
		return;
	}
	// 写后重新 stat：把新的 mtime 回给调用方，下一次保存才有基准可用。
	const written = statSync(target.path, { throwIfNoEntry: false });
	sendJson(response, 200, {
		path: target.path,
		bytes: Buffer.byteLength(content, "utf-8"),
		mtimeMs: written?.mtimeMs ?? null,
	} satisfies FileWriteResponse);
}

/**
 * 夹紧统一由 core 的 `clampPathToWorkspace` 提供（realpath 语义、以及「为什么不能只做字符串
 * 前缀比较」的理由都写在 packages/core/src/paths.ts）。本模块不再保留第二份实现：两份实现迟早
 * 会漂移，而这是安全边界，漂移的代价是越界写。
 */
