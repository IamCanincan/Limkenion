/**
 * `limkenion sessions`：会话管理（列表 / 重命名 / 删除 / 回收目录）。
 *
 * 网页的侧栏一直能看列表、改名、删除，终端这边只有 `-c` 续写与 `search` 找内容——想清理旧会话、
 * 或者给一个会话起个名字便于 `search` 认出来，都无从下手。这一条把同一件事补上。
 *
 * 四条刻意的取舍：
 * - **默认只看当前目录**：`-c` / `rewind` 都是「当前工作目录下最近那个会话」，管理也照这个口径；
 *   跨工作目录看用 `--all`（与网页侧栏一样分组显示）。
 * - **删除走 `Session.remove()`**：它把文件挪到 `<会话目录>/.trash/`，不是硬删——会话是这个工具里
 *   唯一不可再生的东西，而命令行一个 `rm` 只差一次误敲。想找回来用 `sessions trash` 看。
 * - **回收目录不自动清理**（与 `Session.remove()` 的注释同一条理由：自动过期就是静默删除），
 *   只给一个显式的 `sessions trash --empty`。
 * - **目标用 id 前缀**：列表里给的是 uuid 前 8 位，敲着短、也不会有「第几个」那种随列表变化的歧义；
 *   `latest` 是「当前目录下最近那个」的快捷写法。
 */

import { type Dirent, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, getSessionDir, getSessionsDir } from "../config.ts";
import { listAllSessionFiles, Session } from "../session.ts";
import type { Command } from "./command.ts";
import { wantsHelp } from "./common.ts";

/** sessions 子命令：元信息住在命令自己这里 */
export const sessionsCommand: Command = {
	name: "sessions",
	synopsis: "sessions [list|rename|rm|trash]",
	summary: "看/改/删历史会话（列表、重命名、删除、回收目录）",
	run: async (argv) => runSessionsCommand(argv),
};

/** 用法说明 */
function sessionsUsage(): string {
	return [
		`${APP_NAME} sessions - 管理历史会话`,
		"",
		"用法：",
		`  ${APP_NAME} sessions                         列出当前目录下的会话`,
		`  ${APP_NAME} sessions --all                   列出所有工作目录下的会话`,
		`  ${APP_NAME} sessions rename <id> <名字>      给会话起名（名字给空串则取消命名）`,
		`  ${APP_NAME} sessions rm <id>                 删除会话（移到回收目录，不是硬删）`,
		`  ${APP_NAME} sessions trash                   看回收目录里有什么`,
		`  ${APP_NAME} sessions trash --empty           清空回收目录（**真删**，不可恢复）`,
		"",
		"`<id>` 是列表里那一列前 8 位；也可以写 `latest`（当前目录下最近那个）。",
		"删除只是把文件挪到 <会话目录>/.trash/ 下；想找回来用 `sessions trash` 看有哪些，",
		"确认不要了再 `sessions trash --empty`（回收目录不会自动过期，免得又变成静默删除）。",
		"",
		"退出码：0 正常；1 找不到那个会话；2 参数不对。",
	].join("\n");
}

/** 一行列表要的信息 */
interface Row {
	/** uuid 前 8 位；认不出 uuid 时用文件名 */
	short: string;
	file: string;
	cwd: string;
	title: string;
	preview: string;
	messageCount: number;
	updatedAt: number;
}

