/**
 * /insights 测试。
 *
 * 两个重点：
 *   1. 统计必须来自**真实会话数据**（造数据 → 断言聚合结果），不是好看的数字；
 *   2. 报告路由有**文件名白名单** —— 这是唯一一条"从磁盘读文件回给浏览器"的路，
 *      路径穿越必须被拦住（用真的 HTTP 请求打一遍）。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './helpers.mjs'

let stateDir
let insights
let sessions

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lk-insights-'))
  process.env.LIMKENION_WEB_STATE_DIR = stateDir
  process.env.LIMKENION_WEB_WORKSPACE = stateDir
  // 故意不设 DEEPSEEK_API_KEY：走"没有 key 时优雅降级"这条路
  delete process.env.DEEPSEEK_API_KEY
  insights = await import('../server/insights.mjs')
  sessions = await import('../server/sessions.mjs')
})

after(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 4; i++) {
    try {
      await rm(stateDir, { recursive: true, force: true })
      break
    } catch {
      await sleep(200)
    }
  }
})

/** 造一个有真实形状的会话。 */
function makeSession(title, { messages = [], toolCalls = [], filesChanged = [] } = {}) {
  const s = sessions.createSession()
  s.title = title
  s.filesChanged = filesChanged
  s.turnCount = messages.filter(m => m.role === 'assistant').length
  s.toolCallCount = toolCalls.length
  s.usage = { inputTokens: 1200, outputTokens: 300 }
  s.messages = messages
  // 显式给 updatedAt：两个会话在同一毫秒内创建时排序会不稳定，断言就没意义了
  s.updatedAt = messages.reduce((m, x) => Math.max(m, x.timestamp ?? 0), 0) || 1
  return s
}

describe('聚合（对着真实会话数据）', () => {
  test('统计数字与工具分布取自会话里的实际记录', () => {
    // 用增量断言：不知道 /insights 之前进程里已经有几个会话（deleteSession
    // 在删空之后会自动补一个空会话），所以按差值算，不写绝对数。
    const before = insights.collectInsights().totals

    makeSession('会话 A', {
      messages: [
        { role: 'user', text: '帮我改代码', timestamp: 1000 },
        {
          role: 'assistant',
          text: '好的',
          timestamp: 2000,
          toolCalls: [
            { name: 'Read', status: 'done', durationMs: 10 },
            { name: 'Read', status: 'done', durationMs: 30 },
            { name: 'Write', status: 'error', durationMs: 5 },
          ],
        },
      ],
      toolCalls: ['Read', 'Read', 'Write'],
      filesChanged: ['a.ts', 'b.ts'],
    })
    makeSession('会话 B', {
      messages: [{ role: 'user', text: '再来', timestamp: 3000 }],
      filesChanged: ['a.ts'],
    })

    const d = insights.collectInsights()
    const t = d.totals
    assert.equal(t.sessions - before.sessions, 2)
    assert.equal(t.messages - before.messages, 3, '会话 A 2 条 + 会话 B 1 条')
    assert.equal(t.userMessages - before.userMessages, 2)
    assert.equal(t.assistantMessages - before.assistantMessages, 1)
    assert.equal(t.turns - before.turns, 1, 'turnCount 只算助手消息')
    assert.equal(t.toolCalls - before.toolCalls, 3)
    assert.equal(t.inputTokens - before.inputTokens, 2400)
    assert.equal(t.outputTokens - before.outputTokens, 600)
    assert.equal(t.filesChanged - before.filesChanged, 3)
    assert.equal(t.lastAt, 3000, '最近时间取真实的 message.timestamp')

    const read = d.tools.find(x => x.name === 'Read')
    assert.equal(read.calls, 2)
    assert.equal(read.errors, 0)
    assert.equal(read.avgMs, 20, '平均耗时取真实 durationMs')
    const write = d.tools.find(x => x.name === 'Write')
    assert.equal(write.errors, 1)
    assert.equal(write.avgMs, 5)

    assert.equal(d.files.find(f => f.path === 'a.ts').count, 2, '同一文件跨会话要累计')
    assert.equal(d.sessions[0].title, '会话 B', '会话排行按最近更新在前')
  })
})

