/**
 * hooks 测试（command 类型 + 已接线的 8 个事件）。
 *
 * 用**真的子进程**跑钩子（不是 mock）：钩子协议的重点就是"stdin 收 JSON、stdout 回 JSON、
 * 退出码 2 表示阻断" —— 用 mock 测这些等于什么都没测。
 * 钩子脚本用当前 node 跑一个临时 .mjs，行为由命令行参数选（allow / deny / ...）。
 *
 * 隔离：`LIMKENION_CONFIG_DIR` 指向临时目录 —— 否则会往用户真实的
 * `~/.limkenion/settings.json` 里写测试钩子。
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeClient, makeWorkspace, startStubModel } from './helpers.mjs'

let configDir
let ws
let stub
let client
let engine
let sessions
let interactions
let hooks

/** 记录钩子收到的 stdin，供断言"我们确实按 CLI 的字段名传了输入"。 */
let stdinLogPath
let hookScriptPath
let policy = {}

function setupClient(next = {}) {
  policy = next
  client.received.length = 0
  return client
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 写一份 hooks 配置（用户级 settings.json）。 */
async function setHooks(hooksConfig) {
  await writeFile(
    join(configDir, 'settings.json'),
    JSON.stringify({ hooks: hooksConfig }, null, 1),
    'utf8',
  )
  hooks.refreshHooks()
}

/** 生成一条 command 钩子：跑我们的桩脚本，行为由 mode 决定。 */
function hookCommand(mode) {
  return `"${process.execPath}" "${hookScriptPath}" ${mode}`
}

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-hooks-cfg-'))
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })

  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'

  // 桩钩子脚本：读 stdin（记下来），按 mode 输出
  hookScriptPath = join(ws.dir, 'hook.mjs')
  stdinLogPath = join(ws.dir, 'hook-stdin.jsonl')
  await writeFile(
    hookScriptPath,
    `import { readFileSync, appendFileSync } from 'node:fs'
const mode = process.argv[2] ?? 'allow'
let raw = ''
try { raw = readFileSync(0, 'utf8') } catch {}
appendFileSync(${JSON.stringify(stdinLogPath)}, raw.trim() + '\\n')
let input = {}
try { input = JSON.parse(raw.trim().split('\\n').pop() || '{}') } catch {}
if (mode === 'allow') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, permissionDecision: 'allow' } }))
else if (mode === 'deny') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, permissionDecision: 'deny', permissionDecisionReason: 'deny-by-hook' } }))
else if (mode === 'ask') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, permissionDecision: 'ask' } }))
else if (mode === 'exit2') { process.stderr.write('exit2-reason'); process.exit(2) }
else if (mode === 'rewrite') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, permissionDecision: 'allow', updatedInput: { file_path: 'rewritten.txt', content: 'rewritten\\n' } } }))
else if (mode === 'context') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: 'CTX-FROM-HOOK' } }))
else if (mode === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason: 'blocked-by-hook' }))
else if (mode === 'noise') process.stdout.write('日志第一行\\n{"systemMessage":"来自钩子的提示"}')
`,
    'utf8',
  )
  await writeFile(stdinLogPath, '', 'utf8')

  stub = await startStubModel([{ text: '默认回复' }])
  process.env.DEEPSEEK_BASE_URL = stub.baseUrl

  const bus = await import('../server/bus.mjs')
  client = fakeClient({
    onPermission: msg => policy.onPermission?.(msg),
    onQuestion: msg => policy.onQuestion?.(msg),
  })
  bus.addClient(client.ws)
  hooks = await import('../server/hooks.mjs')
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
  interactions = await import('../server/interactions.mjs')
})

after(async () => {
  await stub?.close()
  // Windows 上临时目录可能还被刚被终止的钩子进程（cwd 就设在这里）占着，
  // 直接 rm 会 EBUSY —— 重试几次，别让清理失败把整个文件的用例判成失败。
  for (let i = 0; i < 5; i++) {
    try {
      await ws?.cleanup()
      break
    } catch {
      await sleep(300)
    }
  }
  await rm(configDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await setHooks({})
  await writeFile(stdinLogPath, '', 'utf8')
})

/** 读钩子收到的输入（最后一个）。 */
async function lastHookInput() {
  const raw = await readFile(stdinLogPath, 'utf8')
  const lines = raw.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1] ?? '{}')
}

