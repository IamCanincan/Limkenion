/**
 * CLI → web 命令迁移的测试。
 *
 * 覆盖两类东西：
 *
 * ① **两个静默 bug 的回归防线**（这轮在迁移过程中发现的）：
 *    - `chatCompletion` 把带 tools 的 body 构造好了，fetch 却用了另一份不含 tools
 *      的内联字面量 —— 于是工具 schema 从来没发给过模型，web 端的 agent 实际只能聊天。
 *    - `chatCompletion` 只返回 { usage, toolCalls }，不返回 text，而 WebFetch 的
 *      网页提炼器读的是 `res.text` —— 永远拿到 undefined，提炼器静默失效。
 *    这两个都不会让现有测试变红（桩模型按脚本回放，不看请求内容），所以必须专门守。
 *
 * ② 从 CLI 搬过来的命令语义：/effort、/branch、/rewind、/btw、/init、/schedule、/workflows，
 *    以及命令注册表扫描的修正（insights 被误注册成 project_areas）。
 *
 * 注意：server 各模块在 **import 时**读环境变量，所以必须先设 env 再动态 import。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStubModel } from './helpers.mjs'

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_ROOT = join(WEB_DIR, '..')

let stateDir
let stub
let mod // 懒加载的 server 模块集合

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'limkenion-cmd-'))

  // 桩模型要先起来，才能把 DEEPSEEK_BASE_URL 指向它 —— 这些 env 必须在
  // import server 模块之前设好。
  stub = await startStubModel([{ text: '（桩回复）' }])

  process.env.LIMKENION_WEB_STATE_DIR = stateDir
  process.env.LIMKENION_WEB_WORKSPACE = stateDir
  process.env.LIMKENION_CLI_ROOT = CLI_ROOT
  process.env.DEEPSEEK_BASE_URL = stub.baseUrl
  process.env.DEEPSEEK_API_KEY = 'sk-test'

  mod = {
    ...(await import('../server/commands.mjs')),
    ...(await import('../server/sessions.mjs')),
    ...(await import('../server/config.mjs')),
    ...(await import('../server/deepseek.mjs')),
    ...(await import('../server/engine.mjs')),
  }
})

after(async () => {
  await stub?.close()
  await rm(stateDir, { recursive: true, force: true })
})

/** 造一个会话并返回一个 runCommand 的便捷包装。 */
function makeRunner(messages = []) {
  const s = mod.createSession()
  s.messages = messages
  const registry = { current: null }
  return {
    session: s,
    async run(text) {
      if (!registry.current) registry.current = await mod.loadCommandRegistry()
      const [name, ...rest] = text.replace(/^\//, '').split(/\s+/)
      return mod.runCommand(s, name, rest.join(' '), {}, registry.current)
    },
  }
}

// ---------------------------------------------------------------------------
// ① 静默 bug 的回归防线
// ---------------------------------------------------------------------------

describe('工具 schema 必须真的发给模型（回归防线）', () => {
  test('带 tools 调用时，请求体里有 tools 字段', async () => {
    const before = stub.requests.length
    const tools = [
      {
        type: 'function',
        function: {
          name: 'Read',
          description: '读文件',
          parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
        },
      },
    ]

    await mod.chatCompletion({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '读个文件' }],
      tools,
      onDelta: () => {},
    })

    const body = stub.requests[stub.requests.length - 1]
    assert.ok(stub.requests.length > before, '桩模型应收到请求')
    assert.ok(Array.isArray(body.tools), `请求体应带 tools，实际 ${JSON.stringify(Object.keys(body))}`)
    assert.equal(body.tools[0].function.name, 'Read', 'tools 应原样转发')
  })

  test('不带 tools 时不塞空数组（避免被 API 判为非法）', async () => {
    await mod.chatCompletion({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
      onDelta: () => {},
    })
    const body = stub.requests[stub.requests.length - 1]
    assert.equal(body.tools, undefined, '空 tools 不应出现在请求体里')
  })
})

