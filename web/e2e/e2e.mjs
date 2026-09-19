/**
 * 真实端到端体检：临时 git 仓库 + 隔离配置（hooks / mcpServers）+ 真实 DeepSeek。
 *
 * 走真实 WS 协议，覆盖：普通工具回合、中断竞态、钩子拦截、worktree、MCP、Workflow、/insights。
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// 一切路径都从**本文件的位置**推出来，不写死任何机器特定的目录。
const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = resolve(HERE, '..') // web/

const ROOT = join(tmpdir(), 'limkenion-e2e')
const REPO = join(ROOT, 'repo')
const CFG = join(ROOT, 'config')
const STATE = join(ROOT, 'state')
const HOOKS = join(ROOT, 'hooks')
const PORT = Number(process.env.LIMKENION_E2E_PORT ?? 8797)

rmSync(ROOT, { recursive: true, force: true })
for (const d of [REPO, CFG, STATE, HOOKS, join(REPO, 'src')]) mkdirSync(d, { recursive: true })

writeFileSync(join(REPO, 'seed.txt'), 'hello\n')
writeFileSync(join(REPO, 'src', 'a.ts'), 'export const alpha = 1\n')

const git = (...args) => execFileSync('git', args, { cwd: REPO, stdio: 'pipe' }).toString()
git('init', '-q')
git('config', 'user.email', 'e2e@local')
git('config', 'user.name', 'e2e')
git('add', '-A')
git('commit', '-q', '-m', 'seed')

// ---- 钩子脚本：只拒绝写 denied.txt ----
writeFileSync(
  join(HOOKS, 'deny-write.mjs'),
  `let b = ''
process.stdin.on('data', c => { b += c })
process.stdin.on('end', () => {
  const input = JSON.parse(b || '{}')
  const fp = String(input.tool_input?.file_path ?? '')
  if (fp.includes('denied.txt')) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        permissionDecision: 'deny',
        permissionDecisionReason: 'E2E-HOOK-DENY: 这个文件被钩子规则禁止写入',
      },
    }))
  }
})
`,
)

const STUB_MCP = join(WEB, 'test', 'fixtures', 'mcp-stub-server.mjs')
writeFileSync(
  join(CFG, 'settings.json'),
  JSON.stringify(
    {
      permissions: { allow: [], deny: [], ask: [] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [
              {
                type: 'command',
                command: `"${process.execPath}" "${join(HOOKS, 'deny-write.mjs')}"`,
                timeout: 20,
              },
            ],
          },
        ],
      },
      mcpServers: { stub: { command: process.execPath, args: [STUB_MCP] } },
    },
    null,
    2,
  ),
)

// API key：优先用环境里已有的，否则读 ~/.limkenion.json（与 web 服务端同源）。
// 没有就**明确退出**并说明原因 —— 静默跑下去只会看到一堆含糊的 401。
let KEY = process.env.DEEPSEEK_API_KEY ?? ''
if (!KEY) {
  const cfgPath = join(homedir(), '.limkenion.json')
  if (existsSync(cfgPath)) {
    KEY = JSON.parse(readFileSync(cfgPath, 'utf8')).primaryApiKey ?? ''
  }
}
if (!KEY) {
  console.error('没拿到 API key：请设置 DEEPSEEK_API_KEY，或在 ~/.limkenion.json 里配 primaryApiKey')
  process.exit(1)
}

const server = spawn(
  process.execPath,
  [join(WEB, 'server', 'index.mjs')],
  {
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: KEY,
      LIMKENION_WEB_PORT: String(PORT),
      LIMKENION_WEB_HOST: '127.0.0.1',
      LIMKENION_WEB_WORKSPACE: REPO,
      LIMKENION_WEB_STATE_DIR: STATE,
      LIMKENION_CONFIG_DIR: CFG,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let serverLog = ''
server.stdout.on('data', d => { serverLog += d.toString() })
server.stderr.on('data', d => { serverLog += d.toString() })

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------- WS 客户端 ----------------
function connect() {
  return new Promise(async (resolve, reject) => {
    const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text()
    const token = html.match(/name="limkenion-token" content="([^"]+)"/)?.[1]
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`)
    const events = []
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data)
      events.push(m)
      // 一律允许，避免弹窗挂到超时
      if (m.type === 'permission_request') {
        ws.send(JSON.stringify({ type: 'permission_response', requestId: m.requestId, decision: 'allow' }))
      }
      if (m.type === 'question_request') {
        ws.send(JSON.stringify({
          type: 'question_response',
          requestId: m.requestId,
          answers: m.questions.map(q => ({ question: q.question, answer: '随便' })),
        }))
      }
    })
    ws.addEventListener('open', () =>
      resolve({
        ws,
        events,
        send: obj => ws.send(JSON.stringify(obj)),
        ofType: t => events.filter(e => e.type === t),
        close: () => ws.close(),
      }),
    )
    ws.addEventListener('error', reject)
  })
}

// ---------------- 场景框架 ----------------
const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `\n        ${detail}` : ''}`)
}

/**
 * "没测到"和"测出来是错的"是两回事。
 *
 * 这一整套用例走的是**真实模型**，响应快慢、是否真的调工具都会抖动。
 * 如果把"本轮模型没在预期窗口内调用工具"记成失败，报表里就会混进
 * 一批看起来像产品 bug、实际只是没触发的条目 —— 反而会把真 bug 淹没掉。
 * 所以单列一个"跳过"，汇总时分开说，退出码仍按真实失败算。
 */
