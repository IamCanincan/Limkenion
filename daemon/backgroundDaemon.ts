/**
 * 后台会话守护进程（daemon / attach / logs）。
 *
 * 设计：**进程组合，不改 agent 循环**。守护进程本身不含任何模型逻辑——
 * 它 spawn 一个 `--print --input-format stream-json --output-format stream-json`
 * 的 CLI 子进程（会话持久化照常落盘），自己只做三件事：
 *
 *   1. **桥接**：TCP 上的用户输入 → 子进程 stdin；子进程 stdout 的 SDK 消息
 *      → 日志 + 广播给所有 attach 的客户端。
 *   2. **权限中转**：子进程发出的 `can_use_tool` 控制请求转发给在场的
 *      attach 客户端（y/n 应答）；**无人在场时立即拒绝**并写明原因——
 *      绝不静默放行，也绝不把后台会话卡死在等待上。
 *   3. **生命周期**：状态文件（pid/port/token）+ JSONL 日志 + shutdown。
 *
 * 安全模型与 web 服务一致：只监听 127.0.0.1 回环、一次性 token、
 * token 只写进本机状态文件（本机单用户模型，与 web 的 token 文件同款）。
 *
 * 协议（TCP，换行分隔 JSON）：
 *   客户端 → 守护进程：{type:'hello',token} 之后 {type:'user',text} |
 *     {type:'interrupt'} | {type:'permission_response',request_id,behavior,message?} |
 *     {type:'shutdown'} | {type:'ping'}
 *   守护进程 → 客户端：子进程的原始 SDK 消息行 +
 *     {type:'daemon_event',event,...} 生命周期事件
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs'
import { join } from 'node:path'
import { getLimkenionConfigHomeDir } from '../utils/envUtils.js'

// ============================================================================
// 路径与状态文件
// ============================================================================

function daemonDir(): string {
  return join(getLimkenionConfigHomeDir(), 'daemon')
}
function daemonLogDir(): string {
  return join(daemonDir(), 'logs')
}
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}
function statusPath(name: string): string {
  return join(daemonDir(), `${safeName(name)}.json`)
}
function logPath(name: string): string {
  return join(daemonLogDir(), `${safeName(name)}.jsonl`)
}

type DaemonStatus = {
  name: string
  pid: number
  port: number
  token: string
  startedAt: string
  cwd: string
  sessionId: string
  model?: string
  permissionMode?: string
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readStatus(name: string): DaemonStatus | null {
  const p = statusPath(name)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as DaemonStatus
  } catch {
    return null
  }
}

function unlinkSyncSafe(p: string): void {
  try {
    unlinkSync(p)
  } catch {
    // 不存在则忽略
  }
}

function daemonLog(msg: string): void {
  process.stderr.write(`[daemon] ${msg}\n`)
}

// ============================================================================
// 子进程 SDK 消息渲染（attach 与 logs 共用）
// ============================================================================

/** 从 SDK 消息里提取可读文本；无可渲染内容的返回 null。 */
export function renderSdkMessage(msg: Record<string, unknown>): string | null {
  const type = msg['type']
  if (type === 'system' && msg['subtype'] === 'init') {
    return `已连接会话 ${msg['session_id'] ?? '?'}（模型 ${msg['model'] ?? '?'}）`
  }
  if (type === 'assistant') {
    const message = msg['message'] as { content?: Array<Record<string, unknown>> } | undefined
    const parts: string[] = []
    for (const block of message?.content ?? []) {
      if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
        parts.push(String(block['text']).trimEnd())
      } else if (block['type'] === 'tool_use') {
        parts.push(`⏺ ${String(block['name'])}(${briefInput(block['input'])})`)
      }
      // thinking 块不渲染——后台会话只关心做了什么、答了什么
    }
    return parts.length > 0 ? parts.join('\n') : null
  }
  if (type === 'user') {
    // SDK 流里的 user 消息 = 工具结果回填
    const message = msg['message'] as { content?: Array<Record<string, unknown>> } | undefined
    for (const block of message?.content ?? []) {
      if (block['type'] === 'tool_result' && block['is_error'] === true) {
        const text = typeof block['content'] === 'string'
          ? block['content']
          : JSON.stringify(block['content'])
        return `✳ 工具报错：${text.slice(0, 300)}`
      }
    }
    return null
  }
  if (type === 'result') {
    const bits: string[] = ['✔ 回合完成']
    if (typeof msg['num_turns'] === 'number') bits.push(`轮数 ${msg['num_turns']}`)
    if (typeof msg['duration_ms'] === 'number') bits.push(`耗时 ${Math.round(msg['duration_ms'] / 100) / 10}s`)
    const resultText = typeof msg['result'] === 'string' ? String(msg['result']) : ''
    const tail = resultText ? `\n${resultText.slice(0, 400)}${resultText.length > 400 ? '…' : ''}` : ''
    return bits.join(' · ') + tail
  }
  return null
}

