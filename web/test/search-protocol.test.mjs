/**
 * 搜索的**协议层**测试：起真服务、连 WS、发 search、收 search_results。
 *
 * 单测（search.test.mjs）覆盖不到这一段接线 —— WS 的 case 名写错、
 * 回包字段拼错，单测全绿也发现不了。所以这里必须真连一次。
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
let token

/** 等指定类型的消息（带超时，避免测试挂死）。 */
function waitFor(type, timeoutMs = 8000) {
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
  stateDir = await mkdtemp(join(tmpdir(), 'limkenion-searchws-'))
  srv = await startServer({ port: PORT, env: { LIMKENION_WEB_STATE_DIR: stateDir } })
  PORT = srv.port
  token = await fetchToken(srv.base)
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

test('WS search：能搜到默认会话的标题并回 search_results', async () => {
  // 启动时自动建了一个标题为「新会话」的会话
  const pending = waitFor('search_results')
  ws.send(JSON.stringify({ type: 'search', query: '新会话' }))
  const res = await pending

  assert.strictEqual(res.type, 'search_results')
  assert.strictEqual(res.query, '新会话')
  assert.ok(Array.isArray(res.hits), 'hits 应是数组')
  assert.ok(res.hits.length >= 1, '应至少命中默认会话')
  assert.equal(res.hits[0].kind, 'session')
  assert.strictEqual(typeof res.complete, 'boolean', 'complete 应是布尔（增量快照语义）')
})

test('WS search：空查询返回空结果且不报错', async () => {
  const pending = waitFor('search_results')
  ws.send(JSON.stringify({ type: 'search', query: '' }))
  const res = await pending
  assert.deepStrictEqual(res.hits, [], '空查询不应吐出全部消息')
  assert.strictEqual(res.complete, true)
})
