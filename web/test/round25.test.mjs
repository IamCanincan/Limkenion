/**
 * 第 25 轮：排队消息 / microcompact / 钩子 prompt+agent+http / shell 网络开关。
 */

import { test, describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

let configDir
let ws
let stub
let engine
let sessions
let tools
let hooks
let interactions

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-r25-cfg-'))
  ws = await mkdtemp(join(tmpdir(), 'lk-r25-ws-'))
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws
  process.env.LIMKENION_WEB_STATE_DIR = join(ws, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  // microcompact 阈值调低，测试里 lastInputTokens 才够得着
  process.env.LIMKENION_AUTO_COMPACT_INPUT_TOKENS = '1000'

  const bus = await import('../server/bus.mjs')
  const { fakeClient } = await import('./helpers.mjs')
  bus.addClient(fakeClient({}).ws)
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
  interactions = await import('../server/interactions.mjs')
  hooks = await import('../server/hooks.mjs')
  tools = await import('../server/tools.mjs')
  const { startStubModel } = await import('./helpers.mjs')
  stub = await startStubModel([{ text: '回复A' }, { text: '回复B' }])
  process.env.DEEPSEEK_BASE_URL = stub.baseUrl
})

after(async () => {
  stub?.close?.()
  await rm(ws, { recursive: true, force: true }).catch(() => {})
  await rm(configDir, { recursive: true, force: true }).catch(() => {})
})

describe('排队消息', () => {
  it('回合结束后自动处理队列里的消息', async () => {
    const s = sessions.createSession()
    // 第一回合正常跑
    await engine.runTurn(s, '第一句', 'm1')
    const afterFirst = s.messages.length
    // 模拟 protocol 的排队行为：用户消息已入库 + 进队列
    s.messages.push({ id: 'u2', role: 'user', text: '第二句（排队）', timestamp: Date.now() })
    s.messageQueue = [{ text: '第二句（排队）', at: Date.now() }]
    await engine.runTurn(s, '当前回合', 'm2')
    // 队列被消费：排队的消息也拿到了自己的回合
    assert.ok(s.messages.length >= afterFirst + 2, `排队消息应产出回复：${s.messages.length} vs ${afterFirst}`)
    assert.equal(s.messageQueue.length, 0)
    const texts = s.messages.map(m => m.text ?? '')
    assert.ok(texts.some(t => t === '第二句（排队）'), '排队的用户消息应在历史里')
    assert.ok(s.messages.slice(afterFirst).some(m => m.role === 'assistant'), '排队消息应得到自己的回复')
  })
})

describe('microcompact', () => {
  it('超阈值时清旧工具结果、保留最近 4 条', () => {
    const messages = [{ role: 'system', content: 'sys' }]
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'tool', tool_call_id: 't' + i, content: 'x'.repeat(500) })
    }
    const cleared = engine.microcompactToolResults(messages, 5000, { keep: 4 })
    assert.equal(cleared, 6, `应清掉 6 条旧工具结果：${cleared}`)
    const toolMsgs = messages.filter(m => m.role === 'tool')
    assert.equal(toolMsgs.filter(m => m.content.startsWith('[microcompact]')).length, 6)
    assert.equal(toolMsgs.slice(-4).every(m => m.content === 'x'.repeat(500)), true, '最近 4 条应保留')
    // 幂等：再跑一遍不再清
    assert.equal(engine.microcompactToolResults(messages, 5000), 0)
  })
  it('低于阈值不动', () => {
    const messages = [{ role: 'tool', tool_call_id: 't', content: 'data' }]
    assert.equal(engine.microcompactToolResults(messages, 10), 0)
    assert.equal(messages[0].content, 'data')
  })
})

describe('钩子 prompt / agent / http 类型', () => {
  it('prompt 类型：模型判定 deny → 拦下', async () => {
    // 独立桩：返回 deny JSON
    const judge = createServer((req, res) => {
      let body = ''
      req.on('data', d => (body += d))
      req.on('end', () => {
        // chatCompletion 只解析 SSE 流 —— 桩按流格式回一条带 JSON 判定的 delta
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const content = JSON.stringify({ decision: 'deny', reason: '测试拒绝' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
      })
    })
    await new Promise(r => judge.listen(0, '127.0.0.1', r))
    const prevUrl = process.env.DEEPSEEK_BASE_URL
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${judge.address().port}`
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: '一律拒绝（测试）' }] }] } }),
      'utf8',
    )
    hooks.refreshHooks()
    const acc = await hooks.runEventHooks('turn-end', { hookInput: { session_id: 'x' } })
    assert.equal(acc.decision, 'deny', `prompt 钩子应能 deny：${JSON.stringify(acc)}`)
    assert.match(acc.reason ?? '', /测试拒绝/)
    process.env.DEEPSEEK_BASE_URL = prevUrl
    judge.close()
  })

  it('http 类型：本机 webhook 回 allow → 生效；私网地址被拒', async () => {
    const hookSrv = createServer((req, res) => {
      let body = ''
      req.on('data', d => (body += d))
      req.on('end', () => {
        // 回显请求里的事件名 —— mergeResult 会校验 hookEventName 一致
        let evt = 'turn-end'
        try { evt = JSON.parse(body).hook_event_name ?? evt } catch {}
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: evt, permissionDecision: 'allow' } }))
      })
    })
    await new Promise(r => hookSrv.listen(0, '127.0.0.1', r))
    const port = hookSrv.address().port
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/hook` }] }],
          ToolBefore: [{ matcher: 'Read', hooks: [{ type: 'http', url: 'http://10.0.0.1/hook' }] }],
        },
      }),
      'utf8',
    )
    hooks.refreshHooks()
    const acc = await hooks.runEventHooks('turn-end', { hookInput: { session_id: 'x' } })
    assert.equal(acc.decision, 'allow', `http 钩子应生效：${JSON.stringify(acc)}`)
    // 私网：应被 SSRF 防护拒绝（不抛异常、不生效）
    const acc2 = await hooks.runEventHooks('tool-before', { toolName: 'Read', hookInput: { session_id: 'x' } })
    assert.equal(acc2.decision, null, '私网 http 钩子不应生效')
    hookSrv.close()
  })
})

describe('shell 网络开关', () => {
  it('LIMKENION_WEB_SHELL_NET=off → 子进程拿到死代理', async () => {
    process.env.LIMKENION_WEB_SHELL_NET = 'off'
    try {
      const s = sessions.createSession()
      const out = await tools.executeTool('Bash', { command: 'echo %HTTP_PROXY%' }, { session: s })
      assert.match(String(out), /127\.0\.0\.1:9/, `应注入死代理：${out}`)
    } finally {
      delete process.env.LIMKENION_WEB_SHELL_NET
    }
  })
})
