import { feature } from 'bun:bundle'
import { isReplBridgeActive } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { Tool } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'

// 死代码消除：仅在 KAIROS 或 KAIROS_BRIEF 开启时才需要 Brief 工具名
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../BriefTool/prompt.js') as typeof import('../BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('../SendUserFileTool/prompt.js') as typeof import('../SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

export { TOOL_SEARCH_TOOL_NAME } from './constants.js'

import { TOOL_SEARCH_TOOL_NAME } from './constants.js'

const PROMPT_HEAD = `Fetches full schema definitions for deferred tools so they can be called.

`

// 与 toolSearch.ts 中的 isDeferredToolsDeltaEnabled 保持一致（未导入 ——
// toolSearch.ts 从本文件导入）。启用时：工具通过
// system-reminder 附件公布。禁用时：前置
// <available-deferred-tools> 块（门控前的行为）。
function getToolLocationHint(): string {
  const deltaEnabled =
    (getFeatureValue_CACHED_MAY_BE_STALE('limkenion_glacier_2xr', false))
  return deltaEnabled
    ? 'Deferred tools appear by name in <system-reminder> messages.'
    : 'Deferred tools appear by name in <available-deferred-tools> messages.'
}

const PROMPT_TAIL = ` Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`

/**
 * 检查某个工具是否应被延迟（需要 ToolSearch 加载）。
 * 工具被延迟的条件：
 * - 它是 MCP 工具（总是延迟 - 特定于工作流）
 * - 它有 shouldDefer: true
 *
 * 如果工具有 alwaysLoad: true，则绝不延迟（MCP 工具通过
 * _meta['limkenion/alwaysLoad'] 设置）。该检查最先运行，先于其他任何规则。
 */
export function isDeferredTool(tool: Tool): boolean {
  // 通过 _meta['limkenion/alwaysLoad'] 显式退出 —— 工具会带着完整 schema
  // 出现在初始提示词中。最先检查，以便 MCP 工具能够退出。
  if (tool.alwaysLoad === true) return false

  // MCP 工具总是延迟（特定于工作流）
  if (tool.isMcp === true) return true

  // 绝不延迟 ToolSearch 本身 —— 模型需要它来加载其他所有工具
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  // Fork 优先实验：Agent 必须在第 1 回合就可用，而不是藏在 ToolSearch 之后。
  // 惰性 require：静态导入 forkSubagent → coordinatorMode 会在模块初始化时
  // 经由 constants/tools.ts 形成循环。
  if (feature('FORK_SUBAGENT') && tool.name === AGENT_TOOL_NAME) {
    type ForkMod = typeof import('../AgentTool/forkSubagent.js')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('../AgentTool/forkSubagent.js') as ForkMod
    if (m.isForkSubagentEnabled()) return false
  }

  // 只要该工具存在，Brief 就是主要的通信渠道。
  // 它的提示词包含文本可见性契约，模型必须在没有
  // ToolSearch 往返的情况下看到它。此处无需运行时门控：该
  // 工具的 isEnabled() 就是 isBriefEnabled()，因此被询问其延迟
  // 状态就意味着门控已通过。
  if (
    (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
    BRIEF_TOOL_NAME &&
    tool.name === BRIEF_TOOL_NAME
  ) {
    return false
  }

  // SendUserFile 是文件投递通信渠道（与 Brief 同级）。
  // 必须无需 ToolSearch 往返即可立即使用。
  if (
    feature('KAIROS') &&
    SEND_USER_FILE_TOOL_NAME &&
    tool.name === SEND_USER_FILE_TOOL_NAME &&
    isReplBridgeActive()
  ) {
    return false
  }

  return tool.shouldDefer === true
}

/**
 * 为 <available-deferred-tools> 用户消息格式化一行延迟工具。
 * 搜索提示（tool.searchHint）不会被渲染 ——
 * 提示 A/B 测试（exp_xenhnnmn0smrx4，已于 3 月 21 日停止）显示无收益。
 */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

export function getPrompt(): string {
  return PROMPT_HEAD + getToolLocationHint() + PROMPT_TAIL
}
