/**
 * 会话持久化。
 *
 * 每个工作目录一个子目录，每次启动一个 JSONL 文件：第一行是会话头，之后每行一条消息。
 * 选择 JSONL 而不是数据库，是因为它可追加、可读、可用 grep 直接查，且不需要任何依赖。
 */

import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Message } from "limkenion-ai";
import { CHECKPOINT_SUFFIX, firstLine, flattenWhitespace, parseJsonLines, parseJsonObject } from "limkenion-core";
import { ensureSessionDir, getSessionDir } from "./config.ts";

/** 会话文件第一行 */
export interface SessionHeader {
	type: "session";
	id: string;
	cwd: string;
	createdAt: string;
	/**
	 * 使用者给这个会话起的名字；没起过就没有这个字段。
	 *
	 * 只在文件头里、不写成一条记录：名字是**这个文件的属性**，不是对话里的一句话——`load()` 读的是
	 * 消息，把名字混进去会多出一条莫名其妙的 user 消息。老文件没有这个字段，读到的就是 undefined。
	 */
	title?: string;
	/**
	 * 使用者在侧栏里拖出来的次序；没拖过就没有这个字段。
	 *
	 * 与 `title` 同一套理由：次序是**这个文件的属性**（它在列表里站在哪儿），不是对话里的一句话，
	 * 所以写在文件头里、不追加记录。取值是一把「越大越靠前」的键（侧栏拖一次就整份重排一遍，
	 * 键取当时的时间戳往下递减），因此它和 `updatedAt` 是同一个量级，两者可以直接比大小：
	 * 排过序的按这个键，没排过的（比如刚建的会话）按修改时间——新会话因此仍然落在最上面。
	 */
	order?: number;
}

/**
 * 「清空上下文」的标记。
 *
 * 它是一条**记录**而不是「删掉前面的行」：会话文件是追加式的，删行会破坏「历史可 grep、可回溯」
 * 这个前提。`load()` 见到标记就把此前累积的消息丢掉，因此清空之后重开会话也不会把旧对话带回来。
 */
export interface SessionClearMark {
	type: "clear";
	at: string;
}

/** 列表展示需要的元信息 */
export interface SessionSummary {
	messageCount: number;
	preview: string;
	/** 使用者起的名字；没起过是空串（界面据此退回预览） */
	title: string;
	/** 使用者拖出来的次序；没拖过是 null（列表退回按修改时间排） */
	order: number | null;
}

/** 会话文件后缀 */
const SESSION_SUFFIX = ".jsonl";

/**
 * 会话名的长度上限。
 *
 * 80 与会话预览（首条用户消息）取同一个数：两者在列表里占同一行，能显示的长度本来就一样；
 * 名字太长会把行内的相对时间挤掉，也不好在菜单标题里完整显示。
 */
export const MAX_TITLE_LENGTH = 80;

/**
 * 列出会话根目录下所有工作目录的会话文件，按时间升序。
 *
 * 会话按工作目录分子目录，所以「跨会话搜索」要扫全部子目录，而 `Session.listFiles` 只管一个。
 * 两者共用同一套后缀判断：快照文件同目录同后缀，只有它能区分「这是对话」和「这是回滚记录」。
 */
export function listAllSessionFiles(root: string): string[] {
	if (!existsSync(root)) {
		return [];
	}
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const dir = join(root, entry.name);
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			// 子目录读不了就跳过：搜索不该因为一个坏目录整个失败。
			continue;
		}
		for (const name of names) {
			if (name.endsWith(SESSION_SUFFIX) && !name.endsWith(CHECKPOINT_SUFFIX)) {
				files.push(join(dir, name));
			}
		}
	}
	return files.sort();
}

/** 一个会话文件 */
export class Session {
	/** 会话文件绝对路径 */
	readonly file: string;
	/** 会话头信息 */
	readonly header: SessionHeader;

	private constructor(file: string, header: SessionHeader) {
		this.file = file;
		this.header = header;
	}

	/**
	 * 新建会话。
	 *
	 * 文件名以 ISO 时间戳开头，因此按文件名排序即按时间排序，`latest` 不需要读文件内容。
	 */
	static create(cwd: string, now: Date = new Date()): Session {
		const dir = ensureSessionDir(cwd);
		const createdAt = now.toISOString();
		const header: SessionHeader = {
			type: "session",
			// 时间戳只精确到毫秒，同一毫秒内并发启动会重名，用随机 id 兜底。
			id: randomUUID(),
			cwd,
			createdAt,
		};
		const stamp = createdAt.replace(/[:.]/g, "-");
		const file = join(dir, `${stamp}-${header.id.slice(0, 8)}${SESSION_SUFFIX}`);
		writeFileSync(file, `${JSON.stringify(header)}\n`, "utf-8");
		return new Session(file, header);
	}

