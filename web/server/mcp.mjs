/**
 * MCP 客户端：连外部工具服务器，把它们的工具接进工具集。
 *
 * CLI 那套是 23 文件 / 12,242 行的子系统（三种传输、OAuth、channel 允许列表、
 * elicitation、官方 registry、ide 集成…）。web 端这里实现**能真用起来的子集**，
 * 没做的部分如实列出来（`/mcp` 会显示），不假装支持：
 *
 *   ✅ 传输：`stdio`（本地子进程）+ `http`（Streamable HTTP：POST JSON-RPC，
 *           响应体是 JSON 或 SSE 流两种都认）
 *   ✅ 能力：tools/list + tools/call、resources/list + resources/read
 *   ✅ `sse`（旧版双端点 HTTP+SSE）、OAuth（`McpAuth`）、elicitation / sampling /
 *      roots 这类**服务端反向请求**、prompt 模板、registry
 *
 * 三条刻意的设计：
 *
 * 1. **不做 OAuth**。OAuth 需要回调端口 + 浏览器授权 + 令牌存储，
 *    半做等于给用户一个"点了授权但没生效"的入口。要带凭证就用 `headers` 传固定 token，
 *    `/mcp` 会把需要授权的服务器明确标出来。
 * 2. **服务端反向请求一律回"未支持"**（JSON-RPC error），而不是挂着不回 ——
 *    挂着不回会让服务器一直等，表现为"工具调用卡住"，最难查。
 * 3. **连接失败不阻塞服务启动**：启动时后台连，失败只记状态；`/mcp` 能看到原因
 *    （含子进程的 stderr 尾巴）。一个配错的服务器不该让整个 web 服务起不来。
 *
 * 工具命名与 CLI 完全一致：`mcp__<规范化服务器名>__<工具名>`
 * （见 `services/mcp/normalization.ts`），这样两端写权限规则时不用记两套。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { settingsSources, writeSettingsScope } from './settings.mjs'
import { settingsFor } from './config.mjs'
import { chatCompletion } from './deepseek.mjs'
import { fetch as guardedFetch } from './egress.mjs'
import { HOOK_EVENT, runEventHooks } from './hooks.mjs'
import { workspaceRoot } from './paths.mjs'
import { bearerFor, forceRefresh, startAuthorization, onAuthorized } from './mcpOAuth.mjs'
import { requestQuestions } from './interactions.mjs'
import { broadcast } from './bus.mjs'
import { pathToFileURL } from 'node:url'

/** 与 CLI 一致的工具名前缀。 */
export const MCP_TOOL_PREFIX = 'mcp__'

/** 与 CLI 的 normalizeNameForMCP 一致：非法字符换成下划线。 */
export function normalizeNameForMCP(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * 生成给模型用的工具全名。
 *
 * **工具名也要规范化**（CLI 那边只规范化服务器名）：OpenAI 的函数名规范要求
 * `^[a-zA-Z0-9_-]{1,64}$`，而 MCP 服务器完全可能起名 `read file`、`fs.read` 这种 ——
 * 原样发出去会被上游判成非法 schema。调用时再按规范化后的名字找回真名（见 callMcpTool）。
 */
export function mcpToolName(serverName, toolName) {
  return `${MCP_TOOL_PREFIX}${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`
}

/** 从全名反解出服务器与工具（与 CLI 的 mcpInfoFromString 同样的解析规则）。 */
export function mcpInfoFromString(toolString) {
  const parts = String(toolString).split('__')
  const [mcpPart, serverName, ...rest] = parts
  if (mcpPart !== 'mcp' || !serverName) return null
  return { serverName, toolName: rest.length > 0 ? rest.join('__') : undefined }
}

export const MCP_SUPPORTED_TRANSPORTS = ['stdio', 'http', 'sse']
// 曾经不支持、后来接上的旧传输——留在 git 历史里提醒「清单是算出来的」这回事
export const MCP_UNSUPPORTED_TRANSPORTS = []

const INIT_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'limkenion-web', version: '0.1.0' }

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/**
 * 读设置文件里的 `mcpServers`（用户级 → 项目级 → 项目本地级，后者覆盖同名前者的
 * 标量字段；配置本身按服务器名合并）。
 */
export function mcpServerConfigs() {
  const merged = new Map()
  for (const { source, data } of settingsSources()) {
    const servers = data?.mcpServers
    if (!servers || typeof servers !== 'object') continue
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== 'object') continue
      const transport = String(cfg.type ?? (cfg.url ? 'http' : 'stdio')).toLowerCase()
      merged.set(name, {
        name,
        transport,
        command: typeof cfg.command === 'string' ? cfg.command : '',
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
        url: typeof cfg.url === 'string' ? cfg.url : '',
        headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
        source,
      })
    }
  }
  return [...merged.values()]
}

/** 该配置能不能用；不能用就给出**具体**原因（不要只写"不支持"）。 */
export function configProblem(cfg) {
  if (MCP_UNSUPPORTED_TRANSPORTS.includes(cfg.transport)) {
    return `传输 ${cfg.transport}（旧版双端点 HTTP+SSE）web 端未实现，改用 http 或 stdio`
  }
  if (!MCP_SUPPORTED_TRANSPORTS.includes(cfg.transport)) {
    return `未知传输类型：${cfg.transport}（支持 ${MCP_SUPPORTED_TRANSPORTS.join(' / ')}）`
  }
  if (cfg.transport === 'stdio') {
    if (!cfg.command.trim()) return 'stdio 服务器缺 command'
  } else if (!/^https?:\/\//.test(cfg.url)) {
    return `${cfg.transport} 服务器缺合法的 url`
  }
  return null
}

