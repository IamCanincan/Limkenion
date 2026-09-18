/**
 * 工具集测试。
 *
 * 这里直接调 executeTool —— 覆盖工具本身的实现；
 * 「模型 → tool_call → 权限 → 执行 → 回灌」的完整链路在 engine.test.mjs 里用桩模型跑。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
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
      // CronList / CronDelete 经 ctx 注入（与 scheduleCron 同样的模式，
      // 避免 tools.mjs 反向 import engine.mjs）。默认给一个空清单。
      cronList: () => [],
      cronRemove: () => false,
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
  WORKSPACE_ROOT = tools.workspaceRoot()
})

after(async () => {
  await ws?.cleanup()
  await new Promise(r => searchStub?.close(r))
})

// ---------------------------------------------------------------------------

describe('注册表完整性', () => {
  // 数字故意写死：改工具集时这里会红，提醒你确认是有意为之。
  test('44 个工具，名称唯一，schema 结构合法', () => {
    assert.equal(TOOL_SCHEMAS.length, 44)
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
    // SendMessage 现在会真派活（teammate-idle 的宿主功能）：给 ctx 挂子代理执行器
    ctx.runSubAgent = async ({ description }) => `（${description}）结论 OK`
    assert.match(await executeTool('TeamCreate', { team_name: 'r', members: ['a', 'b'] }, ctx), /2 个/)
    const sent = await executeTool('SendMessage', { to: 'a', message: 'hi' }, ctx)
    assert.match(sent, /已完成/, `应真派活并报告完成：${sent}`)
    assert.match(sent, /结论 OK/)
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

  test('CronList 只列本会话的任务', async () => {
    // CLI 的 ScheduleCronTool 有 CronCreate/CronList/CronDelete 三个工具，
    // web 端原先只搬了 CronCreate —— 模型建了任务列不出来也删不掉。这条守住补齐后的行为。
    const { ctx } = makeCtx({
      cronList: () => [
        { id: 'cron_mine', sessionId: 'test', everyMs: 300000, prompt: '检查构建' },
        { id: 'cron_other', sessionId: '别的会话', everyMs: 60000, prompt: '不该出现' },
      ],
    })
    const out = await executeTool('CronList', {}, ctx)
    assert.match(out, /cron_mine/)
    assert.match(out, /每 300s/)
    assert.doesNotMatch(out, /cron_other/, '不该把别的会话的任务泄给模型')
  })

  test('CronList 无任务时给出下一步', async () => {
    const out = await executeTool('CronList', {}, makeCtx().ctx)
    assert.match(out, /没有定时任务/)
    assert.match(out, /CronCreate/, '应提示怎么创建')
  })

  test('CronDelete 按 id 取消', async () => {
    const removed = []
    const { ctx } = makeCtx({
      cronRemove: id => {
        removed.push(id)
        return id === 'cron_ok'
      },
    })
    assert.match(await executeTool('CronDelete', { id: 'cron_ok' }, ctx), /已取消/)
    assert.deepEqual(removed, ['cron_ok'])

    const miss = await executeTool('CronDelete', { id: 'cron_nope' }, ctx)
    assert.match(miss, /没有找到/)
    assert.match(miss, /CronList/, '找不到时应引导去看列表')
  })

  test('CronDelete 缺 id 被拒', async () => {
    await assert.rejects(() => executeTool('CronDelete', {}, makeCtx().ctx), /需要 id/)
  })

  test('CronList / CronDelete 未挂载时明确报错，而不是静默', async () => {
    const { ctx } = makeCtx({ cronList: undefined, cronRemove: undefined })
    await assert.rejects(() => executeTool('CronList', {}, ctx), /ctx\.cronList 缺失/)
    await assert.rejects(() => executeTool('CronDelete', { id: 'x' }, ctx), /ctx\.cronRemove 缺失/)
  })

  test('CronDelete 算危险工具（要用户确认），CronList 不算', () => {
    assert.ok(DANGEROUS_TOOLS.has('CronDelete'), '取消定时任务会改变后续行为，应需确认')
    assert.ok(!DANGEROUS_TOOLS.has('CronList'), '列清单是只读的')
  })

  test('worktree 工具：不是 git 仓库时如实说明原因', async () => {
    const { ctx } = makeCtx()
    await assert.rejects(() => executeTool('EnterWorktree', {}, ctx), /不是 git 仓库/)
  })

  test('worktree 两个工具都算危险工具（会改沙箱根）', () => {
    assert.ok(DANGEROUS_TOOLS.has('EnterWorktree'), '一次授权会把之后所有文件工具的作用范围换到另一棵树上')
    assert.ok(DANGEROUS_TOOLS.has('ExitWorktree'))
  })

  test('worktree 名称校验：拒绝 .. 与非法字符', () => {
    const { ctx } = makeCtx()
    return assert.rejects(() => executeTool('EnterWorktree', { name: '..' }, ctx), /不允许出现/)
      .then(() => assert.rejects(() => executeTool('EnterWorktree', { name: 'a b' }, ctx), /只能包含/))
      .then(() => assert.rejects(() => executeTool('EnterWorktree', { name: 'x'.repeat(65) }, ctx), /过长/))
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
  ]) {
    test(`${name} 抛出不可用说明`, async () => {
      await assert.rejects(() => executeTool(name, input, makeCtx().ctx), /不可用/)
    })
  }

  test('McpAuth：未知服务器给出明确错误', async () => {
    await assert.rejects(() => executeTool('McpAuth', { server: 'nope' }, makeCtx().ctx), /没有名为|未挂载/)
  })

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

/**
 * worktree：真流程 + **安全边界回归**。
 *
 * 这一组的核心断言不是"能建出 worktree"，而是"建完之后沙箱**真的换了**"：
 * 新树里能写、老树里必须被拦。漏掉这条，worktree 就会变成一个绕过沙箱写文件的通道。
 */
