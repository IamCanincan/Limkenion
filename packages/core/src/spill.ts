/**
 * 大输出落盘。
 *
 * 工具输出一旦过大，直接截断最省事，代价是信息真的没了：模型只能看到前几十 KB，剩下的想再要
 * 一次就得重跑命令（多数时候还跑不出同样的结果）。这里换个做法——把完整输出写进一个文件，
 * 上下文里只留开头一段加路径，需要细节时模型自己用 `read` / `grep` 去取。
 *
 * 落盘目录由调用方给出（CLI 用 `<配置目录>/spill`）。写不进去也不影响主流程：调用方会把原
 * 结果照原样交给模型，是截断还是别的处理由工具自己决定。
 *
 * **阈值不在这里**：每个工具自己声明 `maxResultBytes`（见 tools/contract.ts 的 `DEFAULT_MAX_RESULT_BYTES`），
 * 由 `results/budget.ts` 拿来判断。从前这里有一个全局的 `SPILL_THRESHOLD_BYTES`，于是「多大的输出
 * 该落盘」在一个地方定、而「这个工具的输出能不能落盘」在另一个地方，两处迟早对不上。
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatSize } from "./tools/path.ts";

/** 目录里最多留几份，超出的按修改时间从旧到新删 */
export const SPILL_KEEP_FILES = 50;

/** 上下文里保留前多少行 */
export const SPILL_PREVIEW_LINES = 60;

/**
 * 配了落盘目录时，上游工具可以把输出上限放宽到这个数。
 *
 * 没有落盘时截断是唯一选择，所以工具默认卡在 50KB 很合理；一旦多出磁盘这一层，
 * 就没必要在 50KB 处把内容真丢掉——先写下来，模型要细节时自己去读。
 */
export const SPILL_TOOL_OUTPUT_BYTES = 1_000_000;

/** 一次落盘的结果 */
export interface SpillFile {
	/** 完整输出的位置 */
	path: string;
	/** 字节数 */
	bytes: number;
	/** 行数 */
	lines: number;
}

/** 把文本写进落盘目录，返回位置信息 */
export function spillText(dir: string, name: string, text: string): SpillFile {
	mkdirSync(dir, { recursive: true });
	// 工具名要进文件名，先压成安全字符，免得出现路径分隔符之类的东西。
	const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const path = join(dir, `${stamp}-${safeName}.txt`);
	writeFileSync(path, text, "utf-8");
	pruneSpillDir(dir);
	return { path, bytes: Buffer.byteLength(text, "utf-8"), lines: text.split("\n").length };
}

/** 只留最近 `keep` 份，返回删掉的数量 */
export function pruneSpillDir(dir: string, keep = SPILL_KEEP_FILES): number {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".txt"));
	} catch {
		return 0;
	}
	if (names.length <= keep) {
		return 0;
	}
	const files = names.map((name) => {
		const path = join(dir, name);
		let mtime = 0;
		try {
			mtime = statSync(path).mtimeMs;
		} catch {
			// 读不到时间戳就当它最旧，反正只是清理顺序。
		}
		return { path, mtime };
	});
	files.sort((left, right) => right.mtime - left.mtime);

	let removed = 0;
	for (const file of files.slice(keep)) {
		try {
			rmSync(file.path, { force: true });
			removed += 1;
		} catch {
			// 删不掉就算了，下次再来。
		}
	}
	return removed;
}

/**
 * 落盘并生成给模型的替代正文。
 *
 * 提示里给出可直接照抄的 `read` 调用：模型经常知道「文件在哪」却懒得算 offset，
 * 把参数写全比让它自己拼更省一轮。
 */
export function spillToolOutput(dir: string, toolName: string, content: string): string {
	const file = spillText(dir, toolName, content);
	const lines = content.split("\n");
	const head = lines.slice(0, SPILL_PREVIEW_LINES).join("\n");
	const shown = Math.min(SPILL_PREVIEW_LINES, lines.length);
	const readCall = `{ "path": ${JSON.stringify(file.path)}, "offset": ${shown + 1}, "limit": 2000 }`;
	return [
		head,
		"",
		`[输出过长：上面是前 ${shown} 行，共 ${lines.length} 行 / ${formatSize(file.bytes)}]`,
		`完整输出已写入 ${file.path}`,
		`需要后面的内容就用 read ${readCall} 分段读，或者用 grep 直接搜这个文件。`,
	].join("\n");
}
