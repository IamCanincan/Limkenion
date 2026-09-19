/**
 * 后台 Bash 任务的资源上限。
 *
 * 原先的淘汰逻辑是「超过 30 个时淘汰**已结束**的旧任务」—— 若 30 个**全在跑**，
 * 一个都淘汰不掉，bgTasks 与子进程数会无限增长（每个任务最多还占 64KB 输出）。
 * 长跑的模型攒出几十上百个后台任务就会吃满内存与进程表。
 *
 * 本测试起满上限 +1 个后台任务，断言第 31 个被**明确拒绝**并给出可操作提示，
 * 而不是静默继续堆积。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeWorkspace, rmDir } from './helpers.mjs'
import { join } from 'node:path'

let ws
let tools

before(async () => {
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  // 服务端模块在 import 时读环境变量，必须先设好再动态 import
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:1'
  tools = await import('../server/tools.mjs')
})

after(async () => {
  // 收掉测试期间起的后台任务，别留一堆孤儿进程
  tools?.stopAllBackgroundShells()
  await rmDir(ws.dir)
})

test('后台任务并发超限时明确拒绝，而不是静默堆积', async () => {
  const sleepCmd = process.platform === 'win32' ? 'ping -n 8 127.0.0.1' : 'sleep 8'
  let refused = ''
  for (let i = 0; i < 40 && !refused; i++) {
    const out = await tools.executeTool('Bash', { command: sleepCmd, run_in_background: true }, {})
    if (/并发上限/.test(out)) refused = out
  }
  assert.ok(refused, '超过并发上限时应明确拒绝（否则后台任务与子进程会无限增长）')
  assert.match(refused, /TaskStop|上限/, '拒绝信息应给出可操作的提示，不能只说失败')
})
