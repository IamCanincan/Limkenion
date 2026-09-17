/**
 * 工作区文件索引（带缓存与失效）。
 *
 * Grep / Glob / @ 补全都需要「工作区里有哪些文件」。原先每次调用都重新递归整棵树
 * （上限 5000 文件），既慢又重复。这里做一层缓存：
 *   - 带 TTL（默认 30s），过期自动重建；
 *   - 任何写盘操作（Write / Edit / NotebookEdit）后显式失效；
 *   - 递归时直接跳过 node_modules / .git / dist 等重目录，并设深度与数量上限。
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { relToWorkspace, workspaceRoot } from './paths.mjs'

/** 递归时跳过的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.workbuddy-ai', '.next', 'coverage', '__pycache__'])

/** 参与索引的文件扩展名（@ 补全与 Grep 默认扫描范围）。 */
export const INDEX_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|yml|yaml|toml|txt|sh)$/i

const MAX_FILES = 5000
const MAX_DEPTH = 12
const TTL_MS = 30_000

/**
 * 文件列表缓存，**按沙箱根分别缓存**。
 *
 * 沙箱根是按会话的（会话可以进入某个 git worktree），所以不能只有一份缓存 ——
 * 否则 A 会话切到 worktree 之后，B 会话拿到的是 A 的目录树（越权看到别的树）。
 */
const caches = new Map()

/** 显式失效（写盘后调用）。清全部：写盘可能发生在任何一个根里。 */
export function invalidateFileIndex() {
  caches.clear()
}

/** 递归收集文件绝对路径（内部实现，不带缓存）。 */
async function walk(dir, depth, acc) {
  if (depth > MAX_DEPTH || acc.length >= MAX_FILES) return acc
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break
    if (SKIP_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, depth + 1, acc)
    else if (e.isFile()) acc.push(full)
  }
  return acc
}

/**
 * 取工作区内全部文件的绝对路径（带缓存）。
 * @param {string} [base] 限定子目录；传入时绕过缓存直接扫（范围小、结果多变）
 */
export async function collectFiles(base) {
  const root = workspaceRoot()
  if (base && base !== root) {
    return walk(base, 0, [])
  }
  const cached = caches.get(root)
  if (cached && Date.now() - cached.at < TTL_MS && cached.files.length > 0) return cached.files
  const files = await walk(root, 0, [])
  caches.set(root, { at: Date.now(), files })
  return files
}

/**
 * 供前端 @ 补全使用的相对路径清单（只含源码/文档类扩展名）。
 * @returns {Promise<string[]>} 形如 `web/server/index.mjs`
 */
export async function listIndexedFiles() {
  const files = await collectFiles()
  return files
    .filter(f => INDEX_EXTS.test(f))
    .map(f => relToWorkspace(f))
    .sort()
}

/** 缓存状态（供 /status 展示）。 */
export function fileIndexStatus() {
  const cached = caches.get(workspaceRoot())
  return { count: cached?.files.length ?? 0, ageMs: !cached || cached.at === 0 ? null : Date.now() - cached.at }
}
