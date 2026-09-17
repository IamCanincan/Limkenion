/**
 * 工作流测试。
 *
 * 子代理用**假的 runAgent**（不花钱、不依赖 API）。这里要证明的是编排层本身：
 * 原语语义、预算上限、沙箱隔离、journal 与续跑，以及"脚本拿不到宿主能力"。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ws
let wf
let tools
let calls

before(async () => {
  ws = await mkdtemp(join(tmpdir(), 'lk-wf-'))
  process.env.LIMKENION_WEB_STATE_DIR = ws
  process.env.LIMKENION_WEB_WORKSPACE = ws
  wf = await import('../server/workflow.mjs')
  tools = await import('../server/tools.mjs')
})

after(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 4; i++) {
    try {
      await rm(ws, { recursive: true, force: true })
      break
    } catch {
      await sleep(200)
    }
  }
})

/** 假的子代理：把 prompt 回显回来，并记录调用。 */
function fakeAgent() {
  calls = []
  return async (prompt, description) => {
    calls.push({ prompt, description })
    return `结论(${prompt})`
  }
}

const run = (script, extra = {}) =>
  wf.runWorkflow({ script, runAgent: fakeAgent(), emit: () => {}, ...extra })

describe('原语语义', () => {
  test('agent()：派子代理并拿到结论', async () => {
    const r = await run(`
      const a = await agent('读 A 文件')
      const b = await agent('读 B 文件')
      return a + ' | ' + b
    `)
    assert.equal(r.status, 'done')
    assert.equal(r.result, '结论(读 A 文件) | 结论(读 B 文件)')
    assert.equal(calls.length, 2)
    assert.equal(r.agents.length, 2)
    assert.ok(r.agents.every(a => a.status === 'done'))
  })

  test('parallel()：并发执行，顺序按传入顺序返回', async () => {
    const r = await run(`
      const out = await parallel([
        () => agent('任务一'),
        () => agent('任务二'),
        () => agent('任务三'),
      ])
      return out.join(',')
    `)
    assert.equal(r.result, '结论(任务一),结论(任务二),结论(任务三)')
    assert.equal(calls.length, 3)
  })

  test('pipeline()：每个 item 顺序跑各阶段', async () => {
    const r = await run(`
      const out = await pipeline(
        ['x', 'y'],
        async (item) => { const s = await agent('第一步:' + item); return s },
        async (prev) => { const s = await agent('第二步:' + prev); return s },
      )
      return out.join(' / ')
    `)
    assert.match(r.result, /第二步:结论\(第一步:x\)/)
    assert.match(r.result, /第二步:结论\(第一步:y\)/)
    assert.equal(calls.length, 4, '2 个 item × 2 个阶段')
  })

  test('phase() 与 log() 会被记录（过程可见）', async () => {
    const notices = []
    const r = await wf.runWorkflow({
      script: `
        phase('探查')
        log('开始探查')
        await agent('看看目录')
        phase('汇总')
        return 'ok'
      `,
      runAgent: fakeAgent(),
      emit: m => notices.push(m),
    })
    assert.deepEqual(r.phases.map(p => p.name), ['探查', '汇总'])
    assert.ok(r.logs.includes('开始探查'))
    assert.ok(notices.some(n => n.includes('阶段：探查')))
  })

  test('meta 会被处理：export 语法不报错，name 被采用', async () => {
    const r = await run(`
      export const meta = { name: '我的调研', description: '并行查资料' }
      const a = await agent('查一下')
      return a
    `)
    assert.equal(r.status, 'done', `不该因为 export 语法失败：${r.error}`)
    assert.equal(r.name, '我的调研')
    assert.equal(r.description, '并行查资料')
  })

  test('args 逐字暴露给脚本（对象保持原样，不 JSON 化）', async () => {
    const r = await run(`return args.items.join('+') + '|' + args.n`, { args: { items: ['a', 'b'], n: 3 } })
    assert.equal(r.result, 'a+b|3')
  })

  test('脚本抛错 → run 记为 error，错误信息带"已经跑完几个子代理"', async () => {
    await assert.rejects(
      () =>
        wf.runWorkflow({
          script: `await agent('先跑一个'); throw new Error('脚本自己炸了')`,
          runAgent: fakeAgent(),
        }),
      /脚本自己炸了[\s\S]*已经跑完的子代理：1 个/,
    )
  })
})

describe('沙箱（脚本拿不到宿主能力）', () => {
  test('require / process / fs / fetch 都不存在', async () => {
    const r = await run(`
      return JSON.stringify({
        require: typeof require,
        process: typeof process,
        fetch: typeof fetch,
        globalThisProcess: typeof globalThis.process,
        setTimeout: typeof setTimeout,
      })
    `)
    const got = JSON.parse(r.result)
    assert.equal(got.require, 'undefined', '不能拿到 require')
    assert.equal(got.process, 'undefined', '不能拿到 process')
    assert.equal(got.fetch, 'undefined', '不能拿到 fetch')
    assert.equal(got.globalThisProcess, 'undefined', 'globalThis 上也不能有 process')
  })

  test('顶层同步死循环被 5 秒超时兜住（不会把服务挂死）', async () => {
    const started = Date.now()
    await assert.rejects(
      () => wf.runWorkflow({ script: 'while (true) {}', runAgent: fakeAgent() }),
      /执行失败|timeout|Script execution timed out/i,
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 9000, `应当被超时终止，实际用了 ${elapsed}ms`)
  })
})

