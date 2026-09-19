/**
 * 更新接口（/api/check-update、/api/update）的鉴权与 CSRF 防线。
 *
 * 起因：`/api/update` 是**有副作用**的接口 —— 下载更新包、覆盖安装目录、重启进程。
 * 它此前是 **GET** 且在回环绑定下 httpGate 不设防（httpGate 见 loopback 直接放行），
 * 于是任意网页只要 `<img src="http://127.0.0.1:8788/api/update">` 就能逼用户
 * 下载 448MB 更新并重启服务（跨站发 GET 不需要 CORS 授权，副作用照样发生）。
 *
 * 现在的规则：
 *   ① 两个接口都必须带 `x-limkenion-token` 头 —— 跨站页面设不了自定义头
 *      （会触发 CORS 预检，而本服务不下发任何 CORS 头），因此免疫 CSRF；
 *   ② `/api/update` 只接受 POST，GET 一律 405 —— 不允许 GET 触发状态变更。
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
let token

before(async () => {
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  // 故意不设 LIMKENION_UPDATE_URL：checkUpdate 会走 fail-closed 分支，
  // 于是「鉴权通过」的用例也**不会真的触发下载覆盖**。
  delete process.env.LIMKENION_UPDATE_URL

  const security = await import('../server/security.mjs')
  token = security.WS_TOKEN
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
const authHeader = () => ({ 'x-limkenion-token': token })

describe('/api/update：只接受 POST，GET 不能触发状态变更', () => {
  test('GET /api/update → 405（带 token 也不行）', async () => {
    const res = await call('/api/update', { headers: authHeader() })
    assert.equal(res.status, 405)
    assert.match(res.headers.get('allow') ?? '', /POST/)
  })

  test('HEAD /api/update → 405', async () => {
    const res = await call('/api/update', { method: 'HEAD', headers: authHeader() })
    assert.equal(res.status, 405)
  })
})

describe('两个更新接口都要求 token 头（防跨站页面）', () => {
  test('POST /api/update 无 token → 403，且不会去检查/下载更新', async () => {
    const res = await call('/api/update', { method: 'POST' })
    assert.equal(res.status, 403)
    assert.equal(await res.text(), 'Forbidden')
  })

  test('POST /api/update 带错 token → 403', async () => {
    const res = await call('/api/update', { method: 'POST', headers: { 'x-limkenion-token': 'wrong' } })
    assert.equal(res.status, 403)
  })

  test('GET /api/check-update 无 token → 403', async () => {
    const res = await call('/api/check-update')
    assert.equal(res.status, 403)
  })

  test('GET /api/check-update 带错 token → 403', async () => {
    const res = await call('/api/check-update', { headers: { 'x-limkenion-token': 'wrong' } })
    assert.equal(res.status, 403)
  })
})

describe('带对 token 时才放行（此时仍未配置更新源，走 fail-closed）', () => {
  test('GET /api/check-update → 200，available:false 并说明原因', async () => {
    const res = await call('/api/check-update', { headers: authHeader() })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.available, false)
    assert.match(body.reason, /LIMKENION_UPDATE_URL/)
  })

  test('POST /api/update → 200，ok:false「无可用更新」（不会下载覆盖）', async () => {
    const res = await call('/api/update', { method: 'POST', headers: authHeader() })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: false, reason: '无可用更新' })
  })
})

describe('其它路由不受影响', () => {
  test('未知路径的 POST 仍被挡（405）', async () => {
    const res = await call('/whatever', { method: 'POST', headers: authHeader() })
    assert.equal(res.status, 405)
  })

  test('未命中的静态路径走 SPA 回退（前端路由），不是把未知路径当文件伺服', async () => {
    const res = await call('/some-frontend-route')
    // dist/ 已构建时回退到 index.html（200）；未构建时是 503。
    assert.ok([200, 503].includes(res.status), `实际 ${res.status}`)
  })
})
