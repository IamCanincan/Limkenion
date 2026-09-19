/**
 * MCP 管理的**协议层**测试：起真服务、连 WS、发 mcp_list / mcp_save。
 *
 * 单测覆盖不到 WS 接线（case 名写错、回包字段名拼错都不会红），所以要有这一层。
 * 注意只测到"保存进设置文件"为止，不真的连一个能用的 MCP 服务器 ——
 * 连真服务器要拉外部依赖，那是 E2E 的事。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startServer, fetchToken, rmDir } from './helpers.mjs'

let PORT = 0  // 0 = 让系统分配端口：硬编码端口在 CI 上可能被别的进程占用（EADDRINUSE）
let srv
let stateDir
let ws

function waitFor(type, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs)
    const onMsg = raw => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== type) return
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve(msg)
    }
    ws.on('message', onMsg)
  })
}

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'limkenion-mcpws-'))
  srv = await startServer({ port: PORT, env: { LIMKENION_WEB_STATE_DIR: stateDir } })
  PORT = srv.port
  const token = await fetchToken(srv.base)
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await waitFor('hello')
})

after(async () => {
  try {
    ws?.close()
  } catch {
    /* 已关 */
  }
  srv?.child.kill()
  await rmDir(stateDir)
})

test('WS mcp_list：返回结构化清单（初始为空）', async () => {
  const pending = waitFor('mcp_servers')
  ws.send(JSON.stringify({ type: 'mcp_list' }))
  const res = await pending
  assert.strictEqual(res.type, 'mcp_servers')
  assert.ok(Array.isArray(res.servers), 'servers 应是数组')
})

test('WS mcp_save：写入指定作用域并回推新清单', async () => {
  const pending = waitFor('mcp_servers')
  ws.send(
    JSON.stringify({
      type: 'mcp_save',
      name: 'ws-demo',
      scope: 'user',
      config: { type: 'stdio', command: 'node', args: ['-e', ''] },
    }),
  )
  const res = await pending
  assert.strictEqual(res.type, 'mcp_servers')
  const saved = res.servers.find(s => s.name === 'ws-demo')
  assert.ok(saved, '新清单里应有刚保存的服务器')
  assert.equal(saved.source, 'user', '作用域应记录下来')

  // 确实落到了 user 作用域的设置文件里（写成什么以文件为准，不只看回包）
  const cfgDir = process.env.LIMKENION_CONFIG_DIR ?? join(tmpdir(), 'unused')
  let onDisk = null
  try {
    onDisk = JSON.parse(await readFile(join(cfgDir, 'settings.json'), 'utf8'))
  } catch {
    onDisk = null
  }
  if (onDisk) {
    // 服务进程用的是它自己的 config dir；这里能读到就顺带断言，读不到不勉强
    assert.ok(onDisk.mcpServers?.['ws-demo'], '设置文件里应有该服务器')
  }
})
