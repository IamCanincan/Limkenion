/**
 * 文件检查点（上游 CLI 原型 checkpoint 的 web 实现）。
 *
 * Write/Edit 每次**改动前**把文件旧内容快照一份；`/rewind` 回退对话时，
 * 把「保留窗口之后」发生的所有文件改动一并回滚——当时不存在的文件删掉，
 * 存在过的恢复原内容。
 *
 * 存储是**进程内存**（按会话 id 分桶，条数与单文件大小都有上限）：
 * - 服务重启后快照丢失 → /rewind 的文件回滚能力随之失效，回退时如实报告剩余数；
 * - 不落盘是为了避免 base64 塞爆会话持久化文件。
 *
 * 依赖方向：只被 tools.mjs / commands.mjs import，自身不 import 任何服务端模块。
 */
import { writeFile, readFile, mkdir, rm, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'

import { STATE_DIR } from './sessions.mjs'

/** 会话内自增序号：防抖落盘的定时器句柄。 */
const saveTimers = new Map()

/** sessionId -> entries[]；entry: { msgSeq, path, prev, at }，prev === null 表示当时文件不存在。 */
const store = new Map()

const MAX_ENTRIES_PER_SESSION = 300
const MAX_SNAPSHOT_CHARS = 4_000_000 // 单文件快照上限（约 4MB），超出不记（回滚会漏，如实报告）

// ---- 工作区快照（Bash 盲区补偿）----
// Bash 改文件不走 Write/Edit，没有检查点 → rewind 回不滚。补偿：变更类 Bash
// 执行前对工作区做**有界**内容快照，内容按 SHA1 去重存 blob（同一文件多次快照
// 只存一份）。预算：单文件 1MB / 总量 12MB / 文件数 2500，超限宁可少记、回退时
// 如实报告 failed。blob 只存内存（重启丢，与既有局限一致）；条目本身随 JSON 落盘。
const WS_MAX_FILES = 2500
const WS_MAX_FILE_CHARS = 1_000_000
const WS_MAX_TOTAL_CHARS = 12_000_000
const WS_BLOB_BUDGET_CHARS = 24_000_000
const WS_SKIP_DIRS = new Set([".git", "node_modules", "dist", ".workbuddy", ".workbuddy-ai", ".state", "coverage", ".cache"])
/** sessionId -> Map<hash, content>。 */
const blobs = new Map()

/** 只读命令白名单（含管道/重定向/串联的一律视为可能有写副作用）。 */
const READ_ONLY_RE = /^(ls|dir|cat|type|head|tail|grep|rg|findstr|find|pwd|which|where|whoami|git\s+(status|log|diff|show|branch|remote)\b|node\s+-[vV]|python3?\s+-[Vv])/i
export function commandLikelyMutating(command) {
  const cmd = String(command ?? "")
  if (/[>]|;|&&|\|/.test(cmd)) return true
  return !READ_ONLY_RE.test(cmd.trim())
}

/**
 * 记一条检查点。必须在**写入之前**调用；`prev` 传「写入前的完整内容」，
 * 文件当时不存在则传 `null`（回滚时删除）。
 */
export function recordCheckpoint(session, absolutePath, prev) {
  if (!session?.id || typeof absolutePath !== 'string') return
  if (prev !== null && typeof prev !== 'string') return
  if (prev !== null && prev.length > MAX_SNAPSHOT_CHARS) return // 太大：宁可不记，也不能记成 null 误删
  const arr = store.get(session.id) ?? []
  arr.push({ msgSeq: session.messages?.length ?? 0, path: absolutePath, prev, at: Date.now() })
  if (arr.length > MAX_ENTRIES_PER_SESSION) arr.shift()
  store.set(session.id, arr)
  scheduleSave(session.id)
}

/**
 * 变更类 Bash 执行**之前**调用：对工作区做有界内容快照（哈希去重）。
 * @param {object} session
 * @param {string} root 工作区根（绝对路径，由调用方传入）
 * @returns {Promise<{files:number, captured:number}>} captured = 新存了内容的 blob 数
 */
export async function snapshotWorkspace(session, root) {
  if (!session?.id) return { files: 0, captured: 0 }
  const files = []
  let total = 0
  async function walk(dir) {
    if (files.length >= WS_MAX_FILES || total >= WS_MAX_TOTAL_CHARS) return
    let dirents
    try { dirents = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const d of dirents) {
      if (files.length >= WS_MAX_FILES || total >= WS_MAX_TOTAL_CHARS) return
      if (d.name.startsWith(".") && d.name !== ".limkenion") continue
      if (WS_SKIP_DIRS.has(d.name)) continue
      const abs = join(dir, d.name)
      if (d.isDirectory()) { await walk(abs); continue }
      if (!d.isFile()) continue
      try {
        const st = await stat(abs)
        if (st.size > WS_MAX_FILE_CHARS) continue
        const content = await readFile(abs, "utf8")
        if (content.includes("\u0000")) continue // 二进制内容，不记
        total += content.length
        if (total > WS_MAX_TOTAL_CHARS) return
        const hash = createHash("sha1").update(content).digest("hex")
        files.push({ path: abs, hash })
        let bucket = blobs.get(session.id)
        if (!bucket) { bucket = new Map(); blobs.set(session.id, bucket) }
        if (!bucket.has(hash)) {
          bucket.set(hash, content)
          // 预算淘汰：超了就丢最早的 blob（回退时对应文件会报 failed，如实）
          let size = 0
          for (const v of bucket.values()) size += v.length
          while (size > WS_BLOB_BUDGET_CHARS && bucket.size > 1) {
            const oldest = bucket.keys().next().value
            size -= bucket.get(oldest).length
            bucket.delete(oldest)
          }
        }
      } catch { /* 读不了的文件跳过 */ }
    }
  }
  await walk(root)
  if (files.length === 0) return { files: 0, captured: 0 }
  const arr = store.get(session.id) ?? []
  arr.push({ msgSeq: session.messages?.length ?? 0, kind: "ws", files, at: Date.now() })
  if (arr.length > MAX_ENTRIES_PER_SESSION) arr.shift()
  store.set(session.id, arr)
  scheduleSave(session.id)
  return { files: files.length, captured: 0 }
}

/**
 * 回滚 `keepMsgCount` 之后发生的全部文件改动（msgSeq >= keepMsgCount 的检查点）。
 * 按**逆序**恢复，同一条消息里先 Write 后 Edit 的文件最终停在最早的快照上。
 *
 * @returns {Promise<{restored:number, failed:number, remaining:number}>}
 */
export async function restoreCheckpoints(session, keepMsgCount) {
  await loadIfEmpty(session.id)
  const arr = store.get(session.id) ?? []
  const toRoll = arr.filter(e => e.msgSeq >= keepMsgCount)
  let restored = 0
  let failed = 0
  /** 已恢复过的路径：逆序回放里最早的快照最终生效，后面不用重复写。 */
  const handled = new Set()
  const sessionBlobs = blobs.get(session.id) ?? new Map()
  for (const e of [...toRoll].reverse()) {
    // 工作区快照条目：把当时存在的文件从 blob 还原。只补尚未被更新的
    // per-file 记录处理过的路径（逆序回放里 per-file 记录天然优先）。
    if (e.kind === 'ws' && Array.isArray(e.files)) {
      for (const f of e.files) {
        if (handled.has(f.path)) continue
        handled.add(f.path)
        const content = sessionBlobs.get(f.hash)
        if (content === undefined) { failed++; continue }
        try {
          await writeFile(f.path, content, 'utf8')
          restored++
        } catch {
          failed++
        }
      }
      continue
    }
    if (handled.has(e.path)) continue
    handled.add(e.path)
    try {
      if (e.prev === null) {
        await rm(e.path, { force: true })
      } else {
        await writeFile(e.path, e.prev, 'utf8')
      }
      restored++
    } catch {
      failed++
    }
  }
  store.set(session.id, arr.filter(e => e.msgSeq < keepMsgCount))
  return { restored, failed, remaining: store.get(session.id)?.length ?? 0 }
}

/** 剩余检查点条数（/rewind 帮助文案与回退报告用）。 */
export function checkpointCount(sessionId) {
  return store.get(sessionId)?.length ?? 0
}

/** 会话清空 / 删除时清掉它的快照桶。 */
export function clearCheckpoints(sessionId) {
  store.delete(sessionId)
  blobs.delete(sessionId)
  const t = saveTimers.get(sessionId)
  if (t) { clearTimeout(t); saveTimers.delete(sessionId) }
  rm(ckptFile(sessionId), { force: true }).catch(() => {})
}


// ---------------------------------------------------------------------------
// 持久化：每会话一个 JSON 文件（STATE_DIR/checkpoints/<id>.json），防抖落盘。
// 服务重启后 /rewind 的文件回滚能力不再丢失 —— restoreCheckpoints 发现内存桶
// 空但文件存在时会先加载。总大小超限的会话停止记录（宁缺勿滥，如实报告）。
// ---------------------------------------------------------------------------
const MAX_PERSIST_BYTES = 8 * 1024 * 1024
let approxBytes = 0 // 启动后新写入的近似字节数（含全部会话），粗略即可

function ckptFile(sessionId) {
  return join(STATE_DIR, 'checkpoints', encodeURIComponent(sessionId) + '.json')
}

function scheduleSave(sessionId) {
  if (saveTimers.has(sessionId)) return
  const t = setTimeout(() => {
    saveTimers.delete(sessionId)
    persist(sessionId).catch(() => {})
  }, 500)
  if (typeof t.unref === "function") t.unref()
  saveTimers.set(sessionId, t)
}

async function persist(sessionId) {
  const arr = store.get(sessionId)
  try {
    await mkdir(join(STATE_DIR, "checkpoints"), { recursive: true })
    if (!arr || arr.length === 0) {
      await rm(ckptFile(sessionId), { force: true })
      return
    }
    const json = JSON.stringify(arr)
    if (json.length > MAX_PERSIST_BYTES) return // 太大：不落盘，重启后如实退化为仅对话回退
    approxBytes += json.length
    if (approxBytes > 64 * 1024 * 1024) return // 全局写入预算兜底
    await writeFile(ckptFile(sessionId), json, "utf8")
  } catch { /* 磁盘问题不阻断工具流程 */ }
}

async function loadIfEmpty(sessionId) {
  if ((store.get(sessionId)?.length ?? 0) > 0) return
  try {
    const arr = JSON.parse(await readFile(ckptFile(sessionId), "utf8"))
    if (Array.isArray(arr) && arr.length > 0) store.set(sessionId, arr)
  } catch { /* 没有存档，正常 */ }
}

function dropMemoryOnly(sessionId) {
  store.delete(sessionId)
}