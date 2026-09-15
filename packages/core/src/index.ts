/**
 * limkenion-core 公共导出。
 *
 * 内核分四层，依赖方向单向：
 *   tools/（工具是什么）← permissions/（能不能跑）← results/（结果多大）← 循环（turn.ts / agent.ts）
 *
 * 会话持久化、浏览器界面、遥测等能力不在本包，需要的话由调用方在事件回调上自己实现。
 */

export { Agent, type AgentOptions, DEFAULT_MAX_TURNS } from "./agent.ts";
export {
	CHECKPOINT_SUFFIX,
	CheckpointStore,
	isCheckpointFile,
	MAX_SNAPSHOT_BYTES,
	type RewindResult,
} from "./checkpoints.ts";
export {
	applySummary,
	buildSummaryRequest,
	type CompactionOptions,
	calibrate,
	countChars,
	DEFAULT_KEEP_USER_TOKENS,
	describeCompaction,
	dropOldestTurn,
	estimateContextTokens,
	estimateMessages,
	estimateTokens,
	foldableTokens,
	HANDOFF_PREFIX,
	looksContextOverflow,
	MAX_SUMMARY_TOKENS,
	MIN_FOLD_TOKENS,
	MIN_SUMMARY_TOKENS,
	needsCompaction,
	type OverflowRescue,
	PRUNE_HEAD_LINES,
	PRUNE_TAIL_LINES,
	type PruneOptions,
	type PruneResult,
	prunePlaceholder,
	pruneToolOutputs,
	rescueOverflow,
	summaryBudget,
	truncateToTokenBudget,
	type UsageCalibration,
} from "./compaction.ts";
export { applyPlanMode, applyStyle, compressContext, refreshWorldState } from "./context-manager.ts";
export type { Goal, GoalStatus } from "./goals.ts";
export { createGoalTools, GoalList, MAX_GOAL_CONTENT, parseGoal, renderGoal } from "./goals.ts";
export {
	callSignature,
	DEFAULT_REPEAT_LIMIT,
	RepeatGuard,
	repeatReminder,
	timeoutMessage,
	withToolTimeout,
} from "./guard.ts";
export {
	HOOK_TIMEOUT_MS,
	type HookOutcome,
	type HookRunner,
	type HookRunResult,
	matchesTool,
	type PreToolUseEvent,
	type PreToolUseHook,
	runPreToolUseHooks,
	spawnHookRunner,
} from "./hooks.ts";
export {
	type DiscoverInstructionsOptions,
	discoverInstructions,
	findGitRoot,
	type InstructionFile,
	isGitRepo,
} from "./instructions.ts";
export type { JobRecord, JobStatus } from "./jobs.ts";
export { createJobTools, JobRegistry, MAX_JOB_BYTES, MAX_JOBS, renderJobs } from "./jobs.ts";
export { parseJsonLines, parseJsonObject, readJsonObject } from "./json.ts";
export {
	canonicalizePath,
	clampPathToWorkspace,
	isOutsideWorkspace,
	isOutsideWorkspaceReal,
	type PathClampResult,
} from "./paths.ts";
export { type GuardContext, guardToolUse, judgeToolUse, type PermissionQuery } from "./permissions/chain.ts";
export { looksDangerousCommand } from "./permissions/danger.ts";
// —— 权限 ——
export {
	type ApprovalAnswer,
	type ApprovalRequest,
	isRememberable,
	type PermissionBehavior,
	type PermissionDecision,
	type PermissionReason,
} from "./permissions/decision.ts";
export {
	ApprovalMemory,
	type ApprovalRule,
	describeApprovalPrefix,
	suggestApprovalPrefix,
} from "./permissions/memory.ts";
export {
	APPROVAL_MODES,
	type ApprovalMode,
	DEFAULT_APPROVAL_MODE,
	parseApprovalMode,
} from "./permissions/modes.ts";
export { looksReadOnlyCommand } from "./permissions/readonly-command.ts";
export {
	createExitPlanModeTool,
	EXIT_PLAN_MODE_TOOL,
	type ExitPlanModeOptions,
	isPlanning,
	MIN_PLAN_LENGTH,
	PLAN_BLOCKED_HINT,
	PLAN_MODES,
	type PlanMode,
	type PlanVerdict,
	parsePlanMode,
	planSection,
} from "./plan.ts";
export { DETACH_FOR_KILL, decodeProcessOutput, killProcessTree, legacyEncodingCandidates } from "./process.ts";
export {
	buildSystemPrompt,
	PROMPT_SECTIONS,
	type PromptContext,
	type PromptSection,
	resolvePromptSections,
	type SystemPromptOptions,
} from "./prompt.ts";
export { applyResultBudget, emptyResultPlaceholder } from "./results/budget.ts";
export {
	buildReviewPrompt,
	buildSynthesisPrompt,
	FOCUS_GUIDE,
	MAX_FINDINGS,
	parseReviewFocus,
	parseReviewVerdict,
	REVIEW_FOCUSES,
	type ReviewFocus,
} from "./review.ts";
export {
	pruneSpillDir,
	SPILL_KEEP_FILES,
	SPILL_PREVIEW_LINES,
	SPILL_TOOL_OUTPUT_BYTES,
	type SpillFile,
	spillText,
	spillToolOutput,
} from "./spill.ts";
export {
	OUTPUT_STYLES,
	type OutputStyle,
	parseOutputStyle,
	STYLE_GUIDE,
	styleSection,
} from "./style.ts";
export {
	createSubagentTools,
	DEFAULT_FANOUT_LIMIT,
	renderSubagentProgress,
	runSubagents,
	type SubagentEvent,
	type SubagentProgress,
	SubagentProgressTable,
	type SubagentResult,
	type SubagentTask,
} from "./subagent.ts";
export { firstLine, flattenWhitespace, looksBinary, sliceByBytes, summarizeInline } from "./text.ts";
// 审批执行层的类型：宿主实现「怎么问用户」时要能拿到确切类型（含「本会话总是允许」的返回值）。
// `addUsage` 也是给宿主的：它按轮累计用量时要和内核用同一套加法（缓存命中数不能漏）。
export { addUsage, parseArguments, runTool } from "./tool-run.ts";
// —— 工具契约 ——
// `defineTool` 是内核给「自己造工具」的宿主的入口：不自陈只读性的工具按会写处理，
// 不自陈并发性的按不可并发处理（见 tools/contract.ts）。
export {
	DEFAULT_MAX_RESULT_BYTES,
	defineTool,
	type ToolDefinition,
	type ToolValidation,
} from "./tools/contract.ts";
export {
	type BashToolOptions,
	createBashTool,
	createEditTool,
	createReadTool,
	createSystemTools,
	createTodoTools,
	createWriteTool,
	type EditToolOptions,
	/** 工具集裁剪：子代理这条路上没有子代理工具 */
	filterToolsForSource,
	formatSize,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	MAX_TODO_CONTENT,
	MAX_TODO_ITEMS,
	// 交付物的类型：工具自陈 `deliverables` 的返回形状，界面要按它画卡片
	type PresentFile,
	parseTodos,
	type ReadToolOptions,
	renderTodos,
	resolveUserPath,
	SUBAGENT_DENIED_TOOLS,
	type TodoItem,
	TodoList,
	type TodoStatus,
	type ToolSource,
	truncateHead,
	type WriteToolOptions,
} from "./tools/index.ts";
// —— 调度与结果预算 ——
export {
	MAX_TOOL_CONCURRENCY,
	type PreparedCall,
	partitionCalls,
	prepareCalls,
	runConcurrently,
} from "./tools/orchestrate.ts";
export { type AgentEvent, type AgentTool, type ToolOutcome, toToolSpec } from "./types.ts";
