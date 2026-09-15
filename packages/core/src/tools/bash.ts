/**
 * bash 工具：执行 shell 命令。
 *
 * 这是所有工具里唯一能产生任意副作用的，因此限制写得比较明确：有超时、有输出上限，
 * 超限就杀掉进程，避免 `yes` 之类把内存吃光。
 *
 * 它也是唯一**按入参**自陈只读性的工具：`ls` 与 `rm` 是同一个工具，只读与否取决于命令。
 * 判定交给 `permissions/readonly-command.ts` 的保守白名单——这条自陈直接决定「只读档位与计划
 * 模式（严格）下能不能跑」，所以它宁可漏判（退化成以前的行为）也绝不误判。
 */

import { spawn } from "node:child_process";
import { looksDangerousCommand } from "../permissions/danger.ts";
import { looksReadOnlyCommand } from "../permissions/readonly-command.ts";
import { DETACH_FOR_KILL, decodeProcessOutput, killProcessTree } from "../process.ts";
import { sliceByBytes } from "../text.ts";
import { defineTool } from "./contract.ts";
import { formatSize, MAX_OUTPUT_BYTES, resolveUserPath } from "./path.ts";

/** 默认超时 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 输出超过上限的多少倍才认定是「输出洪流」并终止命令 */
const RUNAWAY_MULTIPLIER = 20;

/** bash 工具的可配置项 */
export interface BashToolOptions {
	/** 工作目录 */
	cwd: string;
	/** 超时毫秒数 */
	timeoutMs?: number;
	/** 输出字节上限 */
	maxBytes?: number;
}

/** 取命令字符串；非字符串或空白都返回空串 */
function commandOf(input: Record<string, unknown>): string {
	return typeof input.command === "string" ? input.command.trim() : "";
}

/** 选择 shell。Windows 用 cmd，其它平台优先使用用户自己的 $SHELL。 */
function resolveShell(): { command: string; args: (input: string) => string[] } {
	if (process.env.LIMKENION_SHELL) {
		return { command: process.env.LIMKENION_SHELL, args: (input) => ["-c", input] };
	}
	if (process.platform === "win32") {
		return { command: "cmd.exe", args: (input) => ["/d", "/s", "/c", input] };
	}
	return { command: process.env.SHELL || "/bin/sh", args: (input) => ["-c", input] };
}

/** 创建 bash 工具 */
export function createBashTool(options: BashToolOptions) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
	const readOnly = (input: Record<string, unknown>): boolean => looksReadOnlyCommand(commandOf(input));

	return defineTool({
		name: "bash",
		// 声明**解析后**的值，不是那个默认常量：调用方给了更长的超时，`withToolTimeout` 就得按它等，
		// 否则调用方的预算形同虚设——声明与执行用了两个数，是重构时踩到的。
		timeoutMs,
		description:
			"在工作目录中执行一条 shell 命令并返回输出。支持管道与重定向。" +
			`命令有 ${(timeoutMs / 1000).toFixed(timeoutMs < 1000 ? 1 : 0)} 秒超时；输出超过 ${formatSize(maxBytes)} 时` +
			`**保留头尾、省略中间**（测试与构建的结论通常在尾部），只有超过 ${RUNAWAY_MULTIPLIER} 倍的输出洪流才终止进程。` +
			"只读的命令（ls / cat / grep / git status 这类）在只读档位与计划模式下也能跑。",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "要执行的 shell 命令" },
				workdir: {
					type: "string",
					description: "命令的工作目录，缺省使用 agent 的工作目录。必须是已存在的目录。",
				},
			},
			required: ["command"],
		},
		isReadOnly: readOnly,
		// 只读的命令之间互不影响，可以并排跑；会写的命令独占一批。
		isConcurrencySafe: readOnly,
		/**
		 * 「看起来不可逆」直接用内核那条危险命令启发式，**不再让界面另抄一份正则清单**。
		 *
		 * 从前网页的 `render.js` 里有一份 `DESTRUCTIVE_PATTERNS`（rm -rf / format / diskpart /
		 * git reset --hard …），审批层又有 `permissions/danger.ts`——同一件事的两份拷贝，改一处
		 * 另一处不会跟着变。现在只有这一份，界面只负责把标出来的那行画醒目一点。
		 *
		 * 它**只影响界面提示**，不参与判定：判定链早就在更前面用同一个启发式把这类命令升到 ask 了。
		 */
		isDestructive: (input) => {
			const command = commandOf(input);
			return command !== "" && looksDangerousCommand(command);
		},
		summarize: (input) => commandOf(input),
		// 确认卡片给**命令原文**：用户要照着它自己核一遍，摘要那一行的截断在这里不合适。
		describeApproval: (input) => {
			const command = commandOf(input);
			return command === "" ? "" : `将要执行：\n$ ${command}`;
		},
		// 声明要跑的目录：在工作目录之外执行命令同样要确认——从前 bash 不参与越界判定，
		// 于是「换个目录跑任意命令」是绕过工作目录边界的现成通道。
		pathOf: (input) => {
			const workdir = typeof input.workdir === "string" ? input.workdir.trim() : "";
			return workdir === "" ? null : workdir;
		},
		validate: (input) => (commandOf(input) === "" ? { ok: false, message: "缺少必填参数 command" } : { ok: true }),
		async execute(input, signal) {
			const command = commandOf(input);
			const cwd =
				typeof input.workdir === "string" && input.workdir.trim() !== ""
					? resolveUserPath(input.workdir, options.cwd)
					: options.cwd;
			return runCommand(command, cwd, timeoutMs, maxBytes, signal);
		},
	});
}

