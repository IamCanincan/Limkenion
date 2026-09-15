/**
 * 行级 diff 的单元测试。
 *
 * 这一份算法有三个消费者：「历史」面板的逐轮差异（`web/feature-history.ts`）、工具确认卡片上的
 * 「改动片段」（`web/runs.ts`）与终端的 `/diff`（`repl.ts`）。从前它们各有一份实现
 * （服务端 LCS、网页「去掉首尾相同的行」），所以这里把口径钉住：哪一侧是旧、行号怎么算、
 * 段头怎么写、截断了怎么说。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	APPROVAL_DIFF_LINES,
	diffSegments,
	diffTurn,
	guardPath,
	MAX_DIFF_LINES,
	renderTurnDiff,
	replacementDiff,
	splitLines,
	stats,
	toSections,
} from "../src/diff.ts";

let cwd = "";

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "limkenion-diff-"));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

/** 把一行压成 `符号+行号 内容`，断言写起来短一些 */
function show(line: { tag: string; oldLine: number | null; newLine: number | null; text: string }): string {
	return `${line.tag}${line.oldLine ?? "-"}/${line.newLine ?? "-"} ${line.text}`;
}

describe("行级 diff（历史面板与审批卡片共用）", () => {
	it("削掉公共前后缀，只对中间那段做 LCS", () => {
		const tagged = diffSegments(["a", "b", "c", "d"], ["a", "B", "c", "d"]);
		expect(tagged.map((line) => `${line.tag}${line.text}`)).toEqual([" a", "-b", "+B", " c", " d"]);
	});

	it("内容一致时不编出一段假 hunk（全是不变的上下文行就是假差异）", () => {
		expect(diffSegments(["a", "b"], ["a", "b"])).toEqual([]);
	});

	it("行号在算的这一步编好：改动行只在一侧有行号", () => {
		const sections = toSections(diffSegments(["a", "b", "c", "d"], ["a", "B", "c", "d"]), Number.POSITIVE_INFINITY);
		expect(sections).toHaveLength(1);
		expect(sections[0]?.header).toBe("@@ -1,4 +1,4 @@");
		expect(sections[0]?.lines.map(show)).toEqual([" 1/1 a", "-2/- b", "+-/2 B", " 3/3 c", " 4/4 d"]);
		expect(stats(sections)).toEqual({ added: 1, removed: 1 });
	});

	it("相隔很远的两处改动切成两段，各带自己的段头", () => {
		const before = Array.from({ length: 40 }, (_, index) => `第 ${index} 行`);
		const after = [...before];
		after[1] = "改过的第 1 行";
		after[38] = "改过的第 38 行";
		const sections = toSections(diffSegments(before, after), Number.POSITIVE_INFINITY);
		expect(sections).toHaveLength(2);
		expect(sections[0]?.header.startsWith("@@ -1,")).toBe(true);
		expect(sections[1]?.header.startsWith("@@ -36,")).toBe(true);
	});

	it("按行切分时认两种行尾，末尾换行不算多一行", () => {
		expect(splitLines("一\r\n二\n三\n")).toEqual(["一", "二", "三"]);
		expect(splitLines("")).toEqual([]);
	});
});

