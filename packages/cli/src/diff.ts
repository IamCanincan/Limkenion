/*
 * 行级 diff：统一 diff 的算法部分（削公共前后缀 → LCS → 编行号 → 切 hunk），加上「一轮快照 → 各文件差异」。
 *
 * 三个地方用它，所以单独成一个模块（不在 `web/` 下：终端也在用）：
 * - **历史**面板的逐轮差异（`web/feature-history.ts`）：快照里记的旧版本 → 当前磁盘上的那一份；
 * - 工具确认卡片上的**改动片段**（`web/runs.ts`）：磁盘上那一份 → 这次要整份写入的内容；
 * - 终端的 `/diff`（`repl.ts`）：与历史面板同一份逐轮差异，只是排成文本。
 *
 * 从前这几处各有一份实现：服务端这份是 LCS，网页那份（`render.js` 的 `appendApprovalDiff`）只是
 * 「去掉首尾相同的行」的近似——同一个改动在两个地方长得不一样，而且「哪一侧是旧」的口径也不同。
 * 现在算法只有一份，调用方拿到的都是**编好行号、切好段**的行，照着画就行：让界面自己数行号等于
 * 把同一套规则实现两遍，迟早对不上。
 *
 * 取舍沿用原来的四条：不引 diff 库（运行时零依赖）、只比前若干行（行数决定 LCS 规模）、
 * 返回行而不是文本（行号与段头由算的一方给）、处处限长（宁可少给也不把界面拖死）。
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { looksBinary } from "limkenion-core";

/**
 * 参与逐行比较的文件行数上限。
 *
 * 超过就只比较前 N 行，并在结果里标出还有多少行没比较——行数决定 LCS 的规模，不设上限的话，
 * 一个几十万行的文件会让一次点击卡住事件循环。
 */
export const MAX_DIFF_LINES = 3000;

/** 单次响应里 diff 的总行数上限；给不出更多就截断并说明 */
export const MAX_OUTPUT_LINES = 2000;

/** 逐行比较前读入内存的字节上限；比这个还大的文件只报告「改过」，不展开内容 */
export const MAX_DIFF_BYTES = 512 * 1024;

/** LCS 表最多算多少个格子；超出的片段退化成「整段删 + 整段插」 */
const MAX_LCS_CELLS = 4_000_000;

/** 每处改动在 diff 里上下各留几行上下文；与统一 diff 的默认值一致 */
const CONTEXT_LINES = 3;

/**
 * 审批卡片上那一节「改动片段」最多几行。
 *
 * 它挤在确认卡片里（卡片本来就要摆命令原文/写入内容/原因），所以比历史面板小得多；
 * 超出就截断并说明，卡片正文里仍然有完整内容可以看。
 */
export const APPROVAL_DIFF_LINES = 24;

/**
 * 二进制判定的读数上限。
 *
 * `looksBinary` 要的是整个文件，但这里只读开头一段：既不为了判断把 500KB 全读进来，
 * 又足够覆盖「这是不是一个文本文件」。
 */
const BINARY_CHECK_BYTES = 8192;

/** 一行 diff：行号只在有这一侧的行时才有值 */
export interface DiffLine {
	/** ` ` 上下文行、`+` 新增行、`-` 删除行 */
	tag: " " | "+" | "-";
	/** 旧版本里的行号，新增行为 null */
	oldLine: number | null;
	/** 新版本里的行号，删除行为 null */
	newLine: number | null;
	/** 行内容，不含前缀 */
	text: string;
}

/** 一段连续的改动，前面带一行 `@@` 段头 */
export interface DiffSection {
	/** 段头，例如 `@@ -12,7 +12,9 @@` */
	header: string;
	lines: DiffLine[];
	/** 这一段因为本次调用的行数预算而被截断了 */
	truncated: boolean;
}

/**
 * 「这次要把某个文件整份换成这些内容」的差异，给工具确认卡片用。
 *
 * 它是**数据**而不是一段拼好的文本：界面照着画，口径（哪一侧是旧、哪一行算第几行）由这里定。
 */
export interface ReplacementDiff {
	/** 文件路径，原样回显请求值 */
	path: string;
	/** 磁盘上还没有这个文件：整份都是新增 */
	created: boolean;
	/** 这次改动的**总**新增行数（不受下面的截断影响：只显示前面一段时它仍是全量） */
	added: number;
	/** 这次改动的**总**删除行数，口径同上 */
	removed: number;
	/** 逐段差异；没有可画的东西时是空数组（原因在 `note` 里） */
	sections: DiffSection[];
	/** 没有展开对比时的原因（新文件、二进制、太大、与磁盘一致…），或截断说明 */
	note: string;
}

