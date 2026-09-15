/**
 * PreToolUse 钩子：让用户在工具执行前插手。
 *
 * 把「要不要放行这次工具调用」交给**用户自己的脚本**，而不是只靠
 * 内置规则。脚本从 stdin 拿到一次调用的 JSON，用 stdout 给结论：
 *
 *   输入：{ tool, input, cwd }
 *   输出：{ decision: "allow" | "deny" | "modify", reason?, input? }
 *
 * 退出码沿用一套固定约定，这样「钩子坏了」不会把 agent 卡死：
 *   0            → 读 stdout 的 JSON（缺字段按 allow）
 *   2            → 拒绝，stderr 作为理由回给模型（这是「按规则拦截」的正规写法）
 *   其它非 0     → **放行**，但把 stderr 作为警告附在结果后面（钩子自己出错不该阻断工作）
 *   超时/输出不合法 → 同上，放行 + 警告
 *
 * 顺序：内置的审批 / 计划模式判定**先**跑，钩子只在放行之后才有机会；钩子不能把计划模式的
 * 拒绝翻成放行，安全不变量不受用户脚本影响。
 */

import { spawn } from "node:child_process";
import { DETACH_FOR_KILL, decodeProcessOutput, killProcessTree } from "./process.ts";

/** 一条钩子声明 */
export interface PreToolUseHook {
	/** 匹配的工具名：`*` 表示全部，也可以用逗号分隔多个（如 `write,edit`） */
	matcher: string;
	/** 要执行的命令；命令本身用 shell 语义交给系统执行 */
	command: string;
}

/** 钩子运行结果（执行器的最小契约，便于测试注入） */
export interface HookRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** 执行器：跑一条命令并把 payload 写进它的 stdin */
export type HookRunner = (command: string, payload: string) => Promise<HookRunResult>;

/** 一次调用的上下文 */
export interface PreToolUseEvent {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
}

/** 汇总后的结论 */
export interface HookOutcome {
	/** 是否放行 */
	allowed: boolean;
	/** 拒绝理由，或放行时的警告 */
	reason: string;
	/** 被钩子改写后的入参；没有改写时是原对象 */
	input: Record<string, unknown>;
	/** 实际跑过的钩子命令，便于排查 */
	ran: string[];
}

/** 钩子执行的超时时间 */
export const HOOK_TIMEOUT_MS = 10_000;

/** 匹配工具名 */
export function matchesTool(matcher: string, toolName: string): boolean {
	const trimmed = matcher.trim();
	if (trimmed === "" || trimmed === "*") {
		return true;
	}
	return trimmed
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "")
		.includes(toolName);
}

/** 默认执行器：交给系统 shell，超时后连整棵进程树一起杀掉 */
export function spawnHookRunner(command: string, payload: string, timeoutMs = HOOK_TIMEOUT_MS): Promise<HookRunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, {
			shell: true,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			// 钩子超时后要连它启动的子进程一起收；POSIX 下必须自成进程组才收得掉（见 process.ts）。
			detached: DETACH_FOR_KILL,
			env: { ...process.env, LIMKENION_HOOK: "pre-tool-use" },
		});
		// 钩子脚本的输出同样可能是系统代码页（Windows 上的 .cmd/.bat）：攒 Buffer 再统一解，
		// 别用 setEncoding("utf-8")——那等于假定它是 UTF-8，GBK 的中文提示会变成乱码。
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let extraStderr = "";
		let done = false;
		const finish = (exitCode: number): void => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			resolve({
				exitCode,
				stdout: decodeProcessOutput(Buffer.concat(stdoutChunks)),
				stderr: decodeProcessOutput(Buffer.concat(stderrChunks)) + extraStderr,
			});
		};
		const timer = setTimeout(() => {
			killProcessTree(child);
			finish(-1);
		}, timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});
		child.on("error", (error) => {
			extraStderr += String(error.message);
			finish(-1);
		});
		child.on("close", (code) => finish(code ?? -1));
		child.stdin?.end(payload);
	});
}

/** 解析钩子输出 */
function parseDecision(
	stdout: string,
): { decision: "allow" | "deny" | "modify"; reason: string; input?: Record<string, unknown> } | null {
	const text = stdout.trim();
	if (text === "") {
		return { decision: "allow", reason: "" };
	}
	try {
		const parsed = JSON.parse(text) as { decision?: unknown; reason?: unknown; input?: unknown };
		const decision = parsed.decision === "deny" || parsed.decision === "modify" ? parsed.decision : "allow";
		const reason = typeof parsed.reason === "string" ? parsed.reason : "";
		const input =
			parsed.input !== null && typeof parsed.input === "object" && !Array.isArray(parsed.input)
				? (parsed.input as Record<string, unknown>)
				: undefined;
		return { decision, reason, input };
	} catch {
		return null;
	}
}

/**
 * 依次跑匹配的钩子。
 *
 * 任何一个拒绝就立即停（后面的钩子不再执行）——拒绝是终态，没必要再问别人。
 * `modify` 会更新入参并继续交给下一个钩子。
 */
export async function runPreToolUseHooks(
	hooks: PreToolUseHook[],
	event: PreToolUseEvent,
	run: HookRunner = spawnHookRunner,
): Promise<HookOutcome> {
	const outcome: HookOutcome = { allowed: true, reason: "", input: event.input, ran: [] };
	let current = event;

	for (const hook of hooks) {
		if (!matchesTool(hook.matcher, current.tool)) {
			continue;
		}
		outcome.ran.push(hook.command);
		// 每次都按当前入参重新序列化：上一个钩子改过的内容要让下一个看到。
		const result = await run(hook.command, `${JSON.stringify(current)}\n`);

		if (result.exitCode === 2) {
			outcome.allowed = false;
			outcome.reason = result.stderr.trim() || "被 PreToolUse 钩子拒绝";
			return outcome;
		}
		if (result.exitCode !== 0) {
			// 钩子自己出错：放行但留个提醒，别让它把工作卡住。
			const detail = result.stderr.trim() || `退出码 ${result.exitCode}`;
			outcome.reason = [outcome.reason, `钩子执行异常（${hook.command}）：${detail}`].filter(Boolean).join("\n");
			continue;
		}

		const decision = parseDecision(result.stdout);
		if (decision === null) {
			outcome.reason = [outcome.reason, `钩子输出不是合法 JSON（${hook.command}），已按放行处理`]
				.filter(Boolean)
				.join("\n");
			continue;
		}
		if (decision.decision === "deny") {
			outcome.allowed = false;
			outcome.reason = decision.reason || "被 PreToolUse 钩子拒绝";
			return outcome;
		}
		if (decision.decision === "modify" && decision.input) {
			outcome.input = decision.input;
			// 后续钩子应看到改写后的入参。
			current = { ...current, input: decision.input };
		}
	}

	return outcome;
}