/** 相对时间：刚改过的说「刚刚」，最近的用分钟/小时，久一点给日期 */
function formatAgo(ms: number, now: number = Date.now()): string {
	if (ms <= 0) {
		return "时间未知";
	}
	const minutes = Math.floor((now - ms) / 60_000);
	if (minutes < 1) {
		return "刚刚";
	}
	if (minutes < 60) {
		return `${minutes} 分钟前`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours} 小时前`;
	}
	const days = Math.floor(hours / 24);
	if (days === 1) {
		return "昨天";
	}
	if (days < 30) {
		return `${days} 天前`;
	}
	return new Date(ms).toISOString().slice(0, 10);
}

/** 把若干会话整理成列表要的行；最近的在前（管理场景里「刚那个」最常被改名或删掉） */
function toRows(sessions: Session[]): Row[] {
	return sessions
		.map((session) => {
			const summary = session.describe();
			return {
				short: session.header.id.replaceAll("-", "").slice(0, 8) || session.file.split(/[\\/]/).pop() || "",
				file: session.file,
				cwd: session.header.cwd,
				title: summary.title,
				preview: summary.preview,
				messageCount: summary.messageCount,
				updatedAt: session.updatedAt(),
			};
		})
		.sort((left, right) => right.updatedAt - left.updatedAt);
}

/** 一行的排版：`id 8 条 2 分钟前 名字或首条消息`；跨目录时把归属缀在后面 */
function formatRow(row: Row, showCwd: boolean): string {
	const name = row.title !== "" ? row.title : row.preview !== "" ? row.preview : "（还没有对话）";
	const line = `  ${row.short.padEnd(10)} ${String(row.messageCount).padStart(4)} 条  ${formatAgo(row.updatedAt).padEnd(9)} ${name}`;
	return showCwd ? `${line}\n${" ".repeat(38)}${row.cwd}` : line;
}

/** 按 id 前缀或 `latest` 找会话；找不到返回 null */
function findSession(rows: Row[], key: string): Row | null {
	if (key === "latest") {
		return rows[0] ?? null;
	}
	const wanted = key.replaceAll("-", "").toLowerCase();
	return rows.find((row) => row.short.toLowerCase().startsWith(wanted.slice(0, 8))) ?? null;
}

/**
 * 收集要管理的会话。
 *
 * `--all` 走 `listAllSessionFiles()`（与网页侧栏、跨会话搜索同一份枚举：会话按工作目录分子目录存放），
 * 否则只看当前目录——与 `-c` / `rewind` 的口径一致。
 */
function collect(all: boolean, cwd: string): Session[] {
	if (!all) {
		return Session.list(cwd);
	}
	return listAllSessionFiles(sessionsRoot())
		.map((file) => Session.open(file))
		.filter((session): session is Session => session !== null);
}

/** 会话根目录；`--all` 与 `search` 用的是同一个 */
function sessionsRoot(): string {
	return getSessionsDir();
}

/** 回收目录里的一个文件 */
interface TrashFile {
	path: string;
	/** 大小（字节） */
	size: number;
	/** 移进来的时间（毫秒） */
	at: number;
}

/** 列出某个回收目录里的文件；目录不存在就是空的 */
function trashFiles(dir: string): TrashFile[] {
	const trash = join(dir, ".trash");
	let names: string[];
	try {
		names = readdirSync(trash);
	} catch {
		return [];
	}
	const files: TrashFile[] = [];
	for (const name of names) {
		const path = join(trash, name);
		try {
			const info = statSync(path);
			if (info.isFile()) {
				files.push({ path, size: info.size, at: info.mtimeMs });
			}
		} catch {
			// 读不到就跳过：一个坏文件不该让整份列表失败
		}
	}
	return files;
}

/** 所有工作目录的回收目录（与 `--all` 的会话列表同一套枚举） */
function allTrashFiles(): TrashFile[] {
	const root = sessionsRoot();
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: TrashFile[] = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			files.push(...trashFiles(join(root, entry.name)));
		}
	}
	return files;
}

/** 运行 sessions 子命令，返回进程退出码；`cwd` 只为测试能指定「当前目录」 */
export function runSessionsCommand(argv: string[], cwd: string = process.cwd()): number {
	if (wantsHelp(argv)) {
		process.stdout.write(`${sessionsUsage()}\n`);
		return 0;
	}

	const all = argv.includes("--all");
	const rest = argv.filter((arg) => arg !== "--all");
	const action = rest[0] ?? "list";
	const rows = toRows(collect(all, cwd));

	if (action === "list") {
		if (rest.length > 1) {
			process.stderr.write(`list 不带参数\n\n${sessionsUsage()}\n`);
			return 2;
		}
		if (rows.length === 0) {
			process.stderr.write(all ? "还没有任何会话\n" : `当前目录还没有会话（用 ${APP_NAME} 说一句话就会建一个）\n`);
			return 0;
		}
		const head = all
			? `全部工作目录下 ${rows.length} 个会话（最近的在前）：`
			: `当前目录下 ${rows.length} 个会话（最近的在前）：`;
		const lines = [head, ...rows.map((row) => formatRow(row, all))];
		lines.push(`（改名：${APP_NAME} sessions rename <id> <名字>；删除：${APP_NAME} sessions rm <id>）`);
		process.stdout.write(`${lines.join("\n")}\n`);
		return 0;
	}

	if (action === "trash") {
		const empty = rest.includes("--empty");
		const unknown = rest.slice(1).filter((arg) => arg !== "--empty");
		if (unknown.length > 0) {
			process.stderr.write(`trash 只认 --empty\n\n${sessionsUsage()}\n`);
			return 2;
		}
		// 回收目录是**每个工作目录一份**（`Session.remove()` 把它建在那个目录的会话目录旁边）
		const files = all ? allTrashFiles() : trashFiles(getSessionDir(cwd));
		if (files.length === 0) {
			process.stderr.write("回收目录里没有东西\n");
			return 0;
		}
		if (!empty) {
			const lines = [`回收目录里 ${files.length} 个文件（这些是删掉的会话，还能拿回来）：`];
			for (const file of files) {
				lines.push(
					`  ${formatAgo(file.at).padEnd(9)} ${String(Math.round(file.size / 1024)).padStart(5)}KB  ${file.path}`,
				);
			}
			lines.push(`（确认不要了就 ${APP_NAME} sessions trash --empty：那是真删，不可恢复）`);
			process.stdout.write(`${lines.join("\n")}\n`);
			return 0;
		}
		let removed = 0;
		for (const file of files) {
			try {
				rmSync(file.path, { force: true });
				removed += 1;
			} catch {
				// 单个删不掉（占用、权限）不该让整条命令失败：跳过它，剩下的照删。
			}
		}
		process.stdout.write(`已清空回收目录：删除 ${removed} 个文件\n`);
		return removed === files.length ? 0 : 1;
	}

	if (action === "rename") {
		const key = rest[1] ?? "";
		const title = rest.slice(2).join(" ").trim();
		if (key === "") {
			process.stderr.write(`用法：${APP_NAME} sessions rename <id> <名字>\n\n${sessionsUsage()}\n`);
			return 2;
		}
		const row = findSession(rows, key);
		if (row === null) {
			process.stderr.write(`找不到会话「${key}」（${APP_NAME} sessions 看列表）\n`);
			return 1;
		}
		const session = Session.open(row.file);
		session?.setTitle(title);
		process.stdout.write(title === "" ? `已取消「${row.short}」的命名\n` : `已改名：${row.short} → ${title}\n`);
		return 0;
	}

	if (action === "rm") {
		const key = rest[1] ?? "";
		if (key === "" || rest.length > 2) {
			process.stderr.write(`用法：${APP_NAME} sessions rm <id>\n\n${sessionsUsage()}\n`);
			return 2;
		}
		const row = findSession(rows, key);
		if (row === null) {
			process.stderr.write(`找不到会话「${key}」（${APP_NAME} sessions 看列表）\n`);
			return 1;
		}
		const session = Session.open(row.file);
		session?.remove();
		// 说清去哪了：这条命令不硬删，用户可能想找回来。
		process.stdout.write(
			`已删除会话 ${row.short}（移到回收目录：${APP_NAME} sessions trash 看，trash --empty 真删）\n`,
		);
		return 0;
	}

	process.stderr.write(`未知的子命令「${action}」\n\n${sessionsUsage()}\n`);
	return 2;
}
