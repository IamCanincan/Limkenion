/**
 * 项目指令文件的发现与读取。
 *
 * 全局配置目录下的 AGENTS.md 放跨项目的个人偏好；项目内则从工作目录沿路径向上查找。
 * 这样仓库里已有的 AGENTS.md 会被自动遵守，不必每次在对话里重复交代。
 *
 * 三条容易踩错的规则：
 * 1. 项目侧**逐目录**解析，而不是全局只认一个文件名。从工作目录向上走到仓库根，每个目录
 *    各自按 AGENTS.override.md、AGENTS.md、CONTEXT.md 的顺序取第一个存在的文件；
 *    一个目录里都没有就跳过这个目录。因此不同目录可以贡献不同文件名、各自生效。
 * 2. AGENTS.override.md 是**替换**而非叠加：它只顶掉**同一目录**里的其他候选文件，父目录的
 *    说明照旧注入（这正是上面「每个目录第一个存在的胜出」的效果）。
 * 3. 注入顺序沿用「由近到远」：越靠近工作目录的文件排在越前，仓库根排在最后。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sliceByBytes } from "./text.ts";

/** 一份要注入的指令文件 */
export interface InstructionFile {
	/** 绝对路径，注入时会标出，便于模型知道说明来自哪一层 */
	path: string;
	content: string;
}

/** 发现参数 */
export interface DiscoverInstructionsOptions {
	/** 工作目录，从这里向上查找 */
	cwd: string;
	/** 全局配置目录；它的 AGENTS.md 作为全局指令，不传则跳过全局这一层 */
	globalConfigDir?: string;
	/** 单个文件的字节上限，超出即截断 */
	maxFileBytes?: number;
	/** 所有文件合计的字节上限，超出即停止追加 */
	maxTotalBytes?: number;
}

/** 项目侧每个目录内按顺序尝试的文件名；第一个存在的胜出，AGENTS.override.md 因此能顶掉同目录其他候选 */
const PROJECT_INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md", "CONTEXT.md"];

/** 全局配置目录里按顺序尝试的文件名 */
const GLOBAL_INSTRUCTION_FILES = ["AGENTS.md"];

/** 默认单文件上限 */
const DEFAULT_MAX_FILE_BYTES = 32 * 1024;

/** 默认合计上限 */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024;

/** 截断标记 */
const TRUNCATED_MARKER = "\n\n[内容过长已截断]";

/**
 * 向上找到 git 仓库根。
 *
 * 这是查找指令文件的边界：不越过仓库根，避免把用户主目录或盘符根上的东西读进来。
 * 找不到 .git 时退回文件系统根。
 */
export function findGitRoot(start: string): string {
	let current = resolve(start);
	for (;;) {
		if (existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return current;
		}
		current = parent;
	}
}

/** 工作目录是否位于 git 仓库内 */
export function isGitRepo(cwd: string): boolean {
	return existsSync(join(findGitRoot(cwd), ".git"));
}

/**
 * 从 from 向上走到 to（含）为止，收集每个目录里第一个存在的候选文件名，顺序为由近到远。
 *
 * 每个目录独立判断：某个目录里 AGENTS.md 存在，并不妨碍下层目录贡献自己的 CONTEXT.md。
 */
function collectUpward(from: string, to: string, names: string[]): string[] {
	const found: string[] = [];
	let current = resolve(from);
	const root = resolve(to);
	for (;;) {
		for (const name of names) {
			const candidate = join(current, name);
			if (existsSync(candidate)) {
				found.push(candidate);
				break;
			}
		}
		if (current === root) {
			break;
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return found;
}

/** 读取一个文件；目录、不可读都返回 null */
function readInstructionFile(path: string): InstructionFile | null {
	try {
		if (!statSync(path).isFile()) {
			return null;
		}
		return { path: resolve(path), content: readFileSync(path, "utf-8") };
	} catch {
		return null;
	}
}

/**
 * 发现要注入的指令文件。
 *
 * 顺序为全局在前、项目在后（项目更贴近当前任务，放在后面让模型最后读到）。
 *
 * 容量处理有两条规则：单文件超过 maxFileBytes 就地截断；合计放不下时，如果已经有文件
 * 进去了就直接放弃后续文件，而不是把下一个文件切成半条规则——半条规则比没有更容易误导模型。
 */
export function discoverInstructions(options: DiscoverInstructionsOptions): InstructionFile[] {
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	const paths: string[] = [];

	// 全局层：第一个存在的胜出。
	if (options.globalConfigDir) {
		const globalCandidates = GLOBAL_INSTRUCTION_FILES.map((name) => join(options.globalConfigDir ?? "", name));
		for (const candidate of globalCandidates) {
			if (existsSync(candidate)) {
				paths.push(candidate);
				break;
			}
		}
	}

	// 项目层：逐目录解析，每个目录取第一个存在的候选文件名，整体顺序为由近到远。
	const gitRoot = findGitRoot(options.cwd);
	paths.push(...collectUpward(options.cwd, gitRoot, PROJECT_INSTRUCTION_FILES));

	const result: InstructionFile[] = [];
	let total = 0;
	for (const path of paths) {
		const remaining = maxTotalBytes - total;
		if (remaining <= 0) {
			break;
		}
		const file = readInstructionFile(path);
		if (!file) {
			continue;
		}

		const capped = sliceByBytes(file.content, maxFileBytes);
		const content = capped === file.content ? capped : `${capped}${TRUNCATED_MARKER}`;
		const size = Buffer.byteLength(content, "utf-8");

		if (size <= remaining) {
			result.push({ path: file.path, content });
			total += size;
			continue;
		}
		// 放不下。第一个文件按剩余空间截断保留，否则整个放弃。
		if (result.length === 0) {
			result.push({
				path: file.path,
				content: `${sliceByBytes(content, remaining)}${TRUNCATED_MARKER}`,
			});
		}
		break;
	}
	return result;
}