// ---------------------------------------------------------------------------
// 传输：stdio
// ---------------------------------------------------------------------------

/**
 * Windows 上 `npx` 这类命令实际是 `npx.cmd`，不经过 shell 找不到；
 * 而经过 shell 又要自己处理引号。所以：win32 走 shell 并逐 token 加引号，
 * 其它平台直接 spawn（更安全，也避免参数被 shell 解释）。
 */
function spawnSpec(cfg) {
  if (process.platform !== 'win32') {
    return { file: cfg.command, args: cfg.args, shell: false }
  }
  const quote = t => (/[\s"&|<>^]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t)
  const line = [cfg.command, ...cfg.args].map(quote).join(' ')
  return { file: line, args: [], shell: true }
}

function createStdioTransport(cfg) {
  const spec = spawnSpec(cfg)
  let child
  const listeners = new Set()
  let closedReason = null
  const stderrTail = []
  // 进程一退出就拒绝"等待连接"的 Promise，避免为了一个打不开的命令干等 20 秒超时
  let onClosed
  const closedPromise = new Promise(resolve => { onClosed = resolve })

  function start() {
    child = spawn(spec.file, spec.args, {
      // 工作目录用当前会话/默认沙箱根 —— 与文件工具看到的是同一个目录，
      // 否则 `npx some-server ./docs` 这类相对路径参数会指向别处。
      cwd: workspaceRoot(),
      env: { ...process.env, ...cfg.env },
      shell: spec.shell,
      windowsHide: true,
    })
    child.stderr?.on('data', d => {
      stderrTail.push(d.toString())
      while (stderrTail.join('').length > 4000) stderrTail.shift()
    })
    let buf = ''
    child.stdout?.on('data', d => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          // 不是 JSON 的行是服务器的日志，当噪音处理（保留在 stderr 尾巴里便于排错）
          stderrTail.push(line + '\n')
          continue
        }
        for (const fn of listeners) fn(msg)
      }
    })
    child.on('error', err => {
      closedReason = `启动失败：${String(err?.message ?? err)}`
      onClosed(closedReason)
    })
    child.on('close', code => {
      closedReason = closedReason ?? `子进程退出（code ${code}）`
      onClosed(closedReason)
    })
  }

  return {
    kind: 'stdio',
    start,
    closedPromise,
    send(msg) {
      if (!child || closedReason) throw new Error(closedReason ?? '连接已关闭')
      child.stdin.write(JSON.stringify(msg) + '\n', 'utf8')
    },
    onMessage(fn) {
      listeners.add(fn)
    },
    get closedReason() {
      return closedReason
    },
    stderrText: () => stderrTail.join('').trim().slice(-2000),
    close() {
      try {
        child?.kill()
      } catch { /* 已退出 */ }
    },
  }
}

// ---------------------------------------------------------------------------
// 传输：Streamable HTTP
// ---------------------------------------------------------------------------

/** 解析 SSE 文本，收集 data 行里的 JSON-RPC 报文。 */
function parseSse(text) {
  const out = []
  for (const block of text.split(/\n\n/)) {
    const dataLines = block
      .split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
    if (dataLines.length === 0) continue
    const payload = dataLines.join('\n')
    if (!payload || payload === '[DONE]') continue
    try {
      out.push(JSON.parse(payload))
    } catch { /* 忽略解析不了的事件 */ }
  }
  return out
}

/**
 * 传输层：stdio 是"发了就不管"（同步、无返回），HTTP 是"一次 POST 一次往返"。
 * 两者 `send()` 的返回类型不同，靠 `kind` 判别。
 *
 * @typedef {{kind: 'stdio', start(): void, send(msg: object): void,
 *   onMessage(fn: (m: any) => void): void, closedReason: string|null,
 *   stderrText(): string, close(): void,
 *   closedPromise?: Promise<string>}} StdioTransport
 * @typedef {{kind: 'http', start(): void, send(msg: object, timeoutMs?: number): Promise<any[]>,
 *   onMessage(fn: (m: any) => void): void, closedReason: string|null,
 *   stderrText(): string, close(): void,
 *   closedPromise?: Promise<string>}} HttpTransport
 * @typedef {StdioTransport | HttpTransport} Transport
 */