	/** 读取某个工作目录下最近的会话，没有则返回 null */
	static latest(cwd: string): Session | null {
		const all = Session.listFiles(cwd);
		// 从后往前找第一个能解析出会话头的文件：目录里可能混着损坏或半写入的文件。
		for (let i = all.length - 1; i >= 0; i--) {
			const session = Session.open(all[i] ?? "");
			if (session) {
				return session;
			}
		}
		return null;
	}

	/** 列出某个工作目录下的全部会话文件，按时间升序 */
	static listFiles(cwd: string): string[] {
		const dir = getSessionDir(cwd);
		if (!existsSync(dir)) {
			return [];
		}
		return (
			readdirSync(dir)
				// 快照文件也叫 .jsonl，但它不是会话：混进来会让 latest() 选中一个没有会话头的文件。
				.filter((name) => name.endsWith(SESSION_SUFFIX) && !name.endsWith(CHECKPOINT_SUFFIX))
				.sort()
				.map((name) => join(dir, name))
		);
	}

	/** 打开一个已存在的会话文件 */
	static open(file: string): Session | null {
		try {
			const headerLine = firstLine(readFileSync(file, "utf-8"));
			if (!headerLine) {
				return null;
			}
			const header = parseJsonObject(headerLine) as SessionHeader | null;
			return header?.type === "session" ? new Session(file, header) : null;
		} catch {
			return null;
		}
	}

	/** 列出某个工作目录下的全部会话，按时间升序；无法解析的文件被跳过 */
	static list(cwd: string): Session[] {
		return Session.listFiles(cwd)
			.map((file) => Session.open(file))
			.filter((session): session is Session => session !== null);
	}

	/**
	 * 读取列表展示需要的元信息。
	 *
	 * 只读一次文件：数消息条数，取首条用户消息当预览。`clear` 标记之前的都不算——清空之后
	 * 「这个会话有多少条」指的显然是之后那些，否则列表上的数字与用户刚做的事对不上。
	 *
	 * 判据是「带 type 字段的一律不是消息」：记录（会话头、清空标记，将来可能还有别的）都不会被算进
	 * 条数里，`load()` 用的是同一条判据。
	 */
	describe(): SessionSummary {
		let messageCount = 0;
		let preview = "";
		parseJsonLines(readFileSync(this.file, "utf-8"), (raw) => {
			const record = raw as { type?: string; role?: string; content?: unknown };
			if (record.type === "session") {
				return;
			}
			if (record.type === "clear") {
				messageCount = 0;
				preview = "";
				return;
			}
			// 其它未知记录（将来新增的标记）跳过，别算进条数里。
			if (record.type !== undefined || record.role === "system") {
				return;
			}
			messageCount += 1;
			if (preview === "" && record.role === "user" && typeof record.content === "string") {
				// 截到 80 字是列表宽度决定的，属于这里的选择；压平空白则与会话搜索共用。
				preview = flattenWhitespace(record.content).slice(0, 80);
			}
		});
		return { messageCount, preview, title: this.header.title ?? "", order: this.header.order ?? null };
	}

	/** 最后一次写入时间（毫秒）；文件读不到时返回 0，列表按 0 处理（侧栏用它显示相对时间） */
	updatedAt(): number {
		try {
			return statSync(this.file).mtimeMs;
		} catch {
			return 0;
		}
	}

