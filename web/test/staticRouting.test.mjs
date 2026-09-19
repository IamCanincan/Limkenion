/**
 * 静态服务的**方法处理**与 SPA 回退。
 *
 * 这个文件的前身是 updateEndpoints.test.mjs（测 `/api/check-update`、`/api/update`
 * 两个更新接口的鉴权与 CSRF 防线）。桌面分发于 2026-09-19 整体删除后，那两个
 * 接口和它的更新器一起没了，**只保留与更新无关的这两条**：
 *   - 非 GET/HEAD 一律 405（现在静态服务没有任何需要变更状态的接口）；
 *   - 未命中的静态路径走 SPA 回退，而不是当成文件伺服出去。
 *
 * 用进程内起 HTTP 服务测（不 spawn 子进程、不依赖 dist 产物）。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { makeWorkspace } from './helpers.mjs'

let ws
let server
let base

before(async () => {
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'

  const { createHttpServer } = await import('../server/static.mjs')
  server = createHttpServer()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(r => server?.close(r))
  await ws?.cleanup()
})

const call = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts })

describe('方法处理：只放行 GET/HEAD', () => {
  test('未知路径的 POST 被挡（405）', async () => {
    const res = await call('/whatever', { method: 'POST' })
    assert.equal(res.status, 405)
  })

  test('POST 一个真实存在的路径同样被挡（不因为路径存在就放行）', async () => {
    const res = await call('/', { method: 'POST' })
    assert.equal(res.status, 405)
  })
})

describe('SPA 回退', () => {
  test('未命中的静态路径回退到前端路由，而不是当文件伺服', async () => {
    const res = await call('/some-frontend-route')
    // dist/ 已构建时回退到 index.html（200）；未构建时是 503。
    assert.ok([200, 503].includes(res.status), `实际 ${res.status}`)
  })
})
