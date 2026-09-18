/**
 * 工作区文件监听 → file-changed 钩子。
 *
 * 设计取舍：
 * - 用 fs.watch 递归监听沙箱根（Windows 原生支持递归）。任何钩子配置之外的开销
 *   只有一个 watcher 句柄；没有配置 file-changed 钩子时，事件直接丢弃。
 * - 500ms 去抖 + 单飞（同一批变更合并成一次触发），避免构建/安装时被钩子风暴淹死。
 * - 跳过 .git / node_modules / dist 等噪音目录。
 */
import { watch } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { workspaceRoot } from './paths.mjs'
import { HOOK_EVENT, runEventHooks } from './hooks.mjs'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.workbuddy', '.workbuddy-ai'])
let started = false
let pending = null
let pendingPaths = new Map()
/** 保险丝：file-changed 钩子可能自己改文件再触发监听 → 自激成环。 */
const HOOK_COOLDOWN_MS = 2000
let lastFireAt = 0
let inFlight = 0

function interesting(relPath) {
  const parts = relPath.split(sep)
  return !parts.some(p => SKIP_DIRS.has(p))
}

function flush() {
  pending = null
  const batch = [...pendingPaths.entries()]
  pendingPaths = new Map()
  // 保险丝：上一批钩子还在跑、或刚跑完没出冷却期，就丢弃本批 ——
  // 宁可少触发（监听是尽力而为），也不能让「钩子改文件 → 再触发钩子」成环。
  if (inFlight > 0 || Date.now() - lastFireAt < HOOK_COOLDOWN_MS) return
  for (const [relPath, change] of batch) {
    inFlight++
    runEventHooks(HOOK_EVENT.FILE_CHANGED, {
      hookInput: { session_id: '', path: relPath, change },
    })
      .catch(() => {})
      .finally(() => { inFlight--; lastFireAt = Date.now() })
  }
}

/** 启动工作区监听（幂等）。失败静默 —— 监听不可用不应影响服务启动。 */
export function startFileWatcher() {
  if (started) return
  started = true
  try {
    watch(workspaceRoot(), { recursive: true }, (_event, filename) => {
      if (!filename) return
      const rel = relative(workspaceRoot(), join(workspaceRoot(), String(filename)))
      if (!rel || rel.startsWith('..') || !interesting(rel)) return
      pendingPaths.set(rel, _event)
      if (!pending) pending = setTimeout(flush, 500)
    })
  } catch { /* 平台不支持等 —— 静默 */ }
}
