/**
 * 项目指令（LIMKENION.md / AGENTS.md）加载与注入。
 *
 * 此前 /init 的提示词里承诺「LIMKENION.md 会被加载进每一个会话」，但引擎
 * 根本不读它 —— 承诺不兑现。这里补上：
 * - ensureInstructions(root)：按 mtime 缓存加载（文件没变不重复读盘）；
 * - 加载后触发 instructions-loaded 钩子，钩子的 additionalContext 追加进缓存；
 * - instructionsCached()：baseSystemPrompt 组装时同步取缓存文本。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HOOK_EVENT, hooksEnabled, runEventHooks } from './hooks.mjs'
import { workspaceRoot } from './paths.mjs'

const INSTRUCTION_FILES = ['LIMKENION.md', 'AGENTS.md']
/** root -> { text, mtimes: Map<path, mtimeMs> } */
const cache = new Map()

/** 加载（带 mtime 缓存）。在回合的沙箱作用域内调用，root = workspaceRoot()。 */
export async function ensureInstructions(root) {
  const prev = cache.get(root)
  const found = []
  for (const name of INSTRUCTION_FILES) {
    const p = join(root, name)
    try {
      const st = await stat(p)
      if (st.isFile()) found.push({ path: p, mtimeMs: st.mtimeMs })
    } catch { /* 没有这个文件，正常 */ }
  }
  if (prev && prev.mtimes.size === found.length && found.every(f => prev.mtimes.get(f.path) === f.mtimeMs)) return
  const parts = []
  for (const f of found) {
    try { parts.push(await readFile(f.path, "utf8")) } catch { /* 读不了就跳过 */ }
  }
  const text = parts.filter(Boolean).join("\n\n")
  cache.set(root, { text, mtimes: new Map(found.map(f => [f.path, f.mtimeMs])) })
  // instructions-loaded 钩子：只在本会话/本根首次加载时才有意义，
  // 但 mtime 变了也要再触发（指令更新 = 重新"加载完成"）。
  if (hooksEnabled() && found.length > 0) {
    try {
      const res = await runEventHooks(HOOK_EVENT.INSTRUCTIONS_LOADED, {
        hookInput: { session_id: "", cwd: root, files: found.map(f => f.path) },
      })
      if (res.additionalContext) {
        cache.get(root).text = text + "\n\n[instructions-loaded 钩子附加]\n" + res.additionalContext
      }
    } catch { /* 钩子失败不拦指令注入 */ }
  }
}

/** 系统提示组装用：当前作用域根的已缓存指令文本（无则空串）。 */
export function instructionsCached() {
  return cache.get(workspaceRoot())?.text ?? ""
}