function createHttpTransport(cfg) {
  return {
    kind: 'http',
    start() {},
    async send(msg, timeoutMs = CALL_TIMEOUT_MS) {
      const token = await bearerFor(cfg.name)
      const res = await guardedFetch(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...cfg.headers,
        },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 401 && token) {
        // 先试一次续期（可能只是 token 过期，不用麻烦用户重新走浏览器）
        const fresh = await forceRefresh(cfg.name)
        if (fresh && fresh !== token) {
          const retry = await guardedFetch(cfg.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              authorization: `Bearer ${fresh}`,
              ...cfg.headers,
            },
            body: JSON.stringify(msg),
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (retry.ok) return parseHttpResponse(retry)
        }
      }
      if (res.status === 401) {
        void triggerAuthFlow(cfg)
        throw new Error(`需要授权（401）。已在聊天里生成「${cfg.name}」的授权链接，完成后再重连。`)
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`)
      }
      return parseHttpResponse(res)
    },
    onMessage() {},
    get closedReason() {
      return null
    },
    stderrText: () => '',
    close() {},
  }
}

/** HTTP 响应体 → JSON-RPC 报文数组（json 或 SSE 文本都吃）。 */
async function parseHttpResponse(res) {
  const ctype = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (!text.trim()) return []
  if (ctype.includes('text/event-stream')) return parseSse(text)
  try {
    return [JSON.parse(text)]
  } catch {
    return parseSse(text)
  }
}
// ---------------------------------------------------------------------------
// 传输：SSE（旧版双端点 HTTP+SSE，大量存量 MCP 服务器只认这个）
// ---------------------------------------------------------------------------

/**
 * 旧版 SSE 传输：GET url 建长连接收服务端推送，POST 到 endpoint 发消息。
 * 连接建立后服务器先推一个 `event: endpoint`（data 是 POST 目标地址，可能是相对路径），
 * 之后所有 JSON-RPC 报文都走 `event: message`。请求的响应用 pending 表等（和 stdio 一样），
 * send 本身不等待。
 */
function createSseTransport(cfg) {
  const listeners = new Set()
  let abort = null
  let endpoint = null
  let closedReason = null
  let onClosed
  const closedPromise = new Promise(resolve => { onClosed = resolve })
  const stderrTail = []

  function handleBlock(block) {
    const lines = block.split('\n')
    const eventLine = lines.find(l => l.startsWith('event:'))
    const eventName = eventLine ? eventLine.slice(6).trim() : 'message'
    const dataLines = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
    if (dataLines.length === 0) return
    const payload = dataLines.join('\n')
    if (eventName === 'endpoint') {
      endpoint = new URL(payload, cfg.url).toString()
      return
    }
    let msg
    try {
      msg = JSON.parse(payload)
    } catch {
      stderrTail.push(payload.slice(0, 200))
      return
    }
    for (const fn of listeners) fn(msg)
  }

  function endpointReady(timeoutMs) {
    if (endpoint) return Promise.resolve()
    if (closedReason) return Promise.reject(new Error(closedReason))
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearInterval(poll)
        clearTimeout(timer)
      }
      const poll = setInterval(() => {
        if (endpoint) {
          cleanup()
          resolve(undefined)
        } else if (closedReason) {
          cleanup()
                    reject(new Error(closedReason))
        }
      }, 50)
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`SSE endpoint 未就绪（${timeoutMs}ms 内没收到 endpoint 事件）`))
      }, timeoutMs)
    })
  }

  return {
    kind: 'sse',
    start() {
      abort = new AbortController()
      ;(async () => {
        try {
          const res = await guardedFetch(cfg.url, {
            headers: { accept: 'text/event-stream', ...(cfg.headers ?? {}) },
            signal: abort.signal,
          })
          if (res.status === 401) {
            void triggerAuthFlow(cfg)
          }
          if (!res.ok || !res.body) {
            closedReason = `SSE 连接失败：HTTP ${res.status} ${res.statusText}`
            onClosed(closedReason)
            return
          }
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            let idx
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              handleBlock(block)
            }
          }
          closedReason = closedReason ?? 'SSE 流结束'
          onClosed(closedReason)
        } catch (err) {
          closedReason = closedReason ?? `SSE 中断：${String(err?.message ?? err)}`
          onClosed(closedReason)
        }
      })()
    },
    async send(msg, timeoutMs = CALL_TIMEOUT_MS) {
      await endpointReady(INIT_TIMEOUT_MS)
      const token = await bearerFor(cfg.name)
      let res
      try {
        res = await guardedFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(cfg.headers ?? {}),
          },
          body: JSON.stringify(msg),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        // close 竞态：连接已被我们主动关掉，报错没有意义（应答永远来不了了）
        if (closedReason) return []
        throw err
      }
      if (res.status === 401) {
        void triggerAuthFlow(cfg)
        throw new Error(`需要授权（401）。已在聊天里生成「${cfg.name}」的授权链接，完成后再重连。`)
      }
      if (!res.ok) throw new Error(`SSE POST 失败：HTTP ${res.status}`)
      // 响应会从 SSE 流里回来
      return []
    },
    onMessage(fn) {
      listeners.add(fn)
    },
    get closedReason() {
      return closedReason
    },
    stderrText: () => stderrTail.join('').trim().slice(-2000),
    close() {
      try {
        abort?.abort()
      } catch { /* 已断 */ }
    },
  }
}


/**
 * 每个服务器只允许同时跑一个授权流程（多次 401 会重复弹浏览器）。
 * 失败也如实播报 —— 静默失败会让用户以为「点了链接没反应」。
 */
const authFlowRunning = new Set()
async function triggerAuthFlow(cfg) {
  if (authFlowRunning.has(cfg.name)) return
  authFlowRunning.add(cfg.name)
  try {
    await startAuthorization(cfg)
  } catch (err) {
    broadcast({ type: 'notice', text: `MCP 服务器「${cfg.name}」授权流程启动失败：${String(err?.message ?? err)}` })
  } finally {
    authFlowRunning.delete(cfg.name)
  }
}

// ---------------------------------------------------------------------------
// 会话（JSON-RPC 走传输层）
// ---------------------------------------------------------------------------

/** 一个 MCP 服务器连接。 */
class McpConnection {
  constructor(cfg) {
    this.cfg = cfg
    this.name = cfg.name
    this.transportName = cfg.transport
    this.state = 'idle'
    this.error = null
    this.tools = []
    this.resources = []
    this.serverInfo = null
    this.capabilities = null
    this.pending = new Map()
    this.seq = 0
    /** 服务端反向请求（elicitation / sampling / roots）的次数，供 /mcp 展示。 */
    this.serverRequests = 0
    /** 发起调用的会话（elicitation 弹窗路由 / sampling 用模型）。由引擎在调工具前赋值。 */
    this.activeSession = /** @type {object|null} */ (null)
  }

  /**
   * 两种传输的**判别联合**：`kind` 必须是字面量类型，否则 `t.kind === 'http'` 收不了窄，
   * 调用点就会拿到 `send()` 的两种返回类型的联合（`void | any[]`），
   * 于是 `for (const m of messages)` / `messages.find(...)` 全线报错。
   *
   * @returns {Transport}
   */
  get transport() {
    if (!this._t) {
      if (this.transportName === 'stdio') this._t = createStdioTransport(this.cfg)
      else if (this.transportName === 'sse') this._t = createSseTransport(this.cfg)
      else this._t = createHttpTransport(this.cfg)
    }
    return /** @type {Transport} */ (this._t)
  }

  /** 发一条请求并等回应（带超时；超时要能看出是哪个方法超的）。 */
  async request(method, params, timeoutMs = LIST_TIMEOUT_MS) {
    const id = ++this.seq
    const t = this.transport
    const payload = { jsonrpc: '2.0', id, method, params }

    // HTTP：一次 POST 就是一次往返，结果直接从响应体里取
    if (t.kind === 'http') {
      const messages = await t.send(payload, timeoutMs)
      // 响应里可能夹着服务端的反向请求 —— 也要回"未支持"，不能当没看见
      for (const m of messages) {
        if (m?.method) this.handleMessage(m)
      }
      const mine = messages.find(m => m.id === id) ?? messages.find(m => !m.method)
      if (!mine) throw new Error(`${method} 没有返回结果`)
      if (mine.error) throw new Error(`${method} 失败：${mine.error.message ?? JSON.stringify(mine.error)}`)
      return mine.result
    }

    // stdio：响应当作独立一行从 stdout 回来，走 pending 表
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
    })
    const timer = setTimeout(() => {
      // 注意：这里要用 pending 里存的那份 reject —— 超时回调里没有闭包变量可抓
      // （踩过：直接写 reject 会 ReferenceError，超时路径整个失效）
      const waiting = this.pending.get(id)
      if (!waiting) return
      this.pending.delete(id)
      waiting.reject(new Error(`${method} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    try {
      // sse 的 send 是异步的：落单的拒绝（如 close 竞态）必须就地接住，否则 unhandledRejection
      const sent = /** @type {any} */ (t.send(payload))
      if (sent && typeof sent.catch === 'function') sent.catch(() => {})
      return await promise
    } finally {
      clearTimeout(timer)
      this.pending.delete(id)
    }
  }

  /** 通知（不需要回应）。 */
  notify(method, params) {
    const t = /** @type {any} */ (this.transport)
    if (t.kind === 'stdio') {
      t.send({ jsonrpc: '2.0', method, params })
    } else if (t.kind === 'sse') {
      const p = t.send({ jsonrpc: '2.0', method, params })
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
  }

  /** 处理服务端来的报文。 */
  handleMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${p.method} 失败：${msg.error.message ?? JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === 'notifications/resources/updated') {
      broadcast({ type: 'notice', text: `MCP 资源已更新：${this.name} ${msg.params?.uri ?? ''}` })
      return
    }
    if (msg.id !== undefined && msg.method === 'elicitation/create') {
      // 服务端反问：转成前端问答弹窗（不回话服务器会一直等，表现为工具卡住）
      this.handleElicitation(msg)
      return
    }
    if (msg.id !== undefined && msg.method === 'sampling/createMessage') {
      // sampling：服务器借我们的模型生成内容
      this.serverRequests++
      this.handleSampling(msg)
      return
    }
    if (msg.id !== undefined && msg.method === 'roots/list') {
      // roots：把当前沙箱根告诉服务器
      this.serverRequests++
      try {
        const sent = this.transport.send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { roots: [{ uri: pathToFileURL(workspaceRoot()).href, name: "workspace" }] },
        })
        if (sent && typeof sent.catch === 'function') sent.catch(() => {})
      } catch { /* 连接已断 */ }
      return
    }
    if (msg.id !== undefined && msg.method) {
      // 其余反向请求（sampling / roots）：明确回"未支持"。
      // **不能挂着不回** —— 服务器会一直等，表现为"工具调用卡住"，最难查。
      this.serverRequests++
      try {
        const sent = this.transport.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `web 端未实现服务端反向请求：${msg.method}` },
        })
        // HTTP 传输的 send 返回 Promise（它要发一个 POST），这里不等它，但要有 catch
        if (sent && typeof sent.catch === 'function') sent.catch(() => {})
      } catch { /* 连接已断，忽略 */ }
    }
  }

  /**
   * 服务端反问（elicitation/create）：把 requestedSchema 的字段转成前端问答弹窗，
   * 答完按字段类型做强制转换回传。超时/全空 → cancel（服务器自己会处理取消分支）。
   */
  handleElicitation(msg) {
    this.serverRequests++
    const params = msg.params ?? {}
    void runEventHooks(HOOK_EVENT.ELICITATION_REQUEST, {
      hookInput: { session_id: this.activeSession?.id ?? '', server: this.name, message: params.message ?? '' },
    }).catch(() => {})
    const schema = params.requestedSchema ?? {}
    const fields = Object.entries(schema.properties ?? {}).slice(0, 8)
    const required = Array.isArray(schema.required) ? schema.required.map(String) : []
    const message = params.message ?? 'MCP 工具需要你补充信息'
    // 原生表单：一次弹窗渲染全部字段（类型化控件），不再一字段一问
    const formFields = fields.map(([name, spec]) => ({
      name,
      label: spec.title ?? name,
      type: spec.type === 'boolean' ? 'boolean'
        : (spec.type === 'number' || spec.type === 'integer') ? 'number'
        : Array.isArray(spec.enum) ? 'enum'
        : 'string',
      description: spec.description ?? '',
      options: Array.isArray(spec.enum) ? spec.enum.map(String) : undefined,
      required: required.includes(name),
    }))
    const questions = [{
      question: message,
      header: this.name.slice(0, 12),
      options: /** @type {{label: string, description: string}[]} */ ([]),
      form: { fields: formFields },
    }]
    const respond = result => {
      void runEventHooks(HOOK_EVENT.ELICITATION_RESULT, {
        hookInput: {
          session_id: this.activeSession?.id ?? '',
          server: this.name,
          action: result?.action ?? 'unknown',
        },
      }).catch(() => {})
      try {
        const sent = this.transport.send({ jsonrpc: '2.0', id: msg.id, result })
        if (sent && typeof sent.catch === 'function') sent.catch(() => {})
      } catch { /* 连接已断，忽略 */ }
    }
    requestQuestions(this.activeSession ?? null, questions)
      .then(answers => {
        const content = {}
        let any = false
        // 原生表单：前端把整个表单序列化成 JSON 放在唯一一题的 answer 里
        const raw = String(answers[0]?.answer ?? '').trim()
        let values = null
        try { values = raw.startsWith('{') ? JSON.parse(raw) : null } catch { values = null }
        if (values && typeof values === 'object') {
          for (const [name, spec] of fields) {
            const v = values[name]
            if (v === undefined || v === null || v === '') continue
            any = true
            if (spec.type === 'boolean') content[name] = v === true || v === 'true'
            else if (spec.type === 'number' || spec.type === 'integer') {
              const n = Number(v)
              if (Number.isFinite(n)) content[name] = n
            } else content[name] = String(v)
          }
        } else {
          // 兜底：旧前端/纯文本作答，按字段逐个填（原逻辑）
          for (const [i, [name, spec]] of fields.entries()) {
            const a = String(answers[i]?.answer ?? '').trim()
            if (!a) continue
            any = true
            if (spec.type === 'boolean') content[name] = a === '是' || a.toLowerCase() === 'true'
            else if (spec.type === 'number' || spec.type === 'integer') content[name] = Number(a)
            else content[name] = a
          }
        }
        respond(any ? { action: 'accept', content } : { action: 'cancel' })
      })
      .catch(() => respond({ action: 'cancel' }))
  }

  /**
   * sampling/createMessage：服务器请求用我们的模型生成内容。
   * 把 MCP sampling 消息映射成一次无工具的 chatCompletion。
   */
  handleSampling(msg) {
    const params = msg.params ?? {}
    const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : 1024
    const model = this.activeSession ? settingsFor(this.activeSession).model : "deepseek-flash"
    const respondOk = result => {
      try {
        const sent = this.transport.send({ jsonrpc: "2.0", id: msg.id, result })
        if (sent && typeof sent.catch === 'function') sent.catch(() => {})
      } catch { /* 连接已断 */ }
    }
    const respondErr = message => {
      try {
        const sent = this.transport.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message } })
        if (sent && typeof sent.catch === 'function') sent.catch(() => {})
      } catch { /* 连接已断 */ }
    }
    const msgs = (params.messages ?? []).map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "object" && m.content !== null && m.content.type === "text" ? m.content.text : String(m.content ?? ""),
    }))
    if (msgs.length === 0) {
      respondErr("sampling 请求没有消息")
      return
    }
    chatCompletion({ model, messages: msgs })
      .then(r => {
        respondOk({
          role: "assistant",
          model,
          content: { type: "text", text: r.text ?? "" },
          stopReason: "endTurn",
        })
      })
      .catch(err => respondErr(String(err?.message ?? err)))
  }

  /** 建连 + 握手 + 拉工具/资源清单。 */
  async connect() {
    const problem = configProblem(this.cfg)
    if (problem) {
      this.state = 'unsupported'
      this.error = problem
      return this
    }
    this.state = 'connecting'
    try {
      const t = this.transport
      t.start()
      t.onMessage(msg => this.handleMessage(msg))

      const closedFailure = (t.closedPromise ?? new Promise(() => {})).then(reason => {
        throw new Error(`连接中断：${reason}`)
      })
      const init = await Promise.race([
        this.request(
          'initialize',
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              // 只声明我们真的会处理的能力。声明了却处理不了，服务器会按声明来调我们。
              tools: {},
              resources: {},
            },
            clientInfo: CLIENT_INFO,
          },
          INIT_TIMEOUT_MS,
        ),
        // 子进程要是压根起不来（命令拼错之类），进程一退出就立刻失败，
        // 不用干等 20 秒超时 —— 那种"没反应"最难查。
        closedFailure,
      ])
      // 防浮动拒绝：race 已经出结果后，closed 分支再拒绝就没人接了
      closedFailure.catch(() => {})
      this.serverInfo = init?.serverInfo ?? null
      this.capabilities = init?.capabilities ?? null
    // prompts 能力：记下服务器暴露的提示词模板（McpPrompt 工具用）
    if (this.capabilities?.prompts !== undefined) {
      try {
        const pl = await this.request("prompts/list", {})
        this.prompts = Array.isArray(pl?.prompts) ? pl.prompts : []
      } catch { this.prompts = [] }
    }
      this.notify('notifications/initialized', {})

      if (this.capabilities?.tools !== undefined) {
        const res = await this.request('tools/list', {})
        this.tools = Array.isArray(res?.tools) ? res.tools : []
      }
      if (this.capabilities?.resources !== undefined) {
        try {
          const res = await this.request('resources/list', {})
          this.resources = Array.isArray(res?.resources) ? res.resources : []
        } catch {
          // 声明了 resources 但列不出来不算致命
          this.resources = []
        }
      }
      this.state = 'connected'
    } catch (err) {
      this.state = 'error'
      const tail = this.transport.stderrText?.()
      this.error = String(err?.message ?? err) + (tail ? `\n子进程输出：${tail}` : '')
      // 连不上的连接留着没用，还会吊着一个子进程
      this.close()
    }
    return this
  }

  async callTool(toolName, args) {
    if (this.state !== 'connected') {
      throw new Error(`MCP 服务器「${this.name}」未连接（状态 ${this.state}${this.error ? `：${this.error}` : ''}）`)
    }
    const res = await this.request('tools/call', { name: toolName, arguments: args ?? {} }, CALL_TIMEOUT_MS)
    return res
  }

  async readResource(uri) {
    if (this.state !== 'connected') {
      throw new Error(`MCP 服务器「${this.name}」未连接（状态 ${this.state}）`)
    }
    return this.request('resources/read', { uri }, CALL_TIMEOUT_MS)
  }

  close() {
    try {
      this.transport.close()
    } catch { /* 已关闭 */ }
    // 不要把 error 状态覆盖成 closed —— 用户看 /mcp 时要知道它**为什么**没连上
    if (this.state !== 'error') this.state = 'closed'
  }
}