describe("审批卡片的「改动片段」（replacementDiff）", () => {
	it("磁盘上还没有这个文件：整份都是新增，也不编一句「无差异」", () => {
		const change = replacementDiff("note.txt", "第一行\n第二行", cwd);
		expect(change).toMatchObject({ path: "note.txt", created: true, added: 2, removed: 0, note: "" });
		expect(change.sections).toHaveLength(1);
		expect(change.sections[0]?.lines.map(show)).toEqual(["+-/1 第一行", "+-/2 第二行"]);
	});

	it("覆盖已有文件：− 是会被盖掉的，+ 是写进去的", async () => {
		await writeFile(join(cwd, "note.txt"), "第一行\n旧的第二行\n第三行\n", "utf-8");
		const change = replacementDiff("note.txt", "第一行\n新的第二行\n第三行\n第四行\n", cwd);
		expect(change).toMatchObject({ created: false, added: 2, removed: 1 });
		const shown = change.sections.flatMap((section) => section.lines).map((line) => `${line.tag} ${line.text}`);
		expect(shown).toEqual(["  第一行", "- 旧的第二行", "+ 新的第二行", "  第三行", "+ 第四行"]);
	});

	it("与磁盘上逐行相同：给一句人话，而不是一块空白的 diff", async () => {
		await writeFile(join(cwd, "note.txt"), "一样\n", "utf-8");
		const change = replacementDiff("note.txt", "一样", cwd);
		expect(change.sections).toEqual([]);
		expect(change.note).toContain("逐行相同");
		expect(change.added).toBe(0);
	});

	it("不是文本（二进制）就不做比较，并说清原因", async () => {
		await writeFile(join(cwd, "blob.bin"), Buffer.from([0x01, 0x00, 0x02, 0x03, 0x00]));
		const change = replacementDiff("blob.bin", "x", cwd);
		expect(change.sections).toEqual([]);
		expect(change.note).toContain("不是文本文件");
	});

	it("越界路径不展开对比（也不去读那个文件）", () => {
		const change = replacementDiff(join(cwd, "..", "outside.txt"), "x", cwd);
		expect(change.sections).toEqual([]);
		expect(change.note).toContain("工作目录之外");
	});

	it("改动太多时截断，但卡片上的统计仍是全量，并说清还有多少行没展开", async () => {
		const many = 200;
		const before = Array.from({ length: many }, (_, index) => `旧 ${index}`);
		const after = Array.from({ length: many }, (_, index) => `新 ${index}`);
		await writeFile(join(cwd, "big.txt"), before.join("\n"), "utf-8");

		const change = replacementDiff("big.txt", after.join("\n"), cwd);
		const drawn = change.sections.reduce((total, section) => total + section.lines.length, 0);
		expect(drawn).toBeLessThanOrEqual(APPROVAL_DIFF_LINES);
		expect(change.sections.some((section) => section.truncated)).toBe(true);
		expect(change.sections.at(-1)?.lines.at(-1)?.text).toContain("未展开");
		// 统计是全量：显示出来的那 20 来行不代表改了多少
		expect(change.added).toBe(many);
		expect(change.removed).toBe(many);
		expect(change.note).toContain("只显示了前面一段");
	});

	it("超过比较上限的长文件：不把「只比了前 N 行」说成「完全一样」", async () => {
		const long = Array.from({ length: MAX_DIFF_LINES + 10 }, (_, index) => `行 ${index}`);
		await writeFile(join(cwd, "long.txt"), long.join("\n"), "utf-8");

		// 唯一的变化在比较范围之外：不能报「逐行相同」，那是在替比较范围打包票
		const beyond = replacementDiff("long.txt", `${long.join("\n")}\n最后一行`, cwd);
		expect(beyond.sections).toEqual([]);
		expect(beyond.note).toContain(`只比较了前 ${MAX_DIFF_LINES} 行`);

		// 范围之内有改动时，截断说明与差异一起给出来
		const inside = replacementDiff("long.txt", ["改过的第一行", ...long.slice(1)].join("\n"), cwd);
		expect(inside.sections.length).toBeGreaterThan(0);
		expect(inside.note).toContain(`只比较了前 ${MAX_DIFF_LINES} 行`);
	});

	it("guardPath：相对路径解到工作目录内，越界返回 null", () => {
		expect(guardPath("a/b.txt", cwd)).toBe(join(cwd, "a", "b.txt"));
		expect(guardPath(join(cwd, "a", "b.txt"), cwd)).toBe(join(cwd, "a", "b.txt"));
		expect(guardPath(join(cwd, "..", "x.txt"), cwd)).toBeNull();
	});
});

/*
 * 一轮快照的差异：「历史」面板（网页）与 `/diff`（终端）共用 `diffTurn`，
 * 排版各自负责——网页按段画两列行号，终端排成文本。
 */
