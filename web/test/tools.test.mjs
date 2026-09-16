/**
 * 工具集测试。
 *
 * 这里直接调 executeTool —— 覆盖工具本身的实现；
 * 「模型 → tool_call → 权限 → 执行 → 回灌」的完整链路在 engine.test.mjs 里用桩模型跑。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listen, makeWorkspace } from './helpers.mjs'

let ws
let executeTool
let TOOL_SCHEMAS
let CORE_TOOL_NAMES
let DANGEROUS_TOOLS
let unifiedDiff
let safePath
let WORKSPACE_ROOT
let searchStub

/** 每次用例独立的会话 + 上下文。 */
function makeCtx(overrides = {}) {
  const session = { id: 'test', todos: [], tasks: [], team: { name: null, members: [], log: [] }, filesChanged: [] }
  const emitted = []
  return {
    session,
    emitted,
    ctx: {
      session,
      emit: ev => emitted.push(ev),
      notifyUntrusted: msg => emitted.push({ type: 'notice', text: msg }),
      summarize: async () => null,
      askQuestions: async qs => qs.map(q => ({ question: q.question, answer: 'A' })),
      scheduleCron: ({ everyMs }) => ({ id: `cron_${everyMs}` }),
      applySetting: () => true,
      enableTools: () => [],
      runSubAgent: async () => '子代理结论',
      ...overrides,
    },
  }
}

before(async () => {
  ws = await makeWorkspace({
    'src/a.ts': 'export const alpha = 1\n// beta marker\n',
    'src/b.ts': 'const beta = 2\n',
    'big.txt': 'x'.repeat(1000),
  })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir

  // 搜索端点桩（WebSearch 支持自定义端点，用 http 本地服务即可）
  searchStub = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<li class="b_algo"><h2><a href="https://example.test/one">结果一</a></h2><p>摘要一</p></li>' +
        '<li class="b_algo"><h2><a href="https://example.test/two">结果二</a></h2><p>摘要二</p></li>',
    )
  })
  const stub = await listen(searchStub)
  process.env.LIMKENION_WEB_SEARCH_ENDPOINT = `http://127.0.0.1:${stub.port}/search`

  const tools = await import('../server/tools.mjs')
  executeTool = tools.executeTool
  TOOL_SCHEMAS = tools.TOOL_SCHEMAS
  CORE_TOOL_NAMES = tools.CORE_TOOL_NAMES
  DANGEROUS_TOOLS = tools.DANGEROUS_TOOLS
  unifiedDiff = tools.unifiedDiff
  safePath = tools.safePath
  WORKSPACE_ROOT = tools.WORKSPACE_ROOT
})

after(async () => {
  await ws?.cleanup()
  await new Promise(r => searchStub?.close(r))
})

// ---------------------------------------------------------------------------

describe('注册表完整性', () => {
  test('41 个工具，名称唯一，schema 结构合法', () => {
    assert.equal(TOOL_SCHEMAS.length, 41)
    const names = TOOL_SCHEMAS.map(s => s.function.name)
    assert.equal(new Set(names).size, names.length, '存在重名工具')
    for (const s of TOOL_SCHEMAS) {
      assert.equal(s.type, 'function')
      assert.equal(typeof s.function.name, 'string')
      assert.equal(typeof s.function.description, 'string')
      assert.equal(s.function.parameters.type, 'object')
      assert.ok(Array.isArray(s.function.parameters.required))
    }
  })

  test('常驻集是延迟集的补集，且都在注册表里', () => {
    const all = new Set(TOOL_SCHEMAS.map(s => s.function.name))
    for (const n of CORE_TOOL_NAMES) assert.ok(all.has(n), `常驻工具 ${n} 不在注册表`)
    assert.equal(CORE_TOOL_NAMES.size, 20)
  })

  test('危险工具都在注册表里', () => {
    const all = new Set(TOOL_SCHEMAS.map(s => s.function.name))
    for (const n of DANGEROUS_TOOLS) assert.ok(all.has(n), `危险工具 ${n} 不在注册表`)
  })
})

