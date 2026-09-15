/**
 * 代码评审的编排。
 *
 * 流程：取 diff → 几个互不通气的评审者各跑一遍（并行）→ 一个汇总者去重、砍掉没证据的条目、
 * 排序 → 打一份报告。
 *
 * 这里不碰凭据与模型配置：怎么造一个「一次性代理」由调用方通过 `ReviewRuntime.run` 提供，
 * 于是这段编排可以完全用假实现测，不必联网。
 */

import {
	Agent,
	buildReviewPrompt,
	buildSynthesisPrompt,
	createSystemTools,
	parseReviewVerdict,
	REVIEW_FOCUSES,
	type ReviewFocus,
	runSubagents,
	type SubagentResult,
	sliceByBytes,
} from "limkenion-core";

/** 执行一条 git 命令的结果 */
export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** 执行 git；测试里注入假实现 */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

/** 评审需要的运行环境 */
export interface ReviewRuntime {
	/**
	 * 跑一个独立代理并返回它的最终回答。
	 *
	 * `readOnly` 为真时只给只读工具：评审者不该改动任何东西。
	 */
	run: (request: { label: string; prompt: string; systemPrompt: string; readOnly: boolean }) => Promise<string>;
	/** 执行 git，默认走真实进程 */
	git?: GitRunner;
	/** 进度输出，默认写 stderr */
	note?: (message: string) => void;
	/** 同时跑几个评审者 */
	limit?: number;
	/** 取消信号 */
	signal?: AbortSignal;
}

/** 评审选项 */
export interface ReviewOptions {
	/** 工作目录 */
	cwd: string;
	/** 比较的基线，给出时用 `<base>...HEAD`，否则看工作区相对 HEAD 的改动 */
	base?: string;
	/** 要跑的角度，默认三个都跑 */
	focuses?: ReviewFocus[];
}

/** 评审结果：要么给出报告，要么给出「做不了」的原因 */
export type ReviewOutcome =
	| { ok: true; report: string; verdict: "block" | "ok"; failed: string[]; files: string[] }
	| { ok: false; error: string };

/** 造评审运行环境需要的代理配置 */
export interface ReviewAgentConfig {
	apiKey: string;
	modelId: string;
	baseUrl?: string;
	retries?: number;
	cwd: string;
	/** 仅用于测试：把它们传给子代理 */
	fetchImpl?: typeof fetch;
	/**
	 * 取消信号：客户端断开时用它把还在跑的评审者收掉。
	 *
	 * 不写进任务书给的那几个字段，但少了它，「浏览器关掉标签页」就只能等几个代理自己
	 * 把轮数跑完——一个能在后台空转几分钟的评审，是这套接口最不该有的行为。
	 */
	signal?: AbortSignal;
}

/** 单个文件的 diff 上限，超过就不再往提示词里塞内容 */
export const MAX_DIFF_BYTES = 200_000;

/** 评审者的系统提示词：独立、只读、只看这个仓库 */
const REVIEWER_SYSTEM_PROMPT =
	"你是一名严格的代码评审者，在用户的终端里工作。你只读代码、只报告问题，不修改任何文件。" +
	"你可以用 read / grep / glob 查看仓库里的真实代码，用它来核实 diff 里的上下文。";

/** 汇总者的系统提示词：只做合并与排序 */
const SYNTHESIS_SYSTEM_PROMPT = "你是代码评审的汇总者，负责把多份报告合成一份结论。你不引入新问题，也不修改文件。";

/** 评审者能用的工具：只读三个，别的都不给 */
const REVIEW_TOOLS = new Set(["read", "grep", "glob"]);

/** 评审者最多几轮：够读几个文件就行，评审不该变成一次探索 */
const REVIEW_MAX_TURNS = 14;

/**
 * 取要评审的改动。
 *
 * 默认看工作区相对 HEAD 的改动（含已暂存），给出 `base` 时看 `<base>...HEAD`——后者适合
 * 「这个分支相对主线改了什么」。未跟踪的新文件不在 `git diff` 里，所以单独列出来交给评审者
 * 自己读：新文件往往正是问题最多的地方，直接漏掉不合适。
 */
export async function collectDiff(
	options: ReviewOptions & { git?: GitRunner },
): Promise<{ ok: true; diff: string; files: string[]; untracked: string[] } | { ok: false; error: string }> {
	const git = options.git ?? defaultGit;
	const range = options.base === undefined || options.base.trim() === "" ? "HEAD" : `${options.base.trim()}...HEAD`;

	const diff = await git(["diff", "--no-color", "--unified=5", range], options.cwd);
	if (diff.code !== 0) {
		const reason = diff.stderr.trim() || `退出码 ${diff.code}`;
		if (/not a git repository/i.test(diff.stderr)) {
			return { ok: false, error: `${options.cwd} 不是 git 仓库，评审需要能取到 diff` };
		}
		return { ok: false, error: `git diff 失败：${reason}` };
	}
	if (diff.stdout.trim() === "") {
		return { ok: true, diff: "", files: [], untracked: [] };
	}

	const names = await git(["diff", "--name-only", range], options.cwd);
	const files = names.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");

	const others = await git(["ls-files", "--others", "--exclude-standard"], options.cwd);
	const untracked = others.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");

	const clipped =
		Buffer.byteLength(diff.stdout, "utf-8") > MAX_DIFF_BYTES
			? `${sliceByBytes(diff.stdout, MAX_DIFF_BYTES)}\n\n[diff 过大，已截断；需要细节请用 read 直接看文件]`
			: diff.stdout;

	return { ok: true, diff: clipped, files, untracked };
}

