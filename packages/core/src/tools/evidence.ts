/**
 * 读取证据。
 *
 * 由来：模型「凭印象改文件」是最常见的翻车方式——它记得的内容可能来自上一轮、
 * 可能来自另一个文件，也可能用户刚在外面改过。这里让 read 记下「某个文件在什么时刻的
 * 内容指纹」，edit / write 覆盖已存在文件前先比对：没读过、或读过之后变了，就拒绝并提示
 * 重新读取，而不是把改动盲目盖上去。
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

	/** 清空记录，仅用于测试与工具集重建 */
	reset(): void {
		this.records.clear();
	}
}

/** 内容指纹：sha256 前 16 位十六进制足够区分，也不占空间 */
function digestOf(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}
