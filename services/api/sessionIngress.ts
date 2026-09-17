import axios, { type AxiosError } from 'axios'
import type { UUID } from 'crypto'
import { getOauthConfig } from '../../constants/oauth.js'
import type { Entry, TranscriptMessage } from '../../types/logs.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { sequential } from '../../utils/sequential.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getOAuthHeaders } from '../../utils/teleport/api.js'

interface SessionIngressError {
  error?: {
    message?: string
    type?: string
  }
}

// 模块级状态
const lastUuidMap: Map<string, UUID> = new Map()

const MAX_RETRIES = 10
const BASE_DELAY_MS = 500

// 每个会话一个顺序包装器，防止并发写入日志
const sequentialAppendBySession: Map<
  string,
  (
    entry: TranscriptMessage,
    url: string,
    headers: Record<string, string>,
  ) => Promise<boolean>
> = new Map()

/**
 * 获取或创建某个会话的顺序包装器
 * 这确保一个会话的日志追加是逐条依次处理的
 */
function getOrCreateSequentialAppend(sessionId: string) {
  let sequentialAppend = sequentialAppendBySession.get(sessionId)
  if (!sequentialAppend) {
    sequentialAppend = sequential(
      async (
        entry: TranscriptMessage,
        url: string,
        headers: Record<string, string>,
      ) => await appendSessionLogImpl(sessionId, entry, url, headers),
    )
    sequentialAppendBySession.set(sessionId, sequentialAppend)
  }
  return sequentialAppend
}

/**
 * appendSessionLog 的内部实现，带重试逻辑
 * 对瞬时错误（网络、5xx、429）重试。遇到 409 时，采用服务器的
 * 最新 UUID 并重试（处理被终止进程的进行中请求残留的过期状态）。
 * 遇到 401 则立即失败。
 */
async function appendSessionLogImpl(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const lastUuid = lastUuidMap.get(sessionId)
      const requestHeaders = { ...headers }
      if (lastUuid) {
        requestHeaders['Last-Uuid'] = lastUuid
      }

      const response = await axios.put(url, entry, {
        headers: requestHeaders,
        validateStatus: status => status < 500,
      })

      if (response.status === 200 || response.status === 201) {
        lastUuidMap.set(sessionId, entry.uuid)
        logForDebugging(
          `已成功持久化会话 ${sessionId} 的日志条目`,
        )
        return true
      }

      if (response.status === 409) {
        // 检查我们的条目是否实际上已被存储（服务器返回 409 但条目已存在）
        // 这处理了条目已存储但客户端收到错误响应、导致 lastUuidMap 过期的场景
        const serverLastUuid = response.headers['x-last-uuid']
        if (serverLastUuid === entry.uuid) {
          // 我们的条目就是服务器上的最后条目——之前已成功存储
          lastUuidMap.set(sessionId, entry.uuid)
          logForDebugging(
            `会话条目 ${entry.uuid} 已存在于服务器上，正在从过期状态恢复`,
          )
          logForDiagnosticsNoPII('info', 'session_persist_recovered_from_409')
          return true
        }

        // 另一个写入者（例如被终止进程的进行中请求）
        // 推进了服务器的链。尝试从响应请求头中采用服务器的最新 UUID，
        // 或重新拉取会话以发现它。
        if (serverLastUuid) {
          lastUuidMap.set(sessionId, serverLastUuid as UUID)
          logForDebugging(
            `会话 409：正在从请求头采用服务器 lastUuid=${serverLastUuid}，重试条目 ${entry.uuid}`,
          )
        } else {
          // 服务器未返回 x-last-uuid（例如 v1 端点）。重新拉取
          // 会话以发现追加链的当前头部。
          const logs = await fetchSessionLogsFromUrl(sessionId, url, headers)
          const adoptedUuid = findLastUuid(logs)
          if (adoptedUuid) {
            lastUuidMap.set(sessionId, adoptedUuid)
            logForDebugging(
              `会话 409：已重新拉取 ${logs!.length} 条条目，采用 lastUuid=${adoptedUuid}，重试条目 ${entry.uuid}`,
            )
          } else {
            // 无法确定服务器状态——放弃
            const errorData = response.data as SessionIngressError
            const errorMessage =
              errorData.error?.message || '检测到并发修改'
            logError(
              new Error(
                `会话持久化冲突：会话 ${sessionId} 的 UUID 不匹配，条目 ${entry.uuid}。${errorMessage}`,
              ),
            )
            logForDiagnosticsNoPII(
              'error',
              'session_persist_fail_concurrent_modification',
            )
            return false
          }
        }
        logForDiagnosticsNoPII('info', 'session_persist_409_adopt_server_uuid')
        continue // 使用更新的 lastUuid 重试
      }

      if (response.status === 401) {
        logForDebugging('会话 token 已过期或无效')
        logForDiagnosticsNoPII('error', 'session_persist_fail_bad_token')
        return false // 不可重试
      }

      // 其他 4xx（429 等）——可重试
      logForDebugging(
        `持久化会话日志失败：${response.status} ${response.statusText}`,
      )
      logForDiagnosticsNoPII('error', 'session_persist_fail_status', {
        status: response.status,
        attempt,
      })
    } catch (error) {
      // 网络错误、5xx——可重试
      const axiosError = error as AxiosError<SessionIngressError>
      logError(new Error(`持久化会话日志出错：${axiosError.message}`))
      logForDiagnosticsNoPII('error', 'session_persist_fail_status', {
        status: axiosError.status,
        attempt,
      })
    }

    if (attempt === MAX_RETRIES) {
      logForDebugging(`远程持久化在 ${MAX_RETRIES} 次尝试后失败`)
      logForDiagnosticsNoPII(
        'error',
        'session_persist_error_retries_exhausted',
        { attempt },
      )
      return false
    }

    const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 8000)
    logForDebugging(
      `远程持久化第 ${attempt}/${MAX_RETRIES} 次尝试失败，将在 ${delayMs}ms 后重试…`,
    )
    await sleep(delayMs)
  }

  return false
}

