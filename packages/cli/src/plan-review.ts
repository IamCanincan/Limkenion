/**
 * 终端上的方案评审。
 *
 * 计划模式下模型调用 `exit_plan_mode` 时走到这里：回车或 `y` 批准，`n` 退回让它继续改，
 * 直接输入文字则当作反馈把方案退回去。非交互环境没有评审通道，`cli.ts` 干脆不注册这个
 * 工具，模型会被要求把方案写成回答。
 *
 * 与审批一样，提示全部走 stderr，正文仍然只走 stdout。
 */

import { createInterface } from "node:readline/promises";
import type { PlanVerdict } from "limkenion-core";

/** 把方案完整打出来再问：评审要看原文，摘要会漏掉最关键的那句 */
export async function reviewPlan(plan: string): Promise<PlanVerdict> {
	process.stderr.write(`\n===== 方案 =====\n${plan}\n================\n`);
	if (!process.stdin.isTTY) {
		// 没有交互通道时不批准：批准等于替用户放行一次没人看过的改动。
		return { approved: false, feedback: "当前不是交互终端，无法评审方案；请把方案写成回答交给用户。" };
	}

	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question("批准这个方案？(y=批准 / n=继续改 / 或直接输入反馈) ")).trim();
		if (answer === "" || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
			return { approved: true };
		}
		if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
			return { approved: false, feedback: "用户要求继续完善方案，没有给出具体意见。" };
		}
		return { approved: false, feedback: answer };
	} catch {
		// Ctrl+C 按「退回」处理，别把异常抛进生成循环。
		return { approved: false, feedback: "用户中断了评审，请等待进一步指示。" };
	} finally {
		rl.close();
	}
}
