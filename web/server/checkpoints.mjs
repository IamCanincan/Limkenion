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
import { writeFile, readFile, rm } from 'node:fs/promises'

/** sessionId -> entries[]；entry: { msgSeq, path, prev, at }，prev === null 表示当时文件不存在。 */
const store = new Map()

const MAX_ENTRIES_PER_SESSION = 300
const MAX_SNAPSHOT_CHARS = 4_000_000 // 单文件快照上限（约 4MB），超出不记（回滚会漏，如实报告）

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
}

/**
 * 回滚 `keepMsgCount` 之后发生的全部文件改动（msgSeq >= keepMsgCount 的检查点）。
 * 按**逆序**恢复，同一条消息里先 Write 后 Edit 的文件最终停在最早的快照上。
 *
 * @returns {Promise<{restored:number, failed:number, remaining:number}>}
 */
export async function restoreCheckpoints(session, keepMsgCount) {
  const arr = store.get(session.id) ?? []
  const toRoll = arr.filter(e => e.msgSeq >= keepMsgCount)
  let restored = 0
  let failed = 0
  for (const e of [...toRoll].reverse()) {
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
}