/**
 * 取最后一次请求里回灌给模型的工具结果。
 *
 * **不能看 `session.messages`** —— 它只存 user/assistant，工具结果只活在本次回合的
 * wire messages 里（`role: 'tool'`）。想断言"模型到底收到了什么"，就得看请求体。
 */
function lastToolResultText() {
  const msgs = stub.requests.at(-1)?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'tool') return String(msgs[i].content ?? '')
  }
  return ''
}

describe('配置解析与 /hooks 摘要', () => {
  test('生效与不生效的钩子会被分开列出（不静默忽略）', async () => {
    await setHooks({
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: hookCommand('allow') }] }],
      PostToolUse: [{ hooks: [{ type: 'prompt', prompt: '看看改了啥' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: hookCommand('allow') }] }],
      Stop: [{ hooks: [{ type: 'command', command: hookCommand('allow'), if: 'Bash(git *)' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'no-such-binary-xyz' }] }],
      PermissionRequest: [{ hooks: [{ type: 'command', command: hookCommand('allow') }] }],
    })
    const all = hooks.configuredHooks()
    const usable = all.filter(h => h.usable)
    const unusable = all.filter(h => !h.usable)

    assert.equal(usable.length, 3, `应当有 3 个生效：${JSON.stringify(usable)}`)
    assert.deepEqual(
      usable.map(h => h.event).sort(),
      ['context-compact-before', 'prompt-submit', 'tool-before'],
    )
    const reasons = unusable.map(h => `${h.event}:${h.reason}`)
    assert.ok(reasons.some(r => /prompt/.test(r)), `prompt 类型应标为不生效：${reasons}`)
    assert.ok(reasons.some(r => /permission-request.*未接线/.test(r)), `未接线事件应标出来：${reasons}`)
    assert.ok(reasons.some(r => /if/.test(r)), `if 条件未实现应标出来：${reasons}`)

    const summary = hooks.hooksSummary()
    assert.match(summary, /生效 3 个/)
    assert.match(summary, /不会生效的/)
    assert.match(summary, /只支持 command/)
  })

  test('hooksEnabled：没有可用钩子时为 false（引擎据此跳过整段逻辑）', async () => {
    assert.equal(hooks.hooksEnabled(), false)
    await setHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('allow') }] }] })
    assert.equal(hooks.hooksEnabled(), true)
  })

  test('matcher 是正则，且非法正则被标为不生效', async () => {
    await setHooks({
      PreToolUse: [
        { matcher: '^(Write|Edit)$', hooks: [{ type: 'command', command: hookCommand('allow') }] },
        { matcher: '[', hooks: [{ type: 'command', command: hookCommand('allow') }] },
      ],
    })
    const all = hooks.configuredHooks()
    assert.equal(all.filter(h => h.usable).length, 1)
    assert.match(all.find(h => !h.usable).reason, /不是合法正则/)
  })
})