/** 全部连接（服务器名 → McpConnection）。 */
const connections = new Map()
let connectPromise = null
const changeListeners = new Set()

/** 工具集变化时通知上层（用来刷新工具注册表）。 */
export function onMcpToolsChanged(fn) {
  changeListeners.add(fn)
}

function notifyChanged() {
  for (const fn of changeListeners) {
    try {
      fn()
    } catch { /* 监听方异常不该影响连接 */ }
  }
}

/**
 * 连接全部配置里的 MCP 服务器（幂等；后台跑，失败只记状态）。
 * @returns {Promise<{connected: number, failed: number, skipped: number}>}
 */
export function connectAll() {
  if (connectPromise) return connectPromise
  const cfgs = mcpServerConfigs()
  connectPromise = (async () => {
    let connected = 0
    let failed = 0
    let skipped = 0
    await Promise.all(
      cfgs.map(async cfg => {
        if (configProblem(cfg)) {
          const c = new McpConnection(cfg)
          c.state = 'unsupported'
          c.error = configProblem(cfg)
          connections.set(cfg.name, c)
          skipped++
          return
        }
        const conn = new McpConnection(cfg)
        connections.set(cfg.name, conn)
        await conn.connect()
        if (conn.state === 'connected') connected++
        else failed++
      }),
    )
    notifyChanged()
    return { connected, failed, skipped }
  })()
  return connectPromise
}

