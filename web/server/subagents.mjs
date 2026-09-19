/**
 * 具名子代理（可视化管理）。
 *
 * 原先子代理是**匿名的**：模型调 Agent 时只能用固定的只读工具集、会话当前的模型。
 * 这里加一层"具名定义"，让用户可以预先配好几种子代理（比如"只读调研员"用便宜模型、
 * 不联网），模型和界面都能按名字选用。
 *
 * 刻意收紧的两条边界（别放开）：
 *   - **工具只能是 SUBAGENT_TOOLS（只读集）的子集** —— 绝不给子代理写盘/执行的能力，
 *     否则"子代理是只读的"这个保证就作废了。
 *   - **模型必须是我们支持的型号**（当前只有 DeepSeek 两款）—— 不因为新增配置面就
 *     悄悄开出多供应商口子。
 */

import { settingsSources, writeSettingsScope } from './settings.mjs'
import { MODELS, PERMISSION_MODES } from './config.mjs'
import { SUBAGENT_TOOLS } from './tools.mjs'

const MODEL_VALUES = MODELS.map(m => m.value)
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/

/**
 * 校验并规范化一条子代理定义。
 * @param {Record<string, any>} cfg
 * @returns {{description:string, model?:string, tools?:string[], permissionMode?:string}}
 */
function normalize(cfg) {
  const out = /** @type {{description:string, model?:string, tools?:string[], permissionMode?:string}} */ ({ description: String(cfg?.description ?? '').trim() })

  if (cfg?.model != null && String(cfg.model).trim() !== '') {
    const model = String(cfg.model).trim()
    if (!MODEL_VALUES.includes(model)) {
      throw new Error(`不支持的模型「${model}」；可用：${MODEL_VALUES.join('、')}`)
    }
    out.model = model
  }

  if (cfg?.tools != null) {
    const tools = Array.isArray(cfg.tools) ? cfg.tools.map(String) : []
    const illegal = tools.filter(t => !SUBAGENT_TOOLS.has(t))
    if (illegal.length > 0) {
      throw new Error(
        `子代理只能用只读工具，这些不行：${illegal.join('、')}（可用：${[...SUBAGENT_TOOLS].join('、')}）`,
      )
    }
    out.tools = [...new Set(tools)]
  }

  if (cfg?.permissionMode != null && String(cfg.permissionMode).trim() !== '') {
    const mode = String(cfg.permissionMode).trim()
    if (!PERMISSION_MODES.includes(mode)) {
      throw new Error(`不支持的权限模式「${mode}」`)
    }
    out.permissionMode = mode
  }
  return out
}

/**
 * 合并各作用域的 subagents（后者覆盖同名前者）。
 * @returns {Array<{name:string, description:string, model?:string, tools?:string[], permissionMode?:string, source:string}>}
 */
export function subagents() {
  /** @type {Map<string, any>} */
  const merged = new Map()
  for (const { source, data } of settingsSources()) {
    const defs = data?.subagents
    if (!defs || typeof defs !== 'object') continue
    for (const [name, cfg] of Object.entries(defs)) {
      if (!cfg || typeof cfg !== 'object') continue
      merged.set(name, { name, ...normalize(cfg), source })
    }
  }
  return [...merged.values()]
}

/** @param {string} name */
export function getSubagent(name) {
  return subagents().find(s => s.name === name) ?? null
}

/**
 * 解析具名子代理（供 runSubAgent 用）。
 *
 * 抽出来一是好读，二是**可测** —— 这里最要紧的不是"能解析"，而是
 * **找不到时必须如实说没执行**：曾经写成「已按默认只读子代理执行」，可代码是直接
 * return 的，任务根本没跑，等于对模型撒谎。
 *
 * @param {string} [name] 空值/不传表示不指定（走默认只读子代理）
 * @returns {{ok: true, agent: ReturnType<typeof getSubagent>} | {ok: false, error: string}}
 */
export function resolveSubagent(name) {
  const key = String(name ?? '').trim()
  if (!key) return { ok: true, agent: null }
  const agent = getSubagent(key)
  if (agent) return { ok: true, agent }
  const known = subagents().map(s => s.name).join('、')
  return {
    ok: false,
    error:
      `子代理「${key}」不存在，**未执行**（不会擅自当成默认子代理跑）` +
      `。可用：${known || '（当前没有配置具名子代理）'}`,
  }
}

/**
 * 新增 / 更新一条定义。
 * @param {string} name
 * @param {Record<string, any>} cfg
 * @param {'user'|'project'|'local'} scope
 */
export function saveSubagent(name, cfg, scope = 'user') {
  const key = String(name ?? '').trim()
  if (!NAME_RE.test(key)) {
    throw new Error(`子代理名不合法：${name}（只限字母数字与 _ -，最长 40）`)
  }
  const value = normalize(cfg)
  writeSettingsScope(scope, data => {
    const defs = { ...(data.subagents ?? {}) }
    defs[key] = { ...(defs[key] ?? {}), ...value }
    return { ...data, subagents: defs }
  })
  return getSubagent(key)
}

/**
 * @param {string} name
 * @param {'user'|'project'|'local'} scope
 * @returns {boolean} 是否真的删掉了（该作用域没定义则返回 false，不动文件）
 */
export function deleteSubagent(name, scope) {
  const key = String(name ?? '').trim()
  const { data } = settingsSources().find(s => s.source === scope) ?? {}
  if (!data?.subagents?.[key]) return false
  writeSettingsScope(scope, d => {
    const defs = { ...(d.subagents ?? {}) }
    delete defs[key]
    return { ...d, subagents: defs }
  })
  return true
}
