/**
 * `limkenion review`：对当前改动跑一轮多角度代码评审。
 *
 * 输出约定：报告走 stdout（它就是这次运行的结果，可以直接重定向或喂给别的工具），进度走 stderr。
 * 退出码：0 没有 blocker，1 有 blocker（CI 里直接当门禁用），2 评审没能跑起来。
 */

import { REVIEW_FOCUSES, type ReviewFocus } from "limkenion-core";
import type { Options } from "../args.ts";
import { APP_NAME } from "../config.ts";
import { createReviewRuntimeFor, type ReviewRuntime, runReview } from "../review.ts";
import type { Command, CommandHost } from "./command.ts";
import { wantsHelp } from "./common.ts";

/** review 子命令：元信息住在命令自己这里 */
export const reviewCommand: Command = {
	name: "review",
	synopsis: "review [--base <ref>]",
	summary: "对当前改动跑一轮多角度代码评审",
	run: runReviewCli,
};

/** 用法说明 */
function reviewUsage(): string {
	return [
		`${APP_NAME} review [--base <ref>] [--focus <角度>]`,
		"",
		"对工作区相对 HEAD 的改动跑一轮代码评审；给出 --base 时改为评审 <base>...HEAD。",
		"几位评审者各管一个角度，互不通气地各跑一遍，再由一个汇总者去重、排序。",
		"",
		"参数：",
		`  --base <ref>     比较基线，例如 main；默认看工作区相对 HEAD 的改动`,
		`  --focus <角度>   只跑指定角度，逗号分隔，可选：${REVIEW_FOCUSES.join(" / ")}`,
		"",
		"退出码：0 没有 blocker；1 存在 blocker；2 评审没能跑起来。",
	].join("\n");
}

/** 解析 review 子命令的参数 */
function parseReviewArgs(argv: string[]): { base?: string; focuses?: ReviewFocus[] } | { error: string } {
	const options: { base?: string; focuses?: ReviewFocus[] } = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--base") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return { error: "--base 后面要跟一个 git 引用，例如 main" };
			}
			options.base = value;
			index += 1;
			continue;
		}
		if (arg === "--focus") {
			const value = argv[index + 1];
			if (value === undefined) {
				return { error: `--focus 后面要跟角度：${REVIEW_FOCUSES.join(" / ")}` };
			}
			const focuses: ReviewFocus[] = [];
			for (const part of value.split(",")) {
				const focus = part.trim().toLowerCase();
				if (!(REVIEW_FOCUSES as readonly string[]).includes(focus)) {
					return { error: `不认识的角度「${part.trim()}」，可选：${REVIEW_FOCUSES.join(" / ")}` };
				}
				focuses.push(focus as ReviewFocus);
			}
			options.focuses = focuses;
			index += 1;
			continue;
		}
		return { error: `未知参数：${arg}` };
	}
	return options;
}

/**
 * 用命令行那套配置造一个「一次性代理」。
 *
 * 只管把 `Options` 里的几项摊平成 `ReviewAgentConfig`：真正的实现在 `review.ts` 的
 * `createReviewRuntimeFor`，网页那边没有 `Options`，直接调的就是它。
 */
export function createReviewRuntime(options: Options, cwd: string): ReviewRuntime {
	return createReviewRuntimeFor({
		apiKey: options.apiKey,
		modelId: options.model,
		baseUrl: options.baseUrl,
		retries: options.retries,
		cwd,
	});
}

/**
 * 把 `review` 自己的参数与全局参数分开。
 *
 * `review` 既要用全局的密钥/模型配置，又有自己的 `--base` / `--focus`，而全局解析器不认识后者
 * （会直接报未知参数），所以先挑出自己的一份，剩下的交给 `parseOptions`。
 */
export function splitReviewArgs(argv: string[]): { global: string[]; review: string[] } {
	const global: string[] = [];
	const review: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--base" || arg === "--focus") {
			review.push(arg);
			const value = argv[index + 1];
			if (value !== undefined) {
				review.push(value);
				index += 1;
			}
			continue;
		}
		if (arg === "help" || arg === "-h" || arg === "--help") {
			review.push(arg);
			continue;
		}
		global.push(arg);
	}
	return { global, review };
}

/**
 * 子命令入口：先挑出属于 review 的参数，剩下的交给全局解析器，再跑评审。
 *
 * 这段从前写在 `cli.ts` 的派发里。它是**这个命令自己的**约定——`--base` / `--focus` 只有它认——
 * 让入口认识某个子命令的参数长什么样，入口就变成「所有命令的参数都得知道一点」的地方。
 */
export async function runReviewCli(argv: string[], host: CommandHost): Promise<number> {
	const split = splitReviewArgs(argv);
	const options = host.parseGlobalOptions(split.global);
	if (options === "usage-error") {
		return 2;
	}
	if (options === null) {
		// `null` 是「帮助已打印」或「正常结束」，两种情况都不是失败。
		return 0;
	}
	return runReviewCommand(split.review, options);
}

/** 运行 review 子命令，返回进程退出码 */
export async function runReviewCommand(argv: string[], options: Options): Promise<number> {
	if (wantsHelp(argv)) {
		process.stdout.write(`${reviewUsage()}\n`);
		return 0;
	}
	const parsed = parseReviewArgs(argv);
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n\n${reviewUsage()}\n`);
		return 2;
	}
	if (options.apiKey === "") {
		process.stderr.write("评审需要 API Key：先跑 `limkenion auth login` 或设置 DEEPSEEK_API_KEY\n");
		return 2;
	}

	const outcome = await runReview(createReviewRuntime(options, process.cwd()), {
		cwd: process.cwd(),
		base: parsed.base,
		focuses: parsed.focuses,
	});
	if (!outcome.ok) {
		process.stderr.write(`${outcome.error}\n`);
		return 2;
	}
	process.stdout.write(`${outcome.report}\n`);
	if (outcome.failed.length > 0) {
		process.stderr.write(`注意：${outcome.failed.join("、")} 这几位评审者没有完成\n`);
	}
	return outcome.verdict === "block" ? 1 : 0;
}
