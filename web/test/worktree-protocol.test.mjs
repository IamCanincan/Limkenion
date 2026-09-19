/**
 * "选分支启动新会话" 的**协议层**测试：起真服务（工作区指向一个真的 git 仓库）、
 * 连 WS、跑 git_branches 与 new_session(worktree)。
 *
 * 单测覆盖不到 WS 接线（case 名/字段名错都不会红），所以要有这一层。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startServer, fetchToken, rmDir } from './helpers.mjs'

let PORT = 0  // 0 = 让系统分配端口：硬编码端口在 CI 上可能被别的进程占用（EADDRINUSE）
let repo
let stateDir
let srv
let ws

const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function waitFor(type, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs)
    const onMsg = raw => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== type) return
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve(msg)
    }
    ws.on('message', onMsg)
  })
}

before(async () => {
  // 一个真的 git 仓库当工作区
  repo = await mkdtemp(join(tmpdir(), 'lk-wtproto-repo-'))
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'src', 'a.txt'), 'a\n', 'utf8')
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'test'])
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  git(['branch', 'feature/from-ui'])

  stateDir = await mkdtemp(join(tmpdir(), 'lk-wtproto-state-'))
  srv = await startServer({
    port: PORT,
    env: { LIMKENION_WEB_STATE_DIR: stateDir, LIMKENION_WEB_WORKSPACE: repo },
  })
  PORT = srv.port
  const token = await fetchToken(srv.base)
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await waitFor('hello')
})

after(async () => {
  try {
    ws?.close()
  } catch {
    /* 已关 */
  }
  srv?.child.kill()
  await rmDir(stateDir)
  await rmDir(repo)
})

test('WS git_branches：返回仓库分支', async () => {
  const pending = waitFor('git_branches')
  ws.send(JSON.stringify({ type: 'git_branches' }))
  const res = await pending
  assert.ok(Array.isArray(res.branches), 'branches 应是数组')
  assert.ok(res.branches.includes('main'), `应含 main，实际 ${res.branches.join(',')}`)
})

test('WS new_session(worktree)：按指定分支真的建出 worktree', async () => {
  const pending = waitFor('session_messages')
  ws.send(
    JSON.stringify({
      type: 'new_session',
      worktree: true,
      branch: 'feature/from-ui',
      worktreeName: 'from-ui',
    }),
  )
  await pending

  // 端到端证据：git 里真的多了一个 worktree，且指向我们指定的分支
  const list = git(['worktree', 'list'])
  assert.match(list, /feature\/from-ui/, `git worktree list 应含该分支，实际：\n${list}`)
  assert.ok(
    existsSync(join(repo, '.limkenion', 'worktrees', 'from-ui')),
    'worktree 目录应建在仓库的 .limkenion/worktrees 下',
  )
})
