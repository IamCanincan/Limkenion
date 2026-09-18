/**
 * SSE 桩 MCP 服务器（旧版 HTTP+SSE 传输）。
 *
 * - GET /sse        → 建立 SSE 流，先推 endpoint 事件
 * - POST /message   → 收 JSON-RPC；响应/主动请求都从 SSE 流推回去
 * 工具：echo（直接回显）、ask_color（先 elicitation/create 反问，等应答后再回结果）。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 0)
let push = null // SSE 流写入函数
let pendingCallId = null // ask_color 的 tools/call id，等 elicitation 应答后回结果

function reply(id, result) {
  push?.({ jsonrpc: '2.0', id, result })
}

function handle(msg) {
  if (msg.method === 'initialize') {
    reply(msg.id, {
      serverInfo: { name: 'sse-stub', version: '0.0.1' },
      capabilities: { tools: {} },
    })
    return
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: [
        { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'ask_color', inputSchema: { type: 'object', properties: {} } },
      ],
    })
    return
  }
  if (msg.method === 'tools/call') {
    if (msg.params.name === 'echo') {
      reply(msg.id, { content: [{ type: 'text', text: 'echo:' + (msg.params.arguments?.text ?? '') }] })
      return
    }
    if (msg.params.name === 'ask_color') {
      pendingCallId = msg.id
      // 服务端反问：等我们（客户端）的 elicitation 应答，再回工具结果
      push({
        jsonrpc: '2.0',
        id: 'srv-elic-1',
        method: 'elicitation/create',
        params: {
          message: '选个颜色',
          requestedSchema: {
            type: 'object',
            properties: { color: { type: 'string', enum: ['红', '蓝'], description: '想要的颜色' } },
          },
        },
      })
      return
    }
  }
  // elicitation 的应答
  if (msg.id === 'srv-elic-1' && msg.result?.action === 'accept') {
    if (pendingCallId !== null) {
      reply(pendingCallId, {
        content: [{ type: 'text', text: '你选了：' + (msg.result.content?.color ?? '?') }],
      })
      pendingCallId = null
    }
  }
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/sse')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    push = m => res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`)
    res.write(`event: endpoint\ndata: http://127.0.0.1:${port}/message\n\n`)
    req.on('close', () => { push = null })
    return
  }
  if (req.method === 'POST' && req.url.startsWith('/message')) {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      res.writeHead(202)
      res.end()
      handle(JSON.parse(body))
    })
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`PORT=${server.address().port}\n`)
})