/** 带行号的行：diff 算法内部用，行号在 `toSections` 里统一补 */
export interface TaggedLine {
	tag: " " | "+" | "-";
	text: string;
}

/**
 * 算「磁盘上那一份 → 将要写入的内容」的差异。
 *
 * 方向是固定的：`-` 是会被覆盖掉的行，`+` 是写进去的新行。读不到或没得比时**不编造内容**，
 * 只给一句原因——卡片据此说明「为什么这里没有前后对比」，而不是空着一块让人以为坏了。
 */
export function replacementDiff(path: string, next: string, cwd: string): ReplacementDiff {
	const absolute = guardPath(path, cwd);
	if (absolute === null) {
		return emptyReplacement(path, "这个路径在工作目录之外，不在这里展开对比");
	}

	const fresh = sliceLines(splitLines(next));
	const current = readCurrent(absolute);
	if (current.kind === "missing") {
		if (fresh.lines.length === 0) {
			return emptyReplacement(path, "磁盘上还没有这个文件，而要写入的内容是空的");
		}
		const sections = toSections(
			fresh.lines.map((text) => ({ tag: "+" as const, text })),
			APPROVAL_DIFF_LINES,
		);
		return {
			path,
			created: true,
			added: fresh.lines.length,
			removed: 0,
			sections,
			note: fresh.truncated ? `将写入的内容超过 ${MAX_DIFF_LINES} 行，只比较了前 ${MAX_DIFF_LINES} 行` : "",
		};
	}
	// 不是文本（二进制、太大）就没得比；这一条用否定式写，判别联合在这里才收得干净。
	if (current.kind !== "text") {
		return emptyReplacement(path, current.note);
	}

	const old = sliceLines(current.lines);
	const tagged = diffSegments(old.lines, fresh.lines);
	const truncated = truncatedNote([
		{ label: "磁盘上那一份", truncated: old.truncated },
		{ label: "要写入的内容", truncated: fresh.truncated },
	]);
	if (tagged.length === 0) {
		// 一致，或只差在被截断掉的那一段之外——后者不能写成「逐行相同」，那是在替比较范围打包票。
		return emptyReplacement(path, truncated ?? "与磁盘上那一份逐行相同，这一笔不会改变内容");
	}
	const sections = toSections(tagged, APPROVAL_DIFF_LINES);
	// 两种截断的理由各自成立，所以分别说，不合并成一句含糊的「已截断」。
	const notes: string[] = [];
	if (truncated !== null) {
		notes.push(truncated);
	}
	if (sections.some((section) => section.truncated)) {
		notes.push("改动太多，这里只显示了前面一段，完整内容在卡片正文里");
	}
	// 统计按**全量**算：卡片上写「共 +N −M」时，N/M 不该只是刚显示出来的那段。
	return { path, created: false, ...countTagged(tagged), sections, note: notes.join("；") };
}

/**
 * 参与比较的行被行数上限截过时的说明（两侧都截了就都说）；没截过返回 null。
 *
 * 单独抽出来是因为「只比了前 N 行」与「逐行相同」是两件事：截断掉的那部分可能正是唯一不一样的地方，
 * 这时把结论写成「逐行相同」就是在替比较范围打包票。两个调用点（历史面板、审批卡片）共用这一句。
 */
export function truncatedNote(sides: { label: string; truncated: boolean }[]): string | null {
	const cut = sides.filter((side) => side.truncated);
	if (cut.length === 0) {
		return null;
	}
	return cut.map((side) => `${side.label}超过 ${MAX_DIFF_LINES} 行，只比较了前 ${MAX_DIFF_LINES} 行`).join("；");
}

/** 带标签行的增删统计（不受截断影响：没显示出来的行也算） */
function countTagged(tagged: TaggedLine[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of tagged) {
		if (line.tag === "+") {
			added++;
		} else if (line.tag === "-") {
			removed++;
		}
	}
	return { added, removed };
}

/** 没有可画的东西时的空结果 */
function emptyReplacement(path: string, note: string): ReplacementDiff {
	return { path, created: false, added: 0, removed: 0, sections: [], note };
}