describe('预算', () => {
  test('超过子代理上限 → 明确报错并提示怎么提高上限', async () => {
    await assert.rejects(
      () => wf.runWorkflow({ script: 'await agent("1"); await agent("2"); await agent("3")', runAgent: fakeAgent(), maxAgents: 2 }),
      /已达子代理上限（2 个）[\s\S]*max_agents/,
    )
  })

  test('并发有上限：同时最多跑 4 个（默认）', async () => {
    let active = 0
    let peak = 0
    const slow = async prompt => {
      active++
      peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 30))
      active--
      return prompt
    }
    await wf.runWorkflow({
      script: `await parallel(${JSON.stringify(Array.from({ length: 8 }, (_, i) => i))}.map(i => () => agent('t' + i)))`,
      runAgent: slow,
    })
    assert.ok(peak <= wf.DEFAULT_CONCURRENCY, `并发峰值 ${peak} 超过上限 ${wf.DEFAULT_CONCURRENCY}`)
    assert.ok(peak > 1, 'parallel 应当真的并发（否则这个测试没意义）')
  })
})

describe('journal 与续跑', () => {
  test('运行会落盘，listRuns / loadRun 都能读到', async () => {
    const r = await run(`await agent('落盘测试'); return 'ok'`)
    const loaded = await wf.loadRun(r.runId)
    assert.ok(loaded, '应当能从盘上读回运行记录')
    assert.equal(loaded.result, 'ok')
    const list = await wf.listRuns(50)
    assert.ok(list.some(x => x.runId === r.runId))
    const raw = await readFile(join(wf.WORKFLOWS_DIR, `${r.runId}.json`), 'utf8')
    assert.ok(raw.includes('落盘测试'))
  })

  test('resume_from 复用已完成的 agent（prompt 未变的那些不重跑）', async () => {
    const first = await run(`await agent('复用我'); await agent('也复用我'); return 'v1'`)
    assert.equal(calls.length, 2)

    const secondAgent = fakeAgent()
    const second = await wf.runWorkflow({
      script: `await agent('复用我'); await agent('也复用我'); await agent('这是新的'); return 'v2'`,
      runAgent: secondAgent,
      resumeFrom: first.runId,
    })
    assert.equal(second.result, 'v2')
    assert.equal(calls.length, 1, `只有新增的那个 agent 该被真的执行，实际：${JSON.stringify(calls.map(c => c.prompt))}`)
    assert.equal(second.agents.filter(a => a.status === 'reused').length, 2)
  })

  test('续跑一个不存在的 run 会明确报错', async () => {
    await assert.rejects(
      () => wf.runWorkflow({ script: 'return 1', runAgent: fakeAgent(), resumeFrom: 'wf_不存在' }),
      /找不到要续跑的运行/,
    )
  })
})

describe('摘要输出', () => {
  test('formatRun 与 workflowsSummary 都能读', async () => {
    const r = await run(`await agent('摘要测试'); return 'done'`)
    const one = wf.formatRun(r, { verbose: true })
    assert.match(one, /摘要测试/)
    assert.match(one, /最终结果：done/)
    const summary = await wf.workflowsSummary()
    assert.match(summary, /工作流：记录 \d+ 条/)
    assert.match(summary, /只读/)
    assert.match(summary, /\/workflows show/)
  })
})

describe('工具层接线', () => {
  test('没有 runWorkflow 时报错清楚', async () => {
    await assert.rejects(() => tools.executeTool('Workflow', { script: 'return 1' }, {}), /未挂载工作流执行器/)
  })

  test('只给 name（预定义工作流）时如实说明未支持', async () => {
    await assert.rejects(
      () => tools.executeTool('Workflow', { name: 'some-workflow' }, { runWorkflow: async () => ({}) }),
      /不支持按名字调用预定义工作流/,
    )
  })

  test('scriptPath 走沙箱校验（不能读任意路径）', async () => {
    await assert.rejects(
      () =>
        tools.executeTool(
          'Workflow',
          { scriptPath: '../../etc/passwd' },
          { session: { id: 's', filesChanged: [] }, runWorkflow: async () => ({}) },
        ),
      /越界/,
    )
  })

  test('给了 script 时能跑通并返回摘要', async () => {
    const out = await tools.executeTool(
      'Workflow',
      { script: `export const meta = { name: '接线测试' }\nconst a = await agent('x')\nreturn a` },
      {
        session: { id: 's', filesChanged: [] },
        runWorkflow: opts => wf.runWorkflow({ ...opts, runAgent: fakeAgent() }),
      },
    )
    assert.match(out, /工作流 .* 完成（接线测试）/)
    assert.match(out, /结论\(x\)/)
  })
})
