/**
 * MCP 客户端测试。
 *
 * 用**真的 stdio 子进程**当桩服务器（`test/fixtures/mcp-stub-server.mjs`），
 * 不 mock JSON-RPC 层 —— 传输、握手、超时、进程退出这些正是容易出错的地方，
 * mock 掉等于什么都没测。
 *
 * 隔离：LIMKENION_CONFIG_DIR 指向临时目录，别往用户真实配置里写 mcpServers。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeClient, startStubModel } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

let configDir
let ws
let mcp
let tools
let toolindex
let stub
let bus
let engine
let sessions
let interactions
let client
let policy = {}

/** 写 mcpServers 配置。 */
async function setServers(servers) {
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({ mcpServers: servers }, null, 1), 'utf8')
}

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-mcp-cfg-'))
  ws = await mkdtemp(join(tmpdir(), 'lk-mcp-ws-'))
  // 桩服务器脚本放到临时工作区（hook 里用的是同一个套路：路径无空格，不用处理引号）
  await copyFile(join(HERE, 'fixtures', 'mcp-stub-server.mjs'), join(ws, 'mcp-stub.mjs'))

  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws
  process.env.LIMKENION_WEB_STATE_DIR = join(ws, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'
  stub = await startStubModel([{ text: '默认回复' }])
  process.env.DEEPSEEK_BASE_URL = stub.baseUrl

  bus = await import('../server/bus.mjs')
  client = fakeClient({
    onPermission: msg => policy.onPermission?.(msg),
    onQuestion: msg => policy.onQuestion?.(msg),
  })
  bus.addClient(client.ws)

  mcp = await import('../server/mcp.mjs')
  tools = await import('../server/tools.mjs')
  toolindex = await import('../server/toolindex.mjs')
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
  interactions = await import('../server/interactions.mjs')
})

after(async () => {
  await stub?.close()
  mcp.closeAllMcp()
  // 桩服务器的 cwd 就设在这个临时目录里，刚被杀掉的进程可能还占着它（Windows 会 EBUSY）。
  // 重试几次，别让清理失败把整个文件判成失败。
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 6; i++) {
    try {
      await rm(ws, { recursive: true, force: true })
      break
    } catch {
      await sleep(300)
    }
  }
  await rm(configDir, { recursive: true, force: true })
})

/** 桩服务器的启动配置（argv 可选：reverse 让它发一个反向请求）。 */
function stubServer(extraArgs = []) {
  return {
    stub: {
      command: process.execPath,
      args: [join(ws, 'mcp-stub.mjs'), ...extraArgs],
      env: {},
    },
  }
}

describe('配置解析与可用性判定', () => {
  test('三种传输类型都能解析出来，sse 已转正（2026-09-18 实现）', async () => {
    await setServers({
      a: { command: 'npx', args: ['-y', 'x'] },
      b: { type: 'http', url: 'https://example.test/mcp' },
      c: { type: 'sse', url: 'https://example.test/sse' },
    })
    const cfgs = mcp.mcpServerConfigs()
    assert.equal(cfgs.length, 3)
    assert.equal(cfgs.find(c => c.name === 'a').transport, 'stdio', '没写 type 时按有无 url 推断')
    assert.equal(cfgs.find(c => c.name === 'b').transport, 'http')
    // sse 曾被列为不支持；实现后 configProblem 必须放行（否则合法配置连不上）
    assert.equal(mcp.configProblem(cfgs.find(c => c.name === 'c')), null)
  })

  test('缺 command / 缺 url 的配置给出具体原因', () => {
    assert.match(mcp.configProblem({ name: 'x', transport: 'stdio', command: '', args: [] }), /缺 command/)
    assert.match(mcp.configProblem({ name: 'y', transport: 'http', url: '', args: [] }), /缺合法的 url/)
  })

  test('项目级配置覆盖同名服务器的字段', async () => {
    await mkdir(join(ws, '.limkenion'), { recursive: true })
    await setServers({ a: { command: 'aaa' } })
    await writeFile(
      join(ws, '.limkenion', 'settings.json'),
      JSON.stringify({ mcpServers: { a: { command: 'bbb' } } }),
      'utf8',
    )
    const cfg = mcp.mcpServerConfigs().find(c => c.name === 'a')
    assert.equal(cfg.command, 'bbb', '项目级应当覆盖用户级')
    assert.equal(cfg.source, 'project')
    await rm(join(ws, '.limkenion'), { recursive: true, force: true })
  })

  test('工具名与 CLI 的约定一致（mcp__server__tool）', () => {
    assert.equal(mcp.mcpToolName('my.server', 'read file'), 'mcp__my_server__read_file')
    assert.deepEqual(mcp.mcpInfoFromString('mcp__srv__read_file'), { serverName: 'srv', toolName: 'read_file' })
    assert.equal(mcp.mcpInfoFromString('Read'), null)
  })
})