function skip(name, reason) {
  results.push({ name, ok: true, skipped: true, detail: reason })
  console.log(`  ⚠️  ${name}（未触发：${reason}）`)
}

/** 发一条用户消息，等到 turn_complete / turn_cancelled / error。 */
async function sendAndWait(c, text, { timeoutMs = 180000, onTick } = {}) {
  const before = c.events.length
  c.send({ type: 'user_message', sessionId: c.sessionId, text })
  const t0 = Date.now()
  let tickTimer
  if (onTick) tickTimer = setInterval(() => onTick(c.events.slice(before)), 500)
  try {
    while (Date.now() - t0 < timeoutMs) {
      const fresh = c.events.slice(before)
      const end = fresh.find(e => e.type === 'turn_complete' || e.type === 'turn_cancelled' || e.type === 'error')
      if (end) return fresh
      await sleep(300)
    }
    return c.events.slice(before)
  } finally {
    if (tickTimer) clearInterval(tickTimer)
  }
}

/**
 * 发一条斜杠命令并等它的 command_result 回来。
 *
 * **不能死等固定秒数**：`/insights` 要调真实模型生成洞察，耗时不固定 ——
 * 原先这里写死 `sleep(20000)`，实测约 1/3 的运行会超过 20 秒，于是
 * 「G1 没输出 / G2 找不到报告文件名」被当成产品缺陷报出来，其实是测试自己等太短。
 * 改成轮询：结果一到就返回，最长等 timeoutMs（到点仍无结果才判失败）。
 */
async function runCommandAndWait(c, sessionId, command, { timeoutMs = 90000 } = {}) {
  const before = c.events.length
  c.send({ type: 'run_command', sessionId, command })
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const fresh = c.events.slice(before)
    const res = fresh.filter(e => e.type === 'command_result')
    if (res.length > 0) return res.map(e => e.output).join('\n')
    await sleep(300)
  }
  return ''
}

