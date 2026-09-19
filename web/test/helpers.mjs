/**
 * 测试辅助：桩模型服务、假客户端、临时工作区、子进程启动服务。
 *
 * 关键点：服务端各模块在 **import 时** 读取环境变量（端口、工作区、base URL…），
 * 所以测试必须在 import 之前把 env 设好，再用动态 import。
 */

import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

export const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server')
export const SERVER_ENTRY = join(SERVER_DIR, 'index.mjs')

/** 监听一个随机端口，返回 { port, close }。 */
export function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        close: () => new Promise(r => server.close(() => r())),
      })
    })
  })
}

/**
 * 桩模型：OpenAI 兼容的 /chat/completions，按脚本顺序回放 SSE。
 *
 * 脚本元素：
 *   { text: '...' }                        → 文本流
 *   { reasoning: '...', text: '...' }      → 思维链 + 文本
 *   { toolCalls: [{ id, name, args }] }    → 一次工具调用
 * 脚本耗尽后重复最后一条。
 */
export async function startStubModel(initialScript) {
  const requests = []
  let script = initialScript
  let idx = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => {
      body += c
    })
    req.on('end', () => {
      try {
        requests.push(JSON.parse(body || '{}'))
      } catch {
        requests.push({})
      }
      const step = script[Math.min(idx++, script.length - 1)] ?? { text: '（桩模型默认回复）' }

      // 支持模拟错误响应：{ status: 500, error: '...' }
      // 用于验证失败路径（重试、错误记录、用户提示）。
      if (step.status && step.status !== 200) {
        res.writeHead(step.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: step.error ?? `桩模型错误 ${step.status}` } }))
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`)

      if (step.reasoning) emit({ choices: [{ delta: { reasoning_content: step.reasoning } }] })
      if (step.text) {
        for (const chunk of String(step.text).match(/[\s\S]{1,24}/g) ?? []) {
          emit({ choices: [{ delta: { content: chunk } }] })
        }
      }
      for (const [i, tc] of (step.toolCalls ?? []).entries()) {
        emit({
          choices: [
            { delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }] } },
          ],
        })
        emit({
          choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(tc.args ?? {}) } }] } }],
        })
      }
      emit({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  const { port, close } = await listen(server)
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    /** 换一段脚本并重置游标（端口不变，因此已加载的 base URL 依然有效）。 */
    setScript(steps) {
      script = steps
      idx = 0
    },
    get callCount() {
      return idx
    },
    close,
  }
}

/**
 * 假 WS 客户端：注册进 bus，记录收到的消息，并可按策略自动应答。
 * @param {{onPermission?: (msg)=>string, onQuestion?: (msg)=>unknown[]}} policy
 */
export function fakeClient(policy = {}) {
  const received = []
  const ws = {
    readyState: 1,
    OPEN: 1,
    on() {},
    send(raw) {
      const msg = JSON.parse(raw)
      received.push(msg)
      if (msg.type === 'permission_request' && policy.onPermission) {
        // 延后一拍，模拟用户点按钮
        setTimeout(() => policy.onPermission(msg), 0)
      }
      if (msg.type === 'question_request' && policy.onQuestion) {
        setTimeout(() => policy.onQuestion(msg), 0)
      }
    },
  }
  return { ws, received, ofType: t => received.filter(m => m.type === t) }
}

/** 建一个临时工作区（可预置文件）。 */
export async function makeWorkspace(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'limkenion-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return {
    dir,
    cleanup: () => rmDir(dir),
  }
}

/**
 * 递归删除目录（测试清理用）。
 *
 * Windows 下裸 `rm -rf` 遇到「还有句柄/子进程短暂占用」的目录会报 ENOTEMPTY 且默认
 * 不重试，导致测试 after 钩子偶发挂（engine.test 的 rmdir ENOTEMPTY flake 即此）。
 * 加 maxRetries/retryDelay 让瞬态占用自动重试——比裸 rm 稳。
 * @param {string} dir
 */
export async function rmDir(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/**
 * 以子进程启动真实服务，等它就绪。
 *
 * **`port: 0` 表示让操作系统分配端口** —— 推荐用它：硬编码端口在 CI 容器里可能
 * 已经被别的进程占着（EADDRINUSE），而这种失败跟被测代码毫无关系，最难查。
 * 端口 0 时真实端口从服务的启动日志里读（服务会打印实际绑定的端口）。
 *
 * @returns {Promise<{child: import('node:child_process').ChildProcess, base: string, port: number, log: () => string}>}
 */
export async function startServer({ port, env = {} }) {
  const tag = port === 0 ? `${process.pid}-${Math.random().toString(36).slice(2, 8)}` : String(port)
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      LIMKENION_WEB_PORT: String(port),
      LIMKENION_WEB_HOST: '127.0.0.1',
      LIMKENION_WEB_STATE_DIR: join(tmpdir(), `limkenion-state-${tag}`),
      DEEPSEEK_API_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', d => {
    out += d.toString()
  })
  child.stderr.on('data', d => {
    out += d.toString()
  })

  const deadline = Date.now() + 15_000
  let actualPort = port

  // 端口 0：先等启动日志给出真实端口，再去探活
  if (port === 0) {
    actualPort = 0
    while (Date.now() < deadline && actualPort === 0) {
      const m = out.match(/服务已启动[^\n]*?:(\d+)/)
      if (m) actualPort = Number(m[1])
      else await new Promise(r => setTimeout(r, 100))
    }
    if (actualPort === 0) {
      child.kill()
      throw new Error(`未能从启动日志解析出实际端口：\n${out}`)
    }
  }

  const base = `http://127.0.0.1:${actualPort}`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) })
      // 只要**有 HTTP 响应**就算就绪 —— 不能要求 200：
      // CI 是全新检出、没有 dist/，`/` 会返回 404，但服务本身是好的（WS 也一样能用）。
      // 本地因为一直构建过 dist，`/` 恒为 200，于是这个坑在本地完全看不见：
      // 表现为"服务日志明明说起来了，却报 15s 未就绪"，极难排查。
      if (res) return { child, base, port: actualPort, log: () => out }
    } catch {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 150))
  }
  child.kill()
  throw new Error(`服务未在 15s 内就绪：\n${out}`)
}

/**
 * 取 WS 握手用的 token。
 *
 * 走 `/ws-token` 接口，**不要**从 index.html 里解析：
 * 后者要求 `dist/` 已经构建过，而测试通常在 build **之前**跑（CI 就是全新检出、
 * 没有 dist），于是静默拿不到 token → WS 握手 403，报错还是"Unexpected server
 * response: 403"，完全指不到根因。本地因为 dist 常在，这个坑一直没暴露。
 */
export async function fetchToken(base) {
  const res = await fetch(`${base}/ws-token`)
  if (!res.ok) throw new Error(`取 token 失败：HTTP ${res.status}`)
  const body = await res.json()
  const token = String(body?.token ?? '')
  if (!token) throw new Error(`取 token 失败：响应里没有 token：${JSON.stringify(body)}`)
  return token
}
