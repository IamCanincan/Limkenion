/**
 * 全局搜索（server/search.mjs）回归测试。
 *
 * 覆盖：跨会话消息匹配（含大小写不敏感、多词 AND、工具结果可搜）、
 * 会话标题命中、命中上限截断（complete=false）、空查询不返回东西。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeWorkspace, rmDir } from './helpers.mjs'
import { join } from 'node:path'

let ws
let sessions
let search

/** 建一个会话并塞几条消息（role/text 可控）。 */
function makeSession(title, messages) {
  const s = sessions.createSession()
  s.title = title
  s.messages = messages.map((m, i) => ({
    id: `m${i}_${s.id}`,
    role: m.role ?? 'user',
    text: m.text ?? '',
    timestamp: 1000 + i,
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
  }))
  return s
}

before(async () => {
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  sessions = await import('../server/sessions.mjs')
  search = await import('../server/search.mjs')

  makeSession('第一个会话', [
    { role: 'user', text: '帮我看看 alpha 模块的报错' },
    { role: 'assistant', text: '好的，我看一下' },
  ])
  makeSession('第二个会话', [
    { role: 'user', text: '查一下 BETA 相关的日志' },
    {
      role: 'assistant',
      text: '查到了',
      toolCalls: [{ id: 't1', name: 'Bash', status: 'done', result: '日志里有 gamma 字样' }],
    },
  ])
})

after(async () => {
  await rmDir(ws.dir)
})

test('跨会话搜消息：大小写不敏感，且能搜到另一个会话', () => {
  const r = search.searchMessages('alpha')
  assert.ok(r.hits.length >= 1, '应命中 alpha')
  assert.ok(r.hits.every(h => h.kind === 'message'))
  assert.match(r.hits[0].snippet, /alpha/i)

  // 大小写不敏感：查 BETA 能命中 "BETA"（原文大写）
  const upper = search.searchMessages('beta')
  assert.ok(upper.hits.length >= 1, '大写原文也应被小写查询命中')
})

test('多词是 AND 语义：两个词都要有', () => {
  const both = search.searchMessages('gamma 日志')
  assert.ok(both.hits.length >= 1, '同一条消息里同时含两词才命中')

  const none = search.searchMessages('gamma 绝不存在的词')
  assert.strictEqual(none.hits.length, 0, '缺一个词就不该命中')
})

test('工具结果里的文字也能被搜到', () => {
  const r = search.searchMessages('gamma')
  assert.ok(r.hits.length >= 1, '工具结果里的 gamma 应可被搜到')
  assert.match(r.hits[0].snippet, /gamma|查到了/)
})

test('命中上限会截断并如实报告 complete=false', () => {
  const r = search.searchMessages('的', { limit: 1 })
  assert.strictEqual(r.hits.length, 1, '应被限制到 1 条')
  assert.strictEqual(r.complete, false, '被截断时 complete 应为 false')
})

test('会话标题命中', () => {
  const r = search.searchSessions('第二个')
  assert.ok(r.hits.length >= 1)
  assert.equal(r.hits[0].kind, 'session')
  assert.match(r.hits[0].sessionTitle, /第二个/)
})

test('空查询不返回命中（不把全部消息吐出来）', async () => {
  const msgs = search.searchMessages('   ')
  assert.deepStrictEqual(msgs.hits, [])
  const all = await search.searchAll('   ')
  assert.deepStrictEqual(all.hits, [])
  assert.strictEqual(all.complete, true)
})

test('searchAll 汇总三类命中，并带上 query', async () => {
  const r = await search.searchAll('alpha')
  assert.strictEqual(r.query, 'alpha')
  assert.ok(r.hits.length >= 1)
  assert.ok(r.hits.some(h => h.kind === 'message'), '应含消息命中')
})
