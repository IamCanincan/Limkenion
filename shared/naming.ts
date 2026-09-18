/**
 * Limkenion 对外概念命名 —— **唯一定义处**。
 *
 * 背景：本项目 fork 自 上游 CLI 原型，品牌词已全部替换，但对外契约仍是 CC 的
 * 命名（`PreToolUse` / `acceptEdits` / `EnterPlanMode` 等）。这份文件定义
 * Limkenion 自己的名字，并保留旧名到新名的映射。
 *
 * 设计取舍（已定）：
 *   - **新名为主**：文档、UI、提示词一律用新名。
 *   - **旧名自动兼容**：读配置时把旧名归一化成新名，用户已有的 settings.json
 *     不用改就能继续工作。**内部代码不需要跟着改** —— 归一化只发生在配置解析入口。
 *
 * 命名风格：连字符的「对象-动作」（`tool-before`），不用 PascalCase。
 *
 * 这个文件没有依赖，CLI（TS）直接 import，web 通过
 * `scripts/gen-shared-contract.mjs` 提取成 JSON 消费 —— 单一来源，不会漂移。
 */

/** 钩子事件：旧名 → 新名。 */
export const HOOK_EVENT_ALIASES = {
  PreToolUse: 'tool-before',
  PostToolUse: 'tool-after',
  PostToolUseFailure: 'tool-failed',
  Notification: 'notice',
  UserPromptSubmit: 'prompt-submit',
  SessionStart: 'session-open',
  SessionEnd: 'session-close',
  Stop: 'turn-end',
  StopFailure: 'turn-failed',
  SubagentStart: 'agent-start',
  SubagentStop: 'agent-end',
  PreCompact: 'context-compact-before',
  PostCompact: 'context-compact-after',
  PermissionRequest: 'permission-request',
  PermissionDenied: 'permission-denied',
  Setup: 'setup',
  TeammateIdle: 'teammate-idle',
  TaskCreated: 'task-created',
  TaskCompleted: 'task-completed',
  Elicitation: 'elicitation-request',
  ElicitationResult: 'elicitation-result',
  ConfigChange: 'config-change',
  WorktreeCreate: 'worktree-create',
  WorktreeRemove: 'worktree-remove',
  InstructionsLoaded: 'instructions-loaded',
  CwdChanged: 'cwd-changed',
  FileChanged: 'file-changed',
} as const

/**
 * 权限模式：旧名 → 新名。
 *
 * **本阶段未启用改名** —— 权限模式名（default / acceptEdits / plan / bypassPermissions）
 * 仍保持与 CLI 一致。原因：改名会牵动 settings 解析、权限判定（interactions.mjs 的
 * 安全关键路径）、前端下拉（SettingsControls.tsx / types.ts）与单测，风险高且本次未确认。
 * 等用户明确要改名时，把下面的值改成新名即可；归一化函数 `canonicalPermissionMode`
 * 已经就位，旧配置 / 旧写法会自动兼容，不用改用户文件。
 * `plan` 原本就是直觉叫法，留着。
 */
export const PERMISSION_MODE_ALIASES = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  bypassPermissions: 'bypassPermissions',
  dontAsk: 'dontAsk',
} as const

/**
 * 工具名：旧名 → 新名。
 *
 * 只动 `EnterPlanMode` / `ExitPlanMode` 这一对 —— 带 "Mode" 后缀是最容易被认出
 * 来自 CC 的部分。改成 `PlanEnter` / `PlanExit`，与既有的
 * `WorktreeCreate` / `WorktreeRemove`（对象+动作）保持一致。
 *
 * 其余工具名（Read / Write / Edit / Bash / Glob / Grep …）是通用叫法，
 * 改了收益低而破坏性大，不动。
 */
export const TOOL_NAME_ALIASES = {
  EnterPlanMode: 'PlanEnter',
  ExitPlanMode: 'PlanExit',
} as const

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/** 做个「旧名 → 新名」的反查加速表；同时能接受已经是新名的输入。 */
function buildIndex(aliases: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>()
  for (const [oldName, newName] of Object.entries(aliases)) {
    m.set(oldName, newName)
    m.set(newName, newName) // 新名归一化成自己
  }
  return m
}

const HOOK_INDEX = buildIndex(HOOK_EVENT_ALIASES)
const MODE_INDEX = buildIndex(PERMISSION_MODE_ALIASES)
const TOOL_INDEX = buildIndex(TOOL_NAME_ALIASES)

/**
 * 把任意写法（新名或旧名）归一化成新名。
 * 不认识的名字**原样返回** —— 交给调用方去报错，这里不擅自吞掉。
 */
export function canonicalHookEvent(name: string): string {
  return HOOK_INDEX.get(name) ?? name
}

export function canonicalPermissionMode(name: string): string {
  return MODE_INDEX.get(name) ?? name
}

/** 工具名归一化。用于解析权限规则（如 `Bash(git:*)`）与工具分派。 */
export function canonicalToolName(name: string): string {
  return TOOL_INDEX.get(name) ?? name
}

/** 这个工具名是不是已改名的那些的旧称（供给出迁移提示用）。 */
export function isLegacyToolName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_NAME_ALIASES, name)
}

/** 全部新名（供文档 / UI 列举）。 */
export const HOOK_EVENTS_CANONICAL = Object.values(HOOK_EVENT_ALIASES)
export const PERMISSION_MODES_CANONICAL = Object.values(PERMISSION_MODE_ALIASES)