/** 真正跑命令并收集输出 */
function runCommand(
	command: string,
	cwd: string,
	timeoutMs: number,
	maxBytes: number,
	signal: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
	return new Promise((resolvePromise) => {
		// 真正的「输出洪流」阈值：到这儿才杀进程。中等程度的超限（跑一遍全量测试、装一次依赖）
		// 不杀，改成省略中间——否则为了看结论得把同一条命令再跑一次，白等一轮。
		const hardCap = maxBytes * RUNAWAY_MULTIPLIER;
		const shell = resolveShell();
		// POSIX 下让子进程成为进程组组长，这样能一次杀掉整棵进程树；Windows 用 taskkill /T。
		const child = spawn(shell.command, shell.args(command), {
			cwd,
			env: process.env,
			windowsHide: true,
			detached: DETACH_FOR_KILL,
			// Windows 上必须给这个标志：否则 cmd.exe /d /s /c 会把整条命令按自己的规则重新拆词，
			// node -e "console.log(1)" 这类带引号的命令会静默不执行（退出码 0、无输出）。实测踩到。
			windowsVerbatimArguments: process.platform === "win32",
		});

		// 攒 Buffer 而不是攒字符串：按块 toString 会把跨块的多字节字符截成乱码，
		// 而且要先拿到整段才能判断是 UTF-8 还是系统代码页（见 decodeProcessOutput）。
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let bytes = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;

		const finish = (exitCode: number | null, failure?: string): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);

			const stdout = decodeProcessOutput(Buffer.concat(stdoutChunks));
			const stderr = decodeProcessOutput(Buffer.concat(stderrChunks));
			const parts: string[] = [];
			// 每个流各分一半预算，超了就省略中间（头尾都留）
			const perStream = Math.ceil(maxBytes / 2);
			const out = middleTruncate(stdout, perStream);
			const err = middleTruncate(stderr, perStream);
			if (out.text !== "") {
				parts.push(out.text);
			}
			if (err.text !== "") {
				parts.push(`[stderr]\n${err.text}`);
			}
			const elided = out.elided + err.elided;
			if (elided > 0) {
				parts.push(`[… 中间省略 ${formatSize(elided)}（保留头尾：结论通常在尾部）]`);
			}
			if (truncated) {
				parts.push(`[输出超过 ${formatSize(hardCap)}，已终止命令]`);
			}
			if (timedOut) {
				parts.push(`[命令超过 ${Math.round(timeoutMs / 1000)} 秒，已终止]`);
			}
			if (failure) {
				parts.push(failure);
			}
			if (parts.length === 0) {
				parts.push("(命令没有输出)");
			}

			const body = parts.join("\n");
			const isError = timedOut || failure !== undefined || (exitCode !== null && exitCode !== 0);
			resolvePromise({
				content: exitCode === null ? body : `${body}\n[退出码 ${exitCode}]`,
				isError,
			});
		};

		const collect = (chunk: Buffer, target: "stdout" | "stderr"): void => {
			if (truncated) {
				return;
			}
			(target === "stdout" ? stdoutChunks : stderrChunks).push(chunk);
			bytes += chunk.byteLength;
			if (bytes > hardCap) {
				truncated = true;
				// 到这儿就不是「日志有点长」而是真的在刷屏（死循环、`yes`），立刻终止，不然内存会一直涨。
				killProcessTree(child);
			}
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(child);
			// 立即返回而不是等 close：被杀的子进程若还持有管道，close 可能迟迟不来，
			// 超时保证就失效了。已经收到的输出仍然会带回去。
			finish(null);
		}, timeoutMs);

		const onAbort = (): void => {
			killProcessTree(child);
			finish(null, "已被取消");
		};
		signal.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
		child.on("error", (error: Error) => finish(null, `启动命令失败：${error.message}`));
		child.on("close", (code: number | null) => finish(code));
	});
}

/**
 * 保留头尾、省略中间。
 *
 * 为什么不是「只留前 N 行」：这条命令的输出里，**结论几乎总在尾部**——测试的失败清单、
 * 构建的错误、安装的结尾。只留头部的代价是模型为了看结论把同一条命令再跑一遍（一轮往返，
 * 构建类命令还要等几十秒）。头尾都留就没这个问题。
 *
 * 边界按行切：省略的地方落在行中间会读起来像乱码。
 */
function middleTruncate(text: string, budget: number): { text: string; elided: number } {
	const total = Buffer.byteLength(text, "utf-8");
	if (total <= budget) {
		return { text, elided: 0 };
	}
	const half = Math.floor(budget / 2);
	const head = headBytes(text, half);
	const tail = tailBytes(text, half);
	const elided = total - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8");
	return { text: `${head}\n…\n${tail}`, elided: Math.max(elided, 0) };
}

/** 从开头取约 n 字节，并退到最后一个换行处 */
function headBytes(text: string, budget: number): string {
	const sliced = sliceByBytes(text, budget);
	const cut = sliced.lastIndexOf("\n");
	return cut === -1 ? sliced : sliced.slice(0, cut);
}

/** 从结尾取约 n 字节，并进到第一个换行处（多字节字符被切到时丢掉那个替换字符） */
function tailBytes(text: string, budget: number): string {
	const buffer = Buffer.from(text, "utf-8");
	if (buffer.byteLength <= budget) {
		return text;
	}
	const sliced = buffer.subarray(buffer.byteLength - budget).toString("utf-8");
	const cleaned = sliced.startsWith("\uFFFD") ? sliced.slice(1) : sliced;
	const cut = cleaned.indexOf("\n");
	return cut === -1 ? cleaned : cleaned.slice(cut + 1);
}
