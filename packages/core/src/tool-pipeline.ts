/**
 * 单次工具调用的管线。
 *
 * 一次调用要过五道，顺序固定：
 *   1. 找到工具、参数是不是合法 JSON；
 *   2. **参数值校验**（工具自陈的 `validate`）；
 *   3. 审批（`permissions/chain.ts`）；
 *   4. PreToolUse 钩子；
 *   5. 执行。
 * 执行完还有两件收尾——重复调用的提醒，以及按预算处理结果（空结果兜底 + 过大落盘）。
 *
 * 从前这些挤成一个四层嵌套的 if/else，其中一条 `outcome === null` 的分支永远走不到
 * （每条路径都已经赋过值）；钩子与审批的先后（内置判定先跑，钩子只能在放行之后加码）也埋在
 * 缩进里。拉直成一条顺序执行的路之后，「什么顺序、谁能拦住谁」一眼可见。
 *
 * 有的实现会把每一步做成 `AsyncGenerator` 以便把进度推给 UI；这里没有
 * 流式 UI 的需求，直接返回结果，事件仍由调用方（turn.ts）发。
 */

import { runPreToolUseHooks } from "./hooks.ts";
import { guardToolUse } from "./permissions/chain.ts";
import { applyResultBudget } from "./results/budget.ts";
import type { SessionState } from "./session.ts";
import { runTool } from "./tool-run.ts";
import type { AgentTool, ToolOutcome } from "./tools/contract.ts";
import type { TurnContext } from "./turn-context.ts";

/**
 * 跑完一次已经配好工具与入参的调用，返回要回灌给模型的结果。
 *
 * `input` 是解析好的入参，参数不是合法 JSON 时由调用方传 null——那种情况下连工具都找不到，
 * 直接回一条错误让模型改。
 *
 * `reminder` 由调用方**按原始顺序**预先算好（`RepeatGuard.observe`），不在这里现算：并发批里的
 * 调用完成顺序是不定的，在这里算会让「连续重复」的计数随调度抖动。
 *
 * 审批与计划模式**现读**会话状态，不用这一轮的快照：网页与命令行都承诺「改了立刻生效」，
 * 而 `exit_plan_mode` 被批准后，同一批里剩下的工具也要马上放行。
 */
export async function runPreparedCall(
	state: SessionState,
	context: TurnContext,
	tool: AgentTool | undefined,
	name: string,
	rawArguments: string,
	input: Record<string, unknown> | null,
	reminder: string | null,
	signal: AbortSignal,
): Promise<ToolOutcome> {
	if (tool === undefined) {
		return { content: `没有名为 ${name} 的工具`, isError: true };
	}
	if (input === null) {
		return { content: `参数不是合法 JSON：${rawArguments}`, isError: true };
	}

	// 参数值校验先于审批：参数本身就不成立的调用不该弹确认卡片——用户点了同意，工具也只会
	// 报一个参数错误，白白打扰一次。
	const validation = tool.validate(input);
	if (!validation.ok) {
		return { content: validation.message, isError: true };
	}

	// 执行前过一道审批：只读放行，读写按模式确认或拒绝。拦下就把原因当结果回传，
	// 模型据此能换个做法，而不是干等着。
	const guarded = await guardToolUse(
		{
			approval: state.approval,
			cwd: context.cwd,
			planMode: state.planMode,
			onApproval: state.onApproval,
			emit: state.emit,
			emitResult: state.emit,
			memory: state.approvals,
		},
		tool,
		input,
		signal,
	);
	const outcome = guarded ?? (await runWithHooks(state, context, tool, input, signal));

	// 循环卫生：同一个调用反复出现时提一句，但不硬拦。提醒按原始顺序算好（见函数说明），
	// 被拦下的那次也算：模型若在原地打转，提醒正是它需要的那句压力。
	const withReminder = reminder === null ? outcome : { ...outcome, content: `${outcome.content}\n\n${reminder}` };

	return applyResultBudget(tool, withReminder, state.spillDir);
}

/**
 * 跑工具本身，中间夹一道 PreToolUse 钩子。
 *
 * 钩子在内置判定放行之后才有机会说话：它可以拒绝，也可以改写入参，但翻不掉计划模式与审批的
 * 拒绝——安全判定不外包给用户脚本。
 */
async function runWithHooks(
	state: SessionState,
	context: TurnContext,
	tool: AgentTool,
	input: Record<string, unknown>,
	signal: AbortSignal,
): Promise<ToolOutcome> {
	if (state.hooks.length === 0) {
		return runTool(tool, input, signal);
	}
	const hooked = await runPreToolUseHooks(state.hooks, { tool: tool.name, input, cwd: context.cwd });
	if (!hooked.allowed) {
		return { content: `已拒绝执行 ${tool.name}：${hooked.reason}`, isError: true };
	}
	const outcome = await runTool(tool, hooked.input, signal);
	return hooked.reason === "" ? outcome : { ...outcome, content: `${outcome.content}\n\n[钩子提示] ${hooked.reason}` };
}
