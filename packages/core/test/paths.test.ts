/**
 * 路径边界判定的单元测试。
 *
 * 这些用例必须碰真实文件系统：符号链接 / junction 正是「字符串前缀比较」看不见的东西，用假路径
 * 测不出真实行为。每个用例在临时目录里建一小棵树，跑完删掉。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizePath, clampPathToWorkspace, isOutsideWorkspace, isOutsideWorkspaceReal } from "../src/paths.ts";

const dirs: string[] = [];

/** 建一个用完就删的临时目录 */
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * 目录链接探针：Windows 上用 junction（不需要管理员权限），POSIX 上用普通符号链接。
 * 受限环境里连 junction 都建不了时，相关用例整体跳过——跳过而不是假装通过。
 */
const CAN_LINK = (() => {
	const base = tempDir("limkenion-link-probe-");
	mkdirSync(join(base, "target"));
	try {
		symlinkSync(join(base, "target"), join(base, "link"), process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch {
		return false;
	}
})();

describe("普通路径", () => {
	it("工作目录内的路径不算越界，绝对与相对都成立", () => {
		const root = tempDir("limkenion-paths-");
		expect(isOutsideWorkspaceReal("src/a.ts", root)).toBe(false);
		expect(isOutsideWorkspaceReal(join(root, "src", "a.ts"), root)).toBe(false);
		// 工作目录本身不算「越界」。
		expect(isOutsideWorkspaceReal(".", root)).toBe(false);
		// 还不存在的路径（正准备新建）也在目录内。
		expect(isOutsideWorkspaceReal("a/b/c.txt", root)).toBe(false);
	});

	it("`..` 走出工作目录被判越界", () => {
		const root = tempDir("limkenion-paths-");
		expect(isOutsideWorkspaceReal("..", root)).toBe(true);
		expect(isOutsideWorkspaceReal("src/../../x.ts", root)).toBe(true);
		expect(isOutsideWorkspaceReal(join(root, "..", "x.ts"), root)).toBe(true);
	});

	it("邻居目录名带相同前缀时不会误判（`proj` 与 `proj-other`）", () => {
		const parent = tempDir("limkenion-paths-");
		const root = join(parent, "proj");
		const sibling = join(parent, "proj-other");
		mkdirSync(root);
		mkdirSync(sibling);
		writeFileSync(join(sibling, "x.ts"), "x", "utf-8");
		expect(isOutsideWorkspaceReal(join(sibling, "x.ts"), root)).toBe(true);
	});

	it("名字以 `..` 开头的兄弟目录是目录内，不是越界", () => {
		const root = tempDir("limkenion-paths-");
		const odd = join(root, "..odd");
		mkdirSync(odd);
		writeFileSync(join(odd, "x.ts"), "x", "utf-8");
		// `path.relative` 会返回 `..odd`：它看着像 `..`，其实是目录里的一个兄弟。
		expect(isOutsideWorkspaceReal(join(odd, "x.ts"), root)).toBe(false);
	});
});

describe("符号链接 / junction", () => {
	it.skipIf(!CAN_LINK)("指向工作目录外的链接被判越界，而纯词法版本会被它骗过", () => {
		const base = tempDir("limkenion-paths-");
		const root = join(base, "work");
		const outside = join(base, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "s", "utf-8");
		symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");

		// 这正是要修的洞：字符串前缀比较认为 `<root>/link/secret.txt` 在目录内。
		expect(isOutsideWorkspace(join("link", "secret.txt"), root)).toBe(false);
		// 按真实路径判定就看得见。
		expect(isOutsideWorkspaceReal(join("link", "secret.txt"), root)).toBe(true);
		// 还不存在的新文件走「最近的已存在祖先」，同样看得出来（`<root>/link/new.txt`）。
		expect(isOutsideWorkspaceReal(join("link", "new", "a.txt"), root)).toBe(true);
		// 链接本身（它指向外部）也算越界。
		expect(isOutsideWorkspaceReal("link", root)).toBe(true);
		// 而夹紧直接拒绝，并把真实路径报出来。
		const clamped = clampPathToWorkspace(join("link", "secret.txt"), root);
		expect(clamped.ok).toBe(false);
	});

	it.skipIf(!CAN_LINK)("工作目录自己就是链接时，比较的两边仍然同源", () => {
		const base = tempDir("limkenion-paths-");
		const real = join(base, "real");
		const outer = join(base, "outer");
		mkdirSync(real);
		mkdirSync(outer);
		writeFileSync(join(real, "a.txt"), "a", "utf-8");
		writeFileSync(join(outer, "b.txt"), "b", "utf-8");
		const linkedRoot = join(base, "cwd-link");
		symlinkSync(real, linkedRoot, process.platform === "win32" ? "junction" : "dir");

		expect(isOutsideWorkspaceReal("a.txt", linkedRoot)).toBe(false);
		expect(isOutsideWorkspaceReal(join(outer, "b.txt"), linkedRoot)).toBe(true);
	});
});

describe("canonicalize 与夹紧", () => {
	it("不存在的目标拼在最近已存在祖先的真实路径之后", () => {
		const root = tempDir("limkenion-paths-");
		const expected = join(realpathSync(root), "a", "b", "c.txt");
		expect(canonicalizePath(join(root, "a", "b", "c.txt"))).toBe(expected);
		expect(canonicalizePath(join(root, "a", "..", "b", "c.txt"))).toBe(join(realpathSync(root), "b", "c.txt"));
	});

	it("通过时把请求路径换成真实绝对路径", () => {
		const root = tempDir("limkenion-paths-");
		const clamped = clampPathToWorkspace("src/a.ts", root);
		expect(clamped.ok).toBe(true);
		expect(clamped.ok ? clamped.path : "").toBe(join(realpathSync(root), "src", "a.ts"));
	});

	it("越界时给出可读原因，且不返回路径", () => {
		const root = tempDir("limkenion-paths-");
		const clamped = clampPathToWorkspace("../x.ts", root);
		expect(clamped.ok).toBe(false);
		expect(clamped.ok ? "" : clamped.error).toContain("路径越界");
	});
});