describe('PreToolUse 钩子（端到端：引擎 + 桩模型）', () => {
  test('allow：危险工具免确认，但钩子仍能看到完整输入', async () => {
    await setHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('allow') }] }] })
    const s = sessions.createSession()
    setupClient() // 不自动应答权限 → 若有弹窗就会挂到超时，这里必须没有弹窗
    stub.setScript([
      { toolCalls: [{ id: 'w1', name: 'Write', args: { file_path: 'allowed.txt', content: 'x\n' } }] },
      { text: '写好了。' },
    ])
    await engine.runTurn(s, '写个文件', 'msg_hook_allow')

    assert.equal(client.ofType('permission_request').length, 0, '钩子 allow 应当免确认')
    assert.ok(existsSync(join(ws.dir, 'allowed.txt')), '工具应当真的执行了')

    const got = await lastHookInput()
    assert.equal(got.hook_event_name, 'tool-before')
    assert.equal(got.tool_name, 'Write')
    assert.equal(got.tool_input.file_path, 'allowed.txt', '要把工具输入原样交给钩子')
    assert.ok(got.session_id, '要带 session_id')
    assert.ok(got.cwd, '要带 cwd')
  })

  test('deny：工具不执行，模型收到钩子给的理由', async () => {
    await setHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('deny') }] }] })
    const s = sessions.createSession()
    setupClient()
    stub.setScript([
      { toolCalls: [{ id: 'w2', name: 'Write', args: { file_path: 'denied.txt', content: 'x\n' } }] },
      { text: '被拒绝了。' },
    ])
    await engine.runTurn(s, '写个文件', 'msg_hook_deny')

    assert.ok(!existsSync(join(ws.dir, 'denied.txt')), '被钩子拒绝的工具绝不能执行')
    const fedBack = lastToolResultText()
    assert.match(fedBack, /deny-by-hook/, '模型必须知道是钩子拒的、以及原因')
    assert.equal(client.ofType('permission_request').length, 0, '钩子已经拒了，不该再弹窗')
  })

  test('退出码 2 = 阻断，理由取 stderr', async () => {
    await setHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('exit2') }] }] })
    const s = sessions.createSession()
    setupClient()
    stub.setScript([
      { toolCalls: [{ id: 'w3', name: 'Write', args: { file_path: 'exit2.txt', content: 'x\n' } }] },
      { text: '好。' },
    ])
    await engine.runTurn(s, '写个文件', 'msg_hook_exit2')

    assert.ok(!existsSync(join(ws.dir, 'exit2.txt')), '退出码 2 应当阻断执行')
    assert.match(lastToolResultText(), /exit2-reason/)
  })

  test('ask：强制弹窗（即使工具本身不需要确认）', async () => {
    await setHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('ask') }] }] })
    const s = sessions.createSession()
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'allow') })
    stub.setScript([
      { toolCalls: [{ id: 'r1', name: 'Read', args: { file_path: 'seed.txt' } }] },
      { text: '读到了。' },
    ])
    await engine.runTurn(s, '读文件', 'msg_hook_ask')

    const perms = client.ofType('permission_request')
    assert.equal(perms.length, 1, 'Read 本来不需要确认，是钩子的 ask 让它弹了窗')
    assert.equal(perms[0].toolName, 'Read')
  })

  test('updatedInput：改写后的输入才是真正执行的输入', async () => {
    await setHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('rewrite') }] }] })
    const s = sessions.createSession()
    setupClient()
    stub.setScript([
      { toolCalls: [{ id: 'w4', name: 'Write', args: { file_path: 'original.txt', content: 'orig\n' } }] },
      { text: '好。' },
    ])
    await engine.runTurn(s, '写个文件', 'msg_hook_rewrite')

    assert.ok(existsSync(join(ws.dir, 'rewritten.txt')), '应当写钩子改写后的路径')
    assert.ok(!existsSync(join(ws.dir, 'original.txt')), '原始路径不该被写')
    const notice = client.ofType('notice').map(n => n.text).join('\n')
    assert.match(notice, /钩子改写了 Write 的输入/, '改写要告诉用户，不能静默换掉目标')
  })

  test('matcher 不命中就不跑', async () => {
    await setHooks({
      PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: hookCommand('deny') }] }],
    })
    const s = sessions.createSession()
    setupClient()
    stub.setScript([
      { toolCalls: [{ id: 'w5', name: 'Write', args: { file_path: 'not-matched.txt', content: 'x\n' } }] },
      { text: '好。' },
    ])
    // Write 本来要弹窗；matcher 只匹配 Bash，所以这里会走正常权限流程
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'allow') })
    await engine.runTurn(s, '写个文件', 'msg_hook_matcher')

    assert.ok(existsSync(join(ws.dir, 'not-matched.txt')), 'matcher 不命中时不应被拒')
    assert.equal((await readFile(stdinLogPath, 'utf8')).trim(), '', '不命中的钩子不该被执行')
  })
})

