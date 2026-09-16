/**
 * Limkenion web 本地服务 —— 入口：装配各模块并启动。
 *
 * 模块划分（原先 1300+ 行挤在一个文件里）：
 *   paths.mjs      路径解析与沙箱校验
 *   config.mjs     常量、设置（全局默认 + 会话级覆盖）
 *   bus.mjs        WS 连接注册表与广播
 *   security.mjs   握手鉴权、shell 守卫、不可信内容隔离
 *   sessions.mjs   会话存储 + 磁盘持久化
 *   workspace.mjs  工作区文件索引（带缓存）
 *   interactions.mjs 权限确认 / 问答通道
 *   tools.mjs      CLI 工具集镜像（41 个）
 *   toolindex.mjs  工具延迟加载
 *   engine.mjs     回合循环、子代理、定时任务
 *   commands.mjs   斜杠命令语义
 *   static.mjs     HTTP 静态伺服
 *   protocol.mjs   WebSocket 协议
 *
 * 运行：cd web && npm install && npm run build && npm run serve
 */

import { TOOL_SCHEMAS } from './tools.mjs'
import { CORE_TOOL_NAMES } from './tools.mjs'
import { DEFERRED_TOOL_NAMES } from './toolindex.mjs'
import { HOST, PORT, SERVER_VERSION } from './config.mjs'
import { loadCommandRegistry } from './commands.mjs'
import { clearAllCrons, clearCronsForSession } from './engine.mjs'
import { attachWebSocket } from './protocol.mjs'
import { securityBanner } from './security.mjs'
import {
  allSessionInfo,
  createSession,
  loadPersisted,
  onSessionDeleted,
  persistNow,
  STATE_FILE,
} from './sessions.mjs'
import { createHttpServer } from './static.mjs'

// 会话被删除时清理它的定时器（sessions 不反向依赖 engine，用钩子通知）
onSessionDeleted(id => clearCronsForSession(id))

const commandRegistry = await loadCommandRegistry()
const restored = await loadPersisted()
if (restored === 0) createSession()

const httpServer = createHttpServer()
attachWebSocket(httpServer, commandRegistry)

httpServer.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST
  console.log(`Limkenion web 服务已启动：http://${shown}:${PORT}`)
  console.log(`WebSocket 端点：ws://${shown}:${PORT}/ws`)
  console.log(`命令注册表：${commandRegistry.length} 个斜杠命令`)
  console.log(
    `工具集：${TOOL_SCHEMAS.length} 个（常驻 ${CORE_TOOL_NAMES.size}，延迟 ${DEFERRED_TOOL_NAMES.length}）`,
  )
  console.log(`会话：${allSessionInfo().length} 个（本次恢复 ${restored} 个）`)
  if (restored > 0) console.log(`状态文件：${STATE_FILE}`)
  console.log(`版本：${SERVER_VERSION}`)
  for (const line of securityBanner()) console.log(line)
})

// 退出前落盘并清理定时器
let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    clearAllCrons()
    persistNow()
      .catch(() => {})
      .finally(() => process.exit(0))
    // 兜底：1 秒内没写完也退出
    setTimeout(() => process.exit(0), 1000).unref()
  })
}
