// SDK 核心类型 —— SDK 消费方与 SDK 构建方都会使用的通用可序列化类型。
//
// 这些类型由 coreSchemas.ts 中的 Zod schemas 生成。
// 若要修改类型：
// 1. 编辑 coreSchemas.ts 中的 Zod schemas
// 2. 运行：bun scripts/generate-sdk-types.ts
//
// Schemas 位于 coreSchemas.ts 中，供运行时校验使用，但不属于公共 API。

// 为 SDK 消费方重新导出沙箱类型
export type {
  SandboxFilesystemConfig,
  SandboxIgnoreViolations,
  SandboxNetworkConfig,
  SandboxSettings,
} from '../sandboxTypes.js'
// 重新导出所有生成类型
export * from './coreTypes.generated.js'

// 重新导出无法以 Zod schema 表达的实用类型
export type { NonNullableUsage } from './sdkUtilityTypes.js'

// 供运行时使用的常量数组
export const HOOK_EVENTS = [
  'tool-before',
  'tool-after',
  'tool-failed',
  'notice',
  'prompt-submit',
  'session-open',
  'session-close',
  'turn-end',
  'turn-failed',
  'agent-start',
  'agent-end',
  'context-compact-before',
  'context-compact-after',
  'permission-request',
  'permission-denied',
  'setup',
  'teammate-idle',
  'task-created',
  'task-completed',
  'elicitation-request',
  'elicitation-result',
  'config-change',
  'worktree-create',
  'worktree-remove',
  'instructions-loaded',
  'cwd-changed',
  'file-changed',
] as const

export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const
