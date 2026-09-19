/**
 * HTTP 静态层韧性 / 守卫回归测试。
 *
 * 背景：static.mjs 的请求 handler 是 async，原先没有顶层 try/catch。畸形输入面
 * 其实已被各处分支妥善处理（decodeURIComponent→400、gate→401、method→405、
 * 前缀→403、stat/readFile→catch 回退、serveIndex→503），但「内部异步步骤意外
 * 抛错」（OAuth 换 token 网路失败、报告/更新读盘异常）会让该请求永远拿不到响应。
 * 这次给 handler 包了顶层 try/catch，统一回 500。
 *
 * 本测试验证两件事：
 *   1. 包了 try/catch 之后，既有的输入守卫没有退化（路径穿越→403、畸形 %→400）；
 *   2. 服务对任意请求都「有响应、不挂死」（happy path 200）。
 *
 * 注：新的「内部异常→500」分支没有可从外部简单触发的入口（OAuth/insights/checkUpdate
 * 都已内部吞错），属防御深度，由代码审查 + crashGuard 进程级兜底共同保障。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './helpers.mjs'

const PORT = 18907
let srv
let stateDir

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'limkenion-static-'))
  srv = await startServer({ port: PORT, env: { LIMKENION_WEB_STATE_DIR: stateDir } })
})
after(async () => {
  srv?.child.kill()
  await rm(stateDir, { recursive: true, force: true })
})

test('happy path：GET / 返回 200（handler 始终有响应、不挂死）', async () => {
  const res = await fetch(`${srv.base}/`, { signal: AbortSignal.timeout(5000) })
  assert.strictEqual(res.status, 200)
  const text = await res.text()
  assert.match(text, /Limkenion/)
})

test('路径穿越被拦：/..%2fpackage.json → 403', async () => {
  const res = await fetch(`${srv.base}/..%2fpackage.json`, { signal: AbortSignal.timeout(5000) })
  assert.strictEqual(res.status, 403, '不能让请求落到 dist 目录之外')
})

test('畸形百分号路径：/foo%zz → 400（decodeURIComponent 抛错被接住）', async () => {
  const res = await fetch(`${srv.base}/foo%zz`, { signal: AbortSignal.timeout(5000) })
  assert.strictEqual(res.status, 400)
})
