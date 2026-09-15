/**
 * 读取证据。
 *
 * 由来：模型「凭印象改文件」是最常见的翻车方式——它记得的内容可能来自上一轮、
 * 可能来自另一个文件，也可能用户刚在外面改过。这里让 read 记下「某个文件在什么时刻的
 * 内容指纹」，edit / write 覆盖已存在文件前先比对：没读过、或读过之后变了，就拒绝并提示
 * 重新读取，而不是把改动盲目盖上去。
 *
 * **两个工具的要求不一样**（这是效率问题，不是安全问题）：
 * - `write` 是整份覆盖，没有锚点，所以要求**整份指纹**没变（`check`）。
 * - `edit` 的每段 oldText 必须逐字命中且唯一，匹配本身就保证了「改的就是模型看见的那一段」，
 *   所以只要求**读过至少一次**，整体变过只在结果里提醒一句（`checkEdits`）。否则跑一次
 *   格式化器就会把后续所有编辑挡回去，每次都得重读整个文件。
 *
 * 只认内容哈希，不认路径字符串：`./a.ts` 与 `a.ts` 归一化后是同一个文件，换个写法不该被拒。
 */

import { createHash } from "node:crypto";

/** 一条读取记录 */
interface ReadRecord {
	/** 模型看到的那份内容的哈希 */
	digest: string;
	/** 记录时间，仅用于报错时说明 */
	at: number;
}

/** 读取证据表 */
export class ReadEvidence {
	/** 绝对路径 -> 记录 */
	private readonly records = new Map<string, ReadRecord>();

	/** 记下「刚刚把这个文件的内容给过模型」 */
	record(absolutePath: string, content: string): void {
		this.records.set(absolutePath, { digest: digestOf(content), at: Date.now() });
	}

	/**
	 * 检查是否可以直接改。
	 *
	 * 返回 null 表示放行；返回字符串表示拒绝原因，调用方直接把它当作工具错误回给模型。
	 */
	check(absolutePath: string, currentContent: string | null): string | null {
		const record = this.records.get(absolutePath);
		if (!record) {
			return "改文件前必须先读它：请先调用 read 查看该文件当前内容。";
		}
		// 文件被删掉了：允许往下走，由各工具自己报「文件不存在」；覆盖不存在的东西不算风险。
		if (currentContent === null) {
			return null;
		}
		if (digestOf(currentContent) !== record.digest) {
			return "文件在你读取之后被改动过（可能是你自己、用户或别的进程改的）：请重新 read 一次再修改。";
		}
		return null;
	}

	/**
	 * `edit` 专用：只要求「这个文件读过至少一次」，内容整体变没变**不影响放行**。
	 *
	 * 为什么与 `check`（`write` 用）不同：`write` 是整份覆盖，没有锚点——文件变了就必须重读，
	 * 否则会把没看见的内容一起盖掉。`edit` 不一样：它的每段 `oldText` 必须与当前内容**逐字相同且
	 * 唯一**才改得动，这本身就证明了「模型看见的就是要改的那一段」，别处变了不影响这次替换。
	 * 从前两者共用同一个整份指纹，代价是：跑一次格式化器（`biome --write`、prettier、`go fmt`）、
	 * 或者门禁顺带重排了文件，后续**所有**编辑都会被挡回去，每次都得重新读整个文件——一次重构里
	 * 能白跑十几次（真踩过）。
	 *
	 * 返回 `stale: true` 表示内容确实变过：调用方据此在结果里提一句（模型对这份文件的印象已经过期），
	 * 但这次编辑照做。
	 */
	checkEdits(
		absolutePath: string,
		currentContent: string | null,
	): { ok: true; stale: boolean } | { ok: false; message: string } {
		const record = this.records.get(absolutePath);
		if (!record) {
			return { ok: false, message: "改文件前必须先读它：请先调用 read 查看该文件当前内容。" };
		}
		if (currentContent === null) {
			return { ok: true, stale: false };
		}
		return { ok: true, stale: digestOf(currentContent) !== record.digest };
	}

	/** 清空记录，仅用于测试与工具集重建 */
	reset(): void {
		this.records.clear();
	}
}

/** 内容指纹：sha256 前 16 位十六进制足够区分，也不占空间 */
function digestOf(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}