/**
 * 构造一条 `can_use_tool` 权限响应（control_response），写回给 spawn 的子进程。
 *
 * 形状必须与子进程 stream-json 协议解析端完全一致：
 * `cli/structuredIO.ts`（消费 `message.response.subtype/response/request_id`）
 * 与 `entrypoints/sdk/controlSchemas.ts` 的 `SDKControlResponseSchema`
 *（`response: { subtype:'success', request_id, response: {behavior,message?} }`）。
 * 改这里必须同步改那两端——`test-cli/daemon-permission.test.ts` 守住这条契约。
 */
export function buildPermissionControlResponse(
  requestId: string,
  behavior: 'allow' | 'deny',
  message?: string,
): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior, ...(message ? { message } : {}) },
    },
  })
}

function briefInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input !== 'object') return String(input).slice(0, 80)
  try {
    const s = JSON.stringify(input)
    return s.length > 120 ? s.slice(0, 120) + '…' : s
  } catch {
    return ''
  }
}

/** 渲染 can_use_tool 请求（attach 客户端的确认提示用）。 */
function renderPermissionRequest(req: Record<string, unknown>): string {
  const tool = String(req['tool_name'] ?? '?')
  const title = typeof req['title'] === 'string' ? String(req['title']) : undefined
  return `⚠ 权限请求：${title ?? tool} ${briefInput(req['input'])}`
}

// ============================================================================
// 守护进程运行模式（daemon run —— 隐藏子命令）
// ============================================================================

type RunOptions = {
  name: string
  sessionId?: string
  resumeId?: string
  model?: string
  permissionMode?: string
}