	/**
	 * 删除会话文件。
	 *
	 * **移到回收目录而不是直接删**：会话是这个工具里唯一不可再生的东西（对话记录没法重新生成），
	 * 而侧栏那个「…」菜单里的删除只差一次误点。原先用 `rmSync` 硬删、不进回收站，真出过一次
	 * 整个工作空间的会话被清空、救不回来的事。现在挪到 `<会话目录>/.trash/` 下并打上时间戳，
	 * 想找回来直接从那儿拿；清理回收目录留给使用者自己做（不自动过期，免得又变成静默删除）。
	 * 挪动失败（跨盘、权限）时才退回删除，至少不让功能卡住。
	 */
	remove(): void {
		if (!existsSync(this.file)) {
			return;
		}
		try {
			const trash = join(getSessionDir(this.header.cwd), ".trash");
			mkdirSync(trash, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			renameSync(this.file, join(trash, `${stamp}-${basename(this.file)}`));
		} catch {
			rmSync(this.file, { force: true });
		}
	}

	/** 追加一条消息 */
	append(message: Message): void {
		appendFileSync(this.file, `${JSON.stringify(message)}\n`, "utf-8");
	}

	/**
	 * 改写会话头里的工作目录。
	 *
	 * **只能重写第一行，不能追加一条新记录**：会话头是 `Session.open` 认这个文件的唯一入口
	 * （它只读第一行），追加的记录会被 `load()` 当未知类型跳过——文件看着「变了」，实际没有任何
	 * 一个会话认得它，等于什么都没做。
	 *
	 * 第一行之后的内容必须逐字节原样写回：只切第一个换行符，后面整段照搬，不按行拆分再拼回去
	 * （那样会顺手改动其余行的空白与空行）。末尾缺换行符时补一个：否则下一次 `append` 会跟头挤在
	 * 同一行，整个文件再也解析不出来——会话是这里唯一不可再生的东西，不留这个险。
	 *
	 * 内存里那份 `header` 同步改掉：调用方（Run 的构造）紧接着读的就是它，不会再去读文件。
	 */
	setCwd(cwd: string): void {
		const content = readFileSync(this.file, "utf-8");
		const newline = content.indexOf("\n");
		const rest = newline === -1 ? "\n" : content.slice(newline);
		// 用展开而不是重建对象：头里将来可能多出别的字段，重写时不该把它们丢掉。
		const header: SessionHeader = { ...this.header, cwd };
		writeFileSync(this.file, `${JSON.stringify(header)}${rest}`, "utf-8");
		this.header.cwd = cwd;
	}

	/**
	 * 改会话名。
	 *
	 * 与 `setCwd` 同一套做法、同一批理由：**只重写第一行**（会话头是 `Session.open` 认这个文件的
	 * 唯一入口），第一行之后逐字节照搬，内存里那份 `header` 同步改掉。
	 *
	 * 空名字（或只有空白）等于**取消命名**：把这个字段从文件头里删掉，界面退回显示首条用户消息。
	 */
	setTitle(title: string): void {
		const clean = flattenWhitespace(title).slice(0, MAX_TITLE_LENGTH);
		const content = readFileSync(this.file, "utf-8");
		const newline = content.indexOf("\n");
		const rest = newline === -1 ? "\n" : content.slice(newline);
		const header: SessionHeader = { ...this.header };
		if (clean === "") {
			delete header.title;
		} else {
			header.title = clean;
		}
		writeFileSync(this.file, `${JSON.stringify(header)}${rest}`, "utf-8");
		if (clean === "") {
			delete this.header.title;
		} else {
			this.header.title = clean;
		}
	}

	/**
	 * 改这个会话在侧栏里的次序。
	 *
	 * 与 `setCwd` / `setTitle` 同一套做法、同一批理由：**只重写第一行**（会话头是 `Session.open`
	 * 认这个文件的唯一入口），第一行之后逐字节照搬，内存里那份 `header` 同步改掉。
	 *
	 * 传 null 等于**取消排序**（把字段删掉，列表退回按修改时间排）。
	 */
	setOrder(order: number | null): void {
		const content = readFileSync(this.file, "utf-8");
		const newline = content.indexOf("\n");
		const rest = newline === -1 ? "\n" : content.slice(newline);
		const header: SessionHeader = { ...this.header };
		if (order === null) {
			delete header.order;
		} else {
			header.order = order;
		}
		writeFileSync(this.file, `${JSON.stringify(header)}${rest}`, "utf-8");
		if (order === null) {
			delete this.header.order;
		} else {
			this.header.order = order;
		}
	}

	/**
	 * 记一次「清空上下文」。
	 *
	 * 只在内存里 reset 是不够的：文件是追加式的，重启或重开这个会话时 `load()` 会把清空之前的消息
	 * 又读回来，用户会以为「清空」没生效。所以写一条标记，之后的历史才作数——文件本身不删，
	 * 旧对话仍然 grep 得到。
	 */
	markCleared(now: Date = new Date()): void {
		const mark: SessionClearMark = { type: "clear", at: now.toISOString() };
		appendFileSync(this.file, `${JSON.stringify(mark)}\n`, "utf-8");
	}

	/**
	 * 读取历史消息。
	 *
	 * 跳过文件头，也跳过系统消息：系统提示词包含工作目录等运行时信息，
	 * 由新的 Agent 实例重新生成，用旧的会导致提示词与当前环境不一致。
	 * 遇到 `clear` 标记则丢掉此前累积的消息：那条标记说的是「从这里开始算」。
	 */
	load(): Message[] {
		const messages: Message[] = [];
		// 会话头与清空标记都带 type 字段：**带 type 的一律不是消息**。
		// 这条判据必须是这句白名单式的判断，否则将来加一种记录就会被当成消息混进历史。
		parseJsonLines(readFileSync(this.file, "utf-8"), (raw) => {
			const record = raw as { type?: string; role?: string };
			if (record.type === "session" || record.role === "system") {
				return;
			}
			if (record.type === "clear") {
				messages.length = 0;
				return;
			}
			if (record.type !== undefined) {
				return;
			}
			messages.push(record as Message);
		});
		return messages;
	}
}