/** 已连接服务器的工具 schema（名字与 CLI 一致）。 */
export function mcpToolSchemas() {
  const out = []
  for (const conn of connections.values()) {
    if (conn.state !== 'connected') continue
    for (const tool of conn.tools) {
      if (!tool?.name) continue
      out.push({
        type: 'function',
        function: {
          name: mcpToolName(conn.name, tool.name),
          description:
            `[MCP:${conn.name}] ${tool.description ?? tool.name}`.slice(0, 900),
          parameters:
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? normalizeSchema(tool.inputSchema)
              : { type: 'object', properties: {}, required: [] },
        },
      })
    }
  }
  return out
}

/**
 * MCP 的 inputSchema 直接透传，但模型的工具调用要求 `parameters` 是 object schema。
 * 有些服务器给的是 `{type:'object'}` 但没有 `required`，这里补齐（缺字段会让部分
 * 上游把 schema 判为非法）。**不改结构**，只补默认值。
 */
function normalizeSchema(schema) {
  const s = { ...schema }
  if (s.type !== 'object') {
    return { type: 'object', properties: {}, required: [], description: s.description }
  }
  if (!s.properties || typeof s.properties !== 'object') s.properties = {}
  if (!Array.isArray(s.required)) s.required = []
  return s
}

/** 执行一个 MCP 工具（名字是 `mcp__server__tool`）。 */
export async function callMcpTool(fullName, args, session = null) {
  // 记下是哪个会话在调工具：服务端反问（elicitation）要弹到这个会话的界面上
  const info = mcpInfoFromString(fullName)
  if (!info?.toolName) throw new Error(`不是合法的 MCP 工具名：${fullName}`)
  const conn = [...connections.values()].find(c => normalizeNameForMCP(c.name) === info.serverName)
  if (!conn) throw new Error(`没有名为「${info.serverName}」的 MCP 服务器`)
  // 先看连接状态再看工具存不存在：连不上的服务器问"有没有这个工具"没有意义，
  // 而且"未连接（error：…）"才是用户能照着修的那句话。
  if (conn.state !== 'connected') {
    throw new Error(
      `MCP 服务器「${conn.name}」未连接（状态 ${conn.state}${conn.error ? `：${conn.error}` : ''}）`,
    )
  }
  // 工具名在注册时被规范化过，这里要找回服务器上的**真名**再调用
  const real = conn.tools.find(t => normalizeNameForMCP(t.name) === info.toolName)
  if (!real) {
    throw new Error(
      `MCP 服务器「${conn.name}」上没有工具 ${info.toolName}` +
        `（它有的是：${conn.tools.map(t => normalizeNameForMCP(t.name)).join('、') || '（无）'}）`,
    )
  }
  conn.activeSession = session
  const res = await conn.callTool(real.name, args)
  return formatToolResult(res)
}

