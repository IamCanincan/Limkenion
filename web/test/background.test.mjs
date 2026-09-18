/**
 * Bash 后台任务测试（run_in_background + timeout + TaskOutput/TaskStop）。
 *
 * 上游 CLI 原型 的 Bash 有 run_in_background / timeout；web 之前只有 30 秒硬编码
 * 超时、起个 dev server 就卡死。本文件证明三条链路：
 * ① 后台启动立即返回任务 ID；② TaskOutput 轮询输出与状态；③ TaskStop 真能杀掉进程树。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkspace } from './helpers.mjs'

let ws
let tools
let sessions

before(async () => {
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  const configDir = join(ws.dir, '.config')
  await mkdir(configDir, { recursive: true })
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.DEEPSEEK_API_KEY = 'test-key'
  sessions = await import('../server/sessions.mjs')
  tools = await import('../server/tools.mjs')
})

after(async () => {
  // 被杀掉的 shell 进程树释放 cwd 句柄需要一点时间（Windows EBUSY 是常态），重试两次
  for (let i = 0; i < 3; i++) {
    try {
      await ws?.cleanup()
      return
    } catch (err) {
      if (i === 2) return // 清不干净就算了 —— 临时目录由系统回收，别让清理失败掩盖测试结果
      await sleep(400)
    }
  }
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function bgId(result) {
  const m = String(result).match(/bg-\d+/)
  assert.ok(m, `结果里应有任务 ID：${result}`)
  return m[0]
}

describe('Bash run_in_background', () => {
  test('立即返回任务 ID，TaskOutput 轮询到输出与 done 状态', async () => {
    const s = sessions.createSession()
    const r = await tools.executeTool('Bash', { command: 'echo bg-hello', run_in_background: true }, { session: s })
    const id = await bgId(r)
    // 轮询最多 5 秒，等任务结束并出现输出
    let out = ''
    for (let i = 0; i < 50; i++) {
      out = await tools.executeTool('TaskOutput', { taskId: id }, { session: s })
      if (out.includes('done') && out.includes('bg-hello')) break
      await sleep(100)
    }
    assert.ok(out.includes('bg-hello'), `应能看到后台命令输出：${out}`)
    assert.ok(out.includes('done'), `最终应为 done 状态：${out}`)
  })

  test('TaskStop 终止长时间运行的后台任务', async () => {
    const s = sessions.createSession()
    const long = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30'
    const r = await tools.executeTool('Bash', { command: long, run_in_background: true }, { session: s })
    const id = await bgId(r)
    await sleep(300) // 让它真的跑起来
    const before = await tools.executeTool('TaskOutput', { taskId: id }, { session: s })
    assert.ok(before.includes('running'), `停止前应为 running：${before}`)
    const stopMsg = await tools.executeTool('TaskStop', { taskId: id }, { session: s })
    assert.ok(String(stopMsg).includes('已终止'), `应报告终止：${stopMsg}`)
    const afterOut = await tools.executeTool('TaskOutput', { taskId: id }, { session: s })
    assert.ok(afterOut.includes('stopped'), `停止后应为 stopped：${afterOut}`)
  })

  test('前台 Bash 支持 timeout 参数（不再硬编码 30 秒）', async () => {
    const s = sessions.createSession()
    const long = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30'
    const started = Date.now()
    const r = await tools.executeTool(
      'Bash',
      { command: long, timeout: 1500 },
      { session: s },
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 10_000, `应在 ~1.5s 超时返回，实际 ${elapsed}ms`)
    assert.ok(String(r).includes('超时'), `应报告超时：${String(r).slice(0, 200)}`)
  })

  test('不存在的后台任务 → TaskOutput 明确报错', async () => {
    const s = sessions.createSession()
    await assert.rejects(
      () => tools.executeTool('TaskOutput', { taskId: 'bg-99999' }, { session: s }),
      /后台任务不存在/,
    )
  })
})
