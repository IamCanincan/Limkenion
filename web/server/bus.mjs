/**
 * WebSocket 连接注册表与消息发送。
 *
 * 单独成模块是为了打断循环依赖：引擎、命令、协议都要发消息，但都不应该直接持有 wss。
 * 回合事件一律走 broadcast —— 前端按 sessionId 过滤，这样第二个标签页也能看到
 * 权限确认 / 问答弹窗，不会因为弹窗发到了别的连接而挂到超时。
 */

const clients = new Set()

/** 注册一个已通过校验的连接。 */
export function addClient(ws) {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
}

export function clientCount() {
  return clients.size
}

/** 发给单个连接（用于对本次请求的直接应答）。 */
export function send(ws, msg) {
  if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

/** 发给所有连接。 */
export function broadcast(msgOrFn) {
  const build = typeof msgOrFn === 'function' ? msgOrFn : () => msgOrFn
  for (const client of clients) send(client, build())
}