describe('chatCompletion 必须返回累计文本（回归防线）', () => {
  test('返回值的 text 字段是流式正文的拼接', async () => {
    stub.setScript([{ text: '你好，' }, { text: '世界' }])
    const res = await mod.chatCompletion({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '打个招呼' }],
      tools: [],
      onDelta: () => {},
    })
    // 桩按脚本回放：第一次请求拿 '你好，'，第二次拿 '世界'。
    assert.ok(typeof res.text === 'string' && res.text.length > 0, `text 不应为空，实际 ${JSON.stringify(res.text)}`)
    assert.ok(res.usage && typeof res.usage.inputTokens === 'number', 'usage 仍要返回')
    assert.ok(Array.isArray(res.toolCalls), 'toolCalls 仍要返回')
    stub.setScript([{ text: '（桩回复）' }])
  })
})

describe('reasoning_effort 转发', () => {
  test('传了 reasoningEffort 就带该字段，没传就不带', async () => {
    await mod.chatCompletion({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      reasoningEffort: 'none',
      onDelta: () => {},
    })
    assert.equal(stub.requests[stub.requests.length - 1].reasoning_effort, 'none', '应带上 reasoning_effort')

    await mod.chatCompletion({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      onDelta: () => {},
    })
    assert.equal(
      stub.requests[stub.requests.length - 1].reasoning_effort,
      undefined,
      '不传时不应出现该字段（由服务端默认）',
    )
  })
})

// ---------------------------------------------------------------------------
// ② 命令语义
// ---------------------------------------------------------------------------

describe('/effort 推理强度', () => {
  test('档位与 CLI 的 EFFORT_LEVELS 一致', () => {
    assert.deepEqual(mod.EFFORT_LEVELS, ['low', 'medium', 'high', 'max'])
  })

  test('max 仅 v4-pro 支持，其余模型降级为 high', () => {
    assert.equal(mod.modelSupportsMaxEffort('deepseek-v4-pro'), true)
    assert.equal(mod.modelSupportsMaxEffort('deepseek-flash'), false)
    assert.equal(mod.resolveEffort('deepseek-v4-pro', 'max'), 'max')
    assert.equal(mod.resolveEffort('deepseek-flash', 'max'), 'high')
    assert.equal(mod.resolveEffort('deepseek-flash', null), undefined)
  })

  test('设置、读取、清除', async () => {
    const r = makeRunner()

    let out = await r.run('/effort')
    assert.match(out, /未设置/, '初始应是未设置')
    assert.match(out, /low\|medium\|high\|max\|default/, '应列出档位')

    out = await r.run('/effort high')
    assert.match(out, /已设为 high/)
    assert.equal(mod.settingsFor(r.session).effortLevel, 'high')

    out = await r.run('/effort default')
    assert.match(out, /已清除/)
    assert.equal(mod.settingsFor(r.session).effortLevel, null)
  })

  test('flash 上设 max 会明确告知降级', async () => {
    const r = makeRunner()
    const out = await r.run('/effort max')
    assert.match(out, /不支持 max/)
    assert.match(out, /按 high 生效/)
  })

  test('非法档位被拒绝，且不写进设置', async () => {
    const r = makeRunner()
    const out = await r.run('/effort 超强')
    assert.match(out, /未知档位/)
    assert.notEqual(mod.settingsFor(r.session).effortLevel, '超强')
  })

  test('publicSettings 暴露 effortLevel 与 effectiveEffort', () => {
    const s = mod.createSession()
    s.settings = { effortLevel: 'max', model: 'deepseek-flash' }
    const pub = mod.publicSettings(s)
    assert.equal(pub.effortLevel, 'max')
    assert.equal(pub.effectiveEffort, 'high', '降级结果要能传给前端展示')
  })
})

