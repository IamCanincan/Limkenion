/**
 * 服务端配置与常量。
 *
 * 职责：路径解析、端口/主机、模型目录、设置（全局默认 + 会话级覆盖）、各类上限常量。
 * 不依赖任何其他内部模块，供其余模块自由引用。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { DEEPSEEK_MODELS, getApiKey } from './deepseek.mjs'
import { CLI_ROOT, WORKSPACE_ROOT } from './paths.mjs'
import { broadcast } from './bus.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 前端构建产物目录。 */
export const DIST_DIR = join(__dirname, '..', 'dist')

/** 端口：环境变量优先。 */
export const PORT = Number(process.env.LIMKENION_WEB_PORT ?? 8788)

/**
 * 监听地址：默认只绑回环，避免局域网内任何人连上就能驱动一个能读写文件、执行 shell 的 agent。
 * 需要从其他设备访问时显式设置 LIMKENION_WEB_HOST=0.0.0.0，并自行承担风险。
 */
export const HOST = process.env.LIMKENION_WEB_HOST ?? '127.0.0.1'

/** 是否绑定了非回环地址（用于启动告警与放宽 Origin 校验）。 */
export const EXPOSED = !['127.0.0.1', 'localhost', '::1'].includes(HOST)

export const SERVER_VERSION = '0.6.0'
export const startedAt = Date.now()

/** CLI 源码根下的命令目录（全局安装时 CLI_ROOT 回退为工作目录，可能不存在）。 */
export const COMMANDS_DIR = join(CLI_ROOT, 'commands')
export const HAS_CLI_SOURCE = existsSync(COMMANDS_DIR)

export { CLI_ROOT, WORKSPACE_ROOT }

/** 模型目录（取自 deepseek-harness packages/llm/llm-deepseek DEFAULT_MODELS）。 */
export const MODELS = DEEPSEEK_MODELS

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
export const THEMES = ['dark', 'light', 'system']
export const CONFIG_KEYS = new Set(['theme', 'model', 'permissionMode', 'outputStyle'])

export const MAX_TOOL_ROUNDS = 20
export const MAX_SUBAGENT_ROUNDS = 8

/** 单次工具结果回灌给模型的上限。 */
export const MAX_TOOL_RESULT_CHARS = 30_000
/** 单条 diff 上限，超出则截断（避免大文件 Write 把整份 diff 塞进 WS 帧与会话内存）。 */
export const MAX_DIFF_CHARS = 60_000

// ---------------------------------------------------------------------------
// 设置：全局默认值 + 会话级覆盖（多标签页互不干扰）
// ---------------------------------------------------------------------------

/** 全局默认设置（新会话继承）。 */
export const globalSettings = {
  theme: 'dark',
  permissionMode: 'default',
  model: MODELS[0].value,
  outputStyle: 'default',
}

/** 取某会话的有效设置（全局默认 + 该会话覆盖）。 */
export function settingsFor(session) {
  return { ...globalSettings, ...(session?.settings ?? {}) }
}

/** 设置项的取值校验。 */
export function validateSetting(key, value) {
  if (key === 'model') return MODELS.some(m => m.value === value)
  if (key === 'theme') return THEMES.includes(value)
  if (key === 'permissionMode') return PERMISSION_MODES.includes(value)
  if (key === 'outputStyle') return typeof value === 'string' && value.length > 0
  return false
}

/**
 * 写入设置。session 为 null 时写全局默认，否则只覆盖该会话。
 * @returns {boolean} 是否成功（取值非法时返回 false）
 */
export function applySetting(session, key, value) {
  if (!validateSetting(key, value)) return false
  if (session) session.settings = { ...(session.settings ?? {}), [key]: value }
  else globalSettings[key] = value
  return true
}

/** 对外暴露的设置快照（不含内部字段）。 */
export function publicSettings(session, engineName) {
  const s = settingsFor(session)
  return {
    theme: s.theme,
    permissionMode: s.permissionMode,
    model: s.model,
    outputStyle: s.outputStyle,
    workspace: WORKSPACE_ROOT,
    engine: engineName ?? (getApiKey() ? 'deepseek' : 'mock'),
  }
}

/** 当前引擎名。 */
export function engineName() {
  return getApiKey() ? 'deepseek' : 'mock'
}

/**
 * 写入设置并广播。
 * session 为 null 时改全局默认；否则只改该会话（多标签页互不干扰）。
 * 广播带 sessionId，前端只应用属于自己活动会话的那份。
 */
export function applySessionSetting(session, key, value) {
  if (!applySetting(session, key, value)) return false
  broadcast({ type: 'settings', sessionId: session?.id ?? null, settings: publicSettings(session) })
  if (key === 'model') {
    broadcast({ type: 'model_changed', sessionId: session?.id ?? null, model: value })
  }
  return true
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