describe('stdio 连接（真的子进程）', () => {
  test('握手 + 拉工具清单，schema 补齐 required', async () => {
    await setServers(stubServer())
    const r = await mcp.reloadMcp()
    assert.deepEqual(r, { connected: 1, failed: 0, skipped: 0 })

    const schemas = mcp.mcpToolSchemas()
    const names = schemas.map(s => s.function.name)
    assert.ok(names.includes('mcp__stub__echo'), `应当发现 echo：${names}`)
    assert.ok(names.includes('mcp__stub__boom'))
    for (const s of schemas) {
      assert.equal(s.function.parameters.type, 'object')
      assert.ok(Array.isArray(s.function.parameters.required), 'required 必须补齐，否则上游可能判 schema 非法')
      assert.match(s.function.description, /^\[MCP:stub\]/)
    }
  })

  test('调用工具并把结果转成文本', async () => {
    const out = await mcp.callMcpTool('mcp__stub__echo', { text: '你好 MCP' })
    assert.match(out, /echo: 你好 MCP/)
  })

  test('isError 的结果要明说是错误（别把失败当正常输出）', async () => {
    const out = await mcp.callMcpTool('mcp__stub__boom', {})
    assert.match(out, /MCP 工具返回错误/)
    assert.match(out, /工具自己报告失败/)
  })

  test('列资源 / 读资源', async () => {
    const list = await mcp.listMcpResources('stub')
    assert.match(list, /stub:\/\/readme/)
    const content = await mcp.readMcpResource('stub', 'stub://readme')
    assert.match(content, /这是桩资源/)
  })

  test('调用不存在的服务器/工具时报错清楚', async () => {
    await assert.rejects(() => mcp.callMcpTool('mcp__nope__x', {}), /没有名为「nope」的 MCP 服务器/)
    // 报错要带上"它有哪些工具"，模型才知道下一步怎么走
    await assert.rejects(() => mcp.callMcpTool('mcp__stub__missing', {}), /没有工具 missing.*echo、boom/)
  })

  test('服务端的反向请求会被回 -32601，不会被挂着不回', async () => {
    await setServers({ stub: { ...stubServer().stub, args: [...stubServer().stub.args, 'reverse'] } })
    await mcp.reloadMcp()
    // 桩服务器在 initialize 之后会发一个 sampling/createMessage 请求，
    // 并把收到的回应写到 <ws>/reverse-answer.json
    const path = join(ws, 'reverse-answer.json')
    let raw = null
    for (let i = 0; i < 40; i++) {
      try {
        raw = await readFile(path, 'utf8')
        break
      } catch {
        await new Promise(r => setTimeout(r, 100))
      }
    }
    assert.ok(raw, '桩服务器应当收到我们对反向请求的回应')
    const answer = JSON.parse(raw)
    // sampling 已实现：空 messages → -32603『sampling 请求没有消息』（不再回 -32601）
    assert.equal(answer.error?.code, -32603, `应有明确错误：${raw}`)
    assert.match(answer.error.message, /sampling 请求没有消息/)
  })
})

