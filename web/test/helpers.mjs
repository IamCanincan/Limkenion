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
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** 以子进程启动真实服务，等它就绪。 */
export async function startServer({ port, env = {} }) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      LIMKENION_WEB_PORT: String(port),
      LIMKENION_WEB_HOST: '127.0.0.1',
      LIMKENION_WEB_STATE_DIR: join(tmpdir(), `limkenion-state-${port}`),
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

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return { child, base, log: () => out }
    } catch {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 150))
  }
  child.kill()
  throw new Error(`服务未在 15s 内就绪：\n${out}`)
}

/** 从 index.html 里取注入的 token。 */
export async function fetchToken(base) {
  const html = await (await fetch(`${base}/`)).text()
  return html.match(/name="limkenion-token" content="([^"]+)"/)?.[1] ?? ''
}
