/**
 * 工具延迟加载。
 *
 * 41 份 schema 全量随每轮请求发出 ≈ 11K 字符，而多数回合只会用到少数几个。
 * 这里把工具分成两档：
 *   - 常驻（CORE_TOOL_NAMES）：基础工作流必需，始终发送；
 *   - 延迟：默认不发，模型通过 ToolSearch 检索后按会话启用。
 * 会话级启用状态存在 session.enabledTools 上，互不影响。
 */

import { CORE_TOOL_NAMES, TOOL_SCHEMAS } from './tools.mjs'

/** 延迟工具名（不含常驻）。 */
export const DEFERRED_TOOL_NAMES = TOOL_SCHEMAS
  .map(s => s.function.name)
  .filter(n => !CORE_TOOL_NAMES.has(n))

/** 取某会话当前应发送的 schema 列表。 */
export function schemasFor(session) {
  const enabled = session?.enabledTools
  if (!enabled || enabled.size === 0) {
    return TOOL_SCHEMAS.filter(s => CORE_TOOL_NAMES.has(s.function.name))
  }
  return TOOL_SCHEMAS.filter(
    s => CORE_TOOL_NAMES.has(s.function.name) || enabled.has(s.function.name),
  )
}

/** 取某会话当前可调用的工具名集合。 */
export function availableNames(session) {
  return new Set(schemasFor(session).map(s => s.function.name))
}

/**
 * 启用若干延迟工具。
 * @returns {string[]} 本次新启用的工具名（已启用的不重复返回）
 */
export function enableTools(session, names) {
  if (!session) return []
  if (!session.enabledTools) session.enabledTools = new Set()
  const newly = []
  for (const n of names) {
    if (!TOOL_SCHEMAS.some(s => s.function.name === n)) continue
    if (CORE_TOOL_NAMES.has(n)) continue
    if (session.enabledTools.has(n)) continue
    session.enabledTools.add(n)
    newly.push(n)
  }
  return newly
}

/** 系统提示里给模型看的延迟工具清单（只列名字，省 token）。 */
export function deferredHint() {
  if (DEFERRED_TOOL_NAMES.length === 0) return ''
  return (
    `以下工具默认未加载，需要时先用 ToolSearch 检索并启用，之后即可直接调用：\n` +
    DEFERRED_TOOL_NAMES.join('、')
  )
}

/** /tools 命令的分组展示。 */
export function toolsOverview(session) {
  const enabled = session?.enabledTools ?? new Set()
  const core = [...CORE_TOOL_NAMES]
  const on = DEFERRED_TOOL_NAMES.filter(n => enabled.has(n))
  const off = DEFERRED_TOOL_NAMES.filter(n => !enabled.has(n))
  return (
    `工具共 ${TOOL_SCHEMAS.length} 个，当前会话可调用 ${schemasFor(session).length} 个。\n\n` +
    `常驻（${core.length}）：\n${core.join('、')}\n\n` +
    `已启用的延迟工具（${on.length}）：\n${on.length ? on.join('、') : '（无）'}\n\n` +
    `未启用（${off.length}）：\n${off.join('、')}\n\n` +
    `用 ToolSearch(query="关键词") 启用，或在输入框执行 /tools enable <名称>。`
  )
}