/** 把 MCP tools/call 的结果转成给模型看的文本（与 CLI 的处理一致：isError 要明说）。 */
function formatToolResult(res) {
  const parts = []
  for (const item of res?.content ?? []) {
    if (item?.type === 'text') parts.push(String(item.text ?? ''))
    else if (item?.type === 'image') parts.push(`[图片内容：${item.mimeType ?? 'image'}，web 端未转成视觉输入]`)
    else if (item?.type === 'resource') parts.push(`[资源：${item.resource?.uri ?? ''}]`)
    else parts.push(JSON.stringify(item))
  }
  const body = parts.join('\n\n') || '（服务器没有返回文本内容）'
  return res?.isError ? `MCP 工具返回错误：\n${body}` : body
}

/** 列出资源（可选按服务器过滤）。 */
export async function listMcpResources(serverName) {
  const targets = [...connections.values()].filter(
    c => c.state === 'connected' && (!serverName || normalizeNameForMCP(c.name) === serverName),
  )
  if (targets.length === 0) {
    const status = mcpStatusLine()
    return `没有可用的 MCP 服务器。\n${status}`
  }
  const lines = []
  for (const c of targets) {
    if (c.resources.length === 0) {
      lines.push(`${c.name}：没有资源（或该服务器未声明 resources 能力）`)
      continue
    }
    lines.push(`${c.name}：`)
    for (const r of c.resources) {
      lines.push(`- ${r.uri}${r.name ? `（${r.name}）` : ''}${r.mimeType ? ` [${r.mimeType}]` : ''}`)
    }
  }
  return lines.join('\n')
}

