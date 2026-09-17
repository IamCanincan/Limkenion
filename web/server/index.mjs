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
import { CORE_TOOL_NAMES, mcpToolNames, registerMcpTools } from './tools.mjs'
import { deferredToolNames } from './toolindex.mjs'
import { HOST, PORT, SERVER_VERSION } from './config.mjs'
import { loadCommandRegistry } from './commands.mjs'
import { clearAllCrons, clearCronsForSession } from './engine.mjs'
import { closeAllMcp, connectAll, hasMcpConfig, mcpStatusLine, mcpToolSchemas, onMcpToolsChanged } from './mcp.mjs'
import { attachWebSocket } from './protocol.mjs'
import { securityBanner } from './security.mjs'
import { loadSettings, settingsSummary, unhonoredRules } from './settings.mjs'
import {
  allSessionInfo,
  allSessions,
  createSession,
  loadPersisted,
  onSessionDeleted,
  persistNow,
  STATE_FILE,
} from './sessions.mjs'
import { hooksEnabled, runEventHooks, sessionHookInput } from './hooks.mjs'
import { createHttpServer } from './static.mjs'

// 会话被删除时清理它的定时器（sessions 不反向依赖 engine，用钩子通知）
onSessionDeleted(id => clearCronsForSession(id))

// MCP 工具变化时刷新工具注册表（连接完成 / 重连之后都会触发）
onMcpToolsChanged(() => {
  registerMcpTools(mcpToolSchemas())
})

const commandRegistry = await loadCommandRegistry()
const restored = await loadPersisted()
if (restored === 0) createSession()
// 设置文件在启动时读一次（config.mjs 的默认权限模式依赖它，必须在建会话之前）
loadSettings()

const httpServer = createHttpServer()
attachWebSocket(httpServer, commandRegistry)

httpServer.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST
  console.log(`Limkenion web 服务已启动：http://${shown}:${PORT}`)
  console.log(`WebSocket 端点：ws://${shown}:${PORT}/ws`)
  console.log(`命令注册表：${commandRegistry.length} 个斜杠命令`)
  console.log(
    `工具集：${TOOL_SCHEMAS.length} 个（常驻 ${CORE_TOOL_NAMES.size}，延迟 ${deferredToolNames().length}）`,
  )
  console.log(`会话：${allSessionInfo().length} 个（本次恢复 ${restored} 个）`)
  if (restored > 0) console.log(`状态文件：${STATE_FILE}`)
  // 设置文件（与 CLI 同一套路径）—— 权限规则在这里读一次
  console.log(settingsSummary())
  const unhonored = unhonoredRules()
  if (unhonored.length > 0) {
    console.warn(
      `注意：${unhonored.length} 条权限规则在 web 端不会生效（该工具的 specifier 语义未实现）：` +
        unhonored.map(u => `${u.kind}:${u.rule}`).join('、'),
    )
  }
  console.log(`版本：${SERVER_VERSION}`)
  for (const line of securityBanner()) console.log(line)

  // MCP：配了才连（后台连，失败只记状态 —— 一个配错的服务器不该让服务起不来）
  if (hasMcpConfig()) {
    console.log(mcpStatusLine())
    void connectAll().then(r => {
      console.log(
        `MCP 连接结果：成功 ${r.connected}、失败 ${r.failed}、不支持 ${r.skipped}` +
          `（工具 ${mcpToolNames().length} 个，用 /mcp 看详情）`,
      )
    })
  }
})

// 退出前落盘并清理定时器
let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    clearAllCrons()
    closeAllMcp()
    // SessionEnd 钩子：给用户一个"服务要关了"的通知/清理点。
    // 必须**限时**（2s）：钩子是用户脚本，卡住的钩子不能把服务关不掉。
    const ending = hooksEnabled()
      ? Promise.race([
          (async () => {
            for (const s of allSessions()) {
              const r = await runEventHooks('SessionEnd', { hookInput: sessionHookInput(s, { reason: sig }) })
              for (const m of r.messages) console.warn('[hooks] SessionEnd:', m)
            }
          })(),
          new Promise(r => setTimeout(r, 2000)),
        ])
      : Promise.resolve()
    ending
      .then(() => persistNow().catch(() => {}))
      .finally(() => process.exit(0))
    // 兜底：2.5 秒内没结束也退出
    setTimeout(() => process.exit(0), 2500).unref()
  })
}
