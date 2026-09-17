/**
 * 对等地址解析——与 peerRegistry.ts 分开，使 SendMessageTool 能在工具枚举时
 * 导入 parseAddress，而不会间接加载 bridge（axios）和 UDS（fs、net）模块。
 */

/** 把 URI 风格地址解析为 scheme + target。 */
export function parseAddress(to: string): {
  scheme: 'uds' | 'bridge' | 'other'
  target: string
} {
  if (to.startsWith('uds:')) return { scheme: 'uds', target: to.slice(4) }
  if (to.startsWith('bridge:')) return { scheme: 'bridge', target: to.slice(7) }
  // 旧版：老代码的 UDS 发送方会在 from= 中发出裸 socket 路径；让它们走
  // UDS 分支，以免回复被静默丢弃进队友路由。
  // （没有裸会话 ID 的后备方案——bridge 消息机制太新，没有旧发送方，
  // 且前缀会劫持诸如 session_manager 的队友名。）
  if (to.startsWith('/')) return { scheme: 'uds', target: to }
  return { scheme: 'other', target: to }
}