describe('/branch 会话分叉', () => {
  test('分叉出独立会话，消息被复制且互不影响', async () => {
    const r = makeRunner([
      { id: 'a', role: 'user', text: '一' },
      { id: 'b', role: 'assistant', text: '二' },
    ])
    const out = await r.run('/branch 我的分支')
    assert.match(out, /已从当前会话分叉/)
    assert.match(out, /我的分支/)

    const list = [...mod.allSessions()]
    const forked = list.find(s => s.title === '我的分支')
    assert.ok(forked, '应能在会话列表里找到分叉出来的会话')
    assert.equal(forked.messages.length, 2, '应复制全部消息')
    assert.notEqual(forked.id, r.session.id, '必须是独立会话')

    // 改分叉出来的会话，不能影响源会话
    forked.messages.push({ id: 'c', role: 'user', text: '三' })
    assert.equal(r.session.messages.length, 2, '源会话不应被改动')
  })

  test('/fork 是 /branch 的别名（与 CLI 一致）', async () => {
    const r = makeRunner()
    const out = await r.run('/fork')
    assert.match(out, /已从当前会话分叉/)
  })

  test('forkSession 支持在指定位置分叉', () => {
    const src = mod.createSession()
    src.messages = [
      { id: '1', role: 'user', text: '一' },
      { id: '2', role: 'assistant', text: '二' },
      { id: '3', role: 'user', text: '三' },
    ]
    const forked = mod.forkSession(src, '半截', 0)
    assert.equal(forked.messages.length, 1, 'atIndex=0 表示只保留第 1 条')
    assert.equal(forked.messages[0].text, '一')
  })
})

describe('/rewind 对话回退', () => {
  test('无参时列出可回退点，并说明文件检查点会一并回滚', async () => {
    const r = makeRunner([
      { id: '1', role: 'user', text: '一' },
      { id: '2', role: 'assistant', text: '二' },
      { id: '3', role: 'user', text: '三' },
    ])
    const out = await r.run('/rewind')
    assert.match(out, /共 3 条消息/)
    assert.match(out, /一并回滚/)
  })

  test('/rewind <n> 截断到前 n 条', async () => {
    const r = makeRunner([
      { id: '1', role: 'user', text: '一' },
      { id: '2', role: 'assistant', text: '二' },
      { id: '3', role: 'user', text: '三' },
    ])
    const out = await r.run('/rewind 1')
    assert.match(out, /删掉 2 条消息，保留 1 条/)
    assert.equal(r.session.messages.length, 1)
    assert.equal(r.session.messages[0].text, '一')
  })

  test('非法参数被拒绝', async () => {
    const r = makeRunner()
    const out = await r.run('/rewind 很多')
    assert.match(out, /参数无效/)
  })
})

describe('/schedule 与 /cron', () => {
  test('两个名字都认，且提示里用的是 /schedule', async () => {
    const r = makeRunner()
    for (const cmd of ['/schedule', '/cron']) {
      const out = await r.run(cmd)
      assert.doesNotMatch(out, /未知命令/, `${cmd} 应被识别`)
    }
  })

  test('remove 缺 id 时给用法', async () => {
    const r = makeRunner()
    assert.match(await r.run('/schedule remove'), /用法/)
  })

  test('删除不存在的 id 给出明确结果', async () => {
    const r = makeRunner()
    assert.match(await r.run('/schedule remove cron_不存在'), /没有找到/)
  })
})

