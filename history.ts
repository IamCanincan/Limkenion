import { appendFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getProjectRoot, getSessionId } from './bootstrap/state.js'
import { registerCleanup } from './utils/cleanupRegistry.js'
import type { HistoryEntry, PastedContent } from './utils/config.js'
import { logForDebugging } from './utils/debug.js'
import { getLimkenionConfigHomeDir, isEnvTruthy } from './utils/envUtils.js'
import { getErrnoCode } from './utils/errors.js'
import { readLinesReverse } from './utils/fsOperations.js'
import { lock } from './utils/lockfile.js'
import {
  hashPastedText,
  retrievePastedText,
  storePastedText,
} from './utils/pasteStore.js'
import { sleep } from './utils/sleep.js'
import { jsonParse, jsonStringify } from './utils/slowOperations.js'

const MAX_HISTORY_ITEMS = 100
const MAX_PASTED_CONTENT_LENGTH = 1024

/**
 * 存储的粘贴内容 —— 可以是内联内容，也可以是指向粘贴存储的哈希引用。
 */
type StoredPastedContent = {
  id: number
  type: 'text' | 'image'
  content?: string // 小段粘贴内容使用内联
  contentHash?: string // 大段粘贴内容外部存储时的哈希引用
  mediaType?: string
  filename?: string
}

/**
 * Limkenion 会解析历史记录中的粘贴内容引用，以便回溯到具体的粘贴内容。
 * 这些引用形如：
 *   Text: [Pasted text #1 +10 lines]
 *   Image: [Image #2]
 * 这些编号在单次提示内应保证唯一，但跨提示不必唯一。
 * 我们选择自增数字 ID，因为它比其他 ID 方案对用户更友好。
 */

// 注意：最初的文本粘贴实现会把 "line1\nline2\nline3" 这样的输入
// 视为 +2 行而不是 3 行。这里我们保留了该行为。
export function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length
}

export function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines === 0) {
    return `[Pasted text #${id}]`
  }
  return `[Pasted text #${id} +${numLines} lines]`
}

export function formatImageRef(id: number): string {
  return `[Image #${id}]`
}

export function parseReferences(
  input: string,
): Array<{ id: number; match: string; index: number }> {
  const referencePattern =
    /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
  const matches = [...input.matchAll(referencePattern)]
  return matches
    .map(match => ({
      id: parseInt(match[2] || '0'),
      match: match[0],
      index: match.index,
    }))
    .filter(match => match.id > 0)
}

/**
 * 把输入中的 [Pasted text #N] 占位符替换为实际内容。
 * 图片引用不作处理 —— 它们会变成内容块，而不是内联文本。
 */
export function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, PastedContent>,
): string {
  const refs = parseReferences(input)
  let expanded = input
  // 按原始匹配的偏移位置做拼接，这样粘贴内容里形似占位符的
  // 字符串就不会被误当成真实引用。采用倒序，好让后面的替换
  // 不会让前面的偏移失效。
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    const content = pastedContents[ref.id]
    if (content?.type !== 'text') continue
    expanded =
      expanded.slice(0, ref.index) +
      content.content +
      expanded.slice(ref.index + ref.match.length)
  }
  return expanded
}

function deserializeLogEntry(line: string): LogEntry {
  return jsonParse(line) as LogEntry
}

async function* makeLogEntryReader(): AsyncGenerator<LogEntry> {
  const currentSession = getSessionId()

  // 从尚未落盘的条目开始
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    yield pendingEntries[i]!
  }

  // 从全局历史文件读取（跨所有项目共享）
  const historyPath = join(getLimkenionConfigHomeDir(), 'history.jsonl')

  try {
    for await (const line of readLinesReverse(historyPath)) {
      try {
        const entry = deserializeLogEntry(line)
        // removeLastFromHistory 的慢路径：该条目在移除之前已被落盘，
        // 所以在这里过滤，好让 getHistory（向上箭头）与 makeHistoryReader
        // （ctrl+r 搜索）都一致地跳过它。
        if (
          entry.sessionId === currentSession &&
          skippedTimestamps.has(entry.timestamp)
        ) {
          continue
        }
        yield entry
      } catch (error) {
        // 不是致命错误 —— 跳过格式错误的行即可
        logForDebugging(`Failed to parse history line: ${error}`)
      }
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return
    }
    throw e
  }
}

export async function* makeHistoryReader(): AsyncGenerator<HistoryEntry> {
  for await (const entry of makeLogEntryReader()) {
    yield await logEntryToHistoryEntry(entry)
  }
}