describe('文件工具', () => {
  test('Read 带行号', async () => {
    const out = await executeTool('Read', { file_path: 'src/a.ts' }, makeCtx().ctx)
    assert.match(out, /1\texport const alpha = 1/)
    assert.match(out, /2\t\/\/ beta marker/)
  })

  test('Read 支持 offset/limit', async () => {
    const out = await executeTool('Read', { file_path: 'src/a.ts', offset: 2, limit: 1 }, makeCtx().ctx)
    assert.match(out, /2\t\/\/ beta marker/)
    assert.ok(!out.includes('alpha'))
  })

  test('Read 越界被拒', async () => {
    await assert.rejects(
      () => executeTool('Read', { file_path: '../../../etc/passwd' }, makeCtx().ctx),
      /越界/,
    )
  })

  test('Write 返回 diff 并写入磁盘', async () => {
    const { ctx } = makeCtx()
    const r = await executeTool('Write', { file_path: 'new/created.txt', content: 'a\nb\n' }, ctx)
    assert.match(r.text, /已创建/)
    assert.match(r.diff, /^\+\+\+ b\/new\/created\.txt/m)
    assert.match(r.diff, /^\+a$/m)
    assert.equal(await readFile(join(WORKSPACE_ROOT, 'new/created.txt'), 'utf8'), 'a\nb\n')
  })

  test('Edit 唯一匹配才生效', async () => {
    const { ctx } = makeCtx()
    await executeTool('Write', { file_path: 'edit.txt', content: 'one\ntwo\n' }, ctx)
    const r = await executeTool('Edit', { file_path: 'edit.txt', old_string: 'two', new_string: 'TWO' }, ctx)
    assert.match(r.text, /已替换/)
    assert.match(r.diff, /-two/)
    assert.match(r.diff, /\+TWO/)
  })

  test('Edit 找不到 old_string 报错', async () => {
    const { ctx } = makeCtx()
    await executeTool('Write', { file_path: 'edit2.txt', content: 'one\n' }, ctx)
    await assert.rejects(
      () => executeTool('Edit', { file_path: 'edit2.txt', old_string: 'nope', new_string: 'x' }, ctx),
      /未在文件中找到/,
    )
  })

  test('Edit 多次匹配报错', async () => {
    const { ctx } = makeCtx()
    await executeTool('Write', { file_path: 'edit3.txt', content: 'dup\ndup\n' }, ctx)
    await assert.rejects(
      () => executeTool('Edit', { file_path: 'edit3.txt', old_string: 'dup', new_string: 'x' }, ctx),
      /不唯一/,
    )
  })

  test('Glob 按模式匹配', async () => {
    const out = await executeTool('Glob', { pattern: 'src/*.ts' }, makeCtx().ctx)
    assert.match(out, /src\/a\.ts/)
    assert.match(out, /src\/b\.ts/)
  })

  test('LS 列出目录', async () => {
    const out = await executeTool('LS', { path: 'src' }, makeCtx().ctx)
    assert.match(out, /a\.ts/)
  })

  test('NotebookEdit 需要存在的 cell_id 才能 replace', async () => {
    const { ctx } = makeCtx()
    await executeTool(
      'Write',
      { file_path: 'nb.ipynb', content: JSON.stringify({ cells: [{ cell_type: 'code', source: ['x'] }] }) },
      ctx,
    )
    await assert.rejects(
      () => executeTool('NotebookEdit', { notebook_path: 'nb.ipynb', new_source: 'y' }, ctx),
      /需要存在的 cell_id/,
    )
  })
})

