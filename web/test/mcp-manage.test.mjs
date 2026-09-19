/**
 * MCP 图形化管理（保存 / 列表 / 删除 + 作用域）。
 *
 * 重点验证三件事：
 *  1. 写的是**用户指定的那个作用域**的文件，不串作用域
 *  2. 列表是结构化的（带 source / state / problem），不是给文本让人去解析
 *  3. 删除时若该作用域**没定义**这台服务器，返回 false 且不动任何文件
 *     （否则会出现"点了删除却什么都没发生"的错觉）
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkspace, rmDir } from './helpers.mjs'

let configDir
let ws
let mcp

const userFile = () => join(configDir, 'settings.json')
const projectFile = () => join(ws.dir, '.limkenion', 'settings.json')

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-mcp-cfg-'))
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  await mkdir(join(ws.dir, '.limkenion'), { recursive: true })
  mcp = await import('../server/mcp.mjs')
})

after(async () => {
  await rmDir(ws.dir)
  await rmDir(configDir)
})

test('保存到 user 作用域：只写 user 文件，不碰 project', async () => {
  await writeFile(userFile(), JSON.stringify({ mcpServers: {} }), 'utf8')
  mcp.saveMcpServer('demo', { type: 'stdio', command: 'node', args: ['server.js'] }, 'user')

  const user = await readJsonSafe(userFile())
  assert.equal(user?.mcpServers?.demo?.command, 'node')
  assert.deepStrictEqual(user?.mcpServers?.demo?.args, ['server.js'])

  const proj = await readJsonSafe(projectFile())
  assert.equal(proj?.mcpServers?.demo, undefined, '不该写到 project 作用域')
})

test('mcpServersInfo 是结构化的（含 source / state / problem）', async () => {
  await writeFile(userFile(), JSON.stringify({ mcpServers: { demo: { command: 'node' } } }), 'utf8')
  const list = mcp.mcpServersInfo()
  const demo = list.find(s => s.name === 'demo')
  assert.ok(demo, '应列出 demo')
  assert.equal(demo.source, 'user')
  assert.equal(demo.transport, 'stdio')
  assert.ok(typeof demo.state === 'string', 'state 应是字符串')
  assert.ok('problem' in demo, '应带上不可用原因字段（没有时为 null）')
  assert.ok(Array.isArray(demo.tools), 'tools 应是数组')
})

test('删除：不在该作用域时返回 false 且不动任何文件', async () => {
  await writeFile(userFile(), JSON.stringify({ mcpServers: { demo: { command: 'node' } } }), 'utf8')
  const before = await readFile(userFile(), 'utf8')

  assert.strictEqual(mcp.deleteMcpServer('demo', 'project'), false, 'project 里没有 demo')
  assert.strictEqual(await readFile(userFile(), 'utf8'), before, '不该改动任何文件')
  assert.ok(mcp.mcpServersInfo().some(s => s.name === 'demo'), 'demo 应还在')

  assert.strictEqual(mcp.deleteMcpServer('demo', 'user'), true)
  assert.ok(!mcp.mcpServersInfo().some(s => s.name === 'demo'), 'demo 应已被删掉')
})

test('作用域分离：同名服务器按作用域各存一份', async () => {
  await writeFile(userFile(), JSON.stringify({ mcpServers: {} }), 'utf8')
  mcp.saveMcpServer('both', { type: 'stdio', command: 'from-user' }, 'user')
  mcp.saveMcpServer('both', { type: 'stdio', command: 'from-project' }, 'project')

  const user = await readJsonSafe(userFile())
  const proj = await readJsonSafe(projectFile())
  assert.equal(user?.mcpServers?.both?.command, 'from-user')
  assert.equal(proj?.mcpServers?.both?.command, 'from-project', '同名服务器各作用域独立')
})

test('空名字要报错，不能写出一个空键', async () => {
  await writeFile(userFile(), JSON.stringify({ mcpServers: {} }), 'utf8')
  assert.throws(() => mcp.saveMcpServer('   ', { type: 'stdio' }, 'user'), /服务器名/)
})