/** 读当前文件内容；非文本与读不到都各自给出原因，让调用方能解释「为什么没有 diff」 */
export function readCurrent(
	path: string,
): { kind: "text"; lines: string[] } | { kind: "missing" | "other"; note: string } {
	const info = statSync(path, { throwIfNoEntry: false });
	if (!info || !info.isFile()) {
		return { kind: "missing", note: "当前磁盘上没有这个文件" };
	}
	if (info.size > MAX_DIFF_BYTES) {
		return { kind: "other", note: `文件超过 ${MAX_DIFF_BYTES} 字节，不做文本比较` };
	}
	const buffer = readFileSync(path);
	if (looksBinary(buffer.subarray(0, BINARY_CHECK_BYTES))) {
		return { kind: "other", note: "不是文本文件，不做文本比较" };
	}
	return { kind: "text", lines: splitLines(buffer.toString("utf-8")) };
}

/**
 * 按行切成数组。
 *
 * 单个 `\n` 与 `\r\n` 都认：仓库在 Windows 上开发，行尾不一致不该被算成「整份文件都改了」。
 */
export function splitLines(text: string): string[] {
	if (text === "") {
		return [];
	}
	const lines = text.split("\n");
	if (lines.at(-1) === "") {
		// 末尾换行不产生额外一行，否则每个文件都会多出一个空行差异。
		lines.pop();
	}
	return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** 逐行 diff 的实现：削掉公共前后缀，中间那块再做 LCS */
export function diffSegments(oldLines: string[], newLines: string[]): TaggedLine[] {
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
		start++;
	}
	let end = 0;
	while (
		end < oldLines.length - start &&
		end < newLines.length - start &&
		oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]
	) {
		end++;
	}

	// 中间那段最长也就是「删完再插」，所以按长度给 DP 表设上限：真的超大时退化成整段替换，
	// 结果依然是正确可读的统一 diff，只是不够精细。
	const oldMiddle = oldLines.slice(start, oldLines.length - end);
	const newMiddle = newLines.slice(start, newLines.length - end);
	const middle =
		oldMiddle.length * newMiddle.length > MAX_LCS_CELLS
			? [
					...oldMiddle.map((text) => ({ tag: "-" as const, text })),
					...newMiddle.map((text) => ({ tag: "+" as const, text })),
				]
			: lcsDiff(oldMiddle, newMiddle);

	if (middle.length === 0) {
		// 中间那段没有差异（整份文件一致，或只差在被截断的部分之外）：没有改动就没有 hunk，
		// 否则会画出一段全是上下文行、一行 `+`/`-` 都没有的假差异。
		return [];
	}
	if (start === 0 && end === 0) {
		return middle;
	}
	// 公共前缀 + 中间差异 + 公共后缀，顺序天然是对的，不必再合并五个分段。
	return [
		...oldLines.slice(0, start).map((text) => ({ tag: " " as const, text })),
		...middle,
		...oldLines.slice(oldLines.length - end).map((text) => ({ tag: " " as const, text })),
	];
}

/** 用 LCS 动态规划把两段行序列对齐，输出带标签的行 */
function lcsDiff(oldLines: string[], newLines: string[]): TaggedLine[] {
	const rows = oldLines.length;
	const cols = newLines.length;
	// 下标从右下往左上填，取值时只需要右边、下边与右下三个格子。
	const table = new Uint32Array((rows + 1) * (cols + 1));
	for (let i = rows - 1; i >= 0; i--) {
		for (let j = cols - 1; j >= 0; j--) {
			table[i * (cols + 1) + j] =
				oldLines[i] === newLines[j]
					? (table[(i + 1) * (cols + 1) + j + 1] ?? 0) + 1
					: Math.max(table[(i + 1) * (cols + 1) + j] ?? 0, table[i * (cols + 1) + j + 1] ?? 0);
		}
	}

	const out: TaggedLine[] = [];
	let i = 0;
	let j = 0;
	while (i < rows && j < cols) {
		if (oldLines[i] === newLines[j]) {
			out.push({ tag: " ", text: oldLines[i] ?? "" });
			i++;
			j++;
		} else if ((table[(i + 1) * (cols + 1) + j] ?? 0) >= (table[i * (cols + 1) + j + 1] ?? 0)) {
			out.push({ tag: "-", text: oldLines[i] ?? "" });
			i++;
		} else {
			out.push({ tag: "+", text: newLines[j] ?? "" });
			j++;
		}
	}
	// 剩下的只可能是一边先走完，直接补出去，顺序与「删完再插」一致。
	for (; i < rows; i++) {
		out.push({ tag: "-", text: oldLines[i] ?? "" });
	}
	for (; j < cols; j++) {
		out.push({ tag: "+", text: newLines[j] ?? "" });
	}
	return out;
}

