/**
 * 危险命令的保守识别（只升不降）。
 *
 * 为什么需要它：`judgeToolUse` 对 bash 只能拿到 `command` 字符串，没有路径可判越界，于是 `auto`
 * 档下 `rm -rf /` 会被直接放行。这里的做法是
 * 在 token 层剥掉 `sudo` / `env` /
 * `nohup` / `timeout` 这类前缀与 `bash -lc "…"` 的内层命令，再看每个「简单命令」是不是危险。
 *
 * 三条边界必须先说清楚，否则这个模块会被误用：
 * 1. **这是保守启发式，只能用来「升高审批」，绝不能作为放行的依据。** 返回 false 只表示
 *    「没看出危险」，不表示命令安全；最终要不要执行仍由审批模式与用户确认决定。
 * 2. **动态拼装必然漏判，这是预期行为**：`cmd=rm; $cmd -rf /`、`find . -exec` 的某些写法、
 *    `eval "$(…)"` 里拼出来的字符串，静态都看不见。所以它只能加一层保险，不能替代沙箱。
 * 3. 只在 token 层做近似解析，不追求完整的 shell 语法。模糊时一律往「危险」靠：多问一次用户
 *    的代价远小于少问一次。
 */

/** 剥包装器时的递归深度上限；用满预算还看不透就 fail-closed 按危险处理 */
const MAX_WRAPPER_DEPTH = 8;

/** 是否在 Windows 上：那张 Windows 专用规则表只在那边生效，免得在 POSIX 上制造误报 */
const ON_WINDOWS = process.platform === "win32";

/** 会把命令字符串再执行一遍的 shell */
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** 能拉取远端内容的下载器：`curl … | sh` 的一半 */
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "aria2c"]);

/** `FOO=1 rm …` 的赋值前缀：它不改变要执行的命令，剥掉 */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 控制流关键字：`if …; then rm …; fi` 里 `then` / `do` 后面才是真正的命令 */
const LEADING_KEYWORDS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"while",
	"until",
	"do",
	"for",
	"in",
	"case",
	"esac",
	"fi",
	"done",
	"select",
	"function",
	"!",
]);

/** `:(){ :|:& };:` 这类叉子炸弹的经典写法 */
const CLASSIC_FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