/** 读一个资源。 */
export async function readMcpResource(serverName, uri) {
  // 读过的资源顺手订阅更新通知（best-effort：服务器不支持就算了）
  try { await subscribeMcpResource(serverName, uri) } catch { /* 不支持订阅就不订 */ }
  const conn = [...connections.values()].find(
    c => c.state === 'connected' && normalizeNameForMCP(c.name) === serverName,
  )
  if (!conn) throw new Error(`没有已连接的 MCP 服务器：${serverName}`)
  const res = await conn.readResource(uri)
  const parts = []
  for (const item of res?.contents ?? []) {
    if (typeof item?.text === 'string') parts.push(item.text)
    else if (typeof item?.blob === 'string') parts.push(`[二进制内容 ${item.blob.length} 字节，未在 web 端解码]`)
  }
  return parts.join('\n\n') || '（资源为空）'
}

/** 一行状态摘要。 */
export function mcpStatusLine() {
  const cfgs = mcpServerConfigs()
  if (cfgs.length === 0) return '未配置任何 MCP 服务器（在设置文件里写 mcpServers）'
  const counts = {}
  for (const c of connections.values()) counts[c.state] = (counts[c.state] ?? 0) + 1
  const parts = Object.entries(counts).map(([k, v]) => `${k} ${v}`)
  return `MCP 服务器：配置 ${cfgs.length} 个（${parts.join('、') || '尚未连接'}）`
}

/** `/mcp` 命令的完整输出。 */
export function mcpSummary() {
  const cfgs = mcpServerConfigs()
  const lines = [
    mcpStatusLine(),
    `支持的传输：${MCP_SUPPORTED_TRANSPORTS.join('、')}（未实现：${MCP_UNSUPPORTED_TRANSPORTS.join('、')}）`,
    '未实现：OAuth 授权（McpAuth）、服务端反向请求（elicitation / sampling / roots）、prompt 模板、registry',
  ]
  if (cfgs.length === 0) {
    lines.push(
      '',
      '配置示例（写在 ~/.limkenion/settings.json 或项目的 .limkenion/settings.json 里）：',
      JSON.stringify(
        { mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } } },
        null,
        1,
      ),
      '',
      '配好之后用 /mcp reload 重连，或在 /settings 里改完重启服务。',
    )
    return lines.join('\n')
  }
  for (const cfg of cfgs) {
    const conn = connections.get(cfg.name)
    const problem = configProblem(cfg)
    const state = conn?.state ?? 'idle'
    lines.push('', `## ${cfg.name}（${cfg.transport}，来源 ${cfg.source}）`)
    lines.push(`状态：${state}${conn?.serverInfo ? `　服务端：${conn.serverInfo.name ?? '?'} ${conn.serverInfo.version ?? ''}` : ''}`)
    if (problem) lines.push(`不可用原因：${problem}`)
    if (conn?.error) lines.push(`错误：${conn.error}`)
    if (conn?.serverRequests) lines.push(`服务端反向请求被拒：${conn.serverRequests} 次（web 端未实现）`)
    if (state === 'connected') {
      lines.push(`工具 ${conn.tools.length} 个：${conn.tools.map(t => mcpToolName(cfg.name, t.name)).join('、') || '（无）'}`)
      lines.push(`资源 ${conn.resources.length} 个`)
    }
  }
  lines.push('')
  lines.push('用 /tools 可以看到这些工具（延迟加载，ToolSearch 检索后启用）。')
  return lines.join('\n')
}

/**
 * 结构化的服务器清单（给图形化管理界面用，不要去解析 mcpSummary() 的文本）。
 *
 * 每个作用域（user / project / local）里定义的同名服务器会按后者覆盖前者合并，
 * 这里返回**合并后的生效配置** + 它来自哪个作用域 + 当前连接状态。
 *
 * @returns {Array<{name:string, transport:string, command:string, args:string[], env:Record<string,string>,
 *   url:string, headers:Record<string,string>, source:string, state:string, error:string|null,
 *   problem:string|null, tools:string[], serverInfo:string|null}>}
 */
export function mcpServersInfo() {
  return mcpServerConfigs().map(cfg => {
    const conn = connections.get(cfg.name)
    return {
      ...cfg,
      state: conn?.state ?? 'idle',
      error: conn?.error ?? null,
      problem: configProblem(cfg),
      tools: conn?.state === 'connected' ? (conn.tools ?? []).map(t => mcpToolName(cfg.name, t.name)) : [],
      serverInfo: conn?.serverInfo ? `${conn.serverInfo.name ?? '?'}${conn.serverInfo.version ? ` ${conn.serverInfo.version}` : ''}` : null,
    }
  })
}

/** 该作用域里定义了这个服务器吗（用于删除时定位）。 */
function definedIn(source, name) {
  const { data } = settingsSources().find(s => s.source === source) ?? {}
  return Boolean(data?.mcpServers?.[name])
}

