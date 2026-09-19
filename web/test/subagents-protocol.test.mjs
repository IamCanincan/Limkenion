/**
 * 具名子代理的**协议层**测试：起真服务、连 WS，跑 subagent_list / save / delete。
 *
 * 单测覆盖不到 WS 接线（case 名/字段名错都不会红），所以要有这一层。
 * 另外在这里复验一次"越权工具会被拒"—— 那是这条配置面的安全底线。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startServer, fetchToken, rmDir } from './helpers.mjs'

let PORT = 0  // 0 = 让系统分配端口：硬编码端口在 CI 上可能被别的进程占用（EADDRINUSE）
let srv
let stateDir
let ws

function waitFor(type, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs)
    const onMsg = raw => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== type) return
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve(msg)
    }
    ws.on('message', onMsg)
  })
}

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'limkenion-subagentws-'))
  srv = await startServer({ port: PORT, env: { LIMKENION_WEB_STATE_DIR: stateDir } })
  PORT = srv.port
  const token = await fetchToken(srv.base)
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await waitFor('hello')
})

after(async () => {
  try {
    ws?.close()
  } catch {
    /* 已关 */
  }
  srv?.child.kill()
  await rmDir(stateDir)
})

test('WS subagent_list：初始为空', async () => {
  const pending = waitFor('subagents')
  ws.send(JSON.stringify({ type: 'subagent_list' }))
  const res = await pending
  assert.ok(Array.isArray(res.subagents), 'subagents 应是数组')
})

test('WS subagent_save：建成后回推清单', async () => {
  const pending = waitFor('subagents')
  ws.send(
    JSON.stringify({
      type: 'subagent_save',
      name: 'researcher',
      scope: 'user',
      config: { description: '只读调研', tools: ['Read', 'Grep'] },
    }),
  )
  const res = await pending
  const one = res.subagents.find(s => s.name === 'researcher')
  assert.ok(one, '清单里应有刚建的')
  assert.deepStrictEqual(one.tools, ['Read', 'Grep'])
})

test('WS subagent_save：给越权工具要回明确的错误', async () => {
  const pending = waitFor('error')
  ws.send(
    JSON.stringify({
      type: 'subagent_save',
      name: 'evil',
      scope: 'user',
      config: { description: 'x', tools: ['Write'] },
    }),
  )
  const err = await pending
  assert.match(err.message, /只读工具|Write|失败/, '应说明为什么不行')
})