describe('报告渲染', () => {
  /** 手搓一份统计数据，让渲染测试不依赖前面的用例造了什么。 */
  const sample = () => ({
    generatedAt: Date.now(),
    stateFile: 'C:/tmp/sessions.json',
    totals: {
      sessions: 2, messages: 9, userMessages: 5, assistantMessages: 4, turns: 4,
      toolCalls: 7, inputTokens: 12345, outputTokens: 678, filesChanged: 3,
      firstAt: Date.now() - 86400000, lastAt: Date.now(),
    },
    tools: [
      { name: 'Read', calls: 4, errors: 0, avgMs: 18, errorRate: 0 },
      { name: 'Write', calls: 3, errors: 1, avgMs: 5, errorRate: 1 / 3 },
    ],
    files: [{ path: 'web/server/engine.mjs', count: 2 }],
    sessions: [
      { title: '测试会话', messages: 9, turns: 4, toolCalls: 7, inputTokens: 12345, outputTokens: 678, updatedAt: Date.now(), worktree: null },
    ],
  })

  test('自包含：没有外部资源、没有脚本，统计数字都在', () => {
    const html = insights.renderInsightsHtml(sample(), '- 第一条洞察\n- 第二条洞察', ['一条警告'])
    assert.match(html, /^<!DOCTYPE html>/)
    assert.ok(!/<script/i.test(html), '报告不该带脚本')
    assert.ok(!/(src|href)=["']https?:/i.test(html), '不该引用外部资源（自包含）')
    assert.match(html, /Limkenion 使用洞察/)
    assert.match(html, /第一条洞察/)
    assert.match(html, /一条警告/)
    assert.match(html, /Read/)
    assert.match(html, /12\.3k/, 'token 要按可读格式显示')
  })

  test('HTML 转义：会话标题里的尖括号不能直接进 DOM', () => {
    const d = sample()
    d.sessions[0].title = '<img src=x onerror=alert(1)>'
    const html = insights.renderInsightsHtml(d, null, [])
    assert.ok(!html.includes('<img src=x'), '标题里的标签必须被转义')
    assert.match(html, /&lt;img src=x/)
  })

  test('没有模型叙述时不留空白，而是明说', () => {
    const html = insights.renderInsightsHtml(sample(), null, [])
    assert.match(html, /没有模型写的洞察/)
  })
})

describe('生成报告（无 API key 时降级）', () => {
  test('仍然出报告，只是没有洞察，并给出原因', async () => {
    const r = await insights.generateInsights()
    assert.match(r.name, /^insights-.*\.html$/)
    assert.match(r.url, /^\/insights\/insights-.*\.html$/)
    assert.equal(r.narrative, null)
    assert.ok(
      r.warnings.some(w => /DEEPSEEK_API_KEY/.test(w)),
      `应当说明为什么没有洞察：${JSON.stringify(r.warnings)}`,
    )
    const html = await readFile(r.path, 'utf8')
    assert.match(html, /DEEPSEEK_API_KEY/)
  })

  test('narrative: false 时完全不调模型', async () => {
    const r = await insights.generateInsights({ narrative: false })
    assert.equal(r.narrative, null)
    assert.equal(r.warnings.length, 0, '没要求叙述就不该有"模型失败"的警告')
  })

  test('latestReport 返回最新那份', async () => {
    const name = await insights.latestReport()
    assert.ok(name, '应当能找到刚生成的报告')
    assert.equal(await insights.readReport(name) !== null, true)
  })
})

describe('报告路由的白名单（安全）', () => {
  test('拒绝路径穿越、非白名单文件名、不存在的文件', async () => {
    assert.equal(await insights.readReport('../sessions.json'), null)
    assert.equal(await insights.readReport('..%2Fsessions.json'), null)
    assert.equal(await insights.readReport('sessions.json'), null, '不是报告文件名，不给读')
    assert.equal(await insights.readReport('insights-2020-01-01T00-00-00.html'), null, '不存在就是 null')
  })

  test('HTTP 路由：只读、按名取、穿越被拦', async () => {
    const port = 8871
    const srv = await startServer({
      port,
      env: { LIMKENION_WEB_STATE_DIR: stateDir, LIMKENION_WEB_WORKSPACE: stateDir },
    })
    try {
      // 服务端进程的 insights 目录与测试进程同一个（STATE_DIR 传了一样的值）
      const r = await insights.generateInsights({ narrative: false })
      await mkdir(join(stateDir, 'insights'), { recursive: true })

      const latest = await fetch(`${srv.base}/insights`)
      assert.equal(latest.status, 200)
      const body = await latest.text()
      assert.match(body, /Limkenion 使用洞察/)

      const byName = await fetch(`${srv.base}${r.url}`)
      assert.equal(byName.status, 200)

      // 穿越尝试：用**编码过的** `..`（普通 `../` 会被 fetch 自己规范化掉，
      // 测不到服务端的行为）。必须不是 200，且绝不能把会话状态文件吐出来。
      const evil = await fetch(`${srv.base}/insights/%2e%2e%2fsessions.json`)
      assert.notEqual(evil.status, 200, '不允许读出报告目录之外的文件')
      const evilText = await evil.text()
      assert.ok(!evilText.includes('"sessions"'), '绝不能返回会话状态文件的内容')

      // POST 也不许
      const posted = await fetch(`${srv.base}/insights`, { method: 'POST' })
      assert.equal(posted.status, 405)
    } finally {
      srv.child.kill()
    }
  })
})