/** 跑一轮评审 */
export async function runReview(runtime: ReviewRuntime, options: ReviewOptions): Promise<ReviewOutcome> {
	const note = runtime.note ?? ((message: string) => process.stderr.write(`${message}\n`));
	const focuses = options.focuses && options.focuses.length > 0 ? options.focuses : [...REVIEW_FOCUSES];

	const collected = await collectDiff({ ...options, git: runtime.git });
	if (!collected.ok) {
		return collected;
	}
	if (collected.diff === "") {
		return { ok: false, error: "没有可评审的改动（工作区相对基线是干净的）" };
	}

	note(`评审 ${collected.files.length} 个文件，${focuses.length} 个角度：${focuses.join("、")}…`);
	const tasks = focuses.map((focus) => ({
		label: focus,
		prompt: buildReviewPrompt({ focus, diff: collected.diff, extraFiles: collected.untracked }),
	}));

	const reports = await runSubagents(
		tasks,
		(task) =>
			runtime.run({
				label: task.label,
				prompt: task.prompt,
				systemPrompt: REVIEWER_SYSTEM_PROMPT,
				readOnly: true,
			}),
		{ limit: runtime.limit, signal: runtime.signal },
	);

	const failed: string[] = [];
	// 跑完但一个字都没写的也按失败算：多半是轮数被工具调用吃光了。
	// 不这样处理，它会以「成功但没有内容」的身份混进汇总，看起来像「这位评审者认为没问题」。
	for (const report of reports) {
		if (report.error === undefined && report.text.trim() === "") {
			report.error = "没有给出报告（可能把轮数花在工具调用上了）";
		}
		if (report.error !== undefined) {
			failed.push(report.label);
		}
	}
	const usable = reports.filter((report) => report.error === undefined && report.text.trim() !== "");
	if (usable.length === 0) {
		const detail = reports.map((report) => `${report.label}：${report.error ?? "没有给出内容"}`).join("；");
		return { ok: false, error: `所有评审者都没能给出结论（${detail}）` };
	}
	if (failed.length > 0) {
		note(`这些评审者没有完成：${failed.join("、")}（结论里会说明）`);
	}

	note("汇总中…");
	const synthesis = await runtime.run({
		label: "synthesis",
		prompt: buildSynthesisPrompt({
			diff: collected.diff,
			reports: reports as SubagentResult[],
			extraFiles: collected.untracked,
		}),
		systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
		readOnly: true,
	});

	const verdict = parseReviewVerdict(synthesis);
	if (verdict === null) {
		// 没有结论行时不猜：按「没有 blocker」处理，但明确说出来，免得 CI 以为是审过了。
		note("汇总结果里没有 VERDICT 行，按「没有 blocker」处理");
	}
	return {
		ok: true,
		report: synthesis.trim(),
		verdict: verdict ?? "ok",
		failed,
		files: collected.files,
	};
}

/** 真实执行 git：不走 shell，参数按数组传，避免命令拼接 */
async function defaultGit(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
	const { execFile } = await import("node:child_process");
	return new Promise((resolve) => {
		const child = execFile(
			"git",
			args,
			{ cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal },
			(error, stdout, stderr) => {
				const code =
					error === null
						? 0
						: typeof (error as { code?: unknown }).code === "number"
							? (error as { code: number }).code
							: 1;
				resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
			},
		);
		// 被取消时 execFile 会杀掉进程，但仍然等它退出才触发回调——工作目录上还占着的进程要等
		// 多久就等多久。这里改成一收到取消就立刻收尾并杀进程，调用方（浏览器断开、服务端关闭）
		// 才不会被一个还没退出的 git 拖住。
		signal?.addEventListener(
			"abort",
			() => {
				child.kill();
				resolve({ code: 1, stdout: "", stderr: "已取消" });
			},
			{ once: true },
		);
	});
}

/**
 * 用一份显式的代理配置造一个「一次性代理」。
 *
 * 评审者与汇总者都只读：工具只给 read / grep / glob，审批模式再加一道只读。它们不改文件，
 * 也不写会话——评审是一次性动作，塞进会话历史只会污染后续上下文。
 *
 * 与 `createReviewRuntime` 分开是因为命令行那边手上只有一个 `Options`（密钥、模型、重试都散在里面），
 * 而网页那边一个都没有、拿到的是已经解析好的几个值。两边需要的代理其实是同一个，让命令行那条路
 * 转调这里，免得两份实现慢慢走偏。
 */
export function createReviewRuntimeFor(config: ReviewAgentConfig): ReviewRuntime {
	const base = {
		apiKey: config.apiKey,
		modelId: config.modelId,
		baseUrl: config.baseUrl,
		cwd: config.cwd,
		approval: "readonly" as const,
		retries: config.retries,
		maxTurns: REVIEW_MAX_TURNS,
		signal: config.signal,
		fetchImpl: config.fetchImpl,
	};
	const readOnlyTools = createSystemTools({ cwd: config.cwd }).filter((tool) => REVIEW_TOOLS.has(tool.name));

	return {
		// git 也吃同一个信号：取 diff 这一步可能要跑一会儿，取消时不该还留着一个 git 子进程。
		git: (args, cwd) => defaultGit(args, cwd, config.signal),
		run: async ({ systemPrompt, prompt, readOnly }) => {
			const agent = new Agent({
				...base,
				systemPrompt,
				tools: readOnly ? readOnlyTools : [],
			});
			await agent.prompt(prompt);
			return finalText(agent);
		},
	};
}

/** 取最后一次回答的正文；工具调用轮次里 assistant 消息可能是空的 */
function finalText(agent: Agent): string {
	for (const message of [...agent.messages].reverse()) {
		if (message.role === "assistant" && message.content.trim() !== "") {
			return message.content;
		}
	}
	return "";
}
