/**
 * 定时周期解析（tools.parseIntervalMs）。
 *
 * 这个函数被**界面（cron_create）和模型（CronCreate）共用** —— 抽出来的目的就是
 * 只有一套标准，免得出现"界面能建的周期、模型建不了"这种不一致。
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkspace } from './helpers.mjs'

let tools

before(async () => {
  const ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.LIMKENION_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'lk-cron-cfg-'))
  tools = await import('../server/tools.mjs')
})

test('秒 / 分 / 小时写法', () => {
  assert.strictEqual(tools.parseIntervalMs('30s'), 30_000)
  assert.strictEqual(tools.parseIntervalMs('5m'), 300_000)
  assert.strictEqual(tools.parseIntervalMs('2h'), 7_200_000)
})

test('纯毫秒与 rrule 的 INTERVAL=n', () => {
  assert.strictEqual(tools.parseIntervalMs('60000'), 60_000)
  assert.strictEqual(tools.parseIntervalMs('FREQ=MINUTELY;INTERVAL=10'), 600_000)
})

test('直接给毫秒时优先用它（界面走的就是这条）', () => {
  assert.strictEqual(tools.parseIntervalMs('5m', 12345), 12_345)
})

test('解析不出来返回 NaN（由调用方决定怎么报错）', () => {
  assert.ok(Number.isNaN(tools.parseIntervalMs('abc')))
  assert.ok(Number.isNaN(tools.parseIntervalMs('')))
})