describe("一轮快照的差异（历史面板与终端 /diff 共用）", () => {
	it("方向是「快照 → 现在」：− 是这一轮删掉的，+ 是这一轮加上的", async () => {
		await writeFile(join(cwd, "note.txt"), "第一行\n新的第二行\n第三行\n", "utf-8");
		const { files } = diffTurn(
			{
				seq: 3,
				at: "2026-09-15T10:00:00.000Z",
				files: [{ path: join(cwd, "note.txt"), content: "第一行\n旧的第二行\n第三行\n", existed: true }],
			},
			cwd,
		);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({ created: false, deleted: false, added: 1, removed: 1 });
		expect(files[0]?.sections[0]?.header).toBe("@@ -1,3 +1,3 @@");
	});

	it("新建与删除的文件整份给出来", async () => {
		await writeFile(join(cwd, "new.txt"), "甲\n乙\n", "utf-8");
		const created = diffTurn(
			{ seq: 1, at: "t", files: [{ path: join(cwd, "new.txt"), content: null, existed: false }] },
			cwd,
		);
		expect(created.files[0]).toMatchObject({ created: true, added: 2, removed: 0 });

		// 快照里有旧内容、磁盘上却没有：这一轮把它删了
		const deleted = diffTurn(
			{ seq: 1, at: "t", files: [{ path: join(cwd, "gone.txt"), content: "甲\n", existed: true }] },
			cwd,
		);
		expect(deleted.files[0]).toMatchObject({ deleted: true, added: 0, removed: 1 });
	});

	it("越界的路径不算（也不去读那个文件）", () => {
		const { files } = diffTurn(
			{ seq: 1, at: "t", files: [{ path: join(cwd, "..", "outside.txt"), content: "x", existed: true }] },
			cwd,
		);
		expect(files).toEqual([]);
	});

	it("requested 只算那一个文件；行数预算撞上就记进 omitted", async () => {
		await writeFile(join(cwd, "a.txt"), "一\n二\n", "utf-8");
		const snapshot = {
			seq: 1,
			at: "t",
			files: [
				{ path: join(cwd, "a.txt"), content: "一\n旧二\n", existed: true },
				{ path: join(cwd, "b.txt"), content: "一\n", existed: true },
			],
		};
		expect(diffTurn(snapshot, cwd, { requested: join(cwd, "a.txt") }).files.map((file) => file.path)).toEqual([
			join(cwd, "a.txt"),
		]);
		// 一行都不给：两个文件都要说清「为什么没有它」，而不是静默少一个
		const limited = diffTurn(snapshot, cwd, { maxLines: 0 });
		expect(limited.files).toEqual([]);
		expect(limited.omitted).toHaveLength(2);
		expect(limited.omitted[0]?.note).toContain("上限");
	});

	it("终端排版：文件头 + @@ 段头 + − / + 两种符号", async () => {
		await writeFile(join(cwd, "note.txt"), "第一行\n新的第二行\n", "utf-8");
		const { files, omitted } = diffTurn(
			{
				seq: 2,
				at: "2026-09-15T10:00:00.000Z",
				files: [{ path: join(cwd, "note.txt"), content: "第一行\n旧的第二行\n", existed: true }],
			},
			cwd,
		);
		const text = renderTurnDiff(2, "2026-09-15T10:00:00.000Z", files, omitted);
		expect(text).toContain("第 2 轮");
		expect(text).toContain("note.txt +1 −1");
		expect(text).toContain("@@ -1,2 +1,2 @@");
		expect(text).toContain("− 旧的第二行");
		expect(text).toContain("+ 新的第二行");
	});

	it("终端排版：没有可画的差异时给出原因，而不是一个空标题", async () => {
		await writeFile(join(cwd, "same.txt"), "一样\n", "utf-8");
		const { files, omitted } = diffTurn(
			{ seq: 1, at: "t", files: [{ path: join(cwd, "same.txt"), content: "一样\n", existed: true }] },
			cwd,
		);
		const text = renderTurnDiff(1, "t", files, omitted);
		expect(text).toContain("与当前内容一致");
	});
});
