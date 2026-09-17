import { open, readFile, stat } from 'fs/promises'
import {
  applyEdits,
  modify,
  parse as parseJsonc,
} from 'jsonc-parser/lib/esm/main.js'
import { stripBOM } from './jsonRead.js'
import { logError } from './log.js'
import { memoizeWithLRU } from './memoize.js'
import { jsonStringify } from './slowOperations.js'

type CachedParse = { ok: true; value: unknown } | { ok: false }

// 已记忆化的内层解析。使用判别联合包装是因为：
// 1. memoizeWithLRU 要求 NonNullable<unknown>，但 JSON.parse 可能返回
//    null（例如 JSON.parse("null")）。
// 2. 无效的 JSON 也必须被缓存——否则用相同的坏串反复调用会每次都
//    重新解析并重新记录（相比旧的包住整个 try/catch 的 lodash memoize
//    是行为回退）。原来的实现每次遇到新的唯一字符串都会永久缓存
//    每一个导致解析失败的字符串，导致内存泄漏。
//    以下是针对这一点的修正。
// 上限为 50 项，防止无界内存增长——之前使用 lodash memoize，会永久
// 缓存每个唯一的 JSON 字符串（settings、.mcp.json、notebook、工具结果），
// 造成显著的内存泄漏。
// 注意：shouldLogError 被刻意排除在缓存键之外（与
// lodash memoize 默认 resolver = 仅第一参数一致）。
// 超过此大小的输入跳过缓存——LRU 把完整字符串存为键，
// 因此一个 200KB 的配置文件会在 50 个槽位中固定约 10MB 的
// #keyList。大的输入如 ~/.limkenion.json 在两次读取之间也会变化
// （numStartups 每次 CC 启动都会递增），所以缓存从不会命中。
const PARSE_CACHE_MAX_KEY_BYTES = 8 * 1024

function parseJSONUncached(json: string, shouldLogError: boolean): CachedParse {
  try {
    return { ok: true, value: JSON.parse(stripBOM(json)) }
  } catch (e) {
    if (shouldLogError) {
      logError(e)
    }
    return { ok: false }
  }
}

const parseJSONCached = memoizeWithLRU(parseJSONUncached, json => json, 50)

// 重要：为了性能而记忆化（最多 50 项的 LRU 上限，仅小输入）。
export const safeParseJSON = Object.assign(
  function safeParseJSON(
    json: string | null | undefined,
    shouldLogError: boolean = true,
  ): unknown {
    if (!json) return null
    const result =
      json.length > PARSE_CACHE_MAX_KEY_BYTES
        ? parseJSONUncached(json, shouldLogError)
        : parseJSONCached(json, shouldLogError)
    return result.ok ? result.value : null
  },
  { cache: parseJSONCached.cache },
)

/**
 * 安全地解析带注释的 JSON（jsonc）。
 * 这对 VS Code 配置文件（如 keybindings.json）很有用，
 * 这类文件支持注释和其他 jsonc 特性。
 */
export function safeParseJSONC(json: string | null | undefined): unknown {
  if (!json) {
    return null
  }
  try {
    // 解析前先去除 BOM——PowerShell 5.x 会向 UTF-8 文件添加 BOM
    return parseJsonc(stripBOM(json))
  } catch (e) {
    logError(e)
    return null
  }
}

/**
 * 通过向数组添加新项来修改 jsonc 字符串，同时保留注释和格式。
 * @param content 要修改的 jsonc 字符串
 * @param newItem 要添加到数组的新项
 * @returns 修改后的 jsonc 字符串
 */
/**
 * Bun.JSONL.parseChunk（如可用），否则返回 false。
 * 同时支持字符串和 Buffer，最大限度减少内存占用和拷贝。
 * 内部也处理 BOM 去除。
 */
type BunJSONLParseChunk = (
  data: string | Buffer,
  offset?: number,
) => { values: unknown[]; error: null | Error; read: number; done: boolean }

const bunJSONLParse: BunJSONLParseChunk | false = (() => {
  if (typeof Bun === 'undefined') return false
  const b = Bun as Record<string, unknown>
  const jsonl = b.JSONL as Record<string, unknown> | undefined
  if (!jsonl?.parseChunk) return false
  return jsonl.parseChunk as BunJSONLParseChunk
})()

function parseJSONLBun<T>(data: string | Buffer): T[] {
  const parse = bunJSONLParse as BunJSONLParseChunk
  const len = data.length
  const result = parse(data)
  if (!result.error || result.done || result.read >= len) {
    return result.values as T[]
  }
  // 流中间出现错误——收集已得的部分并继续
  let values = result.values as T[]
  let offset = result.read
  while (offset < len) {
    const newlineIndex =
      typeof data === 'string'
        ? data.indexOf('\n', offset)
        : data.indexOf(0x0a, offset)
    if (newlineIndex === -1) break
    offset = newlineIndex + 1
    const next = parse(data, offset)
    if (next.values.length > 0) {
      values = values.concat(next.values as T[])
    }
    if (!next.error || next.done || next.read >= len) break
    offset = next.read
  }
  return values
}

