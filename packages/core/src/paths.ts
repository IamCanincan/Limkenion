/**
 * 路径与工作目录的边界判定。
 *
 * 这个模块只讲一件事：**「这个路径算不算在工作目录里面」必须按真实路径判断**。
 * `resolve()` 只做词法归一化，`<cwd>/link -> C:\Windows` 这种符号链接（或 NTFS junction）会让
 * `<cwd>/link/System32/x.dll` 在字符串上看着还在目录里，实际落盘到别处。所以判定要先用
 * `realpathSync` 把链接拆开，再用 `path.relative` 比位置。
 *
 * 为什么不能只做字符串前缀比较，三条理由：
 * 1. 符号链接 / junction 可以指向任意位置，`startsWith` 完全看不出来；
 * 2. Windows 与 macOS 的文件系统大小写不敏感，`C:\Work` 与 `C:\work` 是同一个目录；
 * 3. `C:\a` 与 `C:\ab` 这种「前缀命中、其实是邻居」的假阳性。
 * `relative` 一次性解决第 2、3 条（它在 Windows 上按大小写不敏感比较），第 1 条靠 realpath。
 *
 * 两个判定函数并存，各有用处：
 * - `isOutsideWorkspace`：纯词法、不碰磁盘，供不需要 IO 的场景使用（也保留了历史行为）；
 * - `isOutsideWorkspaceReal`：解符号链接，审批这类「唯一防线」必须用它。
 *
 * 代价是 IO：一次判定要跑几次 `realpathSync`。工具调用与 HTTP 请求的频率下这点开销可以忽略，
 * 而它换来的是边界不再能被一个链接骗过。
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { describeError } from "limkenion-ai";
import { resolveUserPath } from "./tools/path.ts";

/**
 * 判断路径是否落在工作目录之外（**纯词法**，不解析符号链接）。
 *
 * 给不需要 IO 的场景用：它的结论对普通路径是对的，但 `<cwd>/link -> 外部` 这类链接会被
 * 误判成目录内。真正的边界判定请用 `isOutsideWorkspaceReal`。
 */
export function isOutsideWorkspace(path: string, cwd: string): boolean {
	const base = resolve(cwd);
	const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path);
	return absolute !== base && !absolute.startsWith(base + sep);
}

/**
 * 判断路径是否落在工作目录之外（**按真实路径**）。
 *
 * 与词法版本的两处差别，都是刻意的：
 * - 目标路径先 `realpath`（存在时解析链接，不存在时向上找最近的已存在祖先再拼回剩余段）；
 * - 工作目录本身也先 `realpath`，否则「cwd 自己就是链接」时两边不同源，比较结果没有意义。
 *
 * 顺带按 `resolveUserPath` 的规则展开 `~`：文件工具落盘时就是这么解析的，边界判定必须跟实际
 * 写入位置用同一套解析，否则 `~/x` 会一边被当成 `<cwd>/~/x`（看着在目录内）、一边写到主目录。
 *
 * 工作目录解析不了时（不存在、权限不足）退回词法比较：这是「保持原有行为」，不是放宽——
 * 之前所有情况都是词法比较，这里只是不因为多了 IO 就把某些场景变成误报。
 */
export function isOutsideWorkspaceReal(path: string, cwd: string): boolean {
	const root = realRootOf(cwd);
	const target = canonicalizePath(resolveUserPath(path, cwd));
	return isOutsideRoot(root, target);
}

/** 夹紧结果：通过时给出真实绝对路径，拒绝时给出能直接展示给用户的原因 */
export type PathClampResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * 把请求路径夹进工作目录，返回**真实**绝对路径。
 *
 * 相对路径以工作目录为基准，`~` 也照 `resolveUserPath` 的规则展开——但展开到主目录后照样要在
 * 这里过一遍边界，所以「用 `~/...` 读工作目录外的文件」同样会被拒绝：边界只有这一条。
 *
 * 调用方要拿返回的 `path` 去落盘，不要自己再解析一次：夹紧给出的就是最终的真实路径，中途重新
 * 解析等于给「检查完到写入之间把目录换成链接」留一道缝。
 */
export function clampPathToWorkspace(requested: string, cwd: string): PathClampResult {
	let root: string;
	try {
		root = realpathSync(cwd);
	} catch (error) {
		return { ok: false, error: `无法解析工作目录：${describeError(error)}` };
	}

	const target = canonicalizePath(resolveUserPath(requested, cwd));
	if (isOutsideRoot(root, target)) {
		return { ok: false, error: `路径越界：${target} 不在当前工作目录 ${root} 内` };
	}
	return { ok: true, path: target };
}

/**
 * 取真实路径：解析符号链接与 `..`。
 *
 * 目标还不存在时向上找到最近的已存在祖先，取它的真实路径再把剩下的名字拼回来——「新建文件」是
 * 常态，不能因为最后一段不存在就跳过链接解析，那样 `<cwd>/link/new.txt`（link 指向外部目录）
 * 会被误判成目录内。
 *
 * 一路到根都解析不了（权限或平台怪路径）时退回词法绝对路径，边界判定交给调用方。
 */
export function canonicalizePath(target: string): string {
	const absolute = resolve(target);
	const pending: string[] = [];
	let current = absolute;
	for (;;) {
		try {
			const real = realpathSync(current);
			return pending.length === 0 ? real : join(real, ...pending.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				return absolute;
			}
			pending.push(basename(current));
			current = parent;
		}
	}
}

/** 取工作目录的真实路径；解析不了就退回词法路径（见 `isOutsideWorkspaceReal` 的说明） */
function realRootOf(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

/**
 * 用 `relative` 而不是 `startsWith` 比位置。
 *
 * 结果为空表示就是根目录本身；等于 `..`、以 `..<sep>` 开头、或本身是绝对路径（跨盘符），
 * 都表示在根目录之外。注意只认这两种形态：目录名恰好叫 `..foo` 时 `relative`
 * 也会返回 `..foo`，那是根目录里的一个兄弟，不是越界。
 */
function isOutsideRoot(root: string, target: string): boolean {
	const offsets = relative(root, target);
	return offsets !== "" && (offsets === ".." || offsets.startsWith(`..${sep}`) || isAbsolute(offsets));
}