// ---------------- 开跑 ----------------
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`)
    if (r.ok) break
  } catch { /* 还没起 */ }
  await sleep(500)
}

const c = await connect()
await sleep(500)
console.log(`\n会话 ${c.events.find(e => e.type === 'hello')?.sessions?.[0]?.id ?? '?'} 就绪\n`)

// 取一个会话 id
const hello = c.events.find(e => e.type === 'hello')
if (!hello) throw new Error('没收到 hello，服务端日志：\n' + serverLog.slice(-2000))
let sid = hello.sessions[0]?.id
if (!sid) {
  c.send({ type: 'new_session' })
  await sleep(600)
  sid = c.events.filter(e => e.type === 'sessions').at(-1)?.sessions?.[0]?.id
}
c.sessionId = sid

// =============== 场景 A：普通工具回合 ===============
console.log('【A】普通工具回合（Write 改文件）')
{
  const fresh = await sendAndWait(c, '把工作区里的 seed.txt 内容改成 hi（用 Write 工具覆盖写入，不要用 Bash）。完成后只回复两个字：完成', { timeoutMs: 120000 })
  const calls = fresh.filter(e => e.type === 'tool_call')
  const write = calls.find(e => e.toolCall.name === 'Write')
  record('A1 模型调用了 Write', !!write, write ? '' : `实际调用：${calls.map(e => e.toolCall.name).join('、') || '（无）'}`)
  const done = fresh.some(e => e.type === 'turn_complete')
  record('A2 回合正常结束', done, done ? '' : `末尾事件：${fresh.at(-1)?.type}`)
  const content = existsSync(join(REPO, 'seed.txt')) ? readFileSync(join(REPO, 'seed.txt'), 'utf8') : '（文件没了）'
  // 依赖型断言：A1 已经判过「模型调没调 Write」，这里只在**真的调了**的前提下才判
  // 文件内容 —— 否则模型没调工具会连带把 A3 也记成失败，混淆回归判定。
  if (!write) skip('A3 文件真的被改了', '模型本轮没有调用 Write，这条路径未走到')
  else record('A3 文件真的被改了', content.trim() === 'hi', `内容 = ${JSON.stringify(content)}`)
}

// =============== 场景 B：中断后立刻再发 ===============
console.log('\n【B】中断后立刻再发一条（回合代次）')
{
  const before = c.events.length
  c.send({ type: 'user_message', sessionId: sid, text: '用 Read 工具反复读 seed.txt，至少读 6 次，每次都说明读到了什么。' })
  // 等到真的跑起来（出现第一个 tool_call）。带思考链的模型几十秒才出第一次调用都正常，
  // 所以这里给足 60 秒；等不到就说明本轮**没触发**这个场景，那就别硬判失败。
  for (let i = 0; i < 300; i++) {
    if (c.events.slice(before).some(e => e.type === 'tool_call')) break
    await sleep(200)
  }
  const oldMsgId = c.events.slice(before).find(e => e.type === 'tool_call')?.messageId
  if (!oldMsgId) {
    skip('B1 被中断的回合以 turn_cancelled 收尾', '60 秒内没等到任何工具调用，没有"在途回合"可中断')
    skip('B2 被中断的回合没有"复活"成 turn_complete', '同上，本轮没有可观察的旧回合')
    skip('B3 被中断的回合不再继续产出工具调用', '同上，本轮没有可观察的旧回合')
  } else {
  // Esc + 立刻再发（中间不 await，模拟真实连击）
  c.send({ type: 'cancel', sessionId: sid })
  c.send({ type: 'user_message', sessionId: sid, text: '只回复两个字：收到' })

  await sleep(4000)
  const fresh = c.events.slice(before)
  const cancelled = fresh.filter(e => e.type === 'turn_cancelled').map(e => e.messageId)
  const completed = fresh.filter(e => e.type === 'turn_complete').map(e => e.messageId)
  record('B1 被中断的回合以 turn_cancelled 收尾', cancelled.includes(oldMsgId), `cancelled=${cancelled} completed=${completed}`)
  record('B2 被中断的回合没有"复活"成 turn_complete', !completed.includes(oldMsgId), `completed=${completed}`)

  const n1 = fresh.filter(e => e.type === 'tool_call' && e.messageId === oldMsgId).length
  await sleep(5000)
  const n2 = c.events.slice(before).filter(e => e.type === 'tool_call' && e.messageId === oldMsgId).length
  record('B3 被中断的回合不再继续产出工具调用', n2 === n1, `工具调用数 ${n1} → ${n2}`)
  }

  // 新回合要等 —— v4-pro 带思考链，几秒到几十秒都正常，所以轮询而不是猜时间
  let done2 = []
  for (let i = 0; i < 200; i++) {
    done2 = c.events.slice(before).filter(e => e.type === 'turn_complete').map(e => e.messageId)
    if (done2.length > 0) break
    await sleep(500)
  }
  record('B4 新回合正常完成', done2.length >= 1, `completed=${done2}`)
}

// =============== 场景 C：钩子拦截 ===============
console.log('\n【C】PreToolUse 钩子拦截（写 denied.txt 被 deny）')
{
  const fresh = await sendAndWait(
    c,
    '用 Write 工具在工作区根目录创建文件 denied.txt，内容写 "x"。如果这个操作被拒绝了，把拒绝原因原文告诉我；不要换别的方式绕过。',
    { timeoutMs: 120000 },
  )
  const results_ = fresh.filter(e => e.type === 'tool_result')
  const denied = results_.find(e => /E2E-HOOK-DENY/.test(JSON.stringify(e)))
  // 依赖型断言：前提是模型**真的尝试写**了。没尝试的话 C1 必然拿不到拒绝理由、
  // C2 又平凡成立（文件当然不存在）—— 两者都不该算失败，标未触发更诚实。
  const writeTried = fresh.filter(e => e.type === 'tool_call').some(e => e.toolCall.name === 'Write')
  if (!writeTried) {
    skip('C1 钩子的拒绝理由回灌给了模型', '模型本轮没有调用 Write，钩子拦截路径未走到')
    skip('C2 被拒的文件没有被创建', '模型没有尝试写，本条平凡成立')
  } else {
    record('C1 钩子的拒绝理由回灌给了模型', !!denied, denied ? '' : `工具结果：${JSON.stringify(results_).slice(0, 300)}`)
    record('C2 被拒的文件没有被创建', !existsSync(join(REPO, 'denied.txt')), existsSync(join(REPO, 'denied.txt')) ? '文件竟然被写出来了！' : '')
  }
}

// =============== 场景 D：worktree ===============
console.log('\n【D】worktree：切沙箱根')
{
  const fresh = await sendAndWait(
    c,
    '严格按顺序做两件事：1) 调用 EnterWorktree 工具，name 传 e2e-wt；2) 然后在工作区根目录用 Write 创建 only-in-wt.txt，内容写 "in worktree"。完成后只回复两个字：完成',
    { timeoutMs: 180000 },
  )
  const calls = fresh.filter(e => e.type === 'tool_call').map(e => e.toolCall.name)
  record('D1 调用了 EnterWorktree', calls.includes('EnterWorktree'), `调用序列：${calls.join(' → ')}`)
  const wtDir = join(REPO, '.limkenion', 'worktrees', 'e2e-wt')
  record('D2 worktree 目录已创建', existsSync(wtDir), wtDir)
  const inWt = existsSync(join(wtDir, 'only-in-wt.txt'))
  // 依赖型断言：前提是模型真的进了 worktree（D1 已单独判过）。没进的话文件必然落在
  // 原树，D3 落空、D4 反而被判"污染" —— 那是模型没照做的连带结果，不是产品 bug。
  const entered = calls.includes('EnterWorktree')
  if (!entered) {
    skip('D3 文件写进了 worktree 而不是原树', '模型没有调用 EnterWorktree，本条未走到')
    skip('D4 原工作区没有被污染', '模型没有调用 EnterWorktree，本条未走到')
  } else {
    record('D3 文件写进了 worktree 而不是原树', inWt, inWt ? '' : `worktree 里没有；原树里有吗 = ${existsSync(join(REPO, 'only-in-wt.txt'))}`)
    record('D4 原工作区没有被污染', !existsSync(join(REPO, 'only-in-wt.txt')), '')
  }

  // 退出
  // 提示词里**不能**给"如果没有未提交改动"这种退路：本例刚写了 only-in-wt.txt，
  // 模型会据此理性地改用 keep —— 那 remove 这条路径就根本没被走到，
  // 断言却在按"没删掉 = 失败"判，等于把模型的正确选择记成产品 bug。
  const fresh2 = await sendAndWait(
    c,
    '调用 ExitWorktree 工具，action 固定传 remove，不要改成 keep。完成后只回复两个字：完成',
    { timeoutMs: 180000 },
  )
  const calls2 = fresh2.filter(e => e.type === 'tool_call').map(e => e.toolCall.name)
  record('D5 调用了 ExitWorktree', calls2.includes('ExitWorktree'), `调用序列：${calls2.join(' → ')}`)
  const wtCall = fresh2.filter(x => x.type === 'tool_call').find(x => x.toolCall.name === 'ExitWorktree')
  const exitRes = fresh2.filter(e => e.type === 'tool_result' && e.toolCallId === wtCall?.toolCall.id)
  const exitText = JSON.stringify(exitRes)
  const gone = !existsSync(wtDir)
  // 两种正确结局：① 目录干净 → 真删了；② 目录脏（本例写了 only-in-wt.txt）→ 明确拒绝并说明
  const refusedHonestly = /未删除|没有删除|永久没了/.test(exitText) && /discard_changes/.test(exitText)
  const attemptedRemove = JSON.stringify(wtCall?.toolCall?.input ?? wtCall?.toolCall?.args ?? {}).includes('remove')
  if (!attemptedRemove) {
    skip('D6 remove 要么真删、要么如实拒绝并给出补救办法', '模型没有用 remove，这条路径本轮没走到')
  } else {
    record('D6 remove 要么真删、要么如实拒绝并给出补救办法', gone || refusedHonestly, `gone=${gone} 输出=${exitText.slice(0, 240)}`)
  }

  // 退出之后应当回到原根（否则会话会"卡"在刚被删掉的目录上）
  // 退出之后应当回到原根（否则会话会"卡"在刚被删掉的目录上）。
  //
  // 这里必须区分两种「原根里没有文件」，否则会把模型的不确定性当成回归：
  //   - 模型压根没调 Write → 这条路径本轮没走到，按 D6 的惯例 **skip**（不是失败）；
  //   - 模型调了 Write 但文件不在原根 → 这才是真回归（沙箱根没还原 / 写错根）。
  // 实测 D7 有约两成抖动，全部来自「模型没调 Write」；把「没走到」记成失败会
  // 污染回归判定（曾为此白跑 9 轮对照）。
  let backEvents = await sendAndWait(
    c,
    '用 Write 在工作区根目录创建 back-in-main.txt，内容写 "back"。完成后只回复两个字：完成',
    { timeoutMs: 120000 },
  )
  let wroteBack = backEvents.some(e => e.type === 'tool_call' && e.toolCall?.name === 'Write')
  if (!wroteBack) {
    // 再给一次明确的机会（挑明"必须调工具"），仍不写才判未触发
    backEvents = await sendAndWait(
      c,
      '请立刻调用 Write 工具（不要只用文字回复）：路径 back-in-main.txt，内容写 "back"。',
      { timeoutMs: 120000 },
    )
    wroteBack = backEvents.some(e => e.type === 'tool_call' && e.toolCall?.name === 'Write')
  }
  const backInMain = existsSync(join(REPO, 'back-in-main.txt'))
  if (!wroteBack && !backInMain) {
    skip('D7 退出后写入回到原根', '模型本轮没有调用 Write，这条路径未走到')
  } else {
    // 写错到 worktree 是最有价值的线索，单独指出来
    const inWt = existsSync(join(wtDir, 'back-in-main.txt'))
    record(
      'D7 退出后写入回到原根',
      backInMain,
      backInMain
        ? ''
        : inWt
          ? `文件落在 worktree（${wtDir}）而不是原根 —— 沙箱根没还原，这是真回归`
          : '模型调用了 Write，但原根里没找到文件（沙箱根没还原 / 写错根）',
    )
  }
}

// =============== 场景 E：MCP ===============
console.log('\n【E】MCP：连桩服务器并从模型侧调用')
{
  // 命令侧确认连接状态
  const out = await runCommandAndWait(c, sid, '/mcp', { timeoutMs: 30000 })
  record('E1 /mcp 显示已连接', /已连接|connected|工具/.test(out), out.split('\n').slice(0, 6).join(' | '))

  const fresh = await sendAndWait(
    c,
    '调用工具 mcp__stub__echo，参数 text 传 "E2E-MCP-OK"。把工具返回的内容原样贴出来。',
    { timeoutMs: 120000 },
  )
  const mcpCall = fresh.filter(e => e.type === 'tool_call').find(e => e.toolCall.name.startsWith('mcp__'))
  record('E2 模型调用了 MCP 工具', !!mcpCall, mcpCall ? mcpCall.toolCall.name : `调用序列：${fresh.filter(e => e.type === 'tool_call').map(e => e.toolCall.name).join('、')}`)
  const echoRes = fresh.filter(e => e.type === 'tool_result').find(e => /E2E-MCP-OK/.test(JSON.stringify(e)))
  // 依赖型断言：模型没调 MCP 工具（E2 已判），自然拿不到回显，不该连带记失败。
  if (!mcpCall) skip('E3 MCP 工具真的返回了内容', '模型没有调用 MCP 工具，本条未走到')
  else record('E3 MCP 工具真的返回了内容', !!echoRes, echoRes ? '' : '没看到 E2E-MCP-OK')
}

// =============== 场景 F：Workflow ===============
console.log('\n【F】Workflow：动态工作流编排')
{
  const fresh = await sendAndWait(
    c,
    '调用 Workflow 工具，script 参数传这段脚本（原样传，不要改）：\n\nawait agent("回复一个词：甲")\nawait agent("回复一个词：乙")\nreturn "两个子代理都跑完了"\n\n完成后告诉我子代理跑了几个。',
    { timeoutMs: 240000 },
  )
  const wfCall = fresh.filter(e => e.type === 'tool_call').find(e => e.toolCall.name === 'Workflow')
  record('F1 模型调用了 Workflow', !!wfCall, wfCall ? '' : `调用序列：${fresh.filter(e => e.type === 'tool_call').map(e => e.toolCall.name).join('、')}`)
  const wfRes = fresh.filter(e => e.type === 'tool_result').find(e => e.toolCallId === wfCall?.toolCall.id)
  const okWf = wfRes && /子代理 2 个|子代理 1 个/.test(JSON.stringify(wfRes))
  // 依赖型断言：模型没调 Workflow（F1 已判），后面两条都不成立，标未触发而非失败。
  if (!wfCall) skip('F2 工作流真的跑完并报了子代理数', '模型没有调用 Workflow，本条未走到')
  else record('F2 工作流真的跑完并报了子代理数', !!okWf, wfRes ? JSON.stringify(wfRes.result ?? wfRes).slice(0, 300) : '')

  // /workflows 能列出运行记录
  const out = await runCommandAndWait(c, sid, '/workflows', { timeoutMs: 30000 })
  if (!wfCall) skip('F3 /workflows 列出运行记录', '本轮没有跑过 Workflow，列表为空属正常')
  else record('F3 /workflows 列出运行记录', /wf_|运行/.test(out), out.split('\n').slice(0, 4).join(' | '))
}

// =============== 场景 G：/insights ===============
console.log('\n【G】/insights：报告生成与 HTTP 路由')
{
  const out = await runCommandAndWait(c, sid, '/insights', { timeoutMs: 120000 })
  record('G1 /insights 有输出', out.trim().length > 0, out.split('\n').slice(0, 5).join(' | '))
  const m = out.match(/insights-[0-9T-]+\.html/)
  if (m) {
    const r = await fetch(`http://127.0.0.1:${PORT}/insights/${m[0]}`)
    const html = r.ok ? await r.text() : ''
    record('G2 报告能通过 HTTP 取到', r.ok && /Limkenion 使用洞察/.test(html), `HTTP ${r.status}，长度 ${html.length}`)
  } else {
    record('G2 报告能通过 HTTP 取到', false, '命令输出里没找到报告文件名')
  }
}

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(60))
const bad = results.filter(r => !r.ok)
const skipped = results.filter(r => r.skipped)
console.log(
  `合计 ${results.length} 项，通过 ${results.length - bad.length - skipped.length}，` +
    `失败 ${bad.length}，未触发 ${skipped.length}`,
)
for (const b of bad) console.log(`  ❌ ${b.name}  ${b.detail}`)
for (const s of skipped) console.log(`  ⚠️  ${s.name}  ${s.detail}`)

console.log('\n--- 服务端日志尾部 ---')
console.log(serverLog.split('\n').slice(-25).join('\n'))

server.kill()
process.exit(bad.length === 0 ? 0 : 1)