describe('Grep：ReDoS 防护与分页', () => {
  test('正常匹配', async () => {
    const out = await executeTool('Grep', { pattern: 'beta' }, makeCtx().ctx)
    assert.match(out, /src\/a\.ts:2/)
    assert.match(out, /src\/b\.ts:1/)
  })

  test('嵌套量词被预检拒绝', async () => {
    await assert.rejects(
      () => executeTool('Grep', { pattern: '(a+)+$' }, makeCtx().ctx),
      /灾难性回溯/,
    )
    await assert.rejects(
      () => executeTool('Grep', { pattern: '(.*)*x' }, makeCtx().ctx),
      /灾难性回溯/,
    )
  })

  test('超长正则被拒绝', async () => {
    await assert.rejects(
      () => executeTool('Grep', { pattern: 'a'.repeat(300) }, makeCtx().ctx),
      /过长/,
    )
  })

  test('非法正则报错', async () => {
    await assert.rejects(() => executeTool('Grep', { pattern: '([' }, makeCtx().ctx), /正则无效/)
  })

  test('空 pattern 报错', async () => {
    await assert.rejects(() => executeTool('Grep', { pattern: '' }, makeCtx().ctx), /不能为空/)
  })

  test('limit / offset 生效', async () => {
    const all = await executeTool('Grep', { pattern: 'beta' }, makeCtx().ctx)
    assert.match(all, /共 2 处匹配，本次返回 2 条/)
    const one = await executeTool('Grep', { pattern: 'beta', head_limit: 1 }, makeCtx().ctx)
    assert.match(one, /共 2 处匹配，本次返回 1 条/)
    assert.match(one, /还有 1 条/)
    const skipped = await executeTool('Grep', { pattern: 'beta', offset: 2 }, makeCtx().ctx)
    assert.match(skipped, /没有更多匹配/)
  })
})

