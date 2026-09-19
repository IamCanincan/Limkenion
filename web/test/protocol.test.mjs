/**
 * 协议层测试：以子进程启动真实服务，验证握手鉴权、静态服务加固、
 * 命令往返与会话持久化。这是唯一覆盖「真实 HTTP + WS 边界」的测试。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { fetchToken, startServer, rmDir } from './helpers.mjs'

const PORT = 18899
let srv
let token
let stateDir

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'limkenion-state-'))
  srv = await startServer({ port: PORT, env: { LIMKENION_WEB_STATE_DIR: stateDir } })
  token = await fetchToken(srv.base)
})

after(async () => {
  srv?.child.kill()
  await rmDir(stateDir)
})

/** 打开一条 WS，返回 { ws, next(type), close() }。 */
function openWs(query = '', opts = {}) {
  // ws 库要用 options.origin 才会真的发出 Origin 头（headers 里的会被过滤）
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`, opts)
  const queue = []
  const waiters = []
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    const w = waiters.shift()
    if (w) w(msg)
    else queue.push(msg)
  })
  return {
    ws,
    next(type, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const take = msg => {
          if (!type || msg.type === type) resolve(msg)
          else {
            const w = waiters.shift()
            void w
            resolve(msg)
          }
        }
        const found = queue.findIndex(m => !type || m.type === type)
        if (found >= 0) return resolve(queue.splice(found, 1)[0])
        const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs)
        const push = msg => {
          if (!type || msg.type === type) {
            clearTimeout(timer)
            resolve(msg)
          } else {
            queue.push(msg)
            waiters.push(push)
          }
        }
        waiters.push(push)
      })
    },
    close() {
      ws.close()
    },
  }
}

function connect(query = '', opts = {}) {
  return new Promise((resolve, reject) => {
    const client = openWs(query, opts)
    client.ws.on('open', () => resolve(client))
    client.ws.on('error', reject)
    setTimeout(() => reject(new Error('连接超时')), 8000)
  })
}

// ---------------------------------------------------------------------------

describe('握手鉴权', () => {
  test('无 token 被拒（403）', async () => {
    await assert.rejects(() => connect(''), /403|Unexpected server response/)
  })

  test('错误 token 被拒', async () => {
    await assert.rejects(() => connect('?token=deadbeef'), /403|Unexpected server response/)
  })

  test('外部 Origin 被拒（防跨站页面驱动 agent）', async () => {
    await assert.rejects(
      () => connect(`?token=${token}`, { origin: 'https://evil.example.com' }),
      /403|Unexpected server response/,
      '外部 Origin 竟然被放行了',
    )
  })

  test('本机 Origin + 正确 token 放行，并收到 hello/commands/settings', async () => {
    const client = await connect(`?token=${token}`)
    const hello = await client.next('hello')
    assert.ok(hello.serverVersion)
    assert.ok(Array.isArray(hello.sessions))
    const commands = await client.next('commands')
    assert.ok(commands.commands.length > 0)
    const settings = await client.next('settings')
    assert.equal(settings.settings.workspace.length > 0, true)
    client.close()
  })

  test('/ws-token 对本机来源返回 token', async () => {
    const res = await fetch(`${srv.base}/ws-token`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.token, token)
  })

  test('/ws-token 对外部 Origin 返回 403', async () => {
    const res = await fetch(`${srv.base}/ws-token`, { headers: { origin: 'https://evil.example.com' } })
    assert.equal(res.status, 403)
  })

  test('token 不会出现在 HTML 之外的地方（no-store）', async () => {
    const res = await fetch(`${srv.base}/`)
    assert.match(res.headers.get('cache-control') ?? '', /no-store/)
  })
})

describe('静态服务加固', () => {
  test('目录穿越被拒', async () => {
    for (const p of ['/../server/index.mjs', '/..%2fserver/index.mjs', '/..\\server\\index.mjs', '/../package.json']) {
      const res = await fetch(`${srv.base}${p}`)
      // 可能是 403，也可能被 SPA 回退成 200 的 index.html —— 关键是拿不到目标文件
      const body = await res.text()
      assert.ok(
        res.status === 403 || body.includes('<div id="root">'),
        `${p} 竟然返回了目标文件：${body.slice(0, 80)}`,
      )
      assert.ok(!body.includes('limkenion-web'), `${p} 泄露了 package.json`)
    }
  })

  test('安全响应头齐全', async () => {
    const res = await fetch(`${srv.base}/`)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/)
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  })

  test('SPA 回退返回 index.html', async () => {
    const res = await fetch(`${srv.base}/some/route`)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /<div id="root">/)
  })

  test('非 GET/HEAD 返回 405', async () => {
    const res = await fetch(`${srv.base}/`, { method: 'POST' })
    assert.equal(res.status, 405)
  })
})

describe('命令往返', () => {
  test('/help 与 /tools 有真实输出', async () => {
    const client = await connect(`?token=${token}`)
    const hello = await client.next('hello')
    const sessionId = hello.sessions[0].id
    await client.next('commands')
    await client.next('settings')

    for (const [cmd, expect] of [
      ['/help', /web 端有真实语义/],
      ['/tools', /常驻/],
      ['/status', /工作区/],
      ['/config', /当前设置/],
      // /mcp 现在是真实现（会读 mcpServers 并显示连接状态）
      ['/mcp', /MCP 服务器|支持的传输/],
      ['/hooks', /钩子/],
      ['/不存在的命令', /未知命令/],
    ]) {
      client.ws.send(JSON.stringify({ type: 'run_command', sessionId, command: cmd }))
      const res = await client.next('command_result')
      assert.match(res.output, expect, `${cmd} 输出不符：${res.output.slice(0, 120)}`)
    }
    client.close()
  })

  test('设置是会话级的：改一个会话不影响另一个', async () => {
    const client = await connect(`?token=${token}`)
    const hello = await client.next('hello')
    const a = hello.sessions[0].id
    client.ws.send(JSON.stringify({ type: 'new_session' }))
    const created = await client.next('session_messages')
    const b = created.sessionId

    client.ws.send(JSON.stringify({ type: 'set_setting', key: 'theme', value: 'light', sessionId: a }))
    await client.next('settings')

    client.ws.send(JSON.stringify({ type: 'get_settings', sessionId: b }))
    let got = await client.next('settings')
    while (got.sessionId !== b) got = await client.next('settings')
    assert.equal(got.settings.theme, 'dark', 'B 会话被 A 的改动污染了')

    client.ws.send(JSON.stringify({ type: 'get_settings', sessionId: a }))
    got = await client.next('settings')
    while (got.sessionId !== a) got = await client.next('settings')
    assert.equal(got.settings.theme, 'light')
    client.close()
  })

  test('非法设置值被拒', async () => {
    const client = await connect(`?token=${token}`)
    const hello = await client.next('hello')
    await client.next('commands')
    await client.next('settings')
    client.ws.send(JSON.stringify({ type: 'set_setting', key: 'theme', value: '彩虹色', sessionId: hello.sessions[0].id }))
    const err = await client.next('error')
    assert.match(err.message, /无法设置/)
    client.close()
  })

  test('未知会话报错而不是静默丢弃', async () => {
    const client = await connect(`?token=${token}`)
    await client.next('hello')
    await client.next('commands')
    await client.next('settings')
    client.ws.send(JSON.stringify({ type: 'run_command', sessionId: 's_nope', command: '/help' }))
    const err = await client.next('error')
    assert.match(err.message, /会话不存在/)
    client.close()
  })
})

describe('会话持久化', () => {
  test('重启后会话被恢复', async () => {
    const client = await connect(`?token=${token}`)
    const hello = await client.next('hello')
    const id = hello.sessions[0].id
    await client.next('commands')
    await client.next('settings')
    client.ws.send(JSON.stringify({ type: 'rename_session', sessionId: id, title: '持久化验证' }))
    await client.next('sessions_changed')
    client.close()

    // 等防抖落盘
    await new Promise(r => setTimeout(r, 1200))
    const raw = await readFile(join(stateDir, 'sessions.json'), 'utf8')
    assert.match(raw, /持久化验证/)

    // 重启服务
    srv.child.kill()
    await new Promise(r => setTimeout(r, 400))
    srv = await startServer({ port: PORT, env: { LIMKENION_WEB_STATE_DIR: stateDir } })
    token = await fetchToken(srv.base)

    const c2 = await connect(`?token=${token}`)
    const hello2 = await c2.next('hello')
    assert.ok(
      hello2.sessions.some(s => s.title === '持久化验证'),
      `重启后未恢复会话：${JSON.stringify(hello2.sessions.map(s => s.title))}`,
    )
    c2.close()
  })
})

describe('请求追踪协议', () => {
  test('get_requests 返回 requests + summary 两个字段', async () => {
    const client = await connect(`?token=${token}`)
    await client.next('hello')
    client.ws.send(JSON.stringify({ type: 'get_requests' }))
    const msg = await client.next('requests')
    assert.ok(Array.isArray(msg.requests), 'requests 应是数组')
    assert.ok(msg.summary && typeof msg.summary.count === 'number', 'summary 应带 count')
    assert.ok('ok' in msg.summary && 'failed' in msg.summary, 'summary 应带成功/失败计数')
    client.close()
  })

  test('clear_requests 清空并回报条数', async () => {
    const client = await connect(`?token=${token}`)
    await client.next('hello')
    client.ws.send(JSON.stringify({ type: 'clear_requests' }))
    const msg = await client.next('requests')
    assert.ok(typeof msg.cleared === 'number', 'cleared 应是数字')
    assert.equal(msg.requests.length, 0, '清空后应为空')
    client.close()
  })

  test('limit 参数生效（不会返回超过上限的条数）', async () => {
    const client = await connect(`?token=${token}`)
    await client.next('hello')
    client.ws.send(JSON.stringify({ type: 'get_requests', limit: 1 }))
    const msg = await client.next('requests')
    assert.ok(msg.requests.length <= 1, 'limit=1 时最多返回 1 条')
    client.close()
  })
})

describe('会话分叉协议（对应 CLI 的 /branch）', () => {
  test('fork_session 回报 session_forked 并自动切到新会话', async () => {
    const client = await connect(`?token=${token}`)
    await client.next('hello')

    client.ws.send(JSON.stringify({ type: 'new_session' }))
    const created = await client.next('session_messages')
    const srcId = created.sessionId

    client.ws.send(JSON.stringify({ type: 'fork_session', sessionId: srcId, title: '分叉测试' }))
    const forked = await client.next('session_forked')
    assert.equal(forked.fromId, srcId, '应记录源会话')
    assert.equal(forked.title, '分叉测试', '标题应生效')
    assert.notEqual(forked.sessionId, srcId, '必须是新会话 id')

    const switched = await client.next('session_messages')
    assert.equal(switched.sessionId, forked.sessionId, '应自动切到分叉出来的会话')

    // 分叉出来的会话要出现在会话列表里。
    // 这里另开一条连接看 hello 里的列表 —— 复用原连接会先拿到分叉之前那次
    // broadcastSessions 的广播，断言不到新会话。
    const probe = await connect(`?token=${token}`)
    const hello2 = await probe.next('hello')
    assert.ok(
      hello2.sessions.some(s => s.id === forked.sessionId),
      '新会话应出现在会话列表',
    )
    probe.close()
    client.close()
  })

  test('对不存在的会话分叉会回错误', async () => {
    const client = await connect(`?token=${token}`)
    await client.next('hello')
    client.ws.send(JSON.stringify({ type: 'fork_session', sessionId: 's_不存在' }))
    const err = await client.next('error')
    assert.match(err.message, /会话不存在/)
    client.close()
  })
})

// ---------------------------------------------------------------------------

describe('畸形消息不能打挂服务', () => {
  /**
   * 回归：`void handleClientMessage(...)` 原先没有 `.catch()`，而它是 async ——
   * 抛出的异常就是未处理的 promise rejection，Node 15+ 默认**直接终止进程**。
   * 实测一条 `{"type":"run_command","command":{"toString":null}}` 就能让整个服务退出
   * （`String()` 对这种对象抛 TypeError）。现在单条消息失败即可，服务继续可用。
   */
  test('单条畸形消息只让该条失败，并回错误给客户端', async () => {
    const client = await connect(`?token=${token}`)
    await client.next('hello')
    client.ws.send(JSON.stringify({ type: 'new_session' }))
    const sid = (await client.next('session_messages')).sessionId

    client.ws.send(
      JSON.stringify({ type: 'run_command', sessionId: sid, command: { toString: null } }),
    )
    const err = await client.next('error')
    assert.match(err.message, /处理消息失败/)

    // 服务必须还活着 —— 还能正常应答
    client.ws.send(JSON.stringify({ type: 'get_models' }))
    const models = await client.next('models')
    assert.ok(Array.isArray(models.models) && models.models.length > 0, '服务应仍能应答 get_models')
    client.close()
  })

  test('连灌一批畸形消息后服务仍可用', async () => {
    const client = await connect(`?token=${token}`)
    await client.next('hello')
    client.ws.send(JSON.stringify({ type: 'new_session' }))
    const sid = (await client.next('session_messages')).sessionId

    const poison = { toString: null }
    const junk = [
      { type: 'run_command', sessionId: sid, command: poison },
      { type: 'run_command', sessionId: sid, command: 12345 },
      { type: 'run_command', sessionId: sid, command: ['/status'] },
      { type: 'rename_session', sessionId: sid, title: poison },
      { type: 'user_message', sessionId: sid, text: poison },
      { type: 'set_setting', sessionId: sid, key: poison, value: 1 },
      { type: 'team_message', sessionId: sid, member: poison, message: 1 },
      { type: 'list_files', sessionId: sid, path: poison },
      { type: 'fork_session', sessionId: sid, atIndex: poison },
      { type: 'permission_response', requestId: poison, decision: 1 },
      { type: 'question_response', requestId: poison, answers: 1 },
      { type: 'select_session', sessionId: poison },
      { type: '不存在的类型', sessionId: sid },
    ]
    for (const m of junk) client.ws.send(JSON.stringify(m))
    await new Promise(r => setTimeout(r, 800))

    client.ws.send(JSON.stringify({ type: 'get_models' }))
    const models = await client.next('models')
    assert.ok(Array.isArray(models.models), '连灌畸形消息后服务应仍能应答')
    client.close()
  })

  test('非 JSON 帧被静默丢弃，不影响后续请求', async () => {
    const client = await connect(`?token=${token}`)
    await client.next('hello')
    client.ws.send('这不是 JSON {{{')
    client.ws.send(Buffer.from([0x00, 0x01, 0x02]))
    await new Promise(r => setTimeout(r, 300))
    client.ws.send(JSON.stringify({ type: 'get_models' }))
    const models = await client.next('models')
    assert.ok(Array.isArray(models.models))
    client.close()
  })
})
