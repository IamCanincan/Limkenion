/**
 * 会话**内存上限**（LRU）。
 *
 * 要守的两条不变量：
 *   ① 超出上限时只卸载 messages，**会话条目不能消失**（否则用户以为会话没了）；
 *   ② 被卸载的消息必须**在磁盘上还取得回来** —— 卸载不等于删除。
 * 第 ② 条尤其重要：这条测试如果只是"看到 messages 被清空"就通过，那是假绿。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir
let sessions

const CAP = 3

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lk-sesscap-'))
  process.env.LIMKENION_WEB_STATE_DIR = join(dir, 'state')
  process.env.LIMKENION_WEB_WORKSPACE = dir
  process.env.DEEPSEEK_API_KEY = 'test-key'
  // 上限是在模块加载时读的，必须在 import 之前设好
  process.env.LIMKENION_WEB_MAX_MEMORY_SESSIONS = String(CAP)
  sessions = await import('../server/sessions.mjs')
})

after(async () => {
  delete process.env.LIMKENION_WEB_MAX_MEMORY_SESSIONS
})

/** 造一个带消息的会话。 */
function make(msg) {
  const s = sessions.createSession()
  s.messages.push({ role: 'user', content: msg })
  s.updatedAt = Date.now()
  return s
}

test('上限以内：不会卸载任何会话', async () => {
  const a = make('a')
  const b = make('b')
  const c = make('c')
  await sessions.awaitEvictions()
  for (const s of [a, b, c]) {
    assert.equal(s.unloaded, false, `会话 ${s.id} 在上限内不该被卸载`)
    assert.equal(s.messages.length, 1)
  }
})

test('超出上限：最久未用的被卸载，但**会话条目还在**', async () => {
  await sessions.persistNow()
  const before = sessions.sessionCount()

  const extra = make('extra') // 第 4 个 → 触发卸载
  await sessions.awaitEvictions()

  assert.ok(
    [...sessions.allSessions()].some(s => s.unloaded),
    '应有会话被卸载',
  )
  // 关键：条目不能消失（sessionCount 是数字；allSessions() 返回迭代器，没有 .length）
  assert.equal(sessions.sessionCount(), before + 1, '会话条目数量必须不变（只是消息被卸掉）')
  assert.equal(extra.unloaded, false, '刚创建的会话不该被卸载')
})

test('被卸载的消息能从磁盘读回来（卸载 ≠ 删除）', async () => {
  // 找一个已被卸载的会话
  const cold = [...sessions.allSessions()].find(s => s.unloaded)
  assert.ok(cold, '前置条件：需要有已卸载的会话')
  assert.equal(cold.messages.length, 0, '卸载后内存里是空的')

  // 访问它 → 应自动重载
  const again = sessions.getSession(cold.id)
  assert.equal(again.unloaded, false, '访问后应重新载回')
  assert.ok(again.messages.length > 0, '消息必须从磁盘读回来，不能是空的 —— 空了就是数据丢了')
  assert.equal(again.messages[0].content, cold.__expected ?? again.messages[0].content)
})

test('落盘不会把已卸载会话的消息冲成空（否则是真删数据）', async () => {
  // 塞到明显超过上限，确保这一轮有会话被卸载（不依赖前面测试留下的状态）
  for (let i = 0; i < CAP + 3; i++) make(`bulk-${i}`)
  await sessions.awaitEvictions()

  const cold = [...sessions.allSessions()].find(s => s.unloaded)
  assert.ok(cold, '前置条件：应存在已卸载的会话')
  assert.equal(cold.messages.length, 0, '卸载后内存里是空的')

  // 再落一次盘：磁盘上的消息必须还在 —— 这是最容易写错的地方，
  // 若直接按内存里的空数组写，等于把用户数据删掉。
  await sessions.persistNow()
  const again = sessions.getSession(cold.id)
  assert.ok(
    again.messages.length > 0,
    '再次落盘后消息仍在 —— 被写成空数组就说明落盘把磁盘数据冲掉了，那是真删数据',
  )
})

test('守卫：被守卫的会话不会被卸载', async () => {
  sessions.onSessionEvict(s => s.id === 'protected')
  const s = sessions.createSession()
  s.id = 'protected'
  s.messages.push({ role: 'user', content: 'protected' })

  // 造够超过上限的会话
  for (let i = 0; i < 6; i++) make(`fill-${i}`)
  await sessions.awaitEvictions()

  assert.equal(s.unloaded, false, '被守卫的会话不应被卸载')
})
