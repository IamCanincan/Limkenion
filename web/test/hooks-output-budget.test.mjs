/**
 * 钩子输出的**上下文预算** + 溢出落盘。
 *
 * 学 codex 的 output_spill：钩子要塞进上下文的内容（systemMessage /
 * additionalContext）原先没有预算 —— 一个话多的钩子能把上下文撑爆。
 * 现在超过 HOOK_CONTEXT_CHAR_LIMIT 就落盘，上下文里只留截断版 + 指针。
 *
 * 用**真的子进程**跑钩子（与 hooks.test.mjs 同款：钩子协议的重点就是
 * stdin 收 JSON、stdout 回 JSON，用 mock 测等于没测）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkspace, rmDir } from './helpers.mjs'

let configDir
let ws
let hooks
let hookScriptPath

/** 写一份 hooks 配置（用户级 settings.json）。 */
async function setHook(mode) {
  await writeFile(
    join(configDir, 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          'session-open': [
            { hooks: [{ type: 'command', command: `"${process.execPath}" "${hookScriptPath}" ${mode}` }] },
          ],
        },
      },
      null,
      1,
    ),
    'utf8',
  )
  hooks.refreshHooks()
}

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-hookbudget-cfg-'))
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })

  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  // 预算调小，强制触发落盘（不必真的造 8000 字）—— 必须在 import 之前设好
  process.env.LIMKENION_WEB_HOOK_CONTEXT_CHARS = '120'

  // 桩钩子：按 mode 输出不同规模的上下文内容
  hookScriptPath = join(ws.dir, 'budget-hook.mjs')
  await writeFile(
    hookScriptPath,
    [
      "const mode = process.argv[2] ?? 'small'",
      "const long = 'A'.repeat(2000)",
      "if (mode === 'big') {",
      "  process.stdout.write(JSON.stringify({ systemMessage: 'HEAD-' + long + '-TAIL' }))",
      "} else if (mode === 'bigctx') {",
      "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'session-open', additionalContext: 'CTX-' + long + '-END' } }))",
      "} else {",
      "  process.stdout.write(JSON.stringify({ systemMessage: 'short-ok' }))",
      '}',
    ].join('\n'),
    'utf8',
  )

  hooks = await import('../server/hooks.mjs')
})

after(async () => {
  await rmDir(ws.dir)
  await rmDir(configDir)
})

test('超预算的 systemMessage：落盘，只回截断版 + 指针', async () => {
  await setHook('big')
  const acc = await hooks.runEventHooks('session-open', { hookInput: { session_id: 's1' } })

  assert.ok(acc.messages.length > 0, '应产出一条消息')
  const msg = acc.messages[0]
  // 用「相对原文显著缩短」而不是写死数字：预算可由 env 调整，写死会脆
  assert.ok(msg.length < 1000, `应被显著截断，实际长度 ${msg.length}`)
  assert.match(msg, /超出上下文预算/, '应说明超预算')
  assert.match(msg, /完整内容已落盘/, '应给出落盘指针')

  const file = msg.match(/完整内容已落盘：(\S+?)）/)?.[1]
  assert.ok(file && existsSync(file), `落盘文件应存在，取到的是 ${file}`)

  // 落盘的是**完整**内容（头尾都在），不撑上下文但也不丢信息
  const full = await readFile(file, 'utf8')
  assert.ok(full.includes('HEAD-') && full.includes('-TAIL'), '落盘应为完整内容')
  assert.ok(full.length > 2000, `落盘内容应完整，实际 ${full.length} 字`)
})

test('未超预算的输出原样保留（不误伤）', async () => {
  await setHook('small')
  const acc = await hooks.runEventHooks('session-open', { hookInput: { session_id: 's1' } })
  assert.ok(acc.messages.length > 0)
  assert.strictEqual(acc.messages[0], 'short-ok', '短消息不应被改动')
})

test('超预算的 additionalContext 同样落盘', async () => {
  await setHook('bigctx')
  const acc = await hooks.runEventHooks('session-open', { hookInput: { session_id: 's1' } })

  assert.ok(acc.additionalContext, '应产出附加上下文')
  assert.ok(acc.additionalContext.length < 1000, `应被显著截断，实际 ${acc.additionalContext.length}`)
  const file = acc.additionalContext.match(/完整内容已落盘：(\S+?)）/)?.[1]
  assert.ok(file && existsSync(file), '落盘文件应存在')
  const full = await readFile(file, 'utf8')
  assert.ok(full.includes('CTX-') && full.includes('-END'), '落盘应为完整内容')
})