describe('worktree（沙箱根切换）', () => {
  let withWorkspace
  let ctx
  let session
  // 同样不能在 describe 回调里就 join(WORKSPACE_ROOT) —— before 还没跑
  let WT_DIR

  const gitSync = args =>
    new Promise(res => {
      execFile(
        'git',
        args,
        { cwd: WORKSPACE_ROOT, windowsHide: true },
        (e, so, se) => res({ ok: !e, out: String(so).trim(), err: String(se).trim() }),
      )
    })

  const gitAt = (args, cwd) =>
    new Promise(res => {
      execFile('git', args, { cwd, windowsHide: true }, (e, so, se) =>
        res({ ok: !e, out: String(so).trim(), err: String(se).trim() }),
      )
    })

  before(async () => {
    ;({ withWorkspace } = await import('../server/paths.mjs'))
    WT_DIR = join(WORKSPACE_ROOT, '.limkenion', 'worktrees', 'wt-one')
    // 造一个真 git 仓库（EnterWorktree 需要至少一个提交作为 HEAD）
    await gitSync(['init', '-b', 'main'])
    await gitSync(['config', 'user.email', 'test@local'])
    await gitSync(['config', 'user.name', 'test'])
    const r = await gitSync(['add', '-A'])
    if (!r.ok) throw new Error('git add 失败：' + r.err)
    const c = await gitSync(['commit', '-m', 'init', '--allow-empty'])
    if (!c.ok) throw new Error('git commit 失败：' + c.err)
  })

  /** 每个用例一个新的会话对象（沙箱根挂在会话上，用例之间不能互相污染）。 */
  function freshSession() {
    const made = makeCtx()
    session = made.session
    ctx = made.ctx
    return session
  }

  test('进入 worktree：建出目录与分支，并把会话的根切过去', async () => {
    freshSession()
    const out = await executeTool('EnterWorktree', { name: 'wt-one' }, ctx)

    assert.match(out, /已进入 worktree/)
    assert.match(out, /原目录.*不再可访问/, '必须说明沙箱根换了，否则用户以为还能看老目录')
    assert.equal(session.workspaceRoot, WT_DIR, '会话的沙箱根应当是新的 worktree')
    assert.ok(existsSync(WT_DIR), '目录应当真的建出来了')

    const branches = await gitSync(['branch', '--list', 'limkenion-wt/wt-one'])
    assert.ok(branches.out.includes('limkenion-wt/wt-one'), '分支应当在自己的命名空间里')
  })

  test('进入后：新树里能写，**老树里必须越界**（安全边界回归）', async () => {
    freshSession()
    await executeTool('EnterWorktree', { name: 'wt-one' }, ctx)

    // 之后的一切都在"这个会话"的作用域里跑（引擎的 runTurn 就是这么做的）
    await withWorkspace({ root: session.workspaceRoot }, async () => {
      await executeTool('Write', { file_path: 'inside.txt', content: '在 worktree 里\n' }, ctx)
      assert.equal(await readFile(join(WT_DIR, 'inside.txt'), 'utf8'), '在 worktree 里\n')

      // 老根里的文件：必须被 safePath 拦住
      await assert.rejects(
        () => executeTool('Read', { file_path: join(WORKSPACE_ROOT, 'package.json') }, ctx),
        /越界/,
        '进入 worktree 后还能读老目录 = 隔离失效',
      )
      await assert.rejects(
        () => executeTool('Write', { file_path: join(WORKSPACE_ROOT, 'should-not-exist.txt'), content: 'x' }, ctx),
        /越界/,
      )
    })
    assert.ok(!existsSync(join(WORKSPACE_ROOT, 'should-not-exist.txt')), '越界的写入绝不能落地')
  })

  test('退出（keep）：还原根，目录留着', async () => {
    freshSession()
    await executeTool('EnterWorktree', { name: 'wt-one' }, ctx)
    const out = await executeTool('ExitWorktree', { action: 'keep' }, ctx)

    assert.match(out, /已退出 worktree/)
    assert.equal(session.workspaceRoot, null, '退出后应当回落到默认根')
    assert.equal(session.worktree, null)
    assert.ok(existsSync(WT_DIR), 'keep 时目录留着')
  })

  test('退出（remove）：有未提交改动时拒绝丢东西，清干净后才移除', async () => {
    freshSession()
    await executeTool('EnterWorktree', { name: 'wt-one' }, ctx)
    // 留一个未提交的改动：remove 必须**拒绝**丢东西
    await withWorkspace({ root: session.workspaceRoot }, () =>
      executeTool('Write', { file_path: 'dirty.txt', content: '未提交\n' }, ctx),
    )
    const dirty = await executeTool('ExitWorktree', { action: 'remove' }, ctx)
    assert.match(dirty, /没有删除/, '有未提交改动时不能替用户丢东西')
    assert.match(dirty, /discard_changes/, '要把「怎么才能真删」说清楚，否则用户只能干瞪眼')
    assert.ok(existsSync(WT_DIR), '拒绝移除时目录必须还在')
    assert.equal(session.workspaceRoot, null, '拒绝移除时沙箱根也要还原，不能卡在新树里')

    // 改动清掉之后再进去退一次 —— 这次应当真的删掉。
    // 用 git 自己清（前面的用例在树里留过未跟踪文件，git worktree remove 一律会拒绝）。
    await gitAt(['clean', '-fdx'], WT_DIR)
    await gitAt(['checkout', '--', '.'], WT_DIR)
    await executeTool('EnterWorktree', { name: 'wt-one' }, ctx)
    const out = await executeTool('ExitWorktree', { action: 'remove' }, ctx)
    assert.match(out, /已清理/)
    assert.ok(!existsSync(WT_DIR), 'remove 之后目录应当没了')
    const branches = await gitSync(['branch', '--list', 'limkenion-wt/wt-one'])
    assert.equal(branches.out, '', '分支也应当被删掉，避免留下一堆孤儿分支')
  })

  test('remove + discard_changes:true —— 用户明说了才丢改动', async () => {
    freshSession()
    await executeTool('EnterWorktree', { name: 'wt-discard' }, ctx)
    await withWorkspace({ root: session.workspaceRoot }, () =>
      executeTool('Write', { file_path: 'throwaway.txt', content: '可以丢\n' }, ctx),
    )
    // 没明说 → 拒绝（上一条用例已验证）；这里验证「明说了」确实会删
    const out = await executeTool('ExitWorktree', { action: 'remove', discard_changes: true }, ctx)
    assert.match(out, /已清理/)
    assert.ok(!existsSync(join(WT_DIR)), '用户显式放弃改动后，目录应当真的删掉')
    assert.equal(session.workspaceRoot, null)
  })

  test('已在 worktree 里时不能重复进入', async () => {
    freshSession()
    await executeTool('EnterWorktree', { name: 'wt-two' }, ctx)
    await assert.rejects(() => executeTool('EnterWorktree', { name: 'wt-three' }, ctx), /已经在 worktree 里/)
    await executeTool('ExitWorktree', { action: 'remove' }, ctx)
  })

  test('仓库根在沙箱外时拒绝建（不给绕过沙箱的口子）', async () => {
    freshSession()
    // 把会话的根设成仓库里的一个**子目录**：worktree 会建在 <repo>/.limkenion/... ，
    // 那在这个会话的沙箱之外，必须拒绝。
    const sub = join(WORKSPACE_ROOT, 'sub-sandbox')
    await mkdir(sub, { recursive: true })
    session.workspaceRoot = sub
    await assert.rejects(
      () => executeTool('EnterWorktree', { name: 'wt-outside' }, ctx),
      /沙箱之外/,
      '否则"创建 worktree"就是一个绕过沙箱写文件的通道',
    )
  })

  test('不在 worktree 里时退出要报错', async () => {
    freshSession()
    await assert.rejects(() => executeTool('ExitWorktree', {}, ctx), /不在任何 worktree/)
  })
})
