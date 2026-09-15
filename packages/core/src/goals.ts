/**
 * 会话目标。
 *
 * 与待办的分工：**目标只有一个**（这一轮要达成什么），**待办是它的步骤**。两者并排摆在输入框上方
 * 那一小块里（DSH 的 dock 栈位置）——同一处聚合，不往对话流里塞状态。
 *
 * 只有两个动作：`goal_write` 整表替换（目标正文 + 四态），`goal_read` 读回。四态说人话
 * （进行中 / 已暂停 / 受阻 / 未运行），不把 active/paused 这类词丢给使用者。
 *
 * 为什么放在会话里而不是弹窗里：目标要**随时看得见**才有用——「我现在到底在干什么」不该点两下才知道。
 */

import { defineTool } from "./tools/contract.ts";
import type { AgentTool } from "./types.ts";

/** 目标的四种状态 */
export type GoalStatus = "active" | "paused" | "blocked" | "idle";

const STATUSES: GoalStatus[] = ["active", "paused", "blocked", "idle"];

/** 状态的人话 */
const STATUS_LABELS: Record<GoalStatus, string> = {
	active: "进行中",
	paused: "已暂停",
	blocked: "受阻",
	idle: "未运行",
};

/** 目标正文的长度上限：它要显示在输入框上方那一行里，太长就没法一眼看完 */
export const MAX_GOAL_CONTENT = 500;

/** 一条目标 */
export interface Goal {
	content: string;
	status: GoalStatus;
}

/** 解析模型给的目标：只认非空正文；状态不认识时按未运行处理 */
export function parseGoal(input: unknown): { content: string; status: GoalStatus } | { error: string } {
	if (input === null || typeof input !== "object") {
		return { error: "缺少 goal 字段" };
	}
	const raw = input as { content?: unknown; status?: unknown };
	const content = typeof raw.content === "string" ? raw.content.trim() : "";
	if (content === "") {
		return { error: "目标不能为空：一句话说清这一轮要达成什么" };
	}
	if (content.length > MAX_GOAL_CONTENT) {
		return { error: `目标太长（${content.length} 字，上限 ${MAX_GOAL_CONTENT}）：压成一句话` };
	}
	const status =
		typeof raw.status === "string" && (STATUSES as string[]).includes(raw.status)
			? (raw.status as GoalStatus)
			: "idle";
	return { content, status };
}

/** 渲染成人话；没有目标时给一句说明而不是空串（模型读回时才知道该写 */
export function renderGoal(goal: Goal | null): string {
	if (goal === null) {
		return "还没有设目标。（没有目标也能干活：这一步是为了让「现在在干什么」看得见。）";
	}
	return `目标（${STATUS_LABELS[goal.status]}）：${goal.content}`;
}

/** 会话内的目标，只有一个 */
export class GoalList {
	private goal: Goal | null = null;

	/** 当前目标（拷贝，外面改不到内部） */
	get current(): Goal | null {
		return this.goal === null ? null : { ...this.goal };
	}

	/** 整表替换 */
	replace(goal: Goal): void {
		this.goal = { ...goal };
	}

	/** 清掉（换会话时用） */
	clear(): void {
		this.goal = null;
	}

	/** 渲染 */
	render(): string {
		return renderGoal(this.goal);
	}
}

/** 创建目标工具 */
export function createGoalTools(goals: GoalList): AgentTool[] {
	return [
		defineTool({
			name: "goal_write",
			description:
				"设置或更新这一轮的目标（只有一个）。开始一件需要多步的事之前写一句「要达成什么」，" +
				"卡住、暂停、或目标变了也用它更新状态：active 进行中 / paused 已暂停 / blocked 受阻 / idle 未运行。",
			parameters: {
				type: "object",
				properties: {
					content: { type: "string", description: "一句话说清这一轮要达成什么" },
					status: {
						type: "string",
						enum: [...STATUSES],
						description: "不填按 idle 处理",
					},
				},
				required: ["content"],
			},
			// 只动会话内的目标，不碰文件系统：任何档位都放行。
			alwaysReadOnly: true,
			summarize: (input) => (typeof input.content === "string" ? input.content : ""),
			validate: (input) => {
				const parsed = parseGoal(input);
				return "error" in parsed ? { ok: false, message: parsed.error } : { ok: true };
			},
			async execute(input) {
				const parsed = parseGoal(input);
				if ("error" in parsed) {
					return { content: parsed.error, isError: true };
				}
				goals.replace(parsed);
				return { content: goals.render(), isError: false };
			},
		}),
		defineTool({
			name: "goal_read",
			description: "读回当前目标。上下文被压缩、或者中途接手时，用它确认「现在到底在做什么」。",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			alwaysReadOnly: true,
			isConcurrencySafe: () => true,
			async execute() {
				return { content: goals.render(), isError: false };
			},
		}),
	];
}