export async function runDaemonProcess(opts: RunOptions): Promise<void> {
  const token = randomBytes(24).toString('hex')
  mkdirSync(daemonLogDir(), { recursive: true })
  const logFile = logPath(opts.name)
  const log = (line: string): void => {
    try {
      appendFileSync(logFile, line.endsWith('\n') ? line : line + '\n')
    } catch {
      // 日志写失败不能拖垮守护进程
    }
  }

  // ---- 1. spawn 会话子进程（真正的 agent 在这里跑）----
  const script = process.argv[1]
  if (!script || !/\.(mjs|js|cjs)$/.test(script)) {
    daemonLog(`无法定位 CLI 入口脚本（process.argv[1]=${String(script)}），退出`)
    process.exit(1)
  }
  // 注意：--resume 与 --session-id 不能同时给（resume 自带会话身份）
  const childArgs: string[] = [
    script,
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
  ]
  if (opts.resumeId) {
    childArgs.push('--resume', opts.resumeId)
  } else {
    childArgs.push('--session-id', opts.sessionId ?? randomUUID())
  }
  if (opts.model) childArgs.push('--model', opts.model)
  if (opts.permissionMode) childArgs.push('--permission-mode', opts.permissionMode)

  const child: ChildProcess = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (!child.stdin || !child.stdout) {
    daemonLog('子进程 stdio 建立失败，退出')
    process.exit(1)
  }

  // ---- 2. TCP 服务（先挂 connection，再 listen 一次拿临时端口）----
  let shuttingDown = false
  const clients = new Set<Socket>()
  type Pending = { timer: NodeJS.Timeout }
  const pendingPermissions = new Map<string, Pending>()
  const PERMISSION_TIMEOUT_MS = 120_000

  const broadcast = (line: string): void => {
    for (const sock of clients) {
      try {
        sock.write(line.endsWith('\n') ? line : line + '\n')
      } catch {
        clients.delete(sock)
      }
    }
  }

  const respondPermission = (requestId: string, behavior: 'allow' | 'deny', message?: string): void => {
    child.stdin!.write(buildPermissionControlResponse(requestId, behavior, message) + '\n')
    const pending = pendingPermissions.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      pendingPermissions.delete(requestId)
    }
  }

  const server: Server = createServer((sock: Socket) => {
    let authed = false
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      buf += chunk
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl === -1) return
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          sock.destroy()
          return
        }
        if (!authed) {
          if (msg['type'] === 'hello' && msg['token'] === token) {
            authed = true
            clients.add(sock)
            sock.write(JSON.stringify({ type: 'daemon_event', event: 'attached', sessionId, cwd: process.cwd() }) + '\n')
            log(JSON.stringify({ type: 'daemon_event', event: 'client_attached', remote: sock.remoteAddress }))
          } else {
            sock.destroy()
          }
          continue
        }
        switch (msg['type']) {
          case 'user': {
            const text = typeof msg['text'] === 'string' ? msg['text'] : ''
            if (!text) break
            const userMsg = JSON.stringify({
              type: 'user',
              session_id: '',
              message: { role: 'user', content: text },
              parent_tool_use_id: null,
            })
            child.stdin!.write(userMsg + '\n')
            break
          }
          case 'interrupt': {
            child.stdin!.write(JSON.stringify({
              type: 'control_request',
              request_id: randomUUID(),
              request: { subtype: 'interrupt' },
            }) + '\n')
            break
          }
          case 'permission_response': {
            const requestId = String(msg['request_id'] ?? '')
            if (!pendingPermissions.has(requestId)) break
            const behavior = msg['behavior'] === 'allow' ? 'allow' as const : 'deny' as const
            respondPermission(requestId, behavior,
              typeof msg['message'] === 'string' ? msg['message'] : undefined)
            break
          }
          case 'ping':
            sock.write(JSON.stringify({ type: 'daemon_event', event: 'pong' }) + '\n')
            break
          case 'shutdown':
            void shutdown('客户端请求停止')
            break
          default:
            break
        }
      }
    })
    const drop = (): void => {
      clients.delete(sock)
      log(JSON.stringify({ type: 'daemon_event', event: 'client_detached' }))
    }
    sock.on('close', drop)
    sock.on('error', drop)
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('无法获取监听端口'))
    })
  })

  // ---- 3. 状态文件 ----
  const sessionId = opts.resumeId ?? opts.sessionId ?? randomUUID()
  const status: DaemonStatus = {
    name: opts.name,
    pid: process.pid,
    port,
    token,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    sessionId,
    model: opts.model,
    permissionMode: opts.permissionMode,
  }
  writeFileSync(statusPath(opts.name), JSON.stringify(status, null, 2))
  log(JSON.stringify({ type: 'daemon_event', event: 'started', pid: process.pid, port, sessionId }))

  // ---- 4. 子进程 stdout → 日志 + 权限中转 + 广播 ----
  let stdoutBuf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk
    for (;;) {
      const nl = stdoutBuf.indexOf('\n')
      if (nl === -1) break
      const line = stdoutBuf.slice(0, nl).trim()
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line) continue
      log(line)
      let msg: Record<string, unknown> | null = null
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        msg = null
      }
      if (msg && msg['type'] === 'control_request') {
        const request = msg['request'] as Record<string, unknown> | undefined
        const requestId = String(msg['request_id'] ?? '')
        if (request && request['subtype'] === 'can_use_tool') {
          if (clients.size === 0) {
            respondPermission(requestId, 'deny',
              '后台会话无人在场，已自动拒绝（limkenion daemon attach 接入后重试，或启动时用 --permission-mode 放宽）')
            log(JSON.stringify({ type: 'daemon_event', event: 'permission_auto_denied', tool: request['tool_name'] }))
          } else {
            broadcast(line)
            const timer = setTimeout(() => {
              if (pendingPermissions.has(requestId)) {
                respondPermission(requestId, 'deny', '权限请求超时无人应答，已自动拒绝')
                log(JSON.stringify({ type: 'daemon_event', event: 'permission_timeout', tool: request['tool_name'] }))
              }
            }, PERMISSION_TIMEOUT_MS)
            timer.unref()
            pendingPermissions.set(requestId, { timer })
          }
          continue
        }
      }
      // 会话初始化完成：把 CLI 实际分配的会话 ID 回写状态文件
      //（--session-id 可能被子进程忽略/重新生成，以 init 事件为准）
      if (msg && msg['type'] === 'system' && msg['subtype'] === 'init' && typeof msg['session_id'] === 'string') {
        status.sessionId = msg['session_id']
        try {
          writeFileSync(statusPath(opts.name), JSON.stringify(status, null, 2))
        } catch {
          // 状态文件写失败不影响会话本身
        }
      }
      broadcast(line)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.trim()) {
        log(JSON.stringify({ type: 'daemon_event', event: 'child_stderr', text: line.slice(0, 500) }))
      }
    }
  })

  // ---- 5. 退出路径 ----
  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    log(JSON.stringify({ type: 'daemon_event', event: 'stopping', reason }))
    unlinkSyncSafe(statusPath(opts.name))
    broadcast(JSON.stringify({ type: 'daemon_event', event: 'stopping', reason }))
    for (const sock of clients) sock.destroy()
    server.close()
    for (const [id, p] of pendingPermissions) {
      clearTimeout(p.timer)
      pendingPermissions.delete(id)
    }
    child.kill()
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出
      }
      process.exit(0)
    }, 3000).unref()
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  child.on('error', (err) => {
    log(JSON.stringify({ type: 'daemon_event', event: 'child_error', error: String(err) }))
  })
  child.on('exit', (code) => {
    log(JSON.stringify({ type: 'daemon_event', event: 'child_exit', code }))
    void shutdown(`会话子进程退出（code=${code ?? '?'}）`)
  })
  // 兜底：状态文件被手动删除视为外部要求停止
  const watch = setInterval(() => {
    if (!existsSync(statusPath(opts.name))) void shutdown('状态文件被移除')
  }, 5000)
  watch.unref()

  // 守护进程常驻：显式挂起，绝不把控制权交还给入口的收尾逻辑
  // （cli.tsx 的 main() 返回后进程会自然退出——那会静默杀死刚启动的守护进程）
  log(JSON.stringify({ type: 'daemon_event', event: 'setup_complete' }))
  await new Promise<never>(() => {})
}