export type TimestampedHistoryEntry = {
  display: string
  timestamp: number
  resolve: () => Promise<HistoryEntry>
}

/**
 * 供 ctrl+r 选择器使用的当前项目历史：按展示文本去重、
 * 最新的排在最前，并带时间戳。粘贴内容通过 `resolve()` 惰性解析 ——
 * 选择器在列表里只读取展示文本与时间戳。
 */
export async function* getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry> {
  const currentProject = getProjectRoot()
  const seen = new Set<string>()

  for await (const entry of makeLogEntryReader()) {
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue
    if (seen.has(entry.display)) continue
    seen.add(entry.display)

    yield {
      display: entry.display,
      timestamp: entry.timestamp,
      resolve: () => logEntryToHistoryEntry(entry),
    }

    if (seen.size >= MAX_HISTORY_ITEMS) return
  }
}

/**
 * 获取当前项目的历史条目，当前会话的条目排在最前。
 *
 * 当前会话的条目会先于其他会话的条目产出，这样并发会话就不会
 * 把各自的向上箭头历史交错在一起。每组内部按最新优先排序。
 * 扫描范围与之前的 MAX_HISTORY_ITEMS 窗口相同 —— 条目只是在
 * 该窗口内被重排，不会超出这个窗口。
 */
export async function* getHistory(): AsyncGenerator<HistoryEntry> {
  const currentProject = getProjectRoot()
  const currentSession = getSessionId()
  const otherSessionEntries: LogEntry[] = []
  let yielded = 0

  for await (const entry of makeLogEntryReader()) {
    // 跳过格式错误的条目（文件损坏、旧格式或 JSON 结构非法）
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue

    if (entry.sessionId === currentSession) {
      yield await logEntryToHistoryEntry(entry)
      yielded++
    } else {
      otherSessionEntries.push(entry)
    }

    // 与之前相同的 MAX_HISTORY_ITEMS 窗口 —— 只是在窗口内做了重排。
    if (yielded + otherSessionEntries.length >= MAX_HISTORY_ITEMS) break
  }

  for (const entry of otherSessionEntries) {
    if (yielded >= MAX_HISTORY_ITEMS) return
    yield await logEntryToHistoryEntry(entry)
    yielded++
  }
}

type LogEntry = {
  display: string
  pastedContents: Record<number, StoredPastedContent>
  timestamp: number
  project: string
  sessionId?: string
}

/**
 * 把存储的粘贴内容解析为完整的 PastedContent，必要时从粘贴存储中取回。
 */
async function resolveStoredPastedContent(
  stored: StoredPastedContent,
): Promise<PastedContent | null> {
  // 若有内联内容则直接使用
  if (stored.content) {
    return {
      id: stored.id,
      type: stored.type,
      content: stored.content,
      mediaType: stored.mediaType,
      filename: stored.filename,
    }
  }

  // 若有哈希引用则从粘贴存储中取回
  if (stored.contentHash) {
    const content = await retrievePastedText(stored.contentHash)
    if (content) {
      return {
        id: stored.id,
        type: stored.type,
        content,
        mediaType: stored.mediaType,
        filename: stored.filename,
      }
    }
  }

  // 内容不可用
  return null
}

/**
 * 通过解析粘贴存储引用，把 LogEntry 转换为 HistoryEntry。
 */
async function logEntryToHistoryEntry(entry: LogEntry): Promise<HistoryEntry> {
  const pastedContents: Record<number, PastedContent> = {}

  for (const [id, stored] of Object.entries(entry.pastedContents || {})) {
    const resolved = await resolveStoredPastedContent(stored)
    if (resolved) {
      pastedContents[Number(id)] = resolved
    }
  }

  return {
    display: entry.display,
    pastedContents,
  }
}

let pendingEntries: LogEntry[] = []
let isWriting = false
let currentFlushPromise: Promise<void> | null = null
let cleanupRegistered = false
let lastAddedEntry: LogEntry | null = null
// 已落盘、但读取时应被跳过的条目的时间戳。
// 供 removeLastFromHistory 在该条目已越过待写缓冲区时使用。
// 会话作用域（进程重启时模块状态会重置）。
const skippedTimestamps = new Set<number>()