describe('连接失败不阻塞', () => {
  test('命令不存在 → 状态 error 且带原因，connectAll 不抛', async () => {
    await setServers({ broken: { command: 'definitely-not-a-real-binary-xyz', args: [] } })
    const r = await mcp.reloadMcp()
    assert.equal(r.failed, 1)
    assert.equal(r.connected, 0)

    const summary = mcp.mcpSummary()
    assert.match(summary, /## broken/)
    assert.match(summary, /状态：error/)
    assert.match(summary, /definitely-not-a-real-binary-xyz|not found|ENOENT|启动失败/i)
  })

  test('未连接时调用会说明状态与原因', async () => {
    await assert.rejects(
      () => mcp.callMcpTool('mcp__broken__x', {}),
      /未连接.*error|未连接（状态/,
    )
  })
})

describe('接进工具集', () => {
  test('注册进 TOOL_SCHEMAS，出现在延迟清单里，且默认算危险工具', async () => {
    await setServers({ stub: stubServer().stub })
    await mcp.reloadMcp()
    const before = tools.TOOL_SCHEMAS.length
    const total = tools.registerMcpTools(mcp.mcpToolSchemas())
    assert.equal(total, before + 2, 'stub 有 2 个工具')
    assert.ok(tools.mcpToolNames().includes('mcp__stub__echo'))
    assert.ok(toolindex.deferredToolNames().includes('mcp__stub__echo'), '延迟清单必须是活的（不能是快照）')
    assert.ok(tools.isDangerousTool('mcp__stub__echo'), 'MCP 工具能干任何事，默认要确认')

    // 重复注册不会累积（服务器重连后工具清单可能变）
    tools.registerMcpTools(mcp.mcpToolSchemas())
    tools.registerMcpTools(mcp.mcpToolSchemas())
    assert.equal(tools.TOOL_SCHEMAS.length, before + 2, '重复注册不该堆叠')
  })

  test('executeTool 按 mcp__ 前缀分派（没有客户端时给出明确错误）', async () => {
    await assert.rejects(() => tools.executeTool('mcp__stub__echo', {}, {}), /MCP 客户端未挂载/)
    const out = await tools.executeTool('mcp__stub__echo', { text: 'hi' }, { callMcpTool: mcp.callMcpTool })
    assert.match(out, /echo: hi/)
  })

  test('/mcp 摘要里能看到服务器、工具与未实现清单', async () => {
    const summary = mcp.mcpSummary()
    assert.match(summary, /## stub/)
    assert.match(summary, /状态：connected/)
    assert.match(summary, /mcp__stub__echo/)
    assert.match(summary, /未实现：OAuth/)
  })

  test('没配 mcpServers 时摘要给出配置示例', async () => {
    await setServers({})
    const summary = mcp.mcpSummary()
    assert.match(summary, /未配置任何 MCP 服务器/)
    assert.match(summary, /mcpServers/)
  })
})

/**
 * 引擎接线：模型真的能调用 MCP 工具（`ctx.callMcpTool` 那条路）。
 * 上面 executeTool 的测试只证明了分派，不证明引擎把 ctx 接上了。
 */
describe('引擎接线', () => {
  test('模型调用 mcp__stub__echo → 结果回灌 → 最终回答', async () => {
    await setServers({ stub: stubServer().stub })
    await mcp.reloadMcp()
    tools.registerMcpTools(mcp.mcpToolSchemas())

    const s = sessions.createSession()
    // MCP 工具是延迟工具，先启用才会把 schema 发给模型
    s.enabledTools = new Set(['mcp__stub__echo'])

    policy = { onPermission: msg => interactions.resolvePermission(msg.requestId, 'always') }
    client.received.length = 0
    stub.setScript([
      { toolCalls: [{ id: 'm1', name: 'mcp__stub__echo', args: { text: '来自模型' } }] },
      { text: '好，已经调过了。' },
    ])
    await engine.runTurn(s, '用 MCP 工具回显一句话', 'msg_mcp')

    const perms = client.ofType('permission_request')
    assert.equal(perms.length, 1, 'MCP 工具默认要确认（能干任何事，不能默认放行）')
    assert.equal(perms[0].toolName, 'mcp__stub__echo')

    const msgs = stub.requests.at(-1)?.messages ?? []
    const fed = msgs.filter(m => m.role === 'tool').map(m => String(m.content)).join('\n')
    assert.match(fed, /echo: 来自模型/, `模型应当收到 MCP 工具的返回：${fed.slice(0, 200)}`)
    assert.equal(client.ofType('turn_complete').length, 1)
  })

  test('子代理拿不到 MCP 通道（只读保证不能被绕过）', async () => {
    const s = sessions.createSession()
    const { executeTool } = tools
    // 子代理的 ctx 把 callMcpTool 置成 undefined，这里直接验证这条约定
    await assert.rejects(
      () => executeTool('mcp__stub__echo', { text: 'x' }, { session: s, callMcpTool: undefined }),
      /MCP 客户端未挂载/,
    )
  })
})
