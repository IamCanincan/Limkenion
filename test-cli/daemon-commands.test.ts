/**
 * daemon 客户端命令测试：帮助文本、未知子命令、list 的存活判定与坏文件容忍。
 * LIMKENION_CONFIG_DIR 重定向到临时目录，状态文件手工种植——
 * 不派生真实守护进程（那归 smoke 测）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// ⚠ 在动态 import 之前设置：配置根目录记忆化
const tmpConfig = mkdtempSync(join(tmpdir(), 'limkenion-daemon-test-'))
process.env.LIMKENION_CONFIG_DIR = tmpConfig

const daemon = await import('../daemon/backgroundDaemon.js')

// 一个"已死"的 pid：spawn 一个立即退出的子进程
const dead = spawnSync(process.execPath, ['-e', ''])
const deadPid = dead.pid!
assert.ok(deadPid > 0)

function statusPath(name: string): string {
  // 与内部实现一致的安全名规则
  return join(tmpConfig, 'daemon', `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`)
}

function seed(name: string, payload: unknown): void {
  writeFileSync(statusPath(name), typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
}

function validStatus(name: string, pid: number): object {
  return {
    name,
    pid,
    port: 0,
    token: 'x'.repeat(48),
    startedAt: new Date().toISOString(),
    cwd: tmpConfig,
    sessionId: '00000000-0000-4000-8000-000000000000',
  }
}

/** 捕获一次调用期间写入 stdout/stderr 的文本。 */
function capture(fn: () => Promise<void> | void): { out: string; err: string } {
  let out = ''
  let err = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (chunk: unknown): boolean => {
    out += String(chunk)
    return true
  }
  process.stderr.write = (chunk: unknown): boolean => {
    err += String(chunk)
    return true
  }
  return (async () => {
    try {
      await fn()
    } finally {
      process.stdout.write = origOut
      process.stderr.write = origErr
    }
    return { out, err }
  })()
}

before(() => {
  mkdirTempDaemonDir()
})
function mkdirTempDaemonDir(): void {
  require('node:fs').mkdirSync(join(tmpConfig, 'daemon'), { recursive: true })
}

after(() => {
  rmSync(tmpConfig, { recursive: true, force: true })
})

describe('daemon 客户端命令', () => {
  it('无参数 / --help → 输出帮助文本（含子命令清单）', async () => {
    const { out } = await capture(() => daemon.daemonFastMain([]))
    assert.match(out, /start/)
    assert.match(out, /attach/)
    assert.match(out, /logs/)
    assert.match(out, /stop/)
    const { out: out2 } = await capture(() => daemon.daemonFastMain(['--help']))
    assert.match(out2, /用法/)
  })

  it('未知子命令 → 报错并置退出码 1', async () => {
    const { err } = await capture(() => daemon.daemonFastMain(['nonsense']))
    assert.match(err, /未知的 daemon 子命令/)
    assert.equal(process.exitCode, 1)
    process.exitCode = 0 // 复位，不影响后续用例
  })

  it('list：存活 pid 显示运行中，死 pid 显示已退出，坏 JSON 被跳过', async () => {
    seed('alive-1', validStatus('alive-1', process.pid))
    seed('dead-1', validStatus('dead-1', deadPid))
    seed('corrupt', '{ not valid json !!')

    const { out } = await capture(() => daemon.daemonList())
    assert.match(out, /alive-1/)
    assert.match(out, /运行中/)
    assert.match(out, /dead-1/)
    assert.match(out, /已退出/)
    assert.ok(!out.includes('corrupt'), '坏状态文件不应出现（但也不能让命令崩掉）')
  })

  it('list：没有状态文件时输出空态提示', async () => {
    rmSync(join(tmpConfig, 'daemon'), { recursive: true, force: true })
    mkdirTempDaemonDir()
    const { out } = await capture(() => daemon.daemonList())
    assert.match(out, /没有正在运行的后台会话/)
  })
})