describe('/workflows 与命令降级说明', () => {
  test('/workflows 列出运行记录与脚本原语', async () => {
    const r = makeRunner()
    const out = await r.run('/workflows')
    // 工作流现在是真实现（tools.mjs 里挂了 Workflow 工具）
    assert.match(out, /工作流：记录/)
    assert.match(out, /agent\(prompt, opts\)/)
    assert.match(out, /只读/)

    const shown = await r.run('/workflows show wf_不存在')
    assert.match(shown, /找不到这次运行/)
  })

  test('sandbox / terminal-setup 的键名对得上（不再落到兜底说明）', async () => {
    const r = makeRunner()
    // 这两个命令在 CLI 里的 name 分别是 'sandbox' 与 'terminal-setup'，
    // 而 TERMINAL_ONLY 里原来写的是 'sandbox-toggle' / 'terminalSetup' —— 键名对不上。
    assert.match(await r.run('/sandbox'), /沙箱固定为工作区根/)
    assert.match(await r.run('/terminal-setup'), /需要写入终端配置文件/)
  })

  test('占位桩命令归类为「本构建里不可用」而不是「终端专属」', async () => {
    const r = makeRunner()
    for (const cmd of ['/torch', '/proactive', '/subscribe-pr', '/force-snip', '/assistant', '/peers']) {
      const out = await r.run(cmd)
      assert.match(out, /本构建里不可用/, `${cmd} 应归类为本构建不可用`)
      assert.match(out, /占位桩/)
    }
  })

  test('依赖云端账号的命令给出准确原因', async () => {
    const r = makeRunner()
    for (const cmd of ['/fast', '/web-setup', '/privacy-settings']) {
      const out = await r.run(cmd)
      assert.match(out, /云端/, `${cmd} 应说明需要云端账号`)
    }
  })

  test('/usage 映射到 /cost（CLI 的 /usage 是云端套餐，本构建里是死路径）', async () => {
    const r = makeRunner()
    const usage = await r.run('/usage')
    const cost = await r.run('/cost')
    assert.equal(usage, cost, '/usage 应与 /cost 输出一致')
    assert.match(usage, /tokens/, '应给出 token 用量')
  })

  test('/brief 说明是 KAIROS 被关闭', async () => {
    const r = makeRunner()
    assert.match(await r.run('/brief'), /KAIROS/)
  })

  test('未知命令仍然报未知', async () => {
    const r = makeRunner()
    assert.match(await r.run('/根本没有这个命令'), /未知命令/)
  })
})

describe('/btw 旁路提问', () => {
  test('无参时给用法', async () => {
    const r = makeRunner()
    assert.match(await r.run('/btw'), /用法/)
  })

  test('答案作为命令输出返回，并声明不进主对话上下文', async () => {
    stub.setScript([{ text: '旁路答案' }])
    const r = makeRunner()
    const out = await r.run('/btw 1+1=?')
    assert.match(out, /旁路回答/)
    assert.match(out, /不进主对话上下文/)
    assert.match(out, /旁路答案/, '应把模型的回答带回来')
  })

  test('旁路提问不带 tools（不该让模型去调工具）', async () => {
    stub.setScript([{ text: 'x' }])
    const r = makeRunner()
    await r.run('/btw 随便问问')
    assert.equal(
      stub.requests[stub.requests.length - 1].tools,
      undefined,
      '旁路提问的请求里不该有 tools',
    )
  })

  test('命令输出进会话时是 system 角色 —— 而 system 不会被发给模型', () => {
    // 这是 /btw「不打断主对话」能成立的前提：engine 的 sessionToWireMessages
    // 只映射 user / assistant，跳过 system。
    const s = mod.createSession()
    s.messages = [
      { id: '1', role: 'user', text: '主对话' },
      { id: '2', role: 'system', text: '旁路回答：……' },
    ]
    const wire = mod.sessionToWireMessages(s)
    assert.ok(
      !wire.some(m => String(m.content).includes('旁路回答')),
      'system 消息不该出现在发给模型的消息里',
    )
  })
})

describe('/init 生成 LIMKENION.md', () => {
  test('注入初始化提示并触发一轮', async () => {
    stub.setScript([{ text: '好的，我先看仓库结构。' }])
    const r = makeRunner()
    const out = await r.run('/init')
    assert.match(out, /LIMKENION\.md/)
    assert.ok(
      r.session.messages.some(m => m.role === 'user' && m.text.includes('LIMKENION.md')),
      '应把初始化提示作为用户消息放进会话',
    )

    // runTurn 是 fire-and-forget（命令要立刻返回），等它跑完
    await new Promise(res => setTimeout(res, 400))
    assert.ok(
      r.session.messages.some(m => m.role === 'assistant'),
      '应产生一条 assistant 回复',
    )
    stub.setScript([{ text: '（桩回复）' }])
  })
})