// ============================================================================
// 客户端操作（start / list / stop / attach / logs）
// ============================================================================

function cliScriptPath(): string {
  const script = process.argv[1]
  if (!script || !/\.(mjs|js|cjs)$/.test(script)) {
    throw new Error(`无法定位 CLI 入口脚本（process.argv[1]=${String(script)}）`)
  }
  return script
}

/** 连接守护进程并完成 hello 握手。 */
async function connectDaemon(status: DaemonStatus): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port: status.port }, () => {
      sock.write(JSON.stringify({ type: 'hello', token: status.token }) + '\n')
    })
    let buf = ''
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      sock.destroy()
      reject(err)
    }
    sock.once('error', fail)
    const timeout = setTimeout(() => fail(new Error('连接超时')), 5000)
    sock.on('data', (chunk: string) => {
      buf += chunk
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl === -1) return
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as Record<string, unknown>
          if (msg['type'] === 'daemon_event' && msg['event'] === 'attached' && !settled) {
            settled = true
            clearTimeout(timeout)
            resolve(sock)
            return
          }
        } catch {
          // 非 JSON 行忽略
        }
      }
    })
  })
}

export async function daemonStart(opts: {
  name?: string
  resumeId?: string
  model?: string
  permissionMode?: string
}): Promise<void> {
  const name = opts.name ?? 'default'
  const existing = readStatus(name)
  if (existing && isPidAlive(existing.pid)) {
    process.stderr.write(
      `错误：守护进程「${name}」已在运行（pid ${existing.pid}）。\n` +
      `接入它：limkenion daemon attach ${name}\n` +
      `停止它：limkenion daemon stop ${name}\n`)
    process.exitCode = 1
    return
  }
  const args = [cliScriptPath(), 'daemon', 'run', '--name', name]
  if (opts.resumeId) args.push('--resume', opts.resumeId)
  if (opts.model) args.push('--model', opts.model)
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    windowsHide: true,
  })
  child.unref()

  // 轮询状态文件确认启动成功
  const deadline = Date.now() + 10_000
  for (;;) {
    await new Promise(r => setTimeout(r, 200))
    const status = readStatus(name)
    if (status && status.pid === child.pid) {
      process.stdout.write(
        `守护进程「${name}」已启动（pid ${status.pid}，会话 ${status.sessionId}）。\n` +
        `接入：limkenion daemon attach ${name}\n` +
        `日志：limkenion daemon logs ${name} -f\n` +
        `停止：limkenion daemon stop ${name}\n` +
        `之后也可用会话 ID 恢复：limkenion -r ${status.sessionId}\n`)
      return
    }
    if (Date.now() > deadline) {
      process.stderr.write('错误：守护进程启动超时（10 秒内未见状态文件）。查看 ~/.limkenion/daemon/ 排查。\n')
      process.exitCode = 1
      return
    }
  }
}

