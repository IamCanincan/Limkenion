/**
 * 系统工具集合。
 *
 * 六个文件/命令工具：bash / read / write / edit / grep / glob。后两个是搜索，用 Node 内置能力
 * 实现：比让模型自己拼 `find`/`rg` 更稳（跨平台行为一致），也更容易限定范围与输出上限。
 * 另外还有待办、目标、交付物、后台任务与子代理这几组只动会话内状态的工具。
 *
 * **裁剪靠来源，不靠调用方记得少传一个参数**：从前「子代理的工具集里没有子代理工具」
 * 是靠 `runs.ts` 那里**不传** `subagents` 实现的——一条不成文的约定，谁把参数补上就套娃了。
 * 现在改成显式的 `source`：子代理这条路上，子代理自己的工具根本不会被注册。
 */

import type { CheckpointStore } from "../checkpoints.ts";
import { createGoalTools, GoalList } from "../goals.ts";
import { createJobTools, JobRegistry } from "../jobs.ts";
import { createPresentTools, PresentList } from "../present.ts";
import { createSubagentTools, type SubagentProgressTable } from "../subagent.ts";
import { createTodoTools, TodoList } from "../todos.ts";
import type { AgentTool } from "../tools/contract.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { ReadEvidence } from "./evidence.ts";
import { createReadTool } from "./read.ts";
import { createGlobTool, createGrepTool } from "./search.ts";
import { createWriteTool } from "./write.ts";

export type { Goal, GoalStatus } from "../goals.ts";
export { createGoalTools, GoalList, MAX_GOAL_CONTENT, parseGoal, renderGoal } from "../goals.ts";
export type { JobRecord, JobStatus } from "../jobs.ts";
export { createJobTools, JobRegistry, MAX_JOB_BYTES, MAX_JOBS, renderJobs } from "../jobs.ts";
export type { PresentFile } from "../present.ts";
export { createPresentTools, MAX_PRESENT_FILES, PresentList, parsePresent, renderPresent } from "../present.ts";
export type { TodoItem, TodoStatus } from "../todos.ts";
export { createTodoTools, MAX_TODO_CONTENT, MAX_TODO_ITEMS, parseTodos, renderTodos, TodoList } from "../todos.ts";
export { type BashToolOptions, createBashTool } from "./bash.ts";
export type { AgentTool } from "./contract.ts";
export { createEditTool, type EditToolOptions } from "./edit.ts";
export { ReadEvidence } from "./evidence.ts";
export {
	APPROVAL_PREVIEW_LINES,
	formatSize,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	resolveUserPath,
	truncateHead,
} from "./path.ts";
export { createReadTool, type ReadToolOptions } from "./read.ts";
export { createGlobTool, createGrepTool, type SearchToolOptions } from "./search.ts";
export { createWriteTool, type WriteToolOptions } from "./write.ts";

/**
 * 工具集是给谁用的。
 *
 * `main` 是主对话；`subagent` 是子代理。这个区分只用来裁掉「不该出现在这一层」的工具，
 * 不改变任何单个工具的行为。
 */
export type ToolSource = "main" | "subagent";

/**
 * 子代理拿不到的工具。
 *
 * 两类：
 * - **子代理自己的四个工具**：套娃的代价是不可控的上下文与花费，深度上限 1 是硬规矩。
 *   靠这张表而不是靠调用方少传参数——后者是一条没人守着的约定。
 * - **`exit_plan_mode`**：计划模式是主对话与使用者之间的约定，子代理没有评审入口；
 *   真给它，模型会调到一个必然失败的工具。
 */
export const SUBAGENT_DENIED_TOOLS: ReadonlySet<string> = new Set([
	"subagent_start",
	"subagent_stop",
	"subagent_list",
	"subagent_read",
	"exit_plan_mode",
]);

/** 按来源裁掉不该出现的工具 */
export function filterToolsForSource(tools: readonly AgentTool[], source: ToolSource): AgentTool[] {
	return source === "main" ? [...tools] : tools.filter((tool) => !SUBAGENT_DENIED_TOOLS.has(tool.name));
}

/** 创建默认的系统工具；传入 `todos` 可以复用外部持有的清单 */
export function createSystemTools(options: {
	cwd: string;
	/** 这套工具交给谁用；子代理这条路上会裁掉子代理工具与 exit_plan_mode */
	source?: ToolSource;
	checkpoints?: CheckpointStore;
	todos?: TodoList;
	/** 复用外部持有的目标（换会话时清掉） */
	goals?: GoalList;
	/** 复用外部持有的交付物清单（换会话时清掉） */
	present?: PresentList;
	/** 子代理：给了才会注册那四个工具（`source: "subagent"` 时一律不注册） */
	subagents?: {
		run: (task: { label: string; prompt: string }, signal: AbortSignal) => Promise<string>;
		table: SubagentProgressTable;
		limit?: number;
	};
	/** 复用外部持有的后台任务注册表 */
	jobs?: JobRegistry;
	/** bash 的单次输出上限；有落盘目录时调用方通常把它调大 */
	maxBytes?: number;
}): AgentTool[] {
	const source = options.source ?? "main";
	// 三个文件工具（read / write / edit）共用一张读取证据表：谁读过什么，edit / write 才能据此判断该不该放行。
	const evidence = new ReadEvidence();
	const fileOptions = { ...options, evidence };
	const tools: AgentTool[] = [
		createBashTool(options),
		createReadTool(fileOptions),
		createWriteTool(fileOptions),
		createEditTool(fileOptions),
		createGrepTool(options),
		createGlobTool(options),
		...createTodoTools(options.todos ?? new TodoList()),
		...createGoalTools(options.goals ?? new GoalList()),
		...createPresentTools(options.present ?? new PresentList()),
		// 内核不替调用方拍板「怎么造子 agent」：没给 run 就不注册这四个工具（否则模型会调到一个跑不起来的工具）
		...(options.subagents === undefined ? [] : createSubagentTools(options.subagents)),
		...createJobTools(options.jobs ?? new JobRegistry({ cwd: options.cwd })),
	];
	return filterToolsForSource(tools, source);
}