describe('/commit /commit-push-pr /review（prompt 型 git 命令）', () => {
  test('工作区不是 git 仓库 → 明确报错，且不启动回合', async () => {
    // stateDir 里没有 .git，三条都应该直接拒绝
    for (const cmd of ['commit', 'commit-push-pr', 'review']) {
      const r = makeRunner()
      const out = await r.run('/' + cmd)
      assert.match(out, /不是 git 仓库/, `/${cmd} 应说明不是 git 仓库，实际：${out}`)
      assert.equal(
        r.session.messages.filter(m => m.role === 'user').length,
        0,
        `/${cmd} 不应往会话里塞消息（没有启动回合）`,
      )
    }
  })

  test('是 git 仓库 → 把提示词注入会话并触发一轮', async () => {
    const fs = await import('node:fs/promises')
    await fs.mkdir(join(stateDir, '.git'), { recursive: true })

    stub.setScript([{ text: '好的，先看改动。' }])
    const r = makeRunner()
    const out = await r.run('/commit')
    assert.match(out, /已开始创建提交/)
    assert.ok(
      r.session.messages.some(m => m.role === 'user' && /创建一次 git 提交/.test(m.text)),
      '应把提交提示作为用户消息放进会话',
    )
    await new Promise(res => setTimeout(res, 400))
    assert.ok(r.session.messages.some(m => m.role === 'assistant'), '应产生一条 assistant 回复')
    stub.setScript([{ text: '（桩回复）' }])

    await rm(join(stateDir, '.git'), { recursive: true, force: true })
  })

  test('review 的提示里要求先确认 gh 可用（不能闷头失败）', async () => {
    const fs = await import('node:fs/promises')
    await fs.mkdir(join(stateDir, '.git'), { recursive: true })
    stub.setScript([{ text: '收到。' }])

    const r = makeRunner()
    await r.run('/review')
    const injected = r.session.messages.find(m => m.role === 'user' && /审查当前分支/.test(m.text))
    assert.ok(injected, '应注入审查提示')
    assert.match(injected.text, /gh --version/, '提示里必须要求先确认 gh 可用')
    await new Promise(res => setTimeout(res, 400))
    stub.setScript([{ text: '（桩回复）' }])
    await rm(join(stateDir, '.git'), { recursive: true, force: true })
  })
})

describe('命令注册表扫描', () => {
  test('insights 被正确注册（而不是它的分节名 project_areas）', async () => {
    const reg = await mod.loadCommandRegistry()
    const names = reg.map(c => c.name)
    assert.ok(names.includes('insights'), `应注册 insights，实际缺少。前 20 个：${names.slice(0, 20).join(',')}`)
    assert.ok(!names.includes('project_areas'), 'project_areas 是报告分节名，不该被当成命令')
  })

  test('web 端实现的命令都在注册表里（或是有意新增的）', async () => {
    const reg = await mod.loadCommandRegistry()
    const names = new Set(reg.map(c => c.name))
    // web 自带的这几个 CLI 里没有同名命令，跳过
    const webOnly = new Set(['cron', 'web', 'todos', 'summary', 'env', 'tools', 'cost', 'cwd']) // cost/cwd：web 自有实现（CLI 契约里没有）
    for (const cmd of mod.WEB_IMPLEMENTED) {
      if (webOnly.has(cmd)) continue
      assert.ok(names.has(cmd), `/${cmd} 标为已实现，但注册表里没有`)
    }
  })

  test('WEB_IMPLEMENTED 里包含这轮从 CLI 搬过来的命令', () => {
    for (const cmd of ['effort', 'branch', 'rewind', 'btw', 'init', 'schedule', 'workflows']) {
      assert.ok(mod.WEB_IMPLEMENTED.includes(cmd), `/${cmd} 应列入 WEB_IMPLEMENTED`)
    }
  })
})

