/**
 * 第 28 轮：Agent Teams 工作台测试。
 * - SendMessage（回合内派活）：事件带成员标记广播、完成后回 idle
 * - runTeamMemberTurn（工作台直接派活）：独立回合 + team 快照广播 + 事件流
 * - 边界：未知成员 / 忙碌成员
 */

import { test, describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let configDir
let ws
let stub
let engine
let sessions
let tools
let interactions
let client
let bus

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-team-cfg-'))
  ws = await mkdtemp(join(tmpdir(), 'lk-team-ws-'))
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws
  process.env.LIMKENION_WEB_STATE_DIR = join(ws, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  const { fakeClient, startStubModel } = await import('./helpers.mjs')
  stub = await startStubModel([{ text: '成员回复：搞定' }])
  process.env.DEEPSEEK_BASE_URL = stub.baseUrl
  bus = await import('../server/bus.mjs')
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
  tools = await import('../server/tools.mjs')
  client = fakeClient({})
  bus.addClient(client.ws)
})

after(async () => {
  stub?.close?.()
  await rm(ws, { recursive: true, force: true }).catch(() => {})
  await rm(configDir, { recursive: true, force: true }).catch(() => {})
})

const mkSession = () => {
  const s = sessions.createSession()
  s.team = { name: 'review', members: [{ name: 'a', role: 'agent', status: 'idle' }, { name: 'b', role: 'agent', status: 'idle' }], log: [] }
  return s
}

describe('SendMessage（回合内派活）', () => {
  it('事件带成员标记广播，完成后成员回 idle', async () => {
    const s = mkSession()
    let tagSeen = null
    const ctx = {
      session: s,
      emit: ev => {
        if (ev.type === 'team_event') tagSeen = ev.member
      },
      runSubAgent: async ({ tag }) => {
        assert.equal(tag, 'a', 'tag 应传成员名')
        return '结论 OK'
      },
    }
    const out = await tools.executeTool('SendMessage', { to: 'a', message: '帮我审' }, ctx)
    assert.match(String(out), /已完成/)
    assert.equal(tagSeen, 'a', '子代理事件应带成员标记广播')
    assert.equal(s.team.members[0].status, 'idle')
  })

  it('未知成员 → 明确报错，不派活', async () => {
    const s = mkSession()
    const out = await tools.executeTool('SendMessage', { to: 'zzz', message: 'hi' }, { session: s })
    assert.match(String(out), /不在团队中/)
  })
})

describe('runTeamMemberTurn（工作台直接派活）', () => {
  it('独立回合：成员 busy → idle，team 快照广播，事件流按成员标记', async () => {
    client.received.length = 0
    const s = mkSession()
    const r = await engine.runTeamMemberTurn(s, 'b', '去检查一下 seed.txt')
    assert.equal(r.ok, true, `应成功：${JSON.stringify(r)}`)
    assert.match(String(r.result), /成员回复：搞定/)
    assert.equal(s.team.members[1].status, 'idle')
    const teamMsgs = client.ofType('team')
    assert.ok(teamMsgs.length >= 2, `应广播 busy 与 idle 两次快照：${teamMsgs.length}`)
    const last = teamMsgs.at(-1)
    assert.equal(last.team.members[1].status, 'idle')
    const events = client.ofType('team_event').filter(m => m.member === 'b')
    assert.ok(events.length > 0, '成员 b 的事件应按成员标记广播')
  })

  it('未知成员 / 忙碌成员 → 明确错误', async () => {
    const s = mkSession()
    const r1 = await engine.runTeamMemberTurn(s, 'nobody', 'hi')
    assert.equal(r1.ok, false)
    assert.match(r1.error, /不在团队中/)
    s.team.members[0].status = 'busy'
    const r2 = await engine.runTeamMemberTurn(s, 'a', 'hi')
    assert.equal(r2.ok, false)
    assert.match(r2.error, /正在工作中/)
  })
})