export async function daemonList(): Promise<void> {
  const dir = daemonDir()
  if (!existsSync(dir)) {
    process.stdout.write('没有正在运行的后台会话。\n')
    return
  }
  let files: string[] = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch {
    files = []
  }
  const rows: string[] = []
  for (const f of files) {
    const status = readStatus(f.replace(/\.json$/, ''))
    if (!status) continue
    rows.push([
      status.name,
      isPidAlive(status.pid) ? '运行中' : '已退出',
      `pid ${status.pid}`,
      status.sessionId.slice(0, 8),
      status.cwd,
    ].join('  ·  '))
  }
  if (rows.length === 0) {
    process.stdout.write('没有正在运行的后台会话。\n')
    return
  }
  process.stdout.write(`名称 · 状态 · 进程 · 会话 · 工作目录\n${rows.join('\n')}\n`)
}

export async function daemonStop(name: string): Promise<void> {
  const status = readStatus(name)
  if (!status) {
    process.stderr.write(`错误：找不到守护进程「${name}」。\n`)
    process.exitCode = 1
    return
  }
  if (!isPidAlive(status.pid)) {
    unlinkSyncSafe(statusPath(name))
    process.stdout.write(`守护进程「${name}」已不在运行，清理了残留状态文件。\n`)
    return
  }
  try {
    const sock = await connectDaemon(status)
    sock.write(JSON.stringify({ type: 'shutdown' }) + '\n')
    sock.destroy()
  } catch {
    // TCP 不通就直接杀进程
    try {
      process.kill(status.pid)
    } catch {
      // 已退出
    }
  }
  // 等状态文件被移除（正常退出路径会删）
  const deadline = Date.now() + 8000
  while (existsSync(statusPath(name)) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
  }
  if (existsSync(statusPath(name))) {
    unlinkSyncSafe(statusPath(name))
    try {
      process.kill(status.pid)
    } catch {
      // 已退出
    }
  }
  process.stdout.write(`守护进程「${name}」已停止。\n`)
}

