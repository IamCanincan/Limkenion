/**
 * 定时周期的**上限**（server/engine.mjs 的 scheduleCron）。
 *
 * 为什么要有上限：setInterval 对大于 2^31-1（约 24.8 天）的 delay 会当成 1ms，
 * 于是很大的毫秒数会变成「每毫秒起一个回合」—— 等于把自己打挂。
 * 界面允许直接填毫秒数，所以这条边界必须挡住。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkspace, rmDir } from './helpers.mjs'

let ws
let engine
let sessions

before(async () => {
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
})

after(async () => {
  engine?.clearAllCrons?.()
  await rmDir(ws.dir)
})

test('超过定时器上限的周期要被拒（不能默默变成 1ms 疯跑）', () => {
  const s = sessions.createSession()
  assert.throws(
    () => engine.scheduleCron(s, { everyMs: 99_999_999_999, prompt: '每秒跑死你' }),
    /上限|超过/,
    '超大周期必须被拒，否则 setInterval 会当成 1ms',
  )
})

test('刚好在上限以内 / 正常周期不受影响', () => {
  const s = sessions.createSession()
  const ok = engine.scheduleCron(s, { everyMs: 60_000, prompt: '每分钟' })
  assert.ok(ok?.id, '正常周期应能登记')
  assert.ok(engine.cronList().some(c => c.id === ok.id))

  // 上限边界（2^31-1）本身应当可用
  const atMax = engine.scheduleCron(s, { everyMs: engine.MAX_TIMER_MS, prompt: '上限' })
  assert.ok(atMax?.id)
})

test('NaN 之类也要拒（防住解析失败的漏网之鱼）', () => {
  const s = sessions.createSession()
  assert.throws(() => engine.scheduleCron(s, { everyMs: NaN, prompt: 'x' }), /上限|超过/)
  assert.throws(() => engine.scheduleCron(s, { everyMs: Infinity, prompt: 'x' }), /上限|超过/)
})
