/**
 * 出网白名单闸门（server/egress.mjs）的回归防线。
 *
 * 这是**安全控制**：设置 LIMKENION_EGRESS_ALLOWLIST 后，服务端自己发出的请求
 * （模型 API / MCP / OAuth）只能打到白名单内的主机。此前没有任何测试覆盖 ——
 * 白名单配错了（比如 `*.` 不匹配裸域、非法 URL 反而被放行）用户看不出来。
 *
 * 注意：模块在 **加载时** 读取 `LIMKENION_EGRESS_ALLOWLIST`，所以两种配置
 * 必须用带 query 的 `import()` 各加载一份独立实例。
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'

// ---- 实例 1：未配置白名单（应全部放行）----
delete process.env.LIMKENION_EGRESS_ALLOWLIST
const open = await import('../server/egress.mjs?no-allowlist')

// ---- 实例 2：配置了白名单 ----
process.env.LIMKENION_EGRESS_ALLOWLIST = 'api.deepseek.com, *.GitHubUserContent.com ,'
const guarded = await import('../server/egress.mjs?with-allowlist')

const realFetch = globalThis.fetch
after(() => {
  globalThis.fetch = realFetch
})

describe('未配置白名单 → 全部放行（行为不变）', () => {
  test('任意主机都放行', () => {
    assert.equal(open.egressAllowed('https://anything.example/x'), true)
    assert.equal(open.egressAllowed('http://127.0.0.1:8080/'), true)
  })

  test('连非法 URL 也放行（此时闸门等于没开）', () => {
    assert.equal(open.egressAllowed('not a url'), true)
  })
})

describe('配置白名单后：精确匹配', () => {
  test('命中精确主机名 → 放行', () => {
    assert.equal(guarded.egressAllowed('https://api.deepseek.com/v1/chat'), true)
  })

  test('未命中 → 拒绝', () => {
    assert.equal(guarded.egressAllowed('https://evil.example/x'), false)
    assert.equal(guarded.egressAllowed('https://api.deepseek.com.evil.example/x'), false)
  })

  test('忽略端口（只比 hostname）', () => {
    assert.equal(guarded.egressAllowed('https://api.deepseek.com:8443/x'), true)
  })

  test('大小写不敏感（主机名与规则两侧都归一）', () => {
    assert.equal(guarded.egressAllowed('https://API.DEEPSEEK.COM/x'), true)
    // 规则写的是 *.GitHubUserContent.com，同样要能匹配小写主机名
    assert.equal(guarded.egressAllowed('https://raw.githubusercontent.com/x'), true)
  })

  test('规则列表里的空格与空项会被忽略', () => {
    assert.equal(guarded.egressAllowed('https://api.deepseek.com/x'), true)
  })
})

describe('配置白名单后：`*.` 前缀按后缀匹配', () => {
  test('匹配子域', () => {
    assert.equal(guarded.egressAllowed('https://raw.githubusercontent.com/a/b'), true)
    assert.equal(guarded.egressAllowed('https://objects.githubusercontent.com/x'), true)
  })

  test('不匹配裸域：`*.x.com` 不含 `x.com`（已知语义，配错会静默拒绝）', () => {
    assert.equal(guarded.egressAllowed('https://githubusercontent.com/x'), false)
  })

  test('后缀必须落在点上，不能是任意后缀', () => {
    assert.equal(guarded.egressAllowed('https://evilgithubusercontent.com/x'), false)
  })
})

describe('非法 URL 一律拒绝（不 fail-open）', () => {
  test('解析失败 → 拒绝，而不是放行', () => {
    assert.equal(guarded.egressAllowed('not a url'), false)
    assert.equal(guarded.egressAllowed(''), false)
    assert.equal(guarded.egressAllowed(undefined), false)
  })
})

describe('guardedFetch：拒绝时抛错，放行时真的发请求', () => {
  test('白名单外 → 抛错且**不会**触到 fetch', async () => {
    let called = false
    globalThis.fetch = async () => {
      called = true
      return new Response('should not happen')
    }
    await assert.rejects(() => guarded.fetch('https://evil.example/x'), /出网被拒绝/)
    assert.equal(called, false, '被拒绝的请求不应该真的发出去')
  })

  test('白名单内 → 正常调用底层 fetch 并透传结果', async () => {
    let seen = null
    globalThis.fetch = async url => {
      seen = String(url)
      return new Response('ok', { status: 200 })
    }
    const res = await guarded.fetch('https://api.deepseek.com/v1/models')
    assert.equal(seen, 'https://api.deepseek.com/v1/models')
    assert.equal(res.status, 200)
  })

  test('抛出的错误里带上被拒的地址，便于排查', async () => {
    globalThis.fetch = async () => new Response('x')
    await assert.rejects(() => guarded.fetch('https://nope.example/p'), /nope\.example/)
  })
})