// 核心落盘逻辑 —— 把待写条目写入磁盘
async function immediateFlushHistory(): Promise<void> {
  if (pendingEntries.length === 0) {
    return
  }

  let release
  try {
    const historyPath = join(getLimkenionConfigHomeDir(), 'history.jsonl')

    // 在加锁之前确保文件存在（append 模式会在文件缺失时创建）
    await writeFile(historyPath, '', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'a',
    })

    release = await lock(historyPath, {
      stale: 10000,
      retries: {
        retries: 3,
        minTimeout: 50,
      },
    })

    const jsonLines = pendingEntries.map(entry => jsonStringify(entry) + '\n')
    pendingEntries = []

    await appendFile(historyPath, jsonLines.join(''), { mode: 0o600 })
  } catch (error) {
    logForDebugging(`Failed to write prompt history: ${error}`)
  } finally {
    if (release) {
      await release()
    }
  }
}

async function flushPromptHistory(retries: number): Promise<void> {
  if (isWriting || pendingEntries.length === 0) {
    return
  }

  // 在下一条用户提示之前，停止尝试落盘历史
  if (retries > 5) {
    return
  }

  isWriting = true

  try {
    await immediateFlushHistory()
  } finally {
    isWriting = false

    if (pendingEntries.length > 0) {
      // 避免在热循环中反复重试
      await sleep(500)

      void flushPromptHistory(retries + 1)
    }
  }
}

async function addToPromptHistory(
  command: HistoryEntry | string,
): Promise<void> {
  const entry =
    typeof command === 'string'
      ? { display: command, pastedContents: {} }
      : command

  const storedPastedContents: Record<number, StoredPastedContent> = {}
  if (entry.pastedContents) {
    for (const [id, content] of Object.entries(entry.pastedContents)) {
      // 过滤掉图片（它们单独存放在 image-cache 中）
      if (content.type === 'image') {
        continue
      }

      // 小段文本内容直接内联存储
      if (content.content.length <= MAX_PASTED_CONTENT_LENGTH) {
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          content: content.content,
          mediaType: content.mediaType,
          filename: content.filename,
        }
      } else {
        // 大段文本内容：同步计算哈希并存储引用
        // 真正的磁盘写入是异步的（发后不管）
        const hash = hashPastedText(content.content)
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          contentHash: hash,
          mediaType: content.mediaType,
          filename: content.filename,
        }
        // 发后不管的磁盘写入 —— 不阻塞历史条目的创建
        void storePastedText(hash, content.content)
      }
    }
  }

  const logEntry: LogEntry = {
    ...entry,
    pastedContents: storedPastedContents,
    timestamp: Date.now(),
    project: getProjectRoot(),
    sessionId: getSessionId(),
  }

  pendingEntries.push(logEntry)
  lastAddedEntry = logEntry
  currentFlushPromise = flushPromptHistory(0)
  void currentFlushPromise
}

export function addToHistory(command: HistoryEntry | string): void {
  // 在由 Limkenion 的 Tungsten 工具派生的 tmux 会话中运行时跳过历史记录。
  // 这可以避免校验/测试会话污染用户真实的命令历史。
  if (isEnvTruthy(process.env.LIMKENION_SKIP_PROMPT_HISTORY)) {
    return
  }

  // 首次使用时注册清理逻辑
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      // 若已有正在进行的落盘，则等待它完成
      if (currentFlushPromise) {
        await currentFlushPromise
      }
      // 若落盘完成后仍有待写条目，则再执行一次最终落盘
      if (pendingEntries.length > 0) {
        await immediateFlushHistory()
      }
    })
  }

  void addToPromptHistory(command)
}


/**
 * 撤销最近一次 addToHistory 调用。供「中断时自动恢复」使用：
 * 当 Esc 在任何响应到达之前回退了对话时，这次提交在语义上就被撤销了 ——
 * 对应的历史条目也应当撤销，否则向上箭头会把恢复出来的文本显示两次
 * （一次来自输入框，一次来自磁盘）。
 *
 * 快速路径直接从待写缓冲区弹出。若异步落盘已抢先完成
 * （TTFT 通常远大于磁盘写入延迟），该条目的时间戳会被加入一个
 * 跳过集合，由 getHistory 查询。一次性：会清空被跟踪的条目，
 * 因此第二次调用是空操作。
 */
export function removeLastFromHistory(): void {
  if (!lastAddedEntry) return
  const entry = lastAddedEntry
  lastAddedEntry = null

  const idx = pendingEntries.lastIndexOf(entry)
  if (idx !== -1) {
    pendingEntries.splice(idx, 1)
  } else {
    skippedTimestamps.add(entry.timestamp)
  }
}