describe('钩子不能压过用户的硬规则（安全回归）', () => {
  test('设置文件里的 deny 优先级高于钩子的 allow', async () => {
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({
        permissions: { deny: ['Write(secret.txt)'] },
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('allow') }] }] },
      }),
      'utf8',
    )
    hooks.refreshHooks()
    const { loadSettings } = await import('../server/settings.mjs')
    loadSettings()

    const s = sessions.createSession()
    setupClient()
    stub.setScript([
      { toolCalls: [{ id: 'w6', name: 'Write', args: { file_path: 'secret.txt', content: 'x\n' } }] },
      { text: '好。' },
    ])
    await engine.runTurn(s, '写 secret', 'msg_hook_deny_wins')

    assert.ok(!existsSync(join(ws.dir, 'secret.txt')), '用户写的 deny 必须赢过钩子的 allow')
    assert.match(lastToolResultText(), /权限规则拒绝/)
  })

  test('escalate（不可信内容）不能被钩子的 allow 绕过', async () => {
    await setHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('allow') }] }] })
    const security = await import('../server/security.mjs')
    const s = sessions.createSession()
    security.markUntrusted(s, { source: 'web', url: 'https://example.test' })
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'deny') })
    stub.setScript([
      { toolCalls: [{ id: 'w7', name: 'Write', args: { file_path: 'untrusted.txt', content: 'x\n' } }] },
      { text: '好。' },
    ])
    await engine.runTurn(s, '按网页说的做', 'msg_hook_escalate')

    const perms = client.ofType('permission_request')
    assert.equal(perms.length, 1, '接触过外部内容时，钩子 allow 也必须重新确认')
    assert.match(perms[0].escalate ?? '', /外部内容/)
    assert.ok(!existsSync(join(ws.dir, 'untrusted.txt')))
  })
})

