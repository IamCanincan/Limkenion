/**
 * 压缩 / 检查点测试（桩模型，不需要真实 API key）。
 *
 * 覆盖 2026-09-18 补齐的三块能力：
 * 1. 真 /compact —— 摘要替换历史（之前是直接清空，模型彻底失忆）
 * 2. auto-compact —— 上下文逼近上限时自动触发
 * 3. 文件检查点 —— /rewind 连 Write/Edit 的文件改动一起回滚
 */

import { test, describe, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClient, makeWorkspace, startStubModel } from './helpers.mjs'

let ws
let configDir
let stub
let bus
let engine
let sessions
let commands
let hooks
let tools

let client

before(async () => {
  ws = await makeWorkspace({ 'seed.txt': 'seed\n', 'c.txt': 'v1\n' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  configDir = join(ws.dir, '.config')
  await mkdir(configDir, { recursive: true })
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.DEEPSEEK_API_KEY = 'test-key'
  stub = await startStubModel([{ text: '默认回复' }])
  process.env.DEEPSEEK_BASE_URL = stub.baseUrl

  bus = await import('../server/bus.mjs')
  client = fakeClient({})
  bus.addClient(client.ws)
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
  commands = await import('../server/commands.mjs')
  hooks = await import('../server/hooks.mjs')
  tools = await import('../server/tools.mjs')
})

after(async () => {
  await stub?.close()
  await ws?.cleanup()
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

afterEach(async () => {
  // 排空在途回合（桩模型脚本游标是共享的，见 MEMORY 陷阱 7）
  for (let i = 0; i < 50 && engine.isTurnActive('*') === undefined; i++) {
    // isTurnActive 对不存在的 id 返回 undefined —— 这里只为让事件循环转起来
    break
  }
  await sleep(20)
})

async function setHooks(hooksConfig) {
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({ hooks: hooksConfig }, null, 1), 'utf8')
  hooks.refreshHooks()
}

async function runCommand(session, text) {
  const registry = await commands.loadCommandRegistry()
  const [name, ...rest] = text.replace(/^\//, '').split(/\s+/)
  return commands.runCommand(session, name, rest.join(' '), {}, registry)
}

describe('真 /compact（摘要替换历史）', () => {
  test('压缩后只剩一条摘要消息，包含桩模型的摘要文本', async () => {
    setScript([{ text: '这是一份对话摘要' }])
    const s = sessions.createSession()
    s.messages = [
      { id: 'm1', role: 'user', text: '帮我做登录页', timestamp: Date.now() },
      { id: 'm2', role: 'assistant', text: '已完成登录页 v1', timestamp: Date.now() },
    ]
    const out = await runCommand(s, '/compact')
    assert.ok(out.includes('已压缩：'), `应报告压缩成功：${out}`)
    assert.equal(s.messages.length, 1, '历史应被替换为一条摘要消息')
    assert.ok(s.messages[0].text.includes('这是一份对话摘要'), '摘要应来自模型输出')
    assert.ok(s.compactedAt > 0, '应记录压缩时间')
  })

  test('空会话 /compact → 明确说明未压缩', async () => {
    const s = sessions.createSession()
    const out = await runCommand(s, '/compact')
    assert.ok(out.includes('未压缩'), `应说明未压缩：${out}`)
  })

  test('压缩前后钩子都会触发（context-compact-before / after）', async () => {
    const marker = join(ws.dir, 'hook-marker.txt')
    process.env.HOOK_MARKER_FILE = marker
    const mark = join(ws.dir, 'hookmark.mjs')
    await writeFile(
      mark,
      "import { appendFileSync } from 'node:fs'\n" +
        "appendFileSync(process.env.HOOK_MARKER_FILE, process.argv[2] + '\\n')\n",
      'utf8',
    )
    const cmd = mode => `"${process.execPath}" "${mark}" ${mode}`
    await setHooks({
      'context-compact-before': [{ hooks: [{ type: 'command', command: cmd('before') }] }],
      'context-compact-after': [{ hooks: [{ type: 'command', command: cmd('after') }] }],
    })
    try {
      setScript([{ text: '摘要' }])
      const s = sessions.createSession()
      s.messages = [{ id: 'm1', role: 'user', text: 'x', timestamp: Date.now() }]
      await runCommand(s, '/compact')
      await sleep(200) // 钩子是异步 shell
      const fired = existsSync(marker) ? await readFile(marker, 'utf8') : ''
      assert.ok(fired.includes('before'), `before 钩子应触发：${JSON.stringify(fired)}`)
      assert.ok(fired.includes('after'), `after 钩子应触发：${JSON.stringify(fired)}`)
    } finally {
      await setHooks({})
    }
  })
})

describe('auto-compact（上下文逼近上限自动压缩）', () => {
  test('最后一轮输入 tokens 超阈值 → 回合结束后自动压缩', async () => {
    process.env.LIMKENION_AUTO_COMPACT_INPUT_TOKENS = '5' // 桩每轮报 11 → 必然触发
    try {
      setScript([{ text: '回答' }, { text: '这是自动压缩生成的摘要' }])
      const s = sessions.createSession()
      // 触发条件之一：历史消息 > 10 条
      s.messages = Array.from({ length: 12 }, (_, i) => ({
        id: `m${i}`, role: 'user', text: `历史 ${i}`, timestamp: Date.now(),
      }))
      await engine.runTurn(s, '继续', 'msg_ac')
      // 桩脚本游标：第 1 步给回合本身，第 2 步给压缩请求
      assert.equal(s.messages.length, 1, `应只剩一条摘要消息，实际 ${s.messages.length}`)
      assert.ok(s.messages[0].text.includes('自动压缩'), '摘要消息应带自动压缩标记')
    } finally {
      delete process.env.LIMKENION_AUTO_COMPACT_INPUT_TOKENS
    }
  })

  test('低于阈值 → 不压缩', async () => {
    process.env.LIMKENION_AUTO_COMPACT_INPUT_TOKENS = '999999'
    try {
      setScript([{ text: '普通回答' }])
      const s = sessions.createSession()
      s.messages = Array.from({ length: 12 }, (_, i) => ({
        id: `m${i}`, role: 'user', text: `历史 ${i}`, timestamp: Date.now(),
      }))
      await engine.runTurn(s, '继续', 'msg_no_ac')
      assert.equal(s.messages.length, 13, '12 条历史 + 1 条本轮回复，不应被压缩')
    } finally {
      delete process.env.LIMKENION_AUTO_COMPACT_INPUT_TOKENS
    }
  })
})

describe('文件检查点（/rewind 连文件一起回滚）', () => {
  test('Write 已存在文件 → rewind 后恢复旧内容', async () => {
    const s = sessions.createSession()
    s.messages = [{ id: 'm0', role: 'user', text: 'seed', timestamp: Date.now() }]
    await tools.executeTool('Write', { file_path: 'c.txt', content: 'v2\n' }, { session: s })
    assert.equal(await readFile(join(ws.dir, 'c.txt'), 'utf8'), 'v2\n', 'Write 应生效')
    // 此时 messages 有 2 条（seed + Write 的 assistant 桩？没有回合 → 只有原 1 条 + 0）
    const out = await runCommand(s, '/rewind 0')
    assert.ok(out.includes('回滚了 1 个文件'), `应报告文件回滚：${out}`)
    assert.equal(await readFile(join(ws.dir, 'c.txt'), 'utf8'), 'v1\n', '文件应恢复为 v1')
  })

  test('Write 新建文件 → rewind 后文件被删除', async () => {
    const s = sessions.createSession()
    s.messages = []
    await tools.executeTool('Write', { file_path: 'fresh.txt', content: 'new' }, { session: s })
    assert.ok(existsSync(join(ws.dir, 'fresh.txt')), '新文件应存在')
    await runCommand(s, '/rewind 0')
    assert.ok(!existsSync(join(ws.dir, 'fresh.txt')), '新建文件应被回滚删除')
  })

  test('Edit 前也会快照', async () => {
    const s = sessions.createSession()
    s.messages = [{ id: 'm0', role: 'user', text: 'x', timestamp: Date.now() }]
    await tools.executeTool('Edit', { file_path: 'c.txt', old_string: 'v1', new_string: 'v3' }, { session: s })
    assert.equal(await readFile(join(ws.dir, 'c.txt'), 'utf8'), 'v3\n')
    await runCommand(s, '/rewind 0')
    assert.equal(await readFile(join(ws.dir, 'c.txt'), 'utf8'), 'v1\n', 'Edit 改动应被回滚')
  })
})

function setScript(steps) {
  stub.setScript(steps)
}
