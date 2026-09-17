export const AGENT_TOOL_NAME = 'Agent'
// 向后兼容的旧版连线名称（权限规则、钩子、恢复的会话）
export const LEGACY_AGENT_TOOL_NAME = 'Task'
export const VERIFICATION_AGENT_TYPE = 'verification'

// 运行一次并返回报告的内置代理——父代理不会再 SendMessage 回去继续它们。
// 为这些代理跳过 agentId/SendMessage/usage 尾部，以节省 token
// （约 135 字符 × 每周 34M 次 Explore 运行）。
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
])