/** 具名叉子炸弹：函数体里把自己管进自己并放到后台（`bomb(){ bomb|bomb& };bomb`） */
const NAMED_FORK_BOMB = /([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{[^{}]*\1[^{}]*\|[^{}]*\1[^{}]*&/;

/** 符号模式的 chmod 里给「其他人」加写权限：`o+w`、`a+rwx`、`go+rw` */
const SYMBOLIC_WORLD_WRITE = /^(?:a|o|go|ugo|u?go)[+=][rwxXst]*w[rwxXst]*$/i;

/** 会吃掉下一个 token 的 git 全局选项（`git -C dir reset`） */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** shell 自己会吃掉下一个 token 的选项（`bash -o pipefail -c '…'`） */
const SHELL_OPTIONS_WITH_VALUE = new Set(["-o", "+o", "--rcfile", "--init-file"]);

/** 前缀包装器：剥掉它才能看到真正要执行的命令 */
interface WrapperSpec {
	/** 会吃掉下一个 token 的选项（`sudo -u root`、`timeout -k 5`） */
	optionsWithValue: readonly string[];
	/** 剥完选项后再跳过一个操作数（`timeout 5 cmd` 的时长） */
	skipOperand?: boolean;
	/** 顺带跳过 `VAR=value` 赋值（`env FOO=1 cmd`） */
	skipAssignments?: boolean;
}

/** 前缀包装器表。都是「剥掉之后再看内层」的壳，本身不改变内层命令的破坏力。 */
const WRAPPERS: Record<string, WrapperSpec> = {
	sudo: {
		optionsWithValue: [
			"-u",
			"-g",
			"-p",
			"-C",
			"-h",
			"-r",
			"-t",
			"-U",
			"--user",
			"--group",
			"--prompt",
			"--chdir",
			"--host",
			"--role",
			"--type",
			"--other-user",
		],
	},
	doas: { optionsWithValue: ["-u", "-C"] },
	pkexec: { optionsWithValue: ["-u", "--user"] },
	env: { optionsWithValue: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"], skipAssignments: true },
	nohup: { optionsWithValue: [] },
	timeout: { optionsWithValue: ["-k", "-s", "--signal", "--kill-after"], skipOperand: true },
	nice: { optionsWithValue: ["-n", "--adjustment"] },
	ionice: { optionsWithValue: ["-c", "-n", "-p", "-P", "-u"] },
	stdbuf: { optionsWithValue: ["-i", "-o", "-e", "--input", "--output", "--error"] },
	setsid: { optionsWithValue: [] },
	time: { optionsWithValue: [] },
	command: { optionsWithValue: [] },
	builtin: { optionsWithValue: [] },
	exec: { optionsWithValue: ["-a"] },
	xargs: { optionsWithValue: ["-I", "-i", "-n", "-L", "-P", "-s", "-E", "-a", "-d"] },
};

/**
 * 判断一条命令看起来是否危险。
 *
 * **只能用来升档（放行 -> 询问），不能反过来当放行依据。** 见模块头部：false 只代表「没看出
 * 危险」，动态拼装的命令永远可能骗过它。
 */
export function looksDangerousCommand(command: string): boolean {
	const trimmed = command.trim();
	return trimmed === "" ? false : analyze(trimmed, 0);
}

/** 分析一段命令文本；`depth` 是「已经剥了几层会执行字符串的壳」 */
function analyze(text: string, depth: number): boolean {
	if (depth > MAX_WRAPPER_DEPTH) {
		// 壳套得深到看不透：fail-closed。宁可多问一次，也不在看不透的地方放行。
		return true;
	}
	if (CLASSIC_FORK_BOMB.test(text) || NAMED_FORK_BOMB.test(text)) {
		return true;
	}

	const segments = splitSegments(tokenize(text));
	if (pipesIntoShell(segments)) {
		return true;
	}
	for (const words of segments) {
		if (analyzeWords(words, depth)) {
			return true;
		}
	}

	// 命令替换 `$(…)` 与反引号里的内容也是会真的执行的命令（`echo "$(rm -rf /)"`）。
	for (const inner of substitutions(text)) {
		if (analyze(inner, depth + 1)) {
			return true;
		}
	}
	return false;
}

/** 分析一条「简单命令」：先剥前缀，再看是不是「执行字符串的壳」，最后比对规则 */
function analyzeWords(words: string[], depth: number): boolean {
	const budget = MAX_WRAPPER_DEPTH - depth;
	if (budget <= 0) {
		return true;
	}
	const unwrapped = unwrapPrefix(words, budget);
	if (unwrapped.exhausted) {
		// 预算用完时第一个词还是包装器：层数超过上限，看不透就按危险处理。
		return true;
	}
	if (unwrapped.words.length === 0) {
		return false;
	}
	const inner = innerCommandOf(unwrapped.words);
	if (inner !== null) {
		return analyze(inner, depth + 1);
	}
	return matchesDangerousRule(unwrapped.words);
}

/**
 * 剥掉开头的关键字、赋值与前缀包装器。
 *
 * `exhausted` 为 true 表示「预算用完但第一个词仍是包装器」——调用方要 fail-closed。
 */
function unwrapPrefix(words: string[], budget: number): { words: string[]; exhausted: boolean } {
	let list = dropPrefixNoise(words);
	for (let round = 0; round < budget; round += 1) {
		const spec = list.length > 0 ? WRAPPERS[executableName(list[0]!)] : undefined;
		if (!spec) {
			return { words: list, exhausted: false };
		}
		const stripped = stripWrapper(list, spec);
		if (stripped.length === 0) {
			return { words: [], exhausted: false };
		}
		list = stripped;
	}
	const stillWrapped = list.length > 0 && WRAPPERS[executableName(list[0]!)] !== undefined;
	return { words: list, exhausted: stillWrapped };
}

/** 反复丢掉开头的控制流关键字与 `VAR=value` 赋值 */
function dropPrefixNoise(words: string[]): string[] {
	let index = 0;
	while (index < words.length) {
		const word = words[index]!;
		if (LEADING_KEYWORDS.has(word) || ASSIGNMENT_PREFIX.test(word)) {
			index += 1;
			continue;
		}
		break;
	}
	return words.slice(index);
}

/** 剥掉一个包装器的选项，返回它后面真正要执行的命令 */
function stripWrapper(words: string[], spec: WrapperSpec): string[] {
	let index = 1;
	while (index < words.length) {
		const word = words[index]!;
		if (word === "--") {
			index += 1;
			break;
		}
		if (spec.skipAssignments && ASSIGNMENT_PREFIX.test(word)) {
			index += 1;
			continue;
		}
		if (!word.startsWith("-")) {
			break;
		}
		index += spec.optionsWithValue.includes(word) ? 2 : 1;
	}
	if (spec.skipOperand && index < words.length) {
		index += 1;
	}
	return words.slice(index);
}

/** 找出「会再执行一段字符串」的内层脚本：`bash -lc "…"` / `eval "…"` / `trap '…' EXIT` */
function innerCommandOf(words: string[]): string | null {
	const head = executableName(words[0] ?? "");
	if (head === "eval") {
		return words.length > 1 ? words.slice(1).join(" ") : null;
	}
	if (head === "trap") {
		let index = 1;
		if (words[index] === "--") {
			index += 1;
		}
		const action = words[index];
		return action !== undefined && !action.startsWith("-") ? action : null;
	}
	if (!SHELL_NAMES.has(head)) {
		return null;
	}
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index]!;
		if (word === "--" || (!word.startsWith("-") && !word.startsWith("+"))) {
			// `bash -- script.sh` / `bash script.sh`：后面是脚本文件名，不是命令串。
			return null;
		}
		if (SHELL_OPTIONS_WITH_VALUE.has(word)) {
			index += 1;
			continue;
		}
		if (!word.startsWith("--") && word.slice(1).includes("c")) {
			return words[index + 1] ?? null;
		}
	}
	return null;
}

/** 比对危险规则；`words[0]` 已经是剥完壳的命令名 */
function matchesDangerousRule(words: string[]): boolean {
	const head = executableName(words[0] ?? "");
	const args = words.slice(1);

	// `mkfs`、`mkfs.ext4`、`mkfs.xfs` …：格式化文件系统，没有「小范围」这一说。
	if (head.startsWith("mkfs")) {
		return true;
	}

	switch (head) {
		case "rm":
			return rmIsRecursiveDelete(args);
		case "git":
			return gitIsDestructive(args);
		case "chmod":
			return chmodIsWorldWritableRecursive(args);
		case "dd":
			return ddWritesDevice(args);
		default:
			return ON_WINDOWS && windowsDangerousMatch(head, args);
	}
}

/**
 * Windows 上同一类破坏性命令。
 *
 * 只在 Windows 上生效：`format`、`rd`、`del` 在 POSIX 上要么不存在，要么是完全无关的小工具
 * （`format` 在某些 Unix 上是文本排版命令），无条件判定会在那边制造纯粹的误报，
 * 这两张表按平台分开维护。
 */
function windowsDangerousMatch(head: string, args: string[]): boolean {
	switch (head) {
		case "format":
			return true;
		case "rd":
		case "rmdir":
			return hasCmdSwitch(args, "s") && hasCmdSwitch(args, "q");
		case "del":
		case "erase":
			return hasCmdSwitch(args, "s") && (hasCmdSwitch(args, "f") || hasCmdSwitch(args, "q"));
		case "remove-item":
		case "ri":
			return hasPowerShellSwitch(args, "-recurse") && hasPowerShellSwitch(args, "-force");
		default:
			return false;
	}
}

/**
 * `rm` 只要带「递归」就算危险，不论有没有 `-f`。
 *
 * 关于 `rm -rf build` 这种**相对路径**：同样算危险。理由是这里只拿到命令字符串、拿不到 cwd，
 * 无法判断 `build` 是不是指向别处的符号链接、是不是 `*` 展开、会不会跟着 `..` 跑出去；按字符串
 * 猜「这个路径应该在目录里」正是要修掉的那类自信。多问一次用户有代价，但比少问一次小。
 *
 * 为什么以「递归」而不是「强制」为准：不可逆的大范围破坏来自递归删除（`rm -r /` 没有 `-f`
 * 也一样毁东西），而 `-f` 单独出现（`rm -f one.log`）只是不弹确认，删的是明确列出的一两个文件。
 * 顺带说明：另一种口径是「只要带 `-f` 就算危险」，门槛正好相反；两种都覆盖 `rm -rf`，
 * 这里选递归是为了不在无人值守的 auto 档把 `rm -f 临时文件` 这类日常操作也拦下来。
 */
function rmIsRecursiveDelete(args: string[]): boolean {
	for (const argument of args) {
		if (argument === "--") {
			// `--` 之后全是文件名，不再是开关。
			break;
		}
		if (argument.startsWith("--")) {
			if (argument.toLowerCase() === "--recursive") {
				return true;
			}
			continue;
		}
		if (!argument.startsWith("-")) {
			continue;
		}
		// 小写化是为了同时认 PowerShell 风格的别名写法（`rm -Recurse -Force`）。
		if (argument.slice(1).toLowerCase().includes("r")) {
			return true;
		}
	}
	return false;
}

/** `git reset --hard` 丢工作区改动、`git clean -f` 删未跟踪文件：都不可逆 */
function gitIsDestructive(args: string[]): boolean {
	let index = 0;
	while (index < args.length) {
		const argument = args[index]!;
		if (GIT_OPTIONS_WITH_VALUE.has(argument)) {
			index += 2;
			continue;
		}
		if (argument.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}
	const subcommand = (args[index] ?? "").toLowerCase();
	const rest = args.slice(index + 1).map((argument) => argument.toLowerCase());
	if (subcommand === "reset") {
		return rest.includes("--hard");
	}
	if (subcommand === "clean") {
		const force = rest.some(
			(argument) => argument === "--force" || (argument.startsWith("-") && argument.slice(1).includes("f")),
		);
		const dryRun = rest.some(
			(argument) => argument === "--dry-run" || (argument.startsWith("-") && argument.slice(1).includes("n")),
		);
		return force && !dryRun;
	}
	return false;
}

/** 递归把权限放开到任何人可写（`chmod -R 777`）：等于把系统交给所有人 */
function chmodIsWorldWritableRecursive(args: string[]): boolean {
	let recursive = false;
	let worldWritable = false;
	for (const argument of args) {
		if (argument === "--") {
			break;
		}
		if (argument.startsWith("--")) {
			recursive ||= argument.toLowerCase() === "--recursive";
			continue;
		}
		if (argument.startsWith("-")) {
			const flags = argument.slice(1);
			recursive ||= flags.includes("R") || flags.includes("r");
			continue;
		}
		if (/^[0-7]*(?:777|666)$/.test(argument) || SYMBOLIC_WORLD_WRITE.test(argument)) {
			worldWritable = true;
		}
	}
	return recursive && worldWritable;
}

/** `dd of=/dev/…`：直接往块设备上写，没有撤销 */
function ddWritesDevice(args: string[]): boolean {
	return args.some((argument) => {
		const value = argument.toLowerCase();
		if (!value.startsWith("of=")) {
			return false;
		}
		const target = value.slice(3);
		return target.startsWith("/dev/") || target.startsWith("\\\\.\\");
	});
}

/** 管道把刚下载的内容直接喂给 shell 执行：`curl … | sh` */
function pipesIntoShell(segments: string[][]): boolean {
	let downloaded = false;
	for (const segment of segments) {
		const head = executableName(unwrapPrefix(segment, MAX_WRAPPER_DEPTH).words[0] ?? "");
		if (DOWNLOADERS.has(head)) {
			downloaded = true;
			continue;
		}
		if (downloaded && SHELL_NAMES.has(head)) {
			return true;
		}
	}
	return false;
}

/** 词法记号：一个词，或者一个操作符 */
interface Token {
	value: string;
	operator: boolean;
}

/**
 * 极简分词器：只处理引号、反斜杠转义与控制操作符。
 *
 * 不做变量展开、不做通配符展开——这正是本模块漏判 `$cmd -rf` 的根源，属于预期行为。
 */
function tokenize(command: string): Token[] {
	const tokens: Token[] = [];
	let word = "";
	let inWord = false;
	const flush = (): void => {
		if (inWord) {
			tokens.push({ value: word, operator: false });
			word = "";
			inWord = false;
		}
	};

	let index = 0;
	while (index < command.length) {
		const char = command[index]!;
		if (char === "'" || char === '"') {
			index += 1;
			while (index < command.length && command[index] !== char) {
				if (char === '"' && command[index] === "\\" && index + 1 < command.length) {
					word += command[index + 1];
					index += 2;
					continue;
				}
				word += command[index];
				index += 1;
			}
			// 跳过收尾引号；引号没闭合时自然结束。
			index += 1;
			inWord = true;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			word += command[index + 1];
			index += 2;
			inWord = true;
			continue;
		}
		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			flush();
			index += 1;
			continue;
		}
		const two = command.slice(index, index + 2);
		if (two === "&&" || two === "||" || two === ";;") {
			flush();
			tokens.push({ value: two, operator: true });
			index += 2;
			continue;
		}
		if (";|&(){}".includes(char)) {
			flush();
			tokens.push({ value: char, operator: true });
			index += 1;
			continue;
		}
		word += char;
		inWord = true;
		index += 1;
	}
	flush();
	return tokens;
}

/**
 * 按操作符切成「简单命令」。
 *
 * 所有操作符都当边界：`(a; b)`、`a && b` 拆开看，宁可多分析几条，也不漏掉其中一条。
 */
function splitSegments(tokens: Token[]): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	for (const token of tokens) {
		if (token.operator) {
			if (current.length > 0) {
				segments.push(current);
			}
			current = [];
			continue;
		}
		current.push(token.value);
	}
	if (current.length > 0) {
		segments.push(current);
	}
	return segments;
}

/**
 * 取出命令替换里的字符串。
 *
 * 单引号里的内容不展开、不执行，跳过；双引号里照常展开，所以要扫。
 */
function substitutions(text: string): string[] {
	const found: string[] = [];
	let single = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "'") {
			single = !single;
			continue;
		}
		if (single) {
			continue;
		}
		if (char === "`") {
			const end = text.indexOf("`", index + 1);
			if (end === -1) {
				break;
			}
			found.push(text.slice(index + 1, end));
			index = end;
			continue;
		}
		if (char === "$" && text[index + 1] === "(") {
			let depth = 1;
			let cursor = index + 2;
			while (cursor < text.length && depth > 0) {
				const inner = text[cursor]!;
				if (inner === "(") {
					depth += 1;
				} else if (inner === ")") {
					depth -= 1;
				}
				if (depth === 0) {
					break;
				}
				cursor += 1;
			}
			found.push(text.slice(index + 2, cursor));
			index = cursor;
		}
	}
	return found;
}

/** 取可执行文件名字：去掉目录、`\` 分隔与 Windows 的扩展名，统一小写 */
function executableName(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? "";
	const lowered = base.toLowerCase();
	for (const suffix of [".exe", ".cmd", ".bat", ".com", ".ps1"]) {
		if (lowered.endsWith(suffix)) {
			return lowered.slice(0, -suffix.length);
		}
	}
	return lowered;
}

/** cmd 风格的开关：`/s`、`/f`，以及合并写法 `/f/s/q` */
function hasCmdSwitch(args: string[], letter: string): boolean {
	return args.some((argument) => {
		const value = argument.toLowerCase();
		if (!value.startsWith("/")) {
			return false;
		}
		return value
			.slice(1)
			.split("/")
			.some((group) => group.includes(letter));
	});
}

/** PowerShell 风格的长开关（大小写不敏感） */
function hasPowerShellSwitch(args: string[], flag: string): boolean {
	return args.some((argument) => argument.toLowerCase() === flag);
}
