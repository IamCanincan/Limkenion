/**
 * 引擎端到端测试（用桩模型，不需要真实 API key）。
 *
 * 这是唯一能证明「模型 → tool_call → schema → 权限确认 → 执行 → 结果回灌 → 下一轮」
 * 这条链路真的通的测试。之前所有验证都是直接调 executeTool，绕过了整个链路。
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fakeClient, makeWorkspace, startStubModel } from './helpers.mjs'

let ws
let stub
let bus
let engine
let sessions
let interactions
let security

/**
 * 单客户端 + 可换策略。
 *
 * 不能每个用例新建客户端：旧客户端仍留在 bus 里，它注册的自动应答处理器
 * 会抢先 resolve 掉权限请求，导致后一个用例的拒绝策略永远不生效。
 */
let client
let policy = {}

function setupClient(next = {}) {
  policy = next
  client.received.length = 0
  return client
}

before(async () => {
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  // 桩模型地址必须在 import 之前设好（deepseek.mjs 在模块加载时读环境变量）
  stub = await startStubModel([{ text: '默认回复' }])
  process.env.DEEPSEEK_BASE_URL = stub.baseUrl

  bus = await import('../server/bus.mjs')
  // 唯一的假客户端：策略通过闭包读取最新的 policy
  client = fakeClient({
    onPermission: msg => policy.onPermission?.(msg),
    onQuestion: msg => policy.onQuestion?.(msg),
  })
  bus.addClient(client.ws)
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
  interactions = await import('../server/interactions.mjs')
  security = await import('../server/security.mjs')
})

after(async () => {
  await stub?.close()
  await ws?.cleanup()
})

/** 重设桩脚本（端口不变，base URL 仍有效）。 */
function setScript(steps) {
  stub.setScript(steps)
}

describe('完整回合链路', () => {
  test('模型调用 Write → 弹权限 → 允许 → 落盘 → 回灌 → 最终回答', async () => {
    const s = sessions.createSession()
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'allow') })

    setScript([
      { toolCalls: [{ id: 'call_1', name: 'Write', args: { file_path: 'made/by-model.txt', content: 'hello\n' } }] },
      { text: '已经写好文件了。' },
    ])
    process.env.DEEPSEEK_BASE_URL = stub.baseUrl
    // deepseek.mjs 的 base URL 在模块加载时固定，这里改 env 不生效 —— 见下方 baseUrl 说明
    const ds = await import('../server/deepseek.mjs')
    assert.equal(ds.DEEPSEEK_BASE_URL, process.env.DEEPSEEK_BASE_URL, 'base URL 未指向桩模型')

    await engine.runTurn(s, '帮我写个文件', 'msg_1')

    const perms = client.ofType('permission_request')
    assert.equal(perms.length, 1, '应弹一次权限确认')
    assert.equal(perms[0].toolName, 'Write')
    assert.equal(perms[0].input.file_path, 'made/by-model.txt')

    const calls = client.ofType('tool_call')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].toolCall.name, 'Write')

    const results = client.ofType('tool_result')
    assert.equal(results.length, 1)
    assert.equal(results[0].ok, true)
    assert.match(results[0].diff, /\+hello/)

    // 文件真的落盘了，且父目录被自动创建
    assert.equal(await readFile(join(ws.dir, 'made/by-model.txt'), 'utf8'), 'hello\n')

    const done = client.ofType('turn_complete')
    assert.equal(done.length, 1)
    assert.ok(done[0].usage.inputTokens > 0)

    // 助手消息带上了最终文本与工具调用记录
    const last = s.messages.at(-1)
    assert.equal(last.role, 'assistant')
    assert.match(last.text, /已经写好/)
    assert.equal(last.toolCalls.length, 1)
  })

  test('权限被拒 → 工具不执行，拒绝理由回灌', async () => {
    const s = sessions.createSession()
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'deny') })
    setScript([
      { toolCalls: [{ id: 'c1', name: 'Write', args: { file_path: 'denied.txt', content: 'x' } }] },
      { text: '好的，我不写了。' },
    ])

    await engine.runTurn(s, '写文件', 'msg_2')

    const results = client.ofType('tool_result')
    assert.equal(results.length, 1)
    assert.equal(results[0].ok, false)
    assert.match(results[0].result, /用户拒绝/)
    // 文件不应存在
    await assert.rejects(() => readFile(join(ws.dir, 'denied.txt'), 'utf8'))
  })

  test('「本会话总是允许」后同类工具不再弹窗', async () => {
    const s = sessions.createSession()
    let prompts = 0
    setupClient({
      onPermission: msg => {
        prompts++
        interactions.resolvePermission(msg.requestId, 'always')
      },
    })
    setScript([
      { toolCalls: [{ id: 'a', name: 'Write', args: { file_path: 'a1.txt', content: '1' } }] },
      { toolCalls: [{ id: 'b', name: 'Write', args: { file_path: 'a2.txt', content: '2' } }] },
      { text: 'done' },
    ])

    await engine.runTurn(s, '写两个文件', 'msg_3')

    assert.equal(prompts, 1, `只应弹一次，实际 ${prompts} 次`)
    assert.equal(client.ofType('tool_result').length, 2)
    assert.equal(await readFile(join(ws.dir, 'a2.txt'), 'utf8'), '2')
  })
})

