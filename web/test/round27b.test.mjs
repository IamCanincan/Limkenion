import { test, describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let configDir
let ws
let stub
let interactions
let engine
let sessions

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-r27b-cfg-'))
  ws = await mkdtemp(join(tmpdir(), 'lk-r27b-ws-'))
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws
  process.env.LIMKENION_WEB_STATE_DIR = join(ws, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  process.env.LIMKENION_WEB_COMPUTER_USE = '1'
  const bus = await import('../server/bus.mjs')
  const { fakeClient, startStubModel } = await import('./helpers.mjs')
  interactions = await import('../server/interactions.mjs')
  bus.addClient(fakeClient({
    // Computer* 是危险工具：自动放行，让截屏闭环跑通
    onPermission: msg => {
      interactions.resolvePermission(msg.requestId, 'allow')
      return []
    },
  }).ws)
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
  stub = await startStubModel([
    { toolCalls: [{ id: 'shot', name: 'ComputerScreenshot', arguments: '{}' }] },
    { text: '我看到了屏幕' },
  ])
  process.env.DEEPSEEK_BASE_URL = stub.baseUrl
})

after(async () => {
  stub?.close?.()
  delete process.env.LIMKENION_WEB_COMPUTER_USE
  await rm(ws, { recursive: true, force: true }).catch(() => {})
  await rm(configDir, { recursive: true, force: true }).catch(() => {})
})

describe('ComputerScreenshot 闭环（引擎 → 截屏 → 图片注入下一轮请求）', () => {
  it('模型调截屏后，下一轮请求里带 image_url 的 user 消息', async () => {
    if (process.platform !== 'win32') return
    const s = sessions.createSession()
    await engine.runTurn(s, '看看我的屏幕', 'm1')
    const last = stub.requests.at(-1)
        assert.ok(last, '应有第二次模型请求：' + JSON.stringify(stub.requests.map(r => r.messages?.map(m => m.role))))
    const imgMsg = last.messages.find(
      m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'),
    )
    assert.ok(imgMsg, '应注入带 image_url 的 user 消息')
    const part = imgMsg.content.find(p => p.type === 'image_url')
    assert.match(part.image_url.url, /^data:image\/png;base64,/)
    // tool 角色的文本消息也在
    assert.ok(last.messages.some(m => m.role === 'tool' && /图片见下一条/.test(m.content)), 'tool 消息应说明图片在后面')
    // 会话里助手拿到了视觉结论
    assert.ok(s.messages.some(m => m.role === 'assistant' && m.text === '我看到了屏幕'))
  })
})
