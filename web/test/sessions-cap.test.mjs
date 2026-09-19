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
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ---- 边界：配置值本身可能把功能搞坏 ----

test('上限配成负数：不能退化成"把所有会话都卸掉"', async () => {
  // 上限在模块加载时读取，改不了已加载模块里的常量 —— 用子进程验证
  const SESSIONS_URL = new URL('../server/sessions.mjs', import.meta.url).href
  const STATE = join(dir, 'neg-state')
  const script = [
    "process.env.LIMKENION_WEB_MAX_MEMORY_SESSIONS = '-5'",
    `process.env.LIMKENION_WEB_STATE_DIR = ${JSON.stringify(STATE)}`,
    "process.env.DEEPSEEK_API_KEY = 'test-key'",
    `const s = await import(${JSON.stringify(SESSIONS_URL)})`,
    'for (let i = 0; i < 6; i++) s.createSession()',
    'await s.awaitEvictions()',
    'console.log(JSON.stringify({ unloaded: [...s.allSessions()].filter(x => x.unloaded).length, total: s.sessionCount() }))',
    // 必须显式退出：sessions.mjs 里有 schedulePersist 的定时器，
    // 事件循环不空 → 子进程不退出 → spawnSync 会一直等（曾把整套测试挂死 5 分钟）。
    'process.exit(0)',
  ].join('\n')

  const cp = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(cp.status, 0, `子进程失败：${cp.stderr}`)
  const r = JSON.parse(cp.stdout.trim().split('\n').pop())
  // 上限被夹到 1 → 6 个里最多卸 5 个，绝不能是"全卸"（那才是退化）
  assert.ok(r.unloaded < r.total, `不能把所有会话都卸掉（卸了 ${r.unloaded}/${r.total}）`)
})

test('只卸载"确实会落盘"的会话（卸到没落盘的 = 真删数据）', async () => {
  // 用**子进程**跑：这条断言对"当前总会话数"很敏感（状态文件只保留最近 50 条），
  // 而前面的用例已经攒了一堆会话；子进程里是干净状态，结果才确定。
  const SESSIONS_URL = new URL('../server/sessions.mjs', import.meta.url).href
  const STATE = join(dir, 'persist-guard-state')
  const script = [
    "process.env.LIMKENION_WEB_MAX_MEMORY_SESSIONS = '3'",
    `process.env.LIMKENION_WEB_STATE_DIR = ${JSON.stringify(STATE)}`,
    "process.env.DEEPSEEK_API_KEY = 'test-key'",
    `const s = await import(${JSON.stringify(SESSIONS_URL)})`,
    'for (let i = 0; i < 20; i++) {',
    '  const x = s.createSession()',
    "  x.messages.push({ role: 'user', content: 'm' + i })",
    '  x.updatedAt = Date.now()',
    '}',
    'await s.persistNow()',
    'await s.awaitEvictions()',
    'const cold = [...s.allSessions()].filter(x => x.unloaded)',
    'const lost = cold.filter(c => s.getSession(c.id).messages.length === 0)',
    'console.log(JSON.stringify({ total: s.sessionCount(), unloaded: cold.length, lost: lost.length }))',
    'process.exit(0)',
  ].join('\n')

  const cp = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(cp.status, 0, `子进程失败：${cp.stderr}`)
  const r = JSON.parse(cp.stdout.trim().split('\n').pop())
  assert.ok(r.unloaded > 0, '前置条件：应有会话被卸载')
  assert.equal(
    r.lost,
    0,
    `有 ${r.lost} 个会话卸载后消息读不回来 —— 说明卸到了没落盘的会话，那是真删数据`,
  )
})

test('不在持久化窗口内的会话：必须拒绝卸载（卸了就是删）', async () => {
  // 这条才真正测到"落盘后再确认"那道保险：
  // 造 60 个会话（> MAX_PERSISTED_SESSIONS=50），最旧的一批**不在状态文件里**
  // （persistNow 只写最近 50 条）。对它们，功能必须**拒绝卸载** ——
  // 它们只能留在内存里；谁要是不管不顾地把它们卸了，消息就永远没了。
  const SESSIONS_URL = new URL('../server/sessions.mjs', import.meta.url).href
  const STATE = join(dir, 'outside-window-state')
  const script = [
    "process.env.LIMKENION_WEB_MAX_MEMORY_SESSIONS = '3'",
    `process.env.LIMKENION_WEB_STATE_DIR = ${JSON.stringify(STATE)}`,
    "process.env.DEEPSEEK_API_KEY = 'test-key'",
    `const s = await import(${JSON.stringify(SESSIONS_URL)})`,
    'for (let i = 0; i < 60; i++) {',
    '  const x = s.createSession()',
    "  x.messages.push({ role: 'user', content: 'm' + i })",
    '  x.updatedAt = Date.now()',
    '}',
    'await s.persistNow()',
    'await s.awaitEvictions()',
    'const fs = await import("node:fs")',
    'const inFile = new Set(JSON.parse(fs.readFileSync(s.STATE_FILE, "utf8")).sessions.map(x => x.id))',
    'const all = [...s.allSessions()]',
    'const outside = all.filter(x => !inFile.has(x.id))',
    'const unsafe = outside.filter(x => x.unloaded)',
    'console.log(JSON.stringify({ total: all.length, inFile: inFile.size, outside: outside.length, unsafe: unsafe.length }))',
    'process.exit(0)',
  ].join('\n')

  const cp = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(cp.status, 0, `子进程失败：${cp.stderr}`)
  const r = JSON.parse(cp.stdout.trim().split('\n').pop())
  assert.ok(r.outside > 0, '前置条件：应有会话落在持久化窗口之外（否则这条没测到东西）')
  assert.equal(
    r.unsafe,
    0,
    `有 ${r.unsafe} 个会话既不在状态文件里、又被卸载了 —— 那些消息永远找不回来，等于删除`,
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
