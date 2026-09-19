/**
 * 定时任务的**协议层**测试：起真服务、连 WS、跑 cron_list / cron_create / cron_delete。
 *
 * 单测覆盖不到 WS 接线（case 名写错、回包字段名拼错都不会红），所以要有这一层。
 * 周期用 10m，不会在测试期间真的触发（最小 5s 的任务才会在测试里跑起来）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startServer, fetchToken, rmDir } from './helpers.mjs'

const PORT = 18947
let srv
let stateDir
let ws
let sessionId

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

/** 发一条消息并等指定类型的回包。 */
function request(msg, type) {
  const pending = waitFor(type)
  ws.send(JSON.stringify(msg))
  return pending
}

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'limkenion-cronws-'))
  srv = await startServer({ port: PORT, env: { LIMKENION_WEB_STATE_DIR: stateDir } })
  const token = await fetchToken(srv.base)
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const hello = await waitFor('hello')
  sessionId = hello.sessions?.[0]?.id ?? ''
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

test('WS cron_list：初始为空', async () => {
  const res = await request({ type: 'cron_list' }, 'crons')
  assert.strictEqual(res.type, 'crons')
  assert.ok(Array.isArray(res.crons), 'crons 应是数组')
  assert.strictEqual(res.crons.length, 0)
})

test('WS cron_create：用与模型同一套周期写法建成（10m → 600000ms）', async () => {
  assert.ok(sessionId, '应拿到会话 id')
  const res = await request(
    { type: 'cron_create', sessionId, prompt: '检查构建状态', schedule: '10m' },
    'crons',
  )
  assert.strictEqual(res.crons.length, 1)
  assert.strictEqual(res.crons[0].everyMs, 600_000, '10m 应解析成 600000ms')
  assert.strictEqual(res.crons[0].sessionId, sessionId)
  assert.match(res.crons[0].prompt, /检查构建状态/)
})

test('WS cron_delete：删掉后清单为空', async () => {
  const created = await request(
    { type: 'cron_create', sessionId, prompt: '待删除的任务', schedule: '10m' },
    'crons',
  )
  const id = created.crons.find(c => c.prompt === '待删除的任务')?.id
  assert.ok(id, '应拿到新建任务的 id')

  const after = await request({ type: 'cron_delete', id }, 'crons')
  assert.ok(!after.crons.some(c => c.id === id), '该任务应已被删除')
})

test('WS cron_create：周期解析不出来时回明确的错误', async () => {
  const err = await request(
    { type: 'cron_create', sessionId, prompt: '随便', schedule: '不是周期' },
    'error',
  )
  assert.match(err.message, /周期|5 秒/, '错误信息应说明周期问题')
})
