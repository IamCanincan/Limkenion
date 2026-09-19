/**
 * Bash 前台命令超时的两个关键行为（都踩过坑，见 MEMORY）：
 *
 *  1. **不等 close 直接结算**：超时后孙进程可能仍抓着 stdout 管道，等 `close`
 *     永不触发 → **整个回合挂死**。这里断言命令在超时附近就返回。
 *  2. **杀进程树而非只杀 shell**：只杀 cmd.exe/sh 会留下孤儿孙进程占着文件锁
 *     / 端口。这里断言超时后孙进程（node 夹具）确实被杀掉。
 *
 * 走 executeTool('Bash', ...) 这条真实公开路径，而不是直接调内部 execShell。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorkspace, rmDir } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '_fixtures', 'sleep-record-pid.mjs')

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
  await rmDir(ws.dir)
})

test('Bash 成功路径：命令秒回且输出正确', async () => {
  // 只测「超时」是不够的：重写 execShell 时如果成功路径挂住（比如等 close 等到
  // 超时），超时路径的测试照样全绿 —— 所以成功路径必须单独守一条。
  const started = Date.now()
  const out = await tools.executeTool('Bash', { command: 'echo hello-bash-probe' }, {})
  const elapsed = Date.now() - started
  assert.ok(elapsed < 10_000, `成功路径应秒回，实际 ${elapsed}ms（说明挂到了超时）`)
  assert.match(out, /hello-bash-probe/, `应回显命令输出，实际：${out}`)
})

test('Bash 前台超时：立即结算，不等 close（不会挂死回合）', async () => {
  const cmd = process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30'
  const started = Date.now()
  const out = await tools.executeTool('Bash', { command: cmd, timeout: 1200 }, {})
  const elapsed = Date.now() - started
  assert.ok(elapsed < 8000, `应在超时附近就返回，实际 ${elapsed}ms（说明等了 close）`)
  assert.match(out, /超时/)
})

test(
  'Bash 超时：孙进程被连根杀掉（不留孤儿占文件锁）',
  { skip: process.platform !== 'win32' ? '仅 Windows 验证进程树 kill' : false },
  async () => {
    // cmd /d /s /c 的引号规则很拧巴（会剥首尾引号，且参数上的引号可能原样透传给
    // 子进程）。所以这里把夹具复制到**不含空格**的临时工作区，整条命令不带引号，
    // 彻底绕开 cmd 的引号处理 —— 本测试要验证的是「进程树被杀」，不是 cmd 解析。
    const scriptPath = join(ws.dir, 'sleep-record-pid.mjs')
    const pidFile = join(ws.dir, 'orphan-pid.txt')
    await writeFile(scriptPath, await readFile(FIXTURE, 'utf8'), 'utf8')
    const cmd = `node ${scriptPath} ${pidFile}`
    const out = await tools.executeTool('Bash', { command: cmd, timeout: 1500 }, {})
    assert.match(out, /超时/, `命令应超时终止，实际输出：${out}`)

    // taskkill 是异步的（避免阻塞事件循环），给它时间落地
    await new Promise(r => setTimeout(r, 1500))
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    assert.ok(Number.isFinite(pid) && pid > 0, '孙进程应已写下自己的 pid')

    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    assert.strictEqual(
      alive,
      false,
      `超时后孙进程（pid ${pid}）仍存活 —— 说明只杀了 shell，没杀进程树`,
    )
  },
)