describe('计划模式', () => {
  test('危险工具被直接拒绝，且不弹窗', async () => {
    const s = sessions.createSession()
    s.settings = { permissionMode: 'plan' }
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'allow') })
    setScript([
      { toolCalls: [{ id: 'c', name: 'Bash', args: { command: 'echo hi' } }] },
      { text: '计划模式下我不执行命令。' },
    ])

    await engine.runTurn(s, '跑个命令', 'msg_4')

    assert.equal(client.ofType('permission_request').length, 0, '计划模式不应弹窗')
    const results = client.ofType('tool_result')
    assert.equal(results.length, 1)
    assert.equal(results[0].ok, false)
    assert.match(results[0].result, /计划模式/)
  })

  test('只读工具在计划模式下放行', async () => {
    const s = sessions.createSession()
    s.settings = { permissionMode: 'plan' }
    setupClient()
    setScript([
      { toolCalls: [{ id: 'r', name: 'Read', args: { file_path: 'seed.txt' } }] },
      { text: '读到了。' },
    ])

    await engine.runTurn(s, '读一下', 'msg_5')
    const results = client.ofType('tool_result')
    assert.equal(results[0].ok, true)
    assert.match(results[0].result, /seed/)
  })
})

describe('shell 守卫在权限之前生效', () => {
  test('灾难性命令被硬拒绝，且不弹窗（即使已「总是允许」）', async () => {
    const s = sessions.createSession()
    s.allowedTools = new Set(['Bash'])
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'allow') })
    setScript([
      { toolCalls: [{ id: 'd', name: 'Bash', args: { command: 'rm -rf /' } }] },
      { text: '这个我不能执行。' },
    ])

    await engine.runTurn(s, '删库', 'msg_6')

    assert.equal(client.ofType('permission_request').length, 0, '硬拒绝不应走到弹窗')
    const results = client.ofType('tool_result')
    assert.equal(results[0].ok, false)
    assert.match(results[0].result, /已拒绝执行/)
  })

  test('工作区外路径触发升级确认（忽略「总是允许」）', async () => {
    const s = sessions.createSession()
    s.allowedTools = new Set(['Bash'])
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'allow') })
    setScript([
      { toolCalls: [{ id: 'e', name: 'Bash', args: { command: 'type C:\\Windows\\win.ini' } }] },
      { text: '好。' },
    ])

    await engine.runTurn(s, '看下系统文件', 'msg_7')

    const perms = client.ofType('permission_request')
    assert.equal(perms.length, 1, '升级确认必须重新弹窗')
    assert.ok(perms[0].escalate, '应带上升级原因')
    assert.match(perms[0].escalate, /工作区外/)
  })
})

describe('不可信内容触发升级确认', () => {
  test('抓过网页后，危险工具即使已授权也要重新确认', async () => {
    const s = sessions.createSession()
    s.allowedTools = new Set(['Write'])
    security.markUntrusted(s, 'WebFetch https://evil.test')
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'deny') })
    setScript([
      { toolCalls: [{ id: 'f', name: 'Write', args: { file_path: 'injected.txt', content: 'x' } }] },
      { text: '明白。' },
    ])

    await engine.runTurn(s, '按网页说的做', 'msg_8')

    const perms = client.ofType('permission_request')
    assert.equal(perms.length, 1, '接触不可信内容后必须重新确认')
    assert.match(perms[0].escalate, /外部内容/)
    await assert.rejects(() => readFile(join(ws.dir, 'injected.txt'), 'utf8'))
  })
})

describe('中断与定时任务', () => {
  test('cancel 后回合被标记为已取消', async () => {
    const s = sessions.createSession()
    setupClient()
    setScript([{ text: '一段很长的回复' }])

    // 立刻取消
    s.cancelled = true
    await engine.runTurn(s, '说话', 'msg_9')
    assert.ok(client.ofType('turn_cancelled').length >= 1)
  })

  test('/cancel 之后定时任务仍能触发（回归：cancelled 不能被永久卡住）', async () => {
    const s = sessions.createSession()
    setupClient()
    setScript([{ text: '定时触发' }])

    s.cancelled = true // 模拟用户刚中断过回合
    const before = s.messages.length
    engine.scheduleCron(s, { everyMs: 120, prompt: '定时检查' })

    await new Promise(r => setTimeout(r, 500))
    engine.clearCronsForSession(s.id)

    assert.ok(s.messages.length > before, `定时任务被 cancelled 卡住了（消息数仍为 ${s.messages.length}）`)
    assert.ok(s.messages.some(m => m.role === 'user' && String(m.text).includes('定时任务')))
  })

  test('删除会话会清理它的定时器', async () => {
    const s = sessions.createSession()
    setupClient()
    engine.scheduleCron(s, { everyMs: 100_000, prompt: 'x' })
    assert.ok(engine.cronCount() >= 1)
    const cleared = engine.clearCronsForSession(s.id)
    assert.equal(cleared, 1)
  })
})

describe('子代理', () => {
  test('Agent 工具把内部调用标记为 Agent·<工具>', async () => {
    const s = sessions.createSession()
    setupClient()
    setScript([
      // 主代理先派子代理
      { toolCalls: [{ id: 'ag', name: 'Agent', args: { description: '看看种子文件', prompt: '读 seed.txt' } }] },
      // 子代理循环：读文件
      { toolCalls: [{ id: 'sr', name: 'Read', args: { file_path: 'seed.txt' } }] },
      // 子代理给结论
      { text: '文件内容是 seed。' },
      // 主代理收尾
      { text: '子代理说文件是 seed。' },
    ])

    await engine.runTurn(s, '派个子代理看看', 'msg_10')

    const names = client.ofType('tool_call').map(c => c.toolCall.name)
    assert.ok(names.includes('Agent'), `缺少 Agent 调用：${names}`)
    assert.ok(names.some(n => n.startsWith('Agent·')), `子代理内部调用未冒泡：${names}`)
  })
})
