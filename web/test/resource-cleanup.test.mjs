/**
 * 资源清理：会话被删除 / 授权被放弃时，相关资源要跟着释放。
 *
 * - 文件检查点原先只在 `/clear` 命令里清过：会话被**真正删除**时，它的快照桶、
 *   blob 桶、落盘定时器和盘上 ckpt 文件全都残留。现由 checkpoints.mjs 自己
 *   注册 onSessionDeleted 清理（资源归谁谁负责清，免得入口忘了接线）。
 * - mcpOAuth 的待授权请求原先没有过期：用户放弃浏览器授权后 state 永久残留。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { makeWorkspace, rmDir } from './helpers.mjs'
import { join } from 'node:path'

let ws
let sessions
let checkpoints

before(async () => {
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  // 服务端模块在 import 时读环境变量，必须先设好再动态 import
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:1'
  sessions = await import('../server/sessions.mjs')
  checkpoints = await import('../server/checkpoints.mjs')
})

after(async () => {
  await rmDir(ws.dir)
})

test('删除会话会清掉它的文件检查点（不再残留）', async () => {
  const s = sessions.createSession()
  checkpoints.recordCheckpoint(s, join(ws.dir, 'seed.txt'), 'seed\n')
  assert.ok(checkpoints.checkpointCount(s.id) > 0, '前置：先造出一条检查点')

  sessions.deleteSession(s.id)
  assert.strictEqual(
    checkpoints.checkpointCount(s.id),
    0,
    '删除会话后它的检查点应被清掉（快照桶 / blob 桶 / 盘上文件）',
  )
})

/**
 * 截图不该把临时 PNG 留在 tmpdir。
 *
 * **请注意：这一项不是「已验证能抓回归」的测试。**
 * 实测把 computer.mjs 退回旧实现后它**照样通过** —— 因为本环境没有交互桌面，
 * runPs 在 PowerShell 写出 PNG **之前**就失败了，文件根本没被创建，旧代码自然
 * 也没有残留。真正的泄漏需要「PNG 已生成、之后 readFile 等步骤才失败」，
 * 这个窗口在本环境无法稳定复现。
 *
 * 所以：computer.mjs 的 try/finally 修法靠**代码审查**保证（finally 必然执行 rm），
 * 这一项只作为「不留残留」这条不变量的基础守卫 —— 若将来有人删掉清理逻辑、
 * 且运行环境真的会生成 PNG，它才会红。
 */
test('截图无论成功失败，都不把临时 PNG 留在 tmpdir', async () => {
  process.env.LIMKENION_WEB_COMPUTER_USE = '1'
  const computer = await import('../server/computer.mjs')
  await computer.screenshot({ maxWidth: 800 }).catch(() => {})

  const left = (await readdir(tmpdir())).filter(n => n.startsWith('lk-screen-'))
  assert.deepStrictEqual(left, [], '临时 PNG 应被清掉，不能在 tmpdir 里堆积')
})

test('OAuth 回调：无 state 时走「授权回调无效」且过期清理逻辑不崩', async () => {
  const { handleMcpOAuthCallback } = await import('../server/mcpOAuth.mjs')
  // 没有 state → pendingAuth 里查不到 → 返回无效页。这条同时会把新加的
  // purgeExpiredAuth() 跑一遍（空 map / 无过期项），确保它不是从未执行的死路径。
  const html = await handleMcpOAuthCallback(new URLSearchParams())
  assert.match(html, /授权回调无效/)
})
