/**
 * bash 的只读判定：「这一条命令会不会改动东西」。
 *
 * 从前这件事是按**工具名**答的：审批层的 `READ_ONLY_TOOLS` 里没有 `bash`，于是只读档与计划模式
 * （严格）下连 `ls` 都跑不了，模型只能拿 read / grep / glob 硬凑。这里改成**逐条命令**判断：
 * 看的是这一次的入参，而不是「bash 这个工具危不危险」。
 *
 * 但**不引入 shell 解析器**：那份实现靠 tree-sitter-bash 的 WASM 与 130KB 的手写 bashParser，
 * 本仓库零依赖，抄不来也用不上。换来的是一条保守白名单：
 *
 * 1. 命令必须是**单条简单命令**：出现任何改变命令结构的东西（`;` `&` `|` `<` `>` `` ` `` `$(` `\`
 *    换行）就直接判「不是只读」。这一条把管道、重定向、命令替换、多命令一次性排除掉；
 * 2. 命令头必须落在白名单里，且少数命令额外禁用会写盘的开关（`find -delete`、`sort -o`…）；
 * 3. 解释器（node / python…）只在 `--version` 这类查询开关下算只读——`node -e` 是任意代码。
 *
 * 两种失败方向并不对称，所以整条判定只往「不算只读」那边倒：
 * - **漏判**（真只读的命令被当成会写）只是退化成今天的行为，没变好而已；
 * - **误判**（会写的命令被当成只读）会让只读档与计划模式（严格）当场失效。
 *
 * 因此白名单之外的命令一律返回 false，绝不猜、绝不用「大概」补齐。
 */

/**
 * 改变命令结构的东西。
 *
 * 注意 `$` 与反引号都算：`echo $(rm x)` 的命令头是 `echo`，真正跑的是括号里的东西。
 * `\\` 也算：`find . -exec rm {} \;` 里的转义分号就是靠它绕开 `;` 的。
 */
const STRUCTURAL = /[;&|<>`$()\n\r\\]/;

/** 无条件只读的命令头 */
const READ_ONLY_HEADS = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"stat",
	"file",
	"du",
	"df",
	"pwd",
	"whoami",
	"printenv",
	"which",
	"where",
	"type",
	"echo",
	"cut",
	"tr",
	"nl",
	"tac",
	"rev",
	"diff",
	"cmp",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"realpath",
	"basename",
	"dirname",
	"readlink",
	"grep",
	"rg",
	"fd",
	"bat",
	"jq",
]);

/**
 * 只在查询开关下才只读的解释器。
 *
 * `node -e "..."`、`python -c "..."` 都是任意代码，但 `node --version` 是纯粹的查询，
 * 而且它恰好是最常用的一条（确认工具链版本）。
 */
const VERSION_ONLY_HEADS = new Set([
	"node",
	"deno",
	"bun",
	"python",
	"python3",
	"perl",
	"ruby",
	"php",
	"go",
	"cargo",
	"java",
	"dotnet",
	"npm",
	"pnpm",
]);

/** 这些开关下算是「只问版本」。也接受 `-v`，但要求它是唯一一个词（见下） */
const VERSION_FLAGS = new Set(["--version", "-version", "--help", "-h"]);

/**
 * 命令头之外还要看开关的命令。
 *
 * `find` 会写盘（`-delete`、`-exec`），`sort` 的 `-o` 是输出文件，`tee` 不在白名单里所以不必管。
 */
const FORBIDDEN_ARGS: Record<string, string[]> = {
	find: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"],
};

/** 只读子命令的 git；`git config`、`git branch <name>`、`git tag <name>` 都会写，所以只认这些 */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"describe",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"blame",
	"shortlog",
	"cat-file",
	"whatchanged",
	"diff-tree",
	"diff-index",
	"diff-files",
	"name-rev",
	"merge-base",
	"symbolic-ref",
	"for-each-ref",
	"count-objects",
	"verify-pack",
	"grep",
	"grep-tree",
	"help",
]);

/** 取命令头：去掉目录、Windows 扩展名，统一小写（与 approval-memory.ts 同口径） */
function headOf(word: string): string {
	const base = word.split(/[\\/]/).pop() ?? "";
	const lowered = base.toLowerCase();
	for (const suffix of [".exe", ".cmd", ".bat", ".com", ".ps1"]) {
		if (lowered.endsWith(suffix)) {
			return lowered.slice(0, -suffix.length);
		}
	}
	return lowered;
}

/**
 * 判断一条命令是不是只读。
 *
 * 空命令返回 false：空命令没有意义，而「拿不准就当会写」是这里的默认答案。
 * 输入是模型给的原始字符串，**未做任何清洗**——含引号的参数照原样进来，判定只看词。
 */
export function looksReadOnlyCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed === "" || STRUCTURAL.test(trimmed)) {
		return false;
	}

	const words = trimmed.split(/\s+/).filter((word) => word !== "");
	const head = words[0];
	if (head === undefined) {
		return false;
	}
	const name = headOf(head);
	const rest = words.slice(1);

	if (VERSION_ONLY_HEADS.has(name)) {
		// 只接受「一个查询开关，别的什么都没有」：多一个操作数就可能是 `node script.mjs`。
		return rest.length === 1 && VERSION_FLAGS.has((rest[0] ?? "").toLowerCase());
	}

	if (name === "git") {
		const sub = rest[0];
		return sub !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(sub.toLowerCase());
	}

	if (!READ_ONLY_HEADS.has(name) && name !== "find") {
		return false;
	}

	const forbidden = FORBIDDEN_ARGS[name];
	if (forbidden !== undefined) {
		for (const word of rest) {
			if (forbidden.includes(word.toLowerCase())) {
				return false;
			}
		}
	}
	return true;
}