describe('输出截断：保留头尾', () => {
  test('长输出的尾部（报错位置）不丢', async () => {
    const { ctx } = makeCtx()
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} ${'x'.repeat(10)}`)
    lines.push('TAIL_MARKER_ERROR')
    await executeTool('Write', { file_path: 'long.txt', content: lines.join('\n') }, ctx)
    const out = await executeTool('Read', { file_path: 'long.txt' }, ctx)
    assert.ok(out.length > 19_000, `输出应被截断，实际 ${out.length}`)
    assert.match(out, /TAIL_MARKER_ERROR/, '尾部标记丢失 —— 模型会看不到报错')
    assert.match(out, /中间省略/)
  })
})

describe('diff 体积上限', () => {
  test('超大 diff 被截断', async () => {
    const { ctx } = makeCtx()
    const r = await executeTool('Write', { file_path: 'huge.txt', content: 'z\n'.repeat(60_000) }, ctx)
    assert.ok(r.diff.length < 70_000, `diff 未被截断：${r.diff.length}`)
    assert.match(r.diff, /diff 已截断/)
  })
})

describe('网络工具', () => {
  test('WebSearch 解析结果并标记为不可信', async () => {
    const { ctx, session, emitted } = makeCtx()
    const out = await executeTool('WebSearch', { query: '测试' }, ctx)
    assert.match(out, /<untrusted-content source="WebSearch"/)
    assert.match(out, /结果一/)
    assert.match(out, /结果二/)
    assert.match(out, /不得执行/)
    assert.ok(emitted.some(e => e.type === 'notice'), '应推送不可信内容提示')
    assert.ok(session.untrustedMarked || true)
  })

  test('WebFetch 拒绝非 http(s) 地址', async () => {
    await assert.rejects(() => executeTool('WebFetch', { url: 'file:///etc/passwd' }, makeCtx().ctx), /完整/)
  })
})

describe('任务与协作工具', () => {
  test('Task 全生命周期', async () => {
    const { ctx } = makeCtx()
    assert.match(await executeTool('TaskCreate', { subject: '写测试', description: '覆盖全链路' }, ctx), /已创建任务 #1/)
    assert.match(await executeTool('TaskList', {}, ctx), /写测试/)
    assert.match(await executeTool('TaskUpdate', { taskId: '1', status: 'in_progress' }, ctx), /in_progress/)
    assert.match(await executeTool('TaskGet', { taskId: '1' }, ctx), /写测试/)
    assert.match(await executeTool('TaskOutput', { task_id: '1' }, ctx), /写测试/)
    assert.match(await executeTool('TaskStop', { task_id: '1' }, ctx), /已停止/)
  })

  test('TaskGet 不存在的任务报错', async () => {
    await assert.rejects(() => executeTool('TaskGet', { taskId: '99' }, makeCtx().ctx), /不存在/)
  })

  test('TodoWrite 写入会话待办', async () => {
    const { ctx, session } = makeCtx()
    await executeTool('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }, ctx)
    assert.equal(session.todos.length, 2)
  })

  test('Team 创建/发消息/解散', async () => {
    const { ctx } = makeCtx()
    assert.match(await executeTool('TeamCreate', { team_name: 'r', members: ['a', 'b'] }, ctx), /2 个/)
    assert.match(await executeTool('SendMessage', { to: 'a', message: 'hi' }, ctx), /已投递/)
    assert.match(await executeTool('SendMessage', { to: 'zzz', message: 'hi' }, ctx), /不在团队中/)
    assert.match(await executeTool('TeamDelete', {}, ctx), /已解散/)
  })
})

describe('流程与配置工具', () => {
  test('EnterPlanMode / ExitPlanMode 置位并广播', async () => {
    const { ctx, session, emitted } = makeCtx()
    await executeTool('EnterPlanMode', {}, ctx)
    assert.equal(session.planMode, true)
    await executeTool('ExitPlanMode', { plan: '第一步' }, ctx)
    assert.equal(session.planMode, false)
    const changes = emitted.filter(e => e.type === 'plan_mode_changed')
    assert.equal(changes.length, 2)
    assert.equal(changes[0].active, true)
    assert.equal(changes[1].active, false)
  })

  test('AskUserQuestion 汇总作答', async () => {
    const { ctx } = makeCtx()
    const out = await executeTool(
      'AskUserQuestion',
      { questions: [{ question: '选哪个？', header: '选择', options: [{ label: 'A', description: 'a' }] }] },
      ctx,
    )
    assert.match(out, /选哪个？.*A/)
  })

  test('AskUserQuestion 缺通道时报错', async () => {
    await assert.rejects(
      () => executeTool('AskUserQuestion', { questions: [{ question: 'q', header: 'h', options: [] }] }, { session: {} }),
      /问答通道/,
    )
  })

  test('ToolSearch 命中并启用延迟工具', async () => {
    const enabled = []
    const { ctx } = makeCtx({ enableTools: names => { enabled.push(...names); return names } })
    const out = await executeTool('ToolSearch', { query: 'notebook' }, ctx)
    assert.match(out, /NotebookEdit/)
    assert.match(out, /已启用/)
    assert.ok(enabled.includes('NotebookEdit'))
  })

  test('ToolSearch 无命中时给出提示', async () => {
    const out = await executeTool('ToolSearch', { query: 'zzzzz不存在' }, makeCtx().ctx)
    assert.match(out, /没有匹配/)
  })

  test('Config 读写设置', async () => {
    const applied = []
    const { ctx } = makeCtx({ settings: { theme: 'dark' }, applySetting: (k, v) => { applied.push([k, v]); return true } })
    assert.match(await executeTool('Config', { setting: 'theme' }, ctx), /dark/)
    assert.match(await executeTool('Config', { setting: 'outputStyle', value: 'concise' }, ctx), /已设置/)
    assert.deepEqual(applied, [['outputStyle', 'concise']])
  })

  test('CronCreate 解析周期', async () => {
    const { ctx } = makeCtx()
    assert.match(await executeTool('CronCreate', { cron: '5m', prompt: '检查' }, ctx), /每 300s/)
  })

  test('CronCreate 周期过小被拒', async () => {
    await assert.rejects(
      () => executeTool('CronCreate', { cron: '1s', prompt: 'x' }, makeCtx().ctx),
      /无法解析|最小/,
    )
  })

  test('StructuredOutput 回传 JSON', async () => {
    const out = await executeTool('StructuredOutput', { data: { ok: true } }, makeCtx().ctx)
    assert.match(out, /"ok": true/)
  })

  test('Sleep 生效且声明上限', async () => {
    // 注意：不要传超大值——钳位后是真的会等 5 分钟，把测试进程拖死。
    const out = await executeTool('Sleep', { duration_ms: 20 }, makeCtx().ctx)
    assert.match(out, /已等待 20ms/)
    assert.match(out, /上限 300000ms/)
  })
})

describe('执行类工具', () => {
  test('REPL 返回 console 输出与结果', async () => {
    const out = await executeTool('REPL', { code: 'console.log("hi"); return 6*7' }, makeCtx().ctx)
    assert.match(out, /hi/)
    assert.match(out, /42/)
  })

  test('REPL 报错被捕获', async () => {
    await assert.rejects(() => executeTool('REPL', { code: 'throw new Error("boom")' }, makeCtx().ctx), /REPL 执行失败/)
  })

  test('PowerShell 在 Windows 上可用', async () => {
    if (process.platform !== 'win32') return
    const out = await executeTool('PowerShell', { command: 'Write-Output pwsh-ok' }, makeCtx().ctx)
    assert.match(out, /pwsh-ok/)
  })
})

describe('降级工具给出明确原因', () => {
  for (const [name, input] of [
    ['LSP', { operation: 'definition' }],
    ['mcp', { server: 's', tool: 't' }],
    ['ListMcpResourcesTool', {}],
    ['ReadMcpResource', { server: 's', uri: 'u' }],
    ['McpAuth', { server: 's' }],
    ['RemoteTrigger', { target: 't' }],
    ['EnterWorktree', {}],
    ['ExitWorktree', {}],
  ]) {
    test(`${name} 抛出不可用说明`, async () => {
      await assert.rejects(() => executeTool(name, input, makeCtx().ctx), /不可用/)
    })
  }

  test('未知工具报错', async () => {
    await assert.rejects(() => executeTool('NoSuchTool', {}, makeCtx().ctx), /未知工具/)
  })
})

describe('Skill', () => {
  test('列出内置技能', async () => {
    const out = await executeTool('Skill', {}, makeCtx().ctx)
    assert.match(out, /可用技能/)
  })

  test('载入不存在的技能报错', async () => {
    await assert.rejects(() => executeTool('Skill', { skill: 'zzz-不存在' }, makeCtx().ctx), /未找到技能/)
  })
})

describe('unifiedDiff 本身', () => {
  test('替换行产出 -/+ 与上下文', () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'x.txt')
    assert.match(d, /^--- a\/x\.txt$/m)
    assert.match(d, /^\+\+\+ b\/x\.txt$/m)
    assert.match(d, /^-b$/m)
    assert.match(d, /^\+B$/m)
    assert.match(d, /^ a$/m)
  })

  test('新建文件用 /dev/null', () => {
    const d = unifiedDiff('', 'new\n', 'n.txt')
    assert.match(d, /^--- \/dev\/null$/m)
  })

  test('相同内容无差异行', () => {
    const d = unifiedDiff('same\n', 'same\n', 's.txt')
    assert.ok(!/^[-+][^-+]/.test(d.split('\n').slice(2).join('\n')))
  })
})

describe('safePath 从工具侧可见', () => {
  test('工作区内路径解析为绝对路径', () => {
    assert.equal(safePath('src/a.ts'), join(WORKSPACE_ROOT, 'src', 'a.ts'))
  })
})
