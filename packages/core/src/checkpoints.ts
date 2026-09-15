/**
 * 逐轮快照与回滚。
 *
 * 「可以一直开着跑」的前提是能后悔：模型这一轮改了三个文件，你事后发现改歪了，需要一键回到
 * 这一轮之前。做法是最笨也最可靠的那种——改动**之前**把旧内容抄一份，需要时写回去。
 *
 * 几个刻意的取舍：
 * - **按轮记账**：一轮 = 一条用户指令（可能包含很多次工具调用），回滚的单位是「这一轮之前」，
 *   而不是逐个工具调用，这样粒度与人的直觉一致。
 * - **同一文件只抄第一个版本**：一轮里改同一个文件多次，回滚要回到「这轮开始前」，所以只在
 *   首次改动时记录。
 * - **单文件有大小上限**：大文件不抄，只在结果里说明哪个文件没能回滚——比悄悄漏掉一个强。
 * - **落盘在会话旁边**：`<会话文件>.checkpoints.jsonl`，一行一轮，删会话时一并删掉，
 *   不额外引入数据库或依赖。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseJsonLines } from "./json.ts";

/** 单个文件快照上限：超过就放弃记录（回滚时会明确报告） */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;

/**
 * 快照文件后缀。
 *
 * 它与会话文件同在会话目录、同以 `.jsonl` 结尾，所以「这是不是会话」的判断必须靠它；
 * 会话层与搜索层都从这里取，别再各写一份字符串。
 */
export const CHECKPOINT_SUFFIX = ".checkpoints.jsonl";

/** 一轮里被改动的一个文件 */
interface FileSnapshot {
	/** 绝对路径 */
	path: string;
	/** 改动前的内容；文件原本不存在时为 null（回滚时删除） */
	content: string | null;
	/** 改动前是否存在 */
	existed: boolean;
}

/** 一轮的快照 */
interface TurnSnapshot {
	/** 轮次序号，从 1 开始 */
	seq: number;
	/** 提交时间 */
	at: string;
	files: FileSnapshot[];
	/** 因为太大而没能记录的文件 */
	skipped: string[];
}

/** 回滚结果 */
export interface RewindResult {
	/** 回滚到了第几轮之前 */
	seq: number;
	/** 改回旧内容的文件 */
	restored: string[];
	/** 因为原本不存在而被删掉的文件 */
	removed: string[];
	/** 快照里没记全、无法回滚的文件 */
	skipped: string[];
}

/**
 * 一轮的快照记录器。
 *
 * 用法：`begin()` → 工具在写文件前调用 `capture()` → 一轮结束后 `commit()`。
 * 没 commit 的轮次（生成失败、被中断）会在下一次 begin 时丢弃，不污染回滚链。
 */
export class CheckpointStore {
	/** 快照文件路径 */
	readonly file: string;
	/** 当前轮的序号 */
	private seq = 0;
	/** 当前轮已记录的文件，绝对路径 -> 快照 */
	private current = new Map<string, FileSnapshot>();
	/** 当前轮放弃记录的文件 */
	private currentSkipped = new Set<string>();
	/** 是否处在「一轮」之中 */
	private open = false;

	constructor(sessionFile: string) {
		this.file = `${sessionFile}${CHECKPOINT_SUFFIX}`;
	}

	/** 开始一轮：记录之前的未提交内容一律丢弃 */
	begin(): void {
		this.current.clear();
		this.currentSkipped.clear();
		this.open = true;
	}

	/**
	 * 记录某个文件改动前的内容。
	 *
	 * 同一个文件在一轮内只会记第一次——回滚的目标是「这轮开始前」。
	 */
	capture(absolutePath: string, previousContent: string | null): void {
		if (!this.open || this.current.has(absolutePath)) {
			return;
		}
		if (previousContent !== null && Buffer.byteLength(previousContent, "utf-8") > MAX_SNAPSHOT_BYTES) {
			this.currentSkipped.add(absolutePath);
			return;
		}
		this.current.set(absolutePath, {
			path: absolutePath,
			content: previousContent,
			existed: previousContent !== null,
		});
	}

	/** 结束一轮并落盘；没有任何改动则什么都不写，返回 0 */
	commit(): number {
		const files = [...this.current.values()];
		const skipped = [...this.currentSkipped];
		this.open = false;
		this.current.clear();
		this.currentSkipped.clear();
		if (files.length === 0 && skipped.length === 0) {
			return 0;
		}

		this.seq = this.list().length + 1;
		const snapshot: TurnSnapshot = {
			seq: this.seq,
			at: new Date().toISOString(),
			files,
			skipped,
		};
		mkdirSync(dirname(this.file), { recursive: true });
		// 追加一行：无需重写整个文件，任何时刻中断最多丢最后一行。
		writeFileSync(this.file, `${JSON.stringify(snapshot)}\n`, { flag: "a", encoding: "utf-8" });
		return files.length;
	}

	/** 读出全部快照 */
	list(): TurnSnapshot[] {
		if (!existsSync(this.file)) {
			return [];
		}
		const snapshots: TurnSnapshot[] = [];
		parseJsonLines(readFileSync(this.file, "utf-8"), (record) => {
			snapshots.push(record as unknown as TurnSnapshot);
		});
		return snapshots;
	}

	/** 还能回滚几轮 */
	depth(): number {
		return this.list().length;
	}

	/**
	 * 回滚最近一轮。
	 *
	 * 返回 null 表示没有可回滚的轮次；否则按「删掉新建的、写回改过的」恢复现场，
	 * 并把这一轮的记录从文件里去掉（再回滚一次就回到更早一轮）。
	 */
	rewind(): RewindResult | null {
		const snapshots = this.list();
		const last = snapshots.at(-1);
		if (!last) {
			return null;
		}

		const restored: string[] = [];
		const removed: string[] = [];
		for (const file of last.files) {
			try {
				if (file.existed && file.content !== null) {
					writeFileSync(file.path, file.content, "utf-8");
					restored.push(file.path);
				} else if (existsSync(file.path)) {
					unlinkSync(file.path);
					removed.push(file.path);
				}
			} catch {
				// 单个文件失败（权限、被占用）不阻断其余文件，最后统一报告。
				last.skipped.push(file.path);
			}
		}

		// 重写文件，去掉最后一行；没有剩余轮次时直接删掉快照文件。
		const remaining = snapshots.slice(0, -1);
		if (remaining.length === 0) {
			rmSync(this.file, { force: true });
		} else {
			writeFileSync(this.file, `${remaining.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf-8");
		}

		return { seq: last.seq, restored, removed, skipped: last.skipped };
	}
}

/** 快照文件是否落在会话目录里（会话文件的同级同后缀，靠它区分） */
export function isCheckpointFile(path: string): boolean {
	return path.endsWith(CHECKPOINT_SUFFIX);
}