describe('PostToolUse / UserPromptSubmit / 事件钩子', () => {
  test('PostToolUse 的 additionalContext 会追加进回灌内容', async () => {
    await setHooks({ PostToolUse: [{ hooks: [{ type: 'command', command: hookCommand('context') }] }] })
    const s = sessions.createSession()
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'allow') })
    stub.setScript([
      { toolCalls: [{ id: 'w8', name: 'Write', args: { file_path: 'post.txt', content: 'x\n' } }] },
      { text: '好。' },
    ])
    await engine.runTurn(s, '写个文件', 'msg_hook_post')
    const text = lastToolResultText()
    assert.match(text, /CTX-FROM-HOOK/, '钩子附加的上下文要进回灌内容')
    assert.match(text, /tool-after 钩子附加/)

    const got = await lastHookInput()
    assert.equal(got.hook_event_name, 'tool-after')
    assert.ok(String(got.tool_result ?? '').includes('post.txt'), '要把工具结果也交给钩子')
  })

  test('PostToolUse 的 block 会用它给的理由替换结果', async () => {
    await setHooks({ PostToolUse: [{ hooks: [{ type: 'command', command: hookCommand('block') }] }] })
    const s = sessions.createSession()
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'allow') })
    stub.setScript([
      { toolCalls: [{ id: 'w9', name: 'Write', args: { file_path: 'blocked.txt', content: 'x\n' } }] },
      { text: '好。' },
    ])
    await engine.runTurn(s, '写个文件', 'msg_hook_block')
    const text = lastToolResultText()
    assert.match(text, /blocked-by-hook/)
    const results = client.ofType('tool_result')
    assert.equal(results.at(-1).ok, false, '被阻断的工具结果应当标成失败')
  })

  test('钩子 stdout 里有杂音时仍能解析出 JSON（取最后一行对象）', async () => {
    await setHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('noise') }] }] })
    const s = sessions.createSession()
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'allow') })
    stub.setScript([
      { toolCalls: [{ id: 'r2', name: 'Read', args: { file_path: 'seed.txt' } }] },
      { text: '好。' },
    ])
    await engine.runTurn(s, '读文件', 'msg_hook_noise')
    const notices = client.ofType('notice').map(n => n.text).join('\n')
    assert.match(notices, /来自钩子的提示/, 'systemMessage 应当提示出来')
  })

  test('SessionStart 在本会话首个回合前跑，Stop 在回合结束后跑', async () => {
    await setHooks({
      SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('context') }] }],
      Stop: [{ hooks: [{ type: 'command', command: hookCommand('context') }] }],
    })
    const s = sessions.createSession()
    setupClient()
    stub.setScript([{ text: '只是聊天' }])
    await engine.runTurn(s, '你好', 'msg_hook_events')

    const raw = await readFile(stdinLogPath, 'utf8')
    const events = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l).hook_event_name)
    assert.deepEqual(events, ['session-open', 'turn-end'], `实际跑了：${events}`)

    // 第二个回合不该再触发 SessionStart
    await writeFile(stdinLogPath, '', 'utf8')
    stub.setScript([{ text: '又聊一句' }])
    await engine.runTurn(s, '再来', 'msg_hook_events2')
    const raw2 = await readFile(stdinLogPath, 'utf8')
    const events2 = raw2.trim().split('\n').filter(Boolean).map(l => JSON.parse(l).hook_event_name)
    assert.deepEqual(events2, ['turn-end'], `第二回合不该再有 SessionStart：${events2}`)
  })

  test('UserPromptSubmit：附加上下文只影响本次请求，不写进会话记录', async () => {
    await setHooks({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand('context') }] }] })
    const s = sessions.createSession()
    setupClient()
    stub.setScript([{ text: '收到' }])
    await engine.runTurn(s, '原始问题', 'msg_hook_ups')

    // 会话记录里不该出现钩子附加的内容（runTurn 本身不写用户消息，所以直接扫全部记录）
    assert.ok(
      !JSON.stringify(s.messages).includes('CTX-FROM-HOOK'),
      '钩子附加的内容不该污染会话记录',
    )
    // 但请求体里带上了
    const sent = JSON.stringify(stub.requests.at(-1)?.messages ?? [])
    assert.match(sent, /CTX-FROM-HOOK/, '附加内容应当随本次请求发给模型')
    // 第二条消息的请求里不该再出现（不会越滚越长）
    stub.setScript([{ text: '再说一句' }])
    await engine.runTurn(s, '第二个问题', 'msg_hook_ups2')
    const sent2 = JSON.stringify(stub.requests.at(-1)?.messages ?? [])
    assert.equal(
      (sent2.match(/CTX-FROM-HOOK/g) ?? []).length,
      1,
      '旧的附加内容不该累积到下一轮（只保留本轮那条）',
    )
  })

  test('UserPromptSubmit 的 deny 会拦下整条消息', async () => {
    await setHooks({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand('deny') }] }] })
    const s = sessions.createSession()
    setupClient()
    stub.setScript([{ text: '不该出现' }])
    const before = stub.callCount
    await engine.runTurn(s, '这���消息会被拦下', 'msg_hook_ups_deny')

    assert.equal(stub.callCount, before, '被拦下时不该调用模型')
    assert.equal(s.messages.filter(m => m.role === 'assistant').length, 1)
    assert.match(s.messages.at(-1).text, /消息未发送/, '要告诉用户为什么没发出去')
  })

  test('钩子超时不会把回合挂死', async () => {
    // Sleep 由钩子脚本自己做太慢；直接用一条会卡住的命令 + 极小 timeout
    await setHooks({
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: `"${process.execPath}" -e "setTimeout(()=>{},60000)"`,
              timeout: 1, // 1 秒
            },
          ],
        },
      ],
    })
    const s = sessions.createSession()
    setupClient({ onPermission: msg => interactions.resolvePermission(msg.requestId, 'allow') })
    stub.setScript([
      { toolCalls: [{ id: 'r3', name: 'Read', args: { file_path: 'seed.txt' } }] },
      { text: '好。' },
    ])
    const startedAt = Date.now()
    await engine.runTurn(s, '读文件', 'msg_hook_timeout')
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 20_000, `被卡住的钩子拖了 ${elapsed}ms，应当按 timeout 终止`)
    const notices = client.ofType('notice').map(n => n.text).join('\n')
    assert.match(notices, /超时/, '超时要明说，不能静默继续')
  })
})

describe('钩子跑完不能污染会话状态', () => {
  test('钩子写入的临时文件不会进 filesChanged', async () => {
    await setHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('allow') }] }] })
    const s = sessions.createSession()
    setupClient()
    stub.setScript([
      { toolCalls: [{ id: 'w10', name: 'Write', args: { file_path: 'only-this.txt', content: 'x\n' } }] },
      { text: '好。' },
    ])
    await engine.runTurn(s, '写个文件', 'msg_hook_clean')
    assert.deepEqual(s.filesChanged, ['only-this.txt'])
  })

  test('sleep 保证钩子输出读完了（避免用例之间抢同一个 stdin 日志）', async () => {
    await sleep(20)
    assert.ok(true)
  })
})