export async function daemonAttach(name: string): Promise<void> {
  const status = readStatus(name)
  if (!status || !isPidAlive(status.pid)) {
    process.stderr.write(`错误：守护进程「${name}」不在运行。用 limkenion daemon start 启动。\n`)
    process.exitCode = 1
    return
  }
  const { createInterface } = await import('node:readline')
  let sock: Socket
  try {
    sock = await connectDaemon(status)
  } catch (err) {
    process.stderr.write(`错误：无法连接守护进程「${name}」：${String(err)}\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `已接入后台会话「${name}」（会话 ${status.sessionId.slice(0, 8)}，工作目录 ${status.cwd}）。\n` +
    `输入消息回车发送；Ctrl+C 脱离（会话继续在后台运行）。\n\n`)

  let buf = ''
  let pendingPermission: { requestId: string } | null = null
  const rl = createInterface({ input: process.stdin, terminal: true })
  rl.setPrompt('› ')
  // 非 TTY（管道）没有 prompt 可刷；TTY 下也要防 readline 已被关闭（ERR_USE_AFTER_CLOSE）
  const showPrompt = (): void => {
    if (!process.stdin.isTTY) return
    try {
      rl.prompt(true)
    } catch {
      // readline 已关闭（stdin 结束），忽略
    }
  }

  const handleEventLine = (line: string): void => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (msg['type'] === 'control_request') {
      const request = msg['request'] as Record<string, unknown> | undefined
      if (request && request['subtype'] === 'can_use_tool') {
        pendingPermission = { requestId: String(msg['request_id'] ?? '') }
        process.stdout.write(`\n${renderPermissionRequest(request)}\n允许请输入 y，拒绝请输入 n（可附原因，如 "n: 太危险"）：`)
        showPrompt()
      }
      return
    }
    if (msg['type'] === 'daemon_event') {
      if (msg['event'] === 'stopping') {
        process.stdout.write(`\n守护进程正在停止：${String(msg['reason'] ?? '')}\n`)
      }
      return
    }
    const rendered = renderSdkMessage(msg)
    if (rendered) {
      process.stdout.write(`\n${rendered}\n`)
      showPrompt()
    }
    // 管道（非 TTY）模式：一个回合结束即视为完成，退出
    if (msg['type'] === 'result' && !process.stdin.isTTY) {
      sock.destroy()
      process.exit(0)
    }
  }

  sock.setEncoding('utf8')
  sock.on('data', (chunk: string) => {
    buf += chunk
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) handleEventLine(line)
    }
  })
  sock.on('close', () => {
    process.stdout.write('\n与守护进程的连接已断开。\n')
    rl.close()
    process.exit(0)
  })
  sock.on('error', () => {
    // close 事件会跟着来
  })

  rl.on('line', (input: string) => {
    const text = input.trim()
    if (pendingPermission) {
      const req = pendingPermission
      pendingPermission = null
      if (text === 'y' || text === 'yes' || text === 'Y') {
        sock.write(JSON.stringify({ type: 'permission_response', request_id: req.requestId, behavior: 'allow' }) + '\n')
        process.stdout.write('已允许。\n')
      } else {
        const reason = /^n\b/.test(text) && text.length > 1 ? text.slice(1).replace(/^[:\s]+/, '') : undefined
        sock.write(JSON.stringify({
          type: 'permission_response',
          request_id: req.requestId,
          behavior: 'deny',
          ...(reason ? { message: reason } : {}),
        }) + '\n')
        process.stdout.write('已拒绝。\n')
      }
      showPrompt()
      return
    }
    if (!text) {
      showPrompt()
      return
    }
    sock.write(JSON.stringify({ type: 'user', text }) + '\n')
    showPrompt()
  })
  rl.on('SIGINT', () => {
    process.stdout.write(`\n已脱离（会话仍在后台运行）。停止它：limkenion daemon stop ${name}\n`)
    sock.destroy()
    rl.close()
    process.exit(0)
  })
  // TTY 下 Ctrl+D / 管道下 stdin 结束：脱离（socket 事件继续处理，非 TTY 等回合结束再退）
  rl.on('close', () => {
    if (process.stdin.isTTY) {
      process.stdout.write(`\n已脱离（会话仍在后台运行）。停止它：limkenion daemon stop ${name}\n`)
      sock.destroy()
      process.exit(0)
    }
    // 非 TTY：不退出，继续消费 socket 直到 result / 连接关闭
  })
  showPrompt()
}

export async function daemonLogs(name: string, opts: { follow?: boolean; lines?: number }): Promise<void> {
  const file = logPath(name)
  if (!existsSync(file)) {
    process.stderr.write(`错误：守护进程「${name}」没有日志。它运行过吗？\n`)
    process.exitCode = 1
    return
  }
  const tailLines = opts.lines ?? 50
  for (const line of readTail(file, tailLines)) prettyLogLine(line)
  if (!opts.follow) return

  // -f：轮询追加（比 fs.watch 在 Windows 上可靠）
  let offset = statSync(file).size
  process.stdout.write('--- 跟随中（Ctrl+C 退出）---\n')
  const timer = setInterval(() => {
    try {
      const size = statSync(file).size
      if (size < offset) offset = 0 // 文件被清空/轮转
      if (size === offset) return
      const fd = openSync(file, 'r')
      const chunk = Buffer.alloc(size - offset)
      readSync(fd, chunk, 0, chunk.length, offset)
      closeSync(fd)
      offset = size
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) prettyLogLine(line)
      }
    } catch {
      // 文件短暂不可读时忽略
    }
  }, 500)
  timer.unref()
  // 保持进程存活直到 Ctrl+C
  await new Promise<void>(() => {})
}

function prettyLogLine(line: string): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line) as Record<string, unknown>
  } catch {
    process.stdout.write(line + '\n')
    return
  }
  if (msg['type'] === 'daemon_event') {
    process.stdout.write(`· [daemon] ${msg['event'] ?? ''}${msg['reason'] ? `：${msg['reason']}` : ''}\n`)
    return
  }
  const rendered = renderSdkMessage(msg)
  if (rendered) {
    process.stdout.write(rendered + '\n')
    return
  }
  if (msg['type'] === 'control_request') {
    const request = msg['request'] as Record<string, unknown> | undefined
    if (request && request['subtype'] === 'can_use_tool') {
      process.stdout.write(`· ${renderPermissionRequest(request)}\n`)
    }
  }
  // 其余（工具结果、thinking 等）在日志查看里默认折叠
}

function readTail(file: string, n: number): string[] {
  const data = readFileSync(file, 'utf8')
  const lines = data.split('\n').filter(l => l.trim())
  return lines.slice(-n)
}

// ============================================================================
// main.tsx 的统一入口
// ============================================================================

export async function runDaemonCli(action: string, opts: Record<string, unknown>): Promise<void> {
  const str = (k: string): string | undefined => (typeof opts[k] === 'string' ? (opts[k] as string) : undefined)
  const bool = (k: string): boolean => opts[k] === true
  const num = (k: string): number | undefined => (typeof opts[k] === 'number' ? (opts[k] as number) : undefined)
  switch (action) {
    case 'start':
      await daemonStart({
        name: str('name'),
        resumeId: str('resume'),
        model: str('model'),
        permissionMode: str('permissionMode'),
      })
      return
    case 'list':
      await daemonList()
      return
    case 'stop':
      await daemonStop(str('name') ?? '')
      return
    case 'attach':
      await daemonAttach(str('name') ?? '')
      return
    case 'logs':
      await daemonLogs(str('name') ?? '', { follow: bool('follow'), lines: num('lines') })
      return
    case 'run':
      await runDaemonProcess({
        name: str('name') ?? 'default',
        sessionId: str('sessionId'),
        resumeId: str('resume'),
        model: str('model'),
        permissionMode: str('permissionMode'),
      })
      return
    default:
      process.stderr.write(`未知的 daemon 动作：${action}\n`)
      process.exitCode = 1
  }
}

// ============================================================================
// 快速路径入口（entrypoints/cli.tsx 在 commander 之前直接分发到这里）
// ============================================================================

const DAEMON_HELP = `用法：limkenion daemon <子命令>

后台会话守护进程：在后台运行一个持久会话，随时 attach 接管或查看日志。

子命令：
  start [-n <名称>] [-r <会话ID>] [--model <模型>] [--permission-mode <模式>]
        在后台启动一个持久会话守护进程
  list                          列出全部后台会话守护进程
  attach <名称>                 交互式接入一个后台会话（权限请求会转发到这里应答）
  logs <名称> [-f] [--lines N]  查看后台会话日志
  stop <名称>                   停止一个后台会话守护进程
  -h, --help                    显示本帮助

说明：会话照常持久化，停止后可用 \`limkenion -r <会话ID>\` 恢复。
权限请求在无 attach 客户端在场时会被**自动拒绝**（绝不静默放行）。`

/** 把一条提示词发射给正在运行的守护进程（--bg 用，发射后不管）。 */
async function bgSendPrompt(name: string, prompt: string): Promise<void> {
  const status = readStatus(name)
  if (!status) throw new Error(`守护进程「${name}」未就绪`)
  const sock = await connectDaemon(status)
  sock.write(JSON.stringify({ type: 'user', text: prompt }) + '\n')
  // 给 TCP 缓冲一点时间落地再断开（发射后不管，回合在后台继续跑）
  await new Promise(r => setTimeout(r, 300))
  sock.destroy()
}

/**
 * 入口快速路径：`limkenion daemon [子命令]`（args 不含 'daemon' 本身）。
 * 在 commander 之前被 entrypoints/cli.tsx 调用，避免完整的 TUI 启动开销。
 */
export async function daemonFastMain(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(DAEMON_HELP + '\n')
    return
  }
  const flagOf = (flag: string): string | undefined => {
    const i = rest.indexOf(flag)
    return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined
  }
  switch (sub) {
    case 'start': {
      const positional = rest.filter(a => !a.startsWith('-') && rest[rest.indexOf(a) - 1] !== '-n' && rest[rest.indexOf(a) - 1] !== '-r' && rest[rest.indexOf(a) - 1] !== '--name' && rest[rest.indexOf(a) - 1] !== '--model' && rest[rest.indexOf(a) - 1] !== '--permission-mode' && rest[rest.indexOf(a) - 1] !== '--resume')
      await daemonStart({
        name: flagOf('-n') ?? flagOf('--name') ?? positional[0],
        resumeId: flagOf('-r') ?? flagOf('--resume'),
        model: flagOf('--model'),
        permissionMode: flagOf('--permission-mode'),
      })
      return
    }
    case 'list':
    case 'ps':
      await daemonList()
      return
    case 'attach': {
      const name = rest.find(a => !a.startsWith('-'))
      await daemonAttach(name ?? 'default')
      return
    }
    case 'logs': {
      const name = rest.find(a => !a.startsWith('-'))
      await daemonLogs(name ?? 'default', {
        follow: rest.includes('-f') || rest.includes('--follow'),
        lines: (() => {
          const i = rest.indexOf('--lines')
          return i >= 0 ? parseInt(rest[i + 1], 10) : undefined
        })(),
      })
      return
    }
    case 'stop':
    case 'kill': {
      const name = rest.find(a => !a.startsWith('-'))
      await daemonStop(name ?? 'default')
      return
    }
    case 'run': {
      // 内部：由 start 派生的 detached 进程进入这里
      await runDaemonProcess({
        name: flagOf('--name') ?? 'default',
        sessionId: flagOf('--session-id'),
        resumeId: flagOf('--resume'),
        model: flagOf('--model'),
        permissionMode: flagOf('--permission-mode'),
      })
      return
    }
    default:
      process.stderr.write(`未知的 daemon 子命令：${sub}\n\n${DAEMON_HELP}\n`)
      process.exitCode = 1
  }
}

/** `--bg` 发射后不管：启动守护进程 → 等就绪 → 发送提示词 → 脱离。 */
export async function daemonStartWithPrompt(opts: {
  prompt: string
  model?: string
  permissionMode?: string
}): Promise<void> {
  const name = `bg-${randomUUID().slice(0, 8)}`
  await daemonStart({ name, model: opts.model, permissionMode: opts.permissionMode })
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await bgSendPrompt(name, opts.prompt)
      process.stdout.write(`提示词已发给后台会话「${name}」。\n查看进度：limkenion attach ${name} 或 limkenion logs ${name} -f\n结束后停止：limkenion stop ${name}\n`)
      return
    } catch (err) {
      if (Date.now() > deadline) {
        process.stderr.write(`错误：无法向守护进程发送提示词：${String(err)}\n` +
          `它可能还在启动，稍后手动发送：limkenion attach ${name}\n`)
        process.exitCode = 1
        return
      }
      await new Promise(r => setTimeout(r, 500))
    }
  }
}