/**
 * 把带标签的行编上号并切成段落。
 *
 * 行号在这里一次算清：旧版本侧的行号只在上下文行与删除行上前进，新版本侧只在上下文行与新增行上
 * 前进。界面直接照着画两列数字，不需要再猜。分段的规矩与统一 diff 一致——每处改动的上下各留
 * `CONTEXT_LINES` 行上下文，相隔太远就断开成两个 `@@` 段。
 *
 * `budget` 是这次还能容纳的行数（传 `Number.POSITIVE_INFINITY` 表示不限）；不够画完的段落
 * 会被截断（保留段头与前面的行），一段都放不下时就返回空数组——调用方据此说明「差异还有多少
 * 没展开」。
 */
export function toSections(tagged: TaggedLine[], budget: number): DiffSection[] {
	// 先标出哪些行要画：改动行本身，以及离改动不超过 CONTEXT_LINES 行的上下文行。
	// 不先标一遍的话，「文件开头就是改动」这类情形会把该留的上下文挤掉。
	const keep: boolean[] = new Array(tagged.length).fill(false);
	let distance = CONTEXT_LINES + 1;
	for (let i = tagged.length - 1; i >= 0; i--) {
		if (tagged[i]?.tag !== " ") {
			distance = 0;
		} else {
			distance++;
		}
		if (distance <= CONTEXT_LINES) {
			keep[i] = true;
		}
	}
	distance = CONTEXT_LINES + 1;
	for (let i = 0; i < tagged.length; i++) {
		if (tagged[i]?.tag !== " ") {
			distance = 0;
		} else {
			distance++;
		}
		if (distance <= CONTEXT_LINES) {
			keep[i] = true;
		}
	}

	const blocks: DiffLine[][] = [];
	let current: DiffLine[] = [];
	let oldNo = 1;
	let newNo = 1;
	for (let i = 0; i < tagged.length; i++) {
		const item = tagged[i];
		if (!item) {
			continue;
		}
		if (item.tag === " " && !keep[i]) {
			// 离改动太远的上下文：跳过，但两边的行号都要继续走。
			if (current.length > 0) {
				blocks.push(current);
				current = [];
			}
			oldNo++;
			newNo++;
			continue;
		}
		current.push({
			tag: item.tag,
			oldLine: item.tag === "+" ? null : oldNo,
			newLine: item.tag === "-" ? null : newNo,
			text: item.text,
		});
		if (item.tag !== "+") {
			oldNo++;
		}
		if (item.tag !== "-") {
			newNo++;
		}
	}
	if (current.length > 0) {
		blocks.push(current);
	}

	// 段头本身也占一行，所以算预算时把它一并算进去。
	const out: DiffSection[] = [];
	let used = 0;
	for (const lines of blocks) {
		const room = budget - used - 1;
		if (room <= 0) {
			break;
		}
		if (lines.length <= room) {
			out.push({ header: hunkHeader(lines), lines, truncated: false });
			used += lines.length + 1;
			continue;
		}
		// 一段都放不下就整段不要了，放得下一部分就给一部分——总比什么都没有强。
		const shown = lines.slice(0, room);
		// 末尾补一行说明被截掉多少，读的人才知道下面还有内容。
		shown.push({
			tag: " ",
			oldLine: null,
			newLine: null,
			text: `…（本段还有 ${lines.length - room} 行未展开）`,
		});
		out.push({ header: hunkHeader(lines), lines: shown, truncated: true });
		used += room + 1;
		break;
	}
	return out;
}

/** 段头：`@@ -旧起点,旧行数 +新起点,新行数 @@` */
function hunkHeader(lines: DiffLine[]): string {
	// 段头的范围按完整段落算，不按截断后剩下的那几行——它描述的是「这段改动覆盖哪里」。
	const olds = lines.filter((item) => item.oldLine !== null);
	const news = lines.filter((item) => item.newLine !== null);
	const oldStart = olds[0]?.oldLine ?? 0;
	const newStart = news[0]?.newLine ?? 0;
	return `@@ -${oldStart},${olds.length} +${newStart},${news.length} @@`;
}

/** 增删统计；`@@` 段头不计入 */
export function stats(sections: DiffSection[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const section of sections) {
		for (const line of section.lines) {
			if (line.tag === "+") {
				added++;
			} else if (line.tag === "-") {
				removed++;
			}
		}
	}
	return { added, removed };
}

