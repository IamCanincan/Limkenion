/**
 * 计划模式：先出方案，批准后再动手。
 *
 * 两档，区别只在**靠什么约束**：
 * - `strict`（严格）：靠工具层强制。只放行只读工具，write / edit / bash 一律拒绝。适合
 *   「没批准之前一个字节都别动」，代价是模型偶尔会撞几次墙。
 * - `guide`（引导）：靠提示词引导，也就是 DSH 的做法。工具全部可用，提示词要求先探索、先出方案，
 *   限制交给审批模式与沙箱，而不是这一个开关。撞墙更少，但约束是软的。
 *
 * 两档都共用评审退出：模型把方案交给 `exit_plan_mode`，用户批准就离开计划模式继续执行，
 * 给反馈就退回去改方案。工具在两种状态下都注册，只有计划模式内能跑通——工具目录不变，
 * 进出计划模式只改提示词。
 */

import { defineTool } from "./tools/contract.ts";

/** 计划模式的三种状态 */
export type PlanMode = "off" | "strict" | "guide";

/** 全部取值，供参数解析与提示使用 */
export const PLAN_MODES: readonly PlanMode[] = ["off", "strict", "guide"];

/** 退出计划模式的工具名 */
export const EXIT_PLAN_MODE_TOOL = "exit_plan_mode";

/** 方案至少要有多少字；太短的「方案」通常是复述任务 */
export const MIN_PLAN_LENGTH = 40;

/** 解析一个模式取值，认不出来时返回 undefined 交给调用方决定怎么报错 */
export function parsePlanMode(raw: unknown): PlanMode | undefined {
	return typeof raw === "string" && (PLAN_MODES as readonly string[]).includes(raw) ? (raw as PlanMode) : undefined;
}

/** 是否处于计划模式 */
export function isPlanning(mode: PlanMode): boolean {
	return mode !== "off";
}

/**
 * 严格档下**不允许**的工具。
 *
 * 从前这里是一张写死的名字表 `{ write, edit, bash }`，于是 `job_start`（跑任意命令）与
 * `subagent_start`（子代理能改文件）都不在里面——模型用它们就能整个绕开计划模式，
 * 在「批准前一个字节都别动」的档位下跑任意命令、改任意文件。
 *
 * 现在判据改成工具自陈的 `isReadOnly(input)`（见 `permissions/chain.ts` 第 3 步）：
 * 会改动东西的一律拒绝，不必有人记得把新工具加进某张表。这条常量只留给提示词说明用。
 */
export const PLAN_BLOCKED_HINT = "会改动文件或执行命令的工具";

/** 注入系统提示词的引导段落；`off` 时不加任何内容 */
export function planSection(mode: PlanMode): string {
	if (mode === "strict") {
		return [
			"当前处于**计划模式（严格）**：只能读，不能改。read / grep / glob 与只读的 bash 命令可用，",
			"写文件、跑会改动的命令、起后台任务或子代理都会被拒绝。",
			"请先读代码把情况摸清，然后把方案整理出来并调用 `exit_plan_mode` 提交；用户批准后工具才会放开。",
			"方案要写清楚：目标、打算改哪些文件、关键的取舍与风险、怎么验证。",
		].join("\n");
	}
	if (mode === "guide") {
		return [
			"当前处于**计划模式（引导）**：工具都能用，但请先探索、先出方案，不要急着改文件。",
			"把方案整理好后调用 `exit_plan_mode` 提交；用户批准后按方案执行，被退回就按反馈修改再提交。",
			"方案要写清楚：目标、打算改哪些文件、关键的取舍与风险、怎么验证。",
		].join("\n");
	}
	return "";
}

/** 用户对方案的结论 */
export type PlanVerdict = { approved: true } | { approved: false; feedback: string };

/** 创建 `exit_plan_mode` 工具需要的回调 */
export interface ExitPlanModeOptions {
	/** 当前是否在计划模式 */
	isPlanning: () => boolean;
	/** 请用户评审方案；没有交互通道时不传，工具会明确要求改用文字回答 */
	review?: (plan: string) => Promise<PlanVerdict>;
	/** 批准后离开计划模式 */
	onApproved: () => void;
}

/**
 * 创建提交方案的工具。
 *
 * 被退回算一次**失败**的工具调用：模型接到失败会把反馈当成必须处理的输入，而不是
 * 一句「顺便提一下」。批准则返回正常结果，同时离开计划模式。
 */
export function createExitPlanModeTool(options: ExitPlanModeOptions) {
	return defineTool({
		name: EXIT_PLAN_MODE_TOOL,
		description:
			"把方案提交给用户评审。只在计划模式内可用：用户批准就离开计划模式、可以开始动手，" +
			"被退回则按反馈修改后重新提交。方案要完整，不要只写一句结论。",
		parameters: {
			type: "object",
			properties: {
				plan: {
					type: "string",
					description: "完整方案：目标、要改哪些文件、关键取舍与风险、怎么验证",
				},
			},
			required: ["plan"],
		},
		// 只把方案交给用户看，不碰任何东西——所以它在严格档下也必须能调，否则计划模式没有出口。
		alwaysReadOnly: true,
		summarize: () => "提交方案",
		validate: (input) =>
			typeof input.plan === "string" && input.plan.trim().length >= MIN_PLAN_LENGTH
				? { ok: true }
				: {
						ok: false,
						message: `方案太短（至少 ${MIN_PLAN_LENGTH} 字）：请写清楚目标、要改哪些文件、关键取舍与验证方式。`,
					},
		async execute(input) {
			if (!options.isPlanning()) {
				return { content: "当前不在计划模式，不需要提交方案；直接说明结论即可。", isError: true };
			}
			const plan = typeof input.plan === "string" ? input.plan.trim() : "";
			if (plan.length < MIN_PLAN_LENGTH) {
				return {
					content: `方案太短（至少 ${MIN_PLAN_LENGTH} 字）：请写清楚目标、要改哪些文件、关键取舍与验证方式。`,
					isError: true,
				};
			}
			if (!options.review) {
				return {
					content:
						"当前环境没有方案评审入口（例如一次性调用或非交互运行）。请把方案直接写成回答交给用户，" +
						"由用户决定何时退出计划模式。",
					isError: true,
				};
			}

			const verdict = await options.review(plan);
			if (verdict.approved) {
				options.onApproved();
				return { content: "方案已批准，计划模式结束，现在可以动手了。", isError: false };
			}
			return {
				content: `方案被退回，请按下面的意见修改后重新用 ${EXIT_PLAN_MODE_TOOL} 提交：\n${verdict.feedback}`,
				isError: true,
			};
		},
	});
}