/**
 * 使用 JWT token 将会话日志条目追加到会话
 * 通过 Last-Uuid 请求头进行乐观并发控制
 * 确保每个会话顺序执行，以防止竞态条件
 */
export async function appendSessionLog(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
): Promise<boolean> {
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('没有可用于会话持久化的会话 token')
    logForDiagnosticsNoPII('error', 'session_persist_fail_jwt_no_token')
    return false
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${sessionToken}`,
    'Content-Type': 'application/json',
  }

  const sequentialAppend = getOrCreateSequentialAppend(sessionId)
  return sequentialAppend(entry, url, headers)
}

/**
 * 获取全部会话日志用于水合恢复
 */
export async function getSessionLogs(
  sessionId: string,
  url: string,
): Promise<Entry[] | null> {
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('没有可用于获取会话日志的会话 token')
    logForDiagnosticsNoPII('error', 'session_get_fail_no_token')
    return null
  }

  const headers = { Authorization: `Bearer ${sessionToken}` }
  const logs = await fetchSessionLogsFromUrl(sessionId, url, headers)

  if (logs && logs.length > 0) {
    // 将我们的 lastUuid 更新为最后一条条目的 UUID
    const lastEntry = logs.at(-1)
    if (lastEntry && 'uuid' in lastEntry && lastEntry.uuid) {
      lastUuidMap.set(sessionId, lastEntry.uuid)
    }
  }

  return logs
}

/**
 * 通过 OAuth 获取全部会话日志用于水合恢复
 * 用于从 Sessions API 传送会话
 */
export async function getSessionLogsViaOAuth(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const url = `${getOauthConfig().BASE_API_URL}/v1/session_ingress/session/${sessionId}`
  logForDebugging(`[session-ingress] 正在从以下地址获取会话日志：${url}`)
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }
  const result = await fetchSessionLogsFromUrl(sessionId, url, headers)
  return result
}

/**
 * GET /v1/code/sessions/{id}/teleport-events 的响应结构。
 * WorkerEvent.payload 就是 Entry（TranscriptMessage 结构）——CLI
 * 通过 AddWorkerEvent 写入它，服务器将其不透明存储，我们在此读回。
 */
type TeleportEventsResponse = {
  data: Array<{
    event_id: string
    event_type: string
    is_compaction: boolean
    payload: Entry | null
    created_at: string
  }>
  // 当没有更多页时未设置——这本身就是流的结束
  // 信号（没有单独的 has_more 字段）。
  next_cursor?: string
}

/**
 * 通过 CCR v2 Sessions API 获取 worker 事件（会话记录）。一旦
 * session-ingress 退役，它将取代 getSessionLogsViaOAuth。
 *
 * 服务器按会话分发：v2 原生会话走 Spanner，
 * 回填前的 session_* ID 走 threadstore。游标对我们而言是不透明的——
 * 原样回传，直到 next_cursor 未设置。
 *
 * 分页（默认每页 500，服务器上限 1000）。session-ingress 的一次性
 * 5 万条已取消；我们改为循环拉取。
 */
export async function getTeleportEvents(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const baseUrl = `${getOauthConfig().BASE_API_URL}/v1/code/sessions/${sessionId}/teleport-events`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  logForDebugging(`[teleport] 正在从以下地址获取事件：${baseUrl}`)

  const all: Entry[] = []
  let cursor: string | undefined
  let pages = 0

  // 防无限循环：1000/页 × 100 页 = 10 万条事件。大于
  // session-ingress 的一次性 5 万条。若触发此上限，说明有问题
  //（服务器未推进游标）——应退出而非挂起。
  const maxPages = 100

  while (pages < maxPages) {
    const params: Record<string, string | number> = { limit: 1000 }
    if (cursor !== undefined) {
      params.cursor = cursor
    }

    let response
    try {
      response = await axios.get<TeleportEventsResponse>(baseUrl, {
        headers,
        params,
        timeout: 20000,
        validateStatus: status => status < 500,
      })
    } catch (e) {
      const err = e as AxiosError
      logError(new Error(`Teleport 事件获取失败：${err.message}`))
      logForDiagnosticsNoPII('error', 'teleport_events_fetch_fail')
      return null
    }

    if (response.status === 404) {
      // 迁移窗口期的 404 存在歧义：
      //   (a) 会话确实未找到（既不在 Spanner 也不在
      //       threadstore 中）——无可获取。
      //   (b) 路由级 404：端点尚未部署，或该会话是
      //       尚未回填进 Spanner 的 threadstore 会话。
      // 仅凭响应我们无法区分二者。返回 null
      // 可让调用方回退到 session-ingress，它会对场景 (a) 正确返回空、
      // 对场景 (b) 返回数据。一旦回填完成且 session-ingress
      // 下线，回退也会返回 null → 与今天相同的 "Failed to fetch
      // session logs" 错误。
      //
      // 分页中途（pages > 0）的 404 表示会话在页与页之间被删除——
      // 返回我们已有的内容。
      logForDebugging(
        `[teleport] 未找到会话 ${sessionId}（第 ${pages} 页）`,
      )
      logForDiagnosticsNoPII('warn', 'teleport_events_not_found')
      return pages === 0 ? null : all
    }

    if (response.status === 401) {
      logForDiagnosticsNoPII('error', 'teleport_events_bad_token')
      throw new Error(
        '你的会话已过期。请运行 /login 重新登录。',
      )
    }

    if (response.status !== 200) {
      logError(
        new Error(
          `Teleport 事件返回 ${response.status}：${jsonStringify(response.data)}`,
        ),
      )
      logForDiagnosticsNoPII('error', 'teleport_events_bad_status')
      return null
    }

    const { data, next_cursor } = response.data
    if (!Array.isArray(data)) {
      logError(
        new Error(
          `Teleport 事件响应结构无效：${jsonStringify(response.data)}`,
        ),
      )
      logForDiagnosticsNoPII('error', 'teleport_events_invalid_shape')
      return null
    }

    // payload 就是 Entry。null payload 出现在 threadstore 非通用
    // 事件（服务器跳过它们）或加密失败时——这里也一并跳过。
    for (const ev of data) {
      if (ev.payload !== null) {
        all.push(ev.payload)
      }
    }

    pages++
    // == null 同时覆盖 `null` 和 `undefined`——proto 在流结束时省略
    // 该字段，但有些序列化器会发出 `null`。严格的
    // `=== undefined` 会在 `null` 上无限循环（查询参数中的
    // cursor=null 会字符串化为 "null"，服务器会拒绝或原样回显）。
    if (next_cursor == null) {
      break
    }
    cursor = next_cursor
  }

  if (pages >= maxPages) {
    // 不要失败——返回我们已有的内容。带截断的会话记录传送
    // 总比完全无法传送要好。
    logError(
      new Error(`Teleport 事件达到页数上限（${maxPages}）会话 ${sessionId}`),
    )
    logForDiagnosticsNoPII('warn', 'teleport_events_page_cap')
  }

  logForDebugging(
    `[teleport] 已通过 ${pages} 页为会话 ${sessionId} 获取 ${all.length} 条事件`,
  )
  return all
}

/**
 * 从 URL 获取会话日志的共享实现
 */
async function fetchSessionLogsFromUrl(
  sessionId: string,
  url: string,
  headers: Record<string, string>,
): Promise<Entry[] | null> {
  try {
    const response = await axios.get(url, {
      headers,
      timeout: 20000,
      validateStatus: status => status < 500,
      params: isEnvTruthy(process.env.LIMKENION_AFTER_LAST_COMPACT)
        ? { after_last_compact: true }
        : undefined,
    })

    if (response.status === 200) {
      const data = response.data

      // 验证响应结构
      if (!data || typeof data !== 'object' || !Array.isArray(data.loglines)) {
        logError(
          new Error(
            `无效的会话日志响应格式：${jsonStringify(data)}`,
          ),
        )
        logForDiagnosticsNoPII('error', 'session_get_fail_invalid_response')
        return null
      }

      const logs = data.loglines as Entry[]
      logForDebugging(
        `已为会话 ${sessionId} 获取 ${logs.length} 条会话日志`,
      )
      return logs
    }

    if (response.status === 404) {
      logForDebugging(`会话 ${sessionId} 没有现有日志`)
      logForDiagnosticsNoPII('warn', 'session_get_no_logs_for_session')
      return []
    }

    if (response.status === 401) {
      logForDebugging('认证 token 已过期或无效')
      logForDiagnosticsNoPII('error', 'session_get_fail_bad_token')
      throw new Error(
        '你的会话已过期。请运行 /login 重新登录。',
      )
    }

    logForDebugging(
      `获取会话日志失败：${response.status} ${response.statusText}`,
    )
    logForDiagnosticsNoPII('error', 'session_get_fail_status', {
      status: response.status,
    })
    return null
  } catch (error) {
    const axiosError = error as AxiosError<SessionIngressError>
    logError(new Error(`获取会话日志出错：${axiosError.message}`))
    logForDiagnosticsNoPII('error', 'session_get_fail_status', {
      status: axiosError.status,
    })
    return null
  }
}

/**
 * 从后往前遍历条目，找到最后一条带 uuid 的条目。
 * 有些条目类型（SummaryMessage、TagMessage）没有 uuid。
 */
function findLastUuid(logs: Entry[] | null): UUID | undefined {
  if (!logs) {
    return undefined
  }
  const entry = logs.findLast(e => 'uuid' in e && e.uuid)
  return entry && 'uuid' in entry ? (entry.uuid as UUID) : undefined
}

/**
 * 清除某个会话的缓存状态
 */
export function clearSession(sessionId: string): void {
  lastUuidMap.delete(sessionId)
  sequentialAppendBySession.delete(sessionId)
}

/**
 * 清除所有会话的缓存状态（全部会话）。
 * 在 /clear 时调用，以释放子代理会话条目。
 */
export function clearAllSessions(): void {
  lastUuidMap.clear()
  sequentialAppendBySession.clear()
}