/**
 * 新增 / 更新一台服务器。
 *
 * 只写**用户指定的那个作用域**的文件 —— 不跨文件改，避免"以为改了其实
 * 被另一个作用域覆盖"。写完由调用方决定是否 reloadMcp() 重连。
 *
 * @param {string} name
 * @param {Record<string, any>} cfg
 * @param {'user'|'project'|'local'} scope
 */
export function saveMcpServer(name, cfg, scope = 'user') {
  if (!String(name ?? '').trim()) throw new Error('服务器名不能为空')
  writeSettingsScope(scope, data => {
    const servers = { ...(data.mcpServers ?? {}) }
    servers[name] = { ...(servers[name] ?? {}), ...cfg }
    return { ...data, mcpServers: servers }
  })
  return mcpServersInfo().find(s => s.name === name) ?? null
}

/**
 * 从某个作用域删除一台服务器。
 *
 * 只在**该作用域确实定义了它**时才删：否则用户点"删除"却什么都没发生，
 * 而界面还显示着（可能是另一个作用域提供的）—— 那是很难查的错觉。
 *
 * @param {string} name
 * @param {'user'|'project'|'local'} scope
 * @returns {boolean} 是否真的删掉了
 */
export function deleteMcpServer(name, scope) {
  if (!definedIn(scope, name)) return false
  writeSettingsScope(scope, data => {
    const servers = { ...(data.mcpServers ?? {}) }
    delete servers[name]
    return { ...data, mcpServers: servers }
  })
  return true
}

/** 重连（`/mcp reload`）。 */
export async function reloadMcp() {
  for (const c of connections.values()) c.close()
  connections.clear()
  connectPromise = null
  const r = await connectAll()
  return r
}

// OAuth 授权在浏览器里完成后，自动把刚授权的服务器重新连上
onAuthorized(cfg => {
  broadcast({ type: 'notice', text: `「${cfg.name}」授权完成，正在重新连接…` })
  void reloadMcp()
})

/** 服务退出时关闭全部连接。 */
export function closeAllMcp() {
  for (const c of connections.values()) c.close()
  connections.clear()
}

/** 有没有配置（供启动横幅用）。 */
export function hasMcpConfig() {
  return mcpServerConfigs().length > 0
}

/** 配置里是否存在需要 OAuth 的服务器（`/mcp` 会提醒）。 */
export function needsAuthHint() {
  const hits = []
  for (const { source, path, data } of settingsSources()) {
    const servers = data?.mcpServers
    if (!servers || typeof servers !== 'object') continue
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && typeof cfg === 'object' && cfg.oauth) hits.push(`${name}（${source}：${path}）`)
    }
  }
  return hits
}

/** 配置文件是否存在（避免 /mcp 输出里给出不存在的路径）。 */
export function hasConfigFileHint() {
  return settingsSources().some(s => existsSync(s.path))
}

/**
 * 为指定服务器发起 OAuth 授权流程（发现 → 注册 → 浏览器授权 → 回调换 token）。
 * @param {string} serverName 服务器名（mcpServers 的键）
 */
export async function mcpAuthFlow(serverName) {
  const conn = [...connections.values()].find(k => k.name === serverName)
  if (!conn) throw new Error(`没有名为「${serverName}」的 MCP 服务器`)
  const token = await bearerFor(serverName).catch(() => null)
  if (token) return `「${serverName}」已持有有效凭证，无需重新授权。`
  return startAuthorization({ name: serverName, url: conn.cfg?.url })
}

/**
 * 取 MCP 服务器的提示词模板（prompts/get），消息内容拼成文本返回。
 * @param {string} serverName 服务器名（mcpServers 的键）
 * @param {string} name 模板名
 * @param {Record<string,string>|undefined} args 模板参数
 */
export async function getMcpPrompt(serverName, name, args) {
  const conn = [...connections.values()].find(k => k.name === serverName)
  if (!conn || conn.state !== 'connected') throw new Error(`MCP 服务器「${serverName}」未连接`)
  const res = await conn.request("prompts/get", { name, arguments: args ?? {} })
  const msgs = Array.isArray(res?.messages) ? res.messages : []
  return msgs
    .map(m => {
        const c = m.content
        return typeof c === 'string' ? c : c?.type === 'text' ? c.text : JSON.stringify(c)
      })
    .join("\n\n")
}

/** 订阅某服务器的某资源：之后服务器推送 resources/updated 会播报到聊天里。 */
export async function subscribeMcpResource(serverName, uri) {
  const conn = [...connections.values()].find(k => k.name === serverName)
  if (!conn || conn.state !== 'connected') throw new Error(`MCP 服务器「${serverName}」未连接`)
  await conn.request("resources/subscribe", { uri })
  return true
}

/**
 * 搜官方 MCP registry（registry.modelcontextprotocol.io）。返回紧凑文本列表；
 * 网络/白名单失败时返回带原因的错误提示，不抛异常。
 */
export async function mcpRegistrySearch(query) {
  try {
    const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(String(query ?? ""))}&limit=10`
    const res = await guardedFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return `registry 查询失败：HTTP ${res.status}`
    const data = /** @type {any} */ (await res.json())
    const servers = Array.isArray(data?.servers) ? data.servers : []
    if (servers.length === 0) return `registry 里没有匹配「${query}」的服务器`
    return servers
      .map(s => {
        const name = s?.name ?? s?.id ?? "?"
        const desc = s?.description ?? ""
        return `- ${name}${desc ? `：${String(desc).slice(0, 120)}` : ""}`
      })
      .join("\n")
  } catch (err) {
    return "registry 查询失败：" + String(err?.message ?? err)
  }
}
