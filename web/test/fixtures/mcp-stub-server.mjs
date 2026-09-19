/**
 * 测试用的桩 MCP 服务器（stdio，换行分隔的 JSON-RPC 2.0）。
 *
 * 用法：`node mcp-stub.mjs [reverse]`
 *   reverse → 在 initialize 之后主动发一个 `sampling/createMessage` 反向请求，
 *             并把客户端给我们的回应写到同目录的 reverse-answer.json。
 *             用来验证"我们会对未实现的反向请求明确回错，而不是挂着不回"。
 *
 * 提供的工具：
 *   echo({ text })  → 文本
 *   boom({})        → isError 结果
 * 提供的资源：stub://readme
 */

import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const wantReverse = process.argv.includes('reverse')
const SERVER_INFO = { name: 'stub-mcp', version: '1.2.3' }

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

let buf = ''
process.stdin.on('data', chunk => {
  buf += chunk.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line) handle(JSON.parse(line))
  }
})

function handle(msg) {
  // 客户端对我们反向请求的回应
  if (msg.id === 'reverse-1' && (msg.result || msg.error)) {
    // 同 server/paths.mjs 的理由：不用 import.meta.dirname（Node 20.11+ 才有）
    writeFileSync(join(HERE, 'reverse-answer.json'), JSON.stringify(msg, null, 1))
    return
  }

  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: {} },
        serverInfo: SERVER_INFO,
      })
      if (wantReverse) {
        // 立刻发一个反向请求：web 端应当明确回 -32601
        send({ jsonrpc: '2.0', id: 'reverse-1', method: 'sampling/createMessage', params: { messages: [] } })
      }
      return
    case 'notifications/initialized':
      return
    case 'tools/list':
      reply(msg.id, {
        tools: [
          {
            name: 'echo',
            description: '把输入原样回显',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              // 故意不给 required：验证客户端会补齐
            },
          },
          {
            name: 'boom',
            description: '总是失败（isError）',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      })
      return
    case 'tools/call': {
      const name = msg.params?.name
      if (name === 'echo') {
        return reply(msg.id, {
          content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }],
        })
      }
      if (name === 'boom') {
        return reply(msg.id, {
          isError: true,
          content: [{ type: 'text', text: '工具自己报告失败' }],
        })
      }
      return fail(msg.id, -32602, `未知工具：${name}`)
    }
    case 'resources/list':
      return reply(msg.id, {
        resources: [{ uri: 'stub://readme', name: 'readme', mimeType: 'text/plain' }],
      })
    case 'resources/read':
      if (msg.params?.uri === 'stub://readme') {
        return reply(msg.id, { contents: [{ uri: 'stub://readme', text: '这是桩资源' }] })
      }
      return fail(msg.id, -32602, `未知资源：${msg.params?.uri}`)
    default:
      // 未知方法（含 notifications）不回应
      if (msg.id !== undefined) fail(msg.id, -32601, `未知方法：${msg.method}`)
  }
}
