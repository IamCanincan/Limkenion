/**
 * 第 24 轮：四个"宿主功能补齐"事件的测试。
 *
 * - instructions-loaded：LIMKENION.md / AGENTS.md 注入系统提示（/init 早就承诺了）
 * - setup：首回合比 session-open 更早触发
 * - teammate-idle：SendMessage 真派活，子代理跑完成员回 idle
 * - cwd-changed：/cwd 切换工作区根（收窄到子目录）
 */

import { test, describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let configDir
let ws
let hooks
let engine
let sessions
let tools
let commands
let interactions
let stub
let bus
let client

const sleep = ms => new Promise(r => setTimeout(r, ms))

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-host-cfg-'))
  ws = await mkdtemp0()
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws
  process.env.LIMKENION_WEB_STATE_DIR = join(ws, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  // 标记脚本：追加一行事件名（stdin 里带 hook_event_name）—— 必须先于钩子配置生成
  markerScript = join(ws, '.marker.mjs')
  await writeFile(
    markerScript,
    "import { readFileSync, appendFileSync } from 'node:fs'\n" +
      "const input = JSON.parse(readFileSync(0, 'utf8'))\n" +
      "appendFileSync(process.env.HOST_MARKER_FILE, input.hook_event_name + '\\n')\n",
    'utf8',
  )
  process.env.HOST_MARKER_FILE = join(ws, 'markers.txt')
  // 默认钩子：所有目标事件都往标记文件追加事件名
  await writeFile(
    join(configDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        Setup: [{ hooks: [{ type: 'command', command: mark('setup') }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: mark('session-open') }] }],
        InstructionsLoaded: [{ hooks: [{ type: 'command', command: mark('instructions-loaded') }] }],
        TeammateIdle: [{ hooks: [{ type: 'command', command: mark('teammate-idle') }] }],
        CwdChanged: [{ hooks: [{ type: 'command', command: mark('cwd-changed') }] }],
      },
    }),
    'utf8',
  )
  // 标记脚本：追加一行事件名（stdin 里带 hook_event_name）
  markerScript = join(ws, '.marker.mjs')
  await writeFile(
    markerScript,
    "import { readFileSync, appendFileSync } from 'node:fs'\n" +
      "const input = JSON.parse(readFileSync(0, 'utf8'))\n" +
      "appendFileSync(process.env.HOST_MARKER_FILE, input.hook_event_name + '\\n')\n",
    'utf8',
  )
  process.env.HOST_MARKER_FILE = join(ws, 'markers.txt')

  bus = await import('../server/bus.mjs')
  const { fakeClient } = await import('./helpers.mjs')
  client = fakeClient({})
  bus.addClient(client.ws)
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
  interactions = await import('../server/interactions.mjs')
  hooks = await import('../server/hooks.mjs')
  tools = await import('../server/tools.mjs')
  commands = await import('../server/commands.mjs')
  await hooks.refreshHooks() // 钩子配置有缓存：写完 settings.json 必须刷新
})

after(async () => {
  stub?.close?.() // 不关会吊住事件循环，node --test 永远等不到结束
  await rm(ws, { recursive: true, force: true }).catch(() => {})
  await rm(configDir, { recursive: true, force: true }).catch(() => {})
})

// ---- 小工具 ----
let markerScript
async function mkdtemp0() {
  const dir = await mkdtemp(join(tmpdir(), 'lk-host-ws-'))
  await mkdir(join(dir, 'sub'), { recursive: true })
  await writeFile(join(dir, 'seed.txt'), 'seed\n', 'utf8')
  return dir
}
/** 生成一条往 markers.txt 追加事件名的 command 钩子。 */
function mark() {
  return `"${process.execPath}" "${markerScript}"`
}
/** 轮询等某个事件出现在标记文件里（满载时钩子子进程可能慢于固定 sleep）。 */
async function waitForMarker(event, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let cur = []
  while (Date.now() < deadline) {
    try {
      cur = (await readFile(join(ws, 'markers.txt'), 'utf8')).split('\n').filter(Boolean)
    } catch { cur = [] }
    if (cur.includes(event)) return cur
    await new Promise(r => setTimeout(r, 100))
  }
  return cur
}