/** 行数：段头也算一行，与响应里 `omitted` 的预算口径保持一致 */
export function countLines(sections: DiffSection[]): number {
	let total = 0;
	for (const section of sections) {
		total += section.lines.length + 1;
	}
	return total;
}

/** 限制参与比较的行数；超出的部分用一行占位顶掉，让 diff 自己把它标成新增或删除 */
export function sliceLines(lines: string[]): { lines: string[]; truncated: boolean } {
	if (lines.length <= MAX_DIFF_LINES) {
		return { lines, truncated: false };
	}
	return {
		lines: [...lines.slice(0, MAX_DIFF_LINES), "…（其余行未比较）"],
		truncated: true,
	};
}

/**
 * 把路径夹到工作目录内。
 *
 * 快照与写入目标都是本地文件，理论上不该有越界路径，但「读哪个文件」这个动作最终由请求或模型决定，
 * 所以宁可多判一次：越界就当作不存在，绝不把目录外的文件内容喂给浏览器。
 */
export function guardPath(target: string, cwd: string): string | null {
	const base = resolve(cwd);
	const absolute = isAbsolute(target) ? resolve(target) : resolve(base, target);
	const inside = relative(base, absolute);
	if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
		return absolute;
	}
	return null;
}

/** 两个路径是否指同一个文件；Windows 上大小写不敏感，比较前统一小写 */
export function samePath(a: string, b: string): boolean {
	return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/** 单个文件的差异（一轮快照里的一件） */
export interface FileDiff {
	/** 文件绝对路径 */
	path: string;
	/** 快照里记的是「原本不存在」：这一轮把它建了出来 */
	created: boolean;
	/** 快照里记了旧内容，但当前磁盘上已经没有这个文件了 */
	deleted: boolean;
	/** 新增行数 */
	added: number;
	/** 删除行数 */
	removed: number;
	/** 逐段差异，供调用方按统一 diff 排版 */
	sections: DiffSection[];
	/** diff 没有覆盖整个文件时的原因（太大、截断、不是文本） */
	note: string;
}

/** 一轮快照要拿来算差异的那部分（`CheckpointStore.list()` 的元素就是它） */
export interface TurnSnapshot {
	seq: number;
	at: string;
	files: { path: string; content: string | null; existed: boolean }[];
}

/**
 * 算一轮快照对当前磁盘的差异。
 *
 * 网页的「历史」面板与终端的 `/diff` 共用这一份：前者按文件逐个拉（`requested` 只算那一个），
 * 后者一次把整轮打出来。快照里记的是**改动前**的内容，所以方向是「快照 → 现在」：
 * `-` 是这一轮删掉的行，`+` 是这一轮加上的行。
 */
export function diffTurn(
	snapshot: TurnSnapshot,
	cwd: string,
	options: { requested?: string | null; maxLines?: number } = {},
): { files: FileDiff[]; omitted: { path: string; note: string }[] } {
	const requested = options.requested ?? null;
	const maxLines = options.maxLines ?? MAX_OUTPUT_LINES;
	const files: FileDiff[] = [];
	const omitted: { path: string; note: string }[] = [];
	/** 已写出的行数；跨文件累计，避免十个中等文件凑出一个巨响应 */
	let used = 0;

	for (const file of snapshot.files) {
		const path = guardPath(file.path, cwd);
		if (path === null) {
			continue;
		}
		if (requested !== null && !samePath(requested, path)) {
			continue;
		}
		if (used >= maxLines) {
			// 省掉的那些也要说清楚，不然「文件列表里有、diff 里没有」会让人以为是 bug。
			omitted.push({ path, note: `总输出已达 ${maxLines} 行上限` });
			continue;
		}

		const result = diffFile({ ...file, path }, maxLines - used);
		used += countLines(result.sections);
		files.push(result);
	}
	return { files, omitted };
}

/**
 * 算一个文件的差异。
 *
 * 快照里的内容是**改动前**的旧版本，当前磁盘上的才是新版本，所以 diff 的方向是
 * 「快照 -> 现在」：`-` 是这一轮删掉的行，`+` 是这一轮加上的行。
 */
function diffFile(file: { path: string; content: string | null; existed: boolean }, budget: number): FileDiff {
	if (!file.existed) {
		// 快照说它原本不存在：整份文件都是这一轮加的，不必读旧版本，逐行算 LCS 也没有意义。
		const current = readCurrent(file.path);
		if (current.kind !== "text") {
			return emptyDiff(file.path, { created: true, note: current.note });
		}
		return wholeFileDiff(file.path, current.lines, "+", { created: true });
	}

	const current = readCurrent(file.path);
	if (current.kind === "missing") {
		// 快照里有旧内容、磁盘上却没有：这一轮把文件删了，整份旧内容都是 `-`。
		return wholeFileDiff(file.path, splitLines(file.content ?? ""), "-", { deleted: true });
	}
	if (current.kind !== "text") {
		return emptyDiff(file.path, { note: current.note });
	}

	const old = sliceLines(splitLines(file.content ?? ""));
	const fresh = sliceLines(current.lines);
	const tagged = diffSegments(old.lines, fresh.lines);
	const truncated = truncatedNote([
		{ label: "改动前", truncated: old.truncated },
		{ label: "当前文件", truncated: fresh.truncated },
	]);
	if (tagged.length === 0) {
		// 内容一致：这一轮多半改了又改回来。说明一下，免得列表里有文件、点开却什么都没有；
		// 但「只比了前 N 行」时不能写成「没有差异」——被截掉的那部分可能正是改动所在。
		return emptyDiff(file.path, { note: truncated ?? "与当前内容一致，没有差异" });
	}

	const sections = toSections(tagged, budget);
	// 两种截断的理由各自成立，所以分别说，不合并成一句含糊的「已截断」。
	const notes: string[] = [];
	if (truncated !== null) {
		notes.push(truncated);
	}
	if (sections.some((section) => section.truncated)) {
		notes.push(`差异超过本次可用的 ${budget} 行，只显示了前面一段`);
	}
	return { path: file.path, created: false, deleted: false, ...stats(sections), sections, note: notes.join("；") };
}

/** 整份文件都是同一种标签的文件差异（新建或删除） */
function wholeFileDiff(
	path: string,
	lines: string[],
	tag: "+" | "-",
	flags: { created?: boolean; deleted?: boolean },
): FileDiff {
	const sliced = sliceLines(lines).lines;
	if (sliced.length === 0) {
		// 空文件也是有效的差异（新建了一个空文件、或把内容删空），但没行可画。
		return emptyDiff(path, { ...flags, note: "文件内容为空" });
	}
	// 新建或删除的文件整份都要给出来，所以这里不设行数预算（`Infinity` 表示不截断）。
	const sections = toSections(
		sliced.map((text) => ({ tag, text })),
		Number.POSITIVE_INFINITY,
	);
	return {
		path,
		created: flags.created === true,
		deleted: flags.deleted === true,
		...stats(sections),
		sections,
		note: sliced.length < lines.length ? `文件超过 ${MAX_DIFF_LINES} 行，只显示了前 ${MAX_DIFF_LINES} 行` : "",
	};
}

/** 有差异之外的结论（改不了、没得比）时的空结果 */
function emptyDiff(path: string, flags: { created?: boolean; deleted?: boolean; note: string }): FileDiff {
	return {
		path,
		created: flags.created === true,
		deleted: flags.deleted === true,
		added: 0,
		removed: 0,
		sections: [],
		note: flags.note,
	};
}

/**
 * 把一轮差异排成终端里读得下去的文本（统一 diff 的样子）。
 *
 * 终端不像网页那样有行号两列与折叠，所以这里只给：文件头（`▸ 路径 +N −M`）、`@@` 段头、
 * 以及 `+` / `−` / 空格打头的行。`−` 用的是仓库约定的那个减号（与历史面板、确认卡片同符），
 * 免得同一个界面里三种减号。
 */
export function renderTurnDiff(
	seq: number,
	at: string,
	files: FileDiff[],
	omitted: { path: string; note: string }[],
): string {
	const lines: string[] = [`第 ${seq} 轮（${at}）改了 ${files.length} 个文件：`];
	for (const file of files) {
		const flags = `${file.created ? "（新建）" : ""}${file.deleted ? "（已删除）" : ""}`;
		lines.push(`▸ ${file.path} +${file.added} −${file.removed}${flags}`);
		if (file.sections.length === 0) {
			if (file.note !== "") {
				lines.push(`  ${file.note}`);
			}
			continue;
		}
		for (const section of file.sections) {
			lines.push(section.header);
			for (const line of section.lines) {
				lines.push(`${line.tag === "-" ? "−" : line.tag} ${line.text}`);
			}
		}
		if (file.note !== "") {
			lines.push(`  ${file.note}`);
		}
	}
	for (const item of omitted) {
		lines.push(`· ${item.path}：${item.note}`);
	}
	return lines.join("\n");
}
