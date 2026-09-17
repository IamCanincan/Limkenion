/**
 * 请求追踪的端到端验证：跑一个真实回合，确认请求日志里出现了正确的记录。
 *
 * 用桩模型（不起真实网络），所以不需要 API key。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { makeWorkspace, startStubModel, fakeClient } from './helpers.mjs'

let ws
let stub
let engine
let sessions
let requestLog
let bus
let client

before(async () => {
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  stub = await startStubModel([{ text: '默认回复' }])
  process.env.DEEPSEEK_BASE_URL = stub.baseUrl

  bus = await import('../server/bus.mjs')
  client = fakeClient({})
  bus.addClient(client.ws)
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
  requestLog = await import('../server/requestLog.mjs')
})

after(async () => {
  await stub?.close()
  await ws?.cleanup()
})

describe('请求追踪', () => {
  test('成功回合会留下一条记录（含耗时、token、模型名）', async () => {
    requestLog.clearRequests()
    const s = sessions.createSession()
    stub.setScript([{ text: '好的' }])

    await engine.runTurn(s, '说点什么', 'msg_req_1')

    const list = requestLog.listRequests()
    assert.equal(list.length, 1, '应记录一次模型请求')

    const e = list[0]
    assert.equal(e.ok, true, '这次请求应标记为成功')
    assert.ok(
      ['deepseek-flash', 'deepseek-v4-pro'].includes(e.model),
      `模型名应是 CLI 端也有的那两个之一，实际 ${JSON.stringify(e.model)}`,
    )
    assert.ok(typeof e.durationMs === 'number' && e.durationMs >= 0, '耗时应是数字')
    assert.ok(e.inputTokens > 0, '应记录输入 token')
    assert.ok(e.outputTokens > 0, '应记录输出 token')
    assert.equal(e.sessionId, s.id, '应关联到会话')
    assert.equal(e.error, null, '成功时不应有错误信息')
  })

  test('多轮工具调用会产生多条记录', async () => {
    requestLog.clearRequests()
    const s = sessions.createSession()
    // 第一轮要工具、第二轮给最终答复 → 两次模型调用
    stub.setScript([
      { toolCalls: [{ id: 'c1', name: 'Read', args: { file_path: 'seed.txt' } }] },
      { text: '读完了' },
    ])

    await engine.runTurn(s, '读一下 seed.txt', 'msg_req_2')

    const list = requestLog.listRequests()
    assert.ok(list.length >= 2, `应至少记录 2 次模型请求，实际 ${list.length}`)
    assert.ok(list.every(e => e.ok), '都应成功')
  })

  test('失败的请求也会被记录（带错误码）', async () => {
    requestLog.clearRequests()
    const s = sessions.createSession()
    // 桩模型返回 500 → 触发 HTTP_500 错误
    stub.setScript([{ status: 500, error: '服务端炸了' }])

    // 注意：runTurn 不会把错误抛出去 —— 它把错误作为消息推给用户（见 engine.mjs 的外层 catch）。
    // 这里验证的是"失败被记录了"，而不是"失败被抛出了"。
    await engine.runTurn(s, '触发一次失败', 'msg_req_3')

    const list = requestLog.listRequests()
    assert.ok(list.length >= 1, '失败的请求也应留下记录')
    const e = list.find(x => !x.ok)
    assert.ok(e, '应有一条失败记录')
    assert.ok(e.code, `失败记录应带错误码，实际 ${JSON.stringify(e.code)}`)
    assert.ok(e.error, '失败记录应带错误信息')
    assert.equal(e.inputTokens, 0, '失败时没有 token 用量')

    // 用户应该能看到失败提示（引擎把它作为 delta 推出去）
    const deltas = client.ofType('assistant_delta')
    assert.ok(
      deltas.some(d => String(d.delta).includes('失败')),
      '应向用户提示失败',
    )
  })

  test('环形缓冲：条数不会超过上限', async () => {
    requestLog.clearRequests()
    // 直接灌 600 条（超过 MAX_ENTRIES=500）
    for (let i = 0; i < 600; i++) {
      requestLog.recordRequest({ durationMs: i, model: 'deepseek-flash', ok: true })
    }
    const list = requestLog.listRequests(1000)
    assert.equal(list.length, 500, '应只保留最近 500 条')
    // 新的在前
    assert.ok(list[0].durationMs > list[list.length - 1].durationMs, '应是新的在前')
  })

  test('汇总统计正确', async () => {
    requestLog.clearRequests()
    requestLog.recordRequest({ durationMs: 100, model: 'a', ok: true, inputTokens: 10, outputTokens: 5 })
    requestLog.recordRequest({ durationMs: 300, model: 'a', ok: false, code: 'HTTP_500' })
    const s = requestLog.requestSummary()
    assert.equal(s.count, 2)
    assert.equal(s.ok, 1)
    assert.equal(s.failed, 1)
    assert.equal(s.avgMs, 200)
    assert.equal(s.maxMs, 300)
    assert.equal(s.inputTokens, 10)
    assert.equal(s.outputTokens, 5)
  })
})