// ---------------------------------------------------------------------------
// /add-dir：追加额外可访问目录
// ---------------------------------------------------------------------------

describe('/add-dir 追加额外可访问目录', () => {
  test('追加工作区外的目录：写入 workspaceAdditions 且作用域真的带上它', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'limkenion-outside-'))
    const { session, run } = makeRunner()
    const out = await run('/add-dir ' + outside)

    assert.match(out, /已追加额外目录/, '输出应说明已追加，实际：' + out)
    assert.ok(
      session.workspaceAdditions.includes(outside),
      'workspaceAdditions 应包含该目录（这是此前唯一没被写入过的字段）',
    )
    // 闭环：作用域必须真的带上它 —— 否则只是改了个没人读的字段
    const { scopeForSession } = await import('../server/paths.mjs')
    const scope = scopeForSession(session)
    assert.ok(
      scope.additions.includes(outside),
      '作用域的 additions 应包含它，实际：' + JSON.stringify(scope.additions),
    )
    await rm(outside, { recursive: true, force: true })
  })

  test('追加不存在的路径 → 明确报错', async () => {
    const { session, run } = makeRunner()
    const out = await run('/add-dir /definitely-not-exist-xyz')
    assert.match(out, /目录不存在/)
    assert.equal(session.workspaceAdditions.length, 0)
  })

  test('追加一个文件（不是目录）→ 拒绝', async () => {
    const fs = await import('node:fs/promises')
    const file = join(stateDir, 'a-file.txt')
    await fs.writeFile(file, 'x')
    const { session, run } = makeRunner()
    const out = await run('/add-dir ' + file)
    assert.match(out, /不是目录/)
    assert.equal(session.workspaceAdditions.length, 0)
  })

  test('追加工作区内的目录 → 提示本来就可达，不重复加', async () => {
    const fs = await import('node:fs/promises')
    const inside = join(stateDir, 'inside-dir')
    await fs.mkdir(inside, { recursive: true })
    const { session, run } = makeRunner()
    const out = await run('/add-dir ' + inside)
    assert.match(out, /本来就可访问|无需追加/)
    assert.equal(session.workspaceAdditions.length, 0)
  })

  test('追加父目录 → 明确警告"范围被扩大"（否则等于悄悄把沙箱边界往外挪）', async () => {
    // stateDir 是 tmpdir() 下的子目录，所以 tmpdir() 就是它的上级目录
    const { session, run } = makeRunner()
    const out = await run('/add-dir ' + tmpdir())
    assert.ok(
      /扩大/.test(out) && /⚠️/.test(out),
      '追加父目录必须给出扩大范围的警告，实际：' + out,
    )
    assert.ok(session.workspaceAdditions.includes(tmpdir()))
  })

  test('重复追加 → 提示已在清单，不产生重复项', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'limkenion-dup-'))
    const { session, run } = makeRunner()
    await run('/add-dir ' + outside)
    const out = await run('/add-dir ' + outside)
    assert.match(out, /已在清单里/)
    assert.equal(session.workspaceAdditions.filter(p => p === outside).length, 1)
    await rm(outside, { recursive: true, force: true })
  })

  test('--remove 能移除，无参时列出当前清单', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'limkenion-rm-'))
    const { session, run } = makeRunner()
    await run('/add-dir ' + outside)
    const out = await run('/add-dir --remove ' + outside)
    assert.match(out, /已移除额外目录/)
    assert.equal(session.workspaceAdditions.length, 0)

    const list = await run('/add-dir')
    assert.match(list, /额外可访问目录（0）/)
    await rm(outside, { recursive: true, force: true })
  })
})