function parseJSONLBuffer<T>(buf: Buffer): T[] {
  const bufLen = buf.length
  let start = 0

  // 去除 UTF-8 BOM（EF BB BF）
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3
  }

  const results: T[] = []
  while (start < bufLen) {
    let end = buf.indexOf(0x0a, start)
    if (end === -1) end = bufLen

    const line = buf.toString('utf8', start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // 跳过格式错误的行
    }
  }
  return results
}

function parseJSONLString<T>(data: string): T[] {
  const stripped = stripBOM(data)
  const len = stripped.length
  let start = 0

  const results: T[] = []
  while (start < len) {
    let end = stripped.indexOf('\n', start)
    if (end === -1) end = len

    const line = stripped.substring(start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // 跳过格式错误的行
    }
  }
  return results
}

/**
 * 从字符串或 Buffer 解析 JSONL 数据，跳过格式错误的行。
 * 可用时使用 Bun.JSONL.parseChunk 以获得更好性能，
 * 否则回退到基于 indexOf 的扫描。
 */
export function parseJSONL<T>(data: string | Buffer): T[] {
  if (bunJSONLParse) {
    return parseJSONLBun<T>(data)
  }
  if (typeof data === 'string') {
    return parseJSONLString<T>(data)
  }
  return parseJSONLBuffer<T>(data)
}

const MAX_JSONL_READ_BYTES = 100 * 1024 * 1024

/**
 * 读取并解析 JSONL 文件，最多读取最后 100 MB。
 * 对大于 100 MB 的文件，读取尾部并跳过第一行不完整的行。
 *
 * 100 MB 绰绰有余，因为我们支持的最长上下文窗口约 2M tokens，
 * 远低于 100 MB 的 JSONL。
 */
export async function readJSONLFile<T>(filePath: string): Promise<T[]> {
  const { size } = await stat(filePath)
  if (size <= MAX_JSONL_READ_BYTES) {
    return parseJSONL<T>(await readFile(filePath))
  }
  await using fd = await open(filePath, 'r')
  const buf = Buffer.allocUnsafe(MAX_JSONL_READ_BYTES)
  let totalRead = 0
  const fileOffset = size - MAX_JSONL_READ_BYTES
  while (totalRead < MAX_JSONL_READ_BYTES) {
    const { bytesRead } = await fd.read(
      buf,
      totalRead,
      MAX_JSONL_READ_BYTES - totalRead,
      fileOffset + totalRead,
    )
    if (bytesRead === 0) break
    totalRead += bytesRead
  }
  // 跳过第一行不完整的行
  const newlineIndex = buf.indexOf(0x0a)
  if (newlineIndex !== -1 && newlineIndex < totalRead - 1) {
    return parseJSONL<T>(buf.subarray(newlineIndex + 1, totalRead))
  }
  return parseJSONL<T>(buf.subarray(0, totalRead))
}

export function addItemToJSONCArray(content: string, newItem: unknown): string {
  try {
    // 若内容为空或空白，创建新的 JSON 文件
    if (!content || content.trim() === '') {
      return jsonStringify([newItem], null, 4)
    }

    // 解析前先去除 BOM——PowerShell 5.x 会向 UTF-8 文件添加 BOM
    const cleanContent = stripBOM(content)

    // 解析内容以检查是否为有效 JSON
    const parsedContent = parseJsonc(cleanContent)

    // 若解析出的内容是有效数组，则修改之
    if (Array.isArray(parsedContent)) {
      // 获取数组的长度
      const arrayLength = parsedContent.length

      // 判断是否为空数组
      const isEmpty = arrayLength === 0

      // 若为空数组则在索引 0 处添加，否则追加到末尾
      const insertPath = isEmpty ? [0] : [arrayLength]

      // 生成编辑——使用 isArrayInsertion 添加新项而不覆盖现有项
      const edits = modify(cleanContent, insertPath, newItem, {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
        isArrayInsertion: true,
      })

      // 若无法生成编辑，回退到手工 JSON 字符串拼接
      if (!edits || edits.length === 0) {
        const copy = [...parsedContent, newItem]
        return jsonStringify(copy, null, 4)
      }

      // 应用编辑以保留注释（使用不含 BOM 的 cleanContent）
      return applyEdits(cleanContent, edits)
    }
    // 若内容完全不是数组，创建仅含该新项的新数组
    else {
      // 若内容存在但不是数组，我们将其完全替换
      return jsonStringify([newItem], null, 4)
    }
  } catch (e) {
    // 若因任何原因解析失败，记录错误并回退到创建新的 JSON 数组
    logError(e)
    return jsonStringify([newItem], null, 4)
  }
}
