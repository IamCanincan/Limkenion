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
import { WORKSPACE_ROOT, relToWorkspace } from './paths.mjs'

/** 递归时跳过的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.workbuddy-ai', '.next', 'coverage', '__pycache__'])

/** 参与索引的文件扩展名（@ 补全与 Grep 默认扫描范围）。 */
export const INDEX_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|yml|yaml|toml|txt|sh)$/i

const MAX_FILES = 5000
const MAX_DEPTH = 12
const TTL_MS = 30_000

/** 绝对路径列表缓存。 */
let cache = { at: 0, files: [] }

/** 显式失效（写盘后调用）。 */
export function invalidateFileIndex() {
  cache = { at: 0, files: [] }
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
  if (base && base !== WORKSPACE_ROOT) {
    return walk(base, 0, [])
  }
  if (Date.now() - cache.at < TTL_MS && cache.files.length > 0) return cache.files
  const files = await walk(WORKSPACE_ROOT, 0, [])
  cache = { at: Date.now(), files }
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
  return { count: cache.files.length, ageMs: cache.at === 0 ? null : Date.now() - cache.at }
}