async function markers() {
  try {
    return (await readFile(join(ws, 'markers.txt'), 'utf8')).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
describe('instructions-loaded + 注入', () => {
  it('LIMKENION.md 内容进系统提示，且钩子触发', async () => {
    await writeFile(join(ws, 'LIMKENION.md'), '# 项目约定\n永远用中文写提交信息。\n', 'utf8')
    const { ensureInstructions, instructionsCached } = await import('../server/instructions.mjs')
    const { workspaceRoot } = await import('../server/paths.mjs')
    await ensureInstructions(workspaceRoot()) // 缓存键 = 作用域根，必须一致
    assert.match(instructionsCached(), /永远用中文写提交信息/)
    // 注入：sessionToWireMessages 的第一条 system 消息带上指令
    const s = sessions.createSession()
    s.messages.push({ id: 'm1', role: 'user', text: '你好', timestamp: Date.now() })
    const wire = engine.sessionToWireMessages(s)
    assert.match(String(wire[0].content), /项目约定/)
    assert.match(String(wire[0].content), /永远用中文写提交信息/)
    await sleep(100) // 钩子是 fire-and-forget
    assert.ok((await waitForMarker('instructions-loaded')).includes('instructions-loaded'), `instructions-loaded 应触发：${await waitForMarker('instructions-loaded')}`)
  })
})

describe('setup（首回合，早于 session-open）', () => {
  it('首回合先触发 setup 再触发 session-open', async () => {
    // 桩模型：不需要真实 API
    const { startStubModel } = await import('./helpers.mjs')
    stub = await startStubModel([{ text: '好' }])
    process.env.DEEPSEEK_BASE_URL = stub.baseUrl
    const s = sessions.createSession()
    await engine.runTurn(s, '第一句话', 'msg_1')
    const m = await waitForMarker('session-open')
    const iSetup = m.indexOf('setup')
    const iOpen = m.indexOf('session-open')
    assert.ok(iSetup >= 0, `setup 应触发：${m.join(',')}`)
    assert.ok(iOpen >= 0, 'session-open 应触发')
    assert.ok(iSetup < iOpen, 'setup 应早于 session-open')
  })
})

describe('teammate-idle（SendMessage 真派活）', () => {
  it('派活 → 成员 busy → 完成回 idle → 钩子触发', async () => {
    const s = sessions.createSession()
    s.team = { name: 'review', members: [{ name: 'm1', role: 'agent', status: 'idle' }], log: [] }
    let wasBusyDuringRun = null
    const ctx = {
      session: s,
      runSubAgent: async () => {
        wasBusyDuringRun = s.team.members[0].status
        return '子代理结论：OK'
      },
    }
    const out = await tools.executeTool('SendMessage', { to: 'm1', message: '帮我审一下' }, ctx)
    assert.match(String(out), /已完成/, `应报告完成：${out}`)
    assert.match(String(out), /子代理结论：OK/)
    assert.equal(wasBusyDuringRun, 'busy', '子代理执行期间成员应为 busy')
    assert.equal(s.team.members[0].status, 'idle', '完成后应回 idle')
    await sleep(100)
    assert.ok((await waitForMarker('teammate-idle')).includes('teammate-idle'), 'teammate-idle 钩子应触发')
  })

  it('发给不存在的成员 → 优雅提示，不派活', async () => {
    const s = sessions.createSession()
    s.team = { name: 't', members: [], log: [] }
    const out = await tools.executeTool('SendMessage', { to: 'nobody', message: 'hi' }, { session: s })
    assert.match(String(out), /不在团队中|无团队成员/)
  })
})

describe('cwd-changed（/cwd 切换工作区根）', () => {
  it('收窄到子目录 → 钩子触发；/cwd . 重置', async () => {
    const s = sessions.createSession()
    const out = await commands.runCommand(s, 'cwd', 'sub', null, [])
    assert.match(String(out), /已切换/, `应成功：${out}`)
    assert.ok(s.workspaceRoot && s.workspaceRoot.endsWith('sub'), `workspaceRoot 应指向 sub：${s.workspaceRoot}`)
    await sleep(100)
    assert.ok((await waitForMarker('cwd-changed')).includes('cwd-changed'), 'cwd-changed 钩子应触发')
    // 逃逸拒绝
    const bad = await commands.runCommand(s, 'cwd', '../../', null, [])
    assert.match(String(bad), /拒绝/)
    // 重置
    const reset = await commands.runCommand(s, 'cwd', '.', null, [])
    assert.match(String(reset), /已重置/)
    assert.equal(s.workspaceRoot, null)
  })
})
