/**
 * WebSocket 协议层：握手鉴权、消息分发、连接初始化。
 *
 * 用 noServer + 手动 upgrade，才能在握手阶段做 Origin / token 校验
 * （ws 内置的 verifyClient 只能拿到有限信息，且 path 处理不直观）。
 */

import { WebSocketServer } from 'ws'
import { addClient, broadcast, send } from './bus.mjs'
import {
  applySessionSetting,
  engineName,
  MODELS,
  PORT,
  publicSettings,
  SERVER_VERSION,
  settingsFor,
  startedAt,
} from './config.mjs'
import { HOOK_EVENT, runEventHooks } from './hooks.mjs'
import { runCommand, exportSessionMarkdown } from './commands.mjs'
import { isTurnActive, newMessageId, runTeamMemberTurn, runTurn } from './engine.mjs'
import { resolvePermission, resolveQuestions } from './interactions.mjs'
import { clearRequests, listRequests, requestSummary } from './requestLog.mjs'
import { checkHandshake } from './security.mjs'
import {
  allSessionInfo,
  broadcastSessions,
  cancelSession,
  collectStats,
  createSession,
  deleteSession,
  forkSession,
  getSession,
  schedulePersist,
} from './sessions.mjs'
import { scopeForSession, withWorkspace } from './paths.mjs'
import { listIndexedFiles } from './workspace.mjs'
import { searchAll } from './search.mjs'
import { deleteMcpServer, mcpServersInfo, reloadMcp, saveMcpServer } from './mcp.mjs'

/** 单条客户端消息的最大长度（防超大帧打爆内存）。 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024

export function attachWebSocket(httpServer, registry) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  httpServer.on('upgrade', (req, socket, head) => {
    let url
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    } catch {
      socket.destroy()
      return
    }

    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const reason = checkHandshake({
      origin: req.headers.origin,
      token: url.searchParams.get('token'),
      host: req.headers.host,
    })
    if (reason) {
      console.warn(`拒绝 WS 连接：${reason}（origin=${req.headers.origin ?? '无'}）`)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })

  wss.on('connection', ws => {
    addClient(ws)

    ws.on('message', raw => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      // **必须 .catch()**：handleClientMessage 是 async，抛出的异常若没人接就是
      // 「未处理的 promise rejection」—— Node 15+ 默认直接终止进程。
      // 实测：一条 `{"type":"run_command","command":{"toString":null}}` 就能让
      // 整个服务退出（String() 对这种对象会抛 TypeError）。这里让**单条消息**失败即可，
      // 并把原因回给客户端。
      //
      // 注意别在 catch 里对 msg 做强制转换 —— msg 是不可信输入，
      // 刚才抛错的原因可能正是 `String(msg.xxx)`，那样会二次抛出。
      void handleClientMessage(ws, msg, registry).catch(err => {
        console.error('[ws] 处理消息失败：', err)
        try {
          send(ws, { type: 'error', message: `服务端处理消息失败：${err?.message ?? '未知错误'}` })
        } catch {
          /* 连接可能已断 */
        }
      })
    })

    send(ws, { type: 'hello', sessions: allSessionInfo(), serverVersion: SERVER_VERSION })
    send(ws, { type: 'commands', commands: registry })
    send(ws, { type: 'models', models: MODELS, current: settingsFor(null).model })
    // 未绑定会话时下发全局默认设置
    send(ws, { type: 'settings', sessionId: null, settings: publicSettings(null) })
  })

  return wss
}

/** 解析请求里的会话；不存在则回错误并返回 null。 */
function requireSession(ws, sessionId) {
  const s = getSession(sessionId)
  if (!s) send(ws, { type: 'error', message: `会话不存在：${sessionId}` })
  return s ?? null
}

async function handleClientMessage(ws, msg, registry) {
  // 沙箱根是按会话的（会话可以进入某个 git worktree），所以每条消息都在
  // **该会话的作用域**里处理 —— 命令（/status、/diff、/memory…）与文件列表
  // 都属于"这个会话在看哪个目录"的范畴。没有 sessionId 的消息（如 new_session）
  // 走默认根，因为它们不碰文件。
  const session = msg.sessionId ? getSession(msg.sessionId) : null
  return withWorkspace(scopeForSession(session), () => handleClientMessageInner(ws, msg, registry))
}

async function handleClientMessageInner(ws, msg, registry) {
  switch (msg.type) {
    case 'new_session': {
      const s = createSession()
      broadcastSessions()
      send(ws, { type: 'session_messages', sessionId: s.id, messages: s.messages })
      send(ws, { type: 'settings', sessionId: s.id, settings: publicSettings(s) })
      break
    }

    case 'select_session': {
      const s = getSession(msg.sessionId)
      if (!s) {
        send(ws, { type: 'error', message: `会话不存在：${msg.sessionId}` })
        return
      }
      send(ws, { type: 'session_messages', sessionId: s.id, messages: s.messages })
      send(ws, { type: 'settings', sessionId: s.id, settings: publicSettings(s) })
      break
    }

    case 'rename_session': {
      const s = getSession(msg.sessionId)
      if (s) {
        s.title = String(msg.title ?? '').trim().slice(0, 40) || s.title
        s.updatedAt = Date.now()
        broadcastSessions()
        schedulePersist()
      }
      break
    }

    case 'fork_session': {
      // 对应 CLI 的 /branch：在某处分叉出一条独立会话。
      // 带上 atIndex 就是「从第 N 条消息处分叉」（前端在消息上点分叉时用）。
      const src = requireSession(ws, msg.sessionId)
      if (!src) return
      const forked = forkSession(src, msg.title, msg.atIndex)
      if (!forked) {
        send(ws, { type: 'error', message: '分叉失败：找不到源会话' })
        return
      }
      broadcastSessions()
      send(ws, {
        type: 'session_forked',
        sessionId: forked.id,
        fromId: src.id,
        title: forked.title,
        messageCount: forked.messages.length,
      })
      // 直接把新会话的内容推过去 —— 前端收到 session_messages 会自动切到它
      send(ws, { type: 'session_messages', sessionId: forked.id, messages: forked.messages })
      send(ws, { type: 'settings', sessionId: forked.id, settings: publicSettings(forked) })
      // 切换之后再补一条提示（顺序上必须在这之后，否则会被 session_messages 覆盖掉）
      broadcast({
        type: 'notice',
        sessionId: forked.id,
        text: `已分叉出「${forked.title}」（${forked.messages.length} 条消息）。这是独立的一份，改它不影响原会话。`,
      })
      break
    }

    case 'delete_session': {
      if (deleteSession(msg.sessionId)) {
        broadcastSessions()
        send(ws, { type: 'session_deleted', sessionId: msg.sessionId })
        const remaining = allSessionInfo()
        if (remaining.length > 0) {
          send(ws, { type: 'session_messages', sessionId: remaining[0].id, messages: getSession(remaining[0].id)?.messages ?? [] })
        }
      }
      break
    }

    case 'cancel': {
      const s = getSession(msg.sessionId)
      // 用 cancelSession：除了置 cancelled，还会推进回合代次 ——
      // 这样即使用户紧接着又发一条（下面会把 cancelled 置回 false），
      // 被中断的那个回合也回不来。
      if (s) cancelSession(s)
      break
    }

    case 'permission_response': {
      resolvePermission(msg.requestId, msg.decision)
      break
    }

    case 'question_response': {
      resolveQuestions(msg.requestId, msg.answers)
      break
    }

    case 'get_models': {
      const s = getSession(msg.sessionId)
      send(ws, { type: 'models', models: MODELS, current: settingsFor(s).model })
      break
    }

    case 'set_model': {
      const s = getSession(msg.sessionId)
      if (!MODELS.some(m => m.value === msg.model)) {
        send(ws, { type: 'error', message: `未知模型：${msg.model}` })
        break
      }
      if (!applySessionSetting(s ?? null, 'model', msg.model)) {
        send(ws, { type: 'error', message: `无法切换模型：${msg.model}` })
      }
      schedulePersist()
      break
    }

    case 'get_team': {
      const s = getSession(msg.sessionId)
      send(ws, { type: 'team', sessionId: s?.id ?? null, team: s?.team ?? null })
      break
    }

    case 'team_message': {
      const s = getSession(msg.sessionId)
      if (!s) {
        send(ws, { type: 'error', message: '会话不存在' })
        break
      }
      // 后台跑成员回合：事件按成员广播到团队面板，不阻塞消息通道
      void runTeamMemberTurn(s, String(msg.member ?? ""), String(msg.text ?? ""))
      break
    }

    case 'get_settings': {
      const s = getSession(msg.sessionId)
      send(ws, { type: 'settings', sessionId: s?.id ?? null, settings: publicSettings(s ?? null) })
      break
    }

    case 'set_setting': {
      void runEventHooks(HOOK_EVENT.CONFIG_CHANGE, {
        hookInput: { session_id: msg.sessionId ?? '', key: String(msg.key ?? ''), value: String(msg.value ?? '') },
      }).catch(() => {})
      const s = getSession(msg.sessionId)
      if (!applySessionSetting(s ?? null, msg.key, msg.value)) {
        send(ws, { type: 'error', message: `无法设置 ${msg.key} = ${msg.value}` })
      }
      schedulePersist()
      break
    }

    case 'get_stats': {
      const s = getSession(msg.sessionId) ?? allSessionInfo()[0]
      send(ws, { type: 'stats', stats: collectStats(s ? getSession(s.id) : null, startedAt) })
      break
    }

    case 'get_requests': {
      send(ws, {
        type: 'requests',
        requests: listRequests(msg.limit),
        summary: requestSummary(),
      })
      break
    }

    case 'clear_requests': {
      const cleared = clearRequests()
      send(ws, {
        type: 'requests',
        requests: listRequests(msg.limit),
        summary: requestSummary(),
        cleared,
      })
      break
    }

    case 'export_session': {
      const s = requireSession(ws, msg.sessionId)
      if (!s) return
      send(ws, {
        type: 'session_export',
        sessionId: s.id,
        filename: `${s.title || 'session'}.md`,
        markdown: exportSessionMarkdown(s),
      })
      break
    }

    // ---- MCP 图形化管理：列 / 存 / 删 ----
    // 写的是设置文件（按作用域分文件），改完由这里触发重连。
    case 'mcp_list':
      send(ws, { type: 'mcp_servers', servers: mcpServersInfo() })
      break
    case 'mcp_save': {
      try {
        const scope = msg.scope === 'project' || msg.scope === 'local' ? msg.scope : 'user'
        const saved = saveMcpServer(String(msg.name ?? ''), msg.config ?? {}, scope)
        send(ws, { type: 'mcp_servers', servers: mcpServersInfo() })
        if (saved) void reloadMcp().then(() => send(ws, { type: 'mcp_servers', servers: mcpServersInfo() }))
      } catch (err) {
        send(ws, { type: 'error', message: `保存 MCP 服务器失败：${String(err)}` })
      }
      break
    }
    case 'mcp_delete': {
      try {
        const scope = msg.scope === 'project' || msg.scope === 'local' ? msg.scope : 'user'
        const removed = deleteMcpServer(String(msg.name ?? ''), scope)
        if (!removed) {
          send(ws, { type: 'error', message: `${scope} 作用域里没有服务器「${msg.name}」，未做改动` })
          break
        }
        send(ws, { type: 'mcp_servers', servers: mcpServersInfo() })
        void reloadMcp().then(() => send(ws, { type: 'mcp_servers', servers: mcpServersInfo() }))
      } catch (err) {
        send(ws, { type: 'error', message: `删除 MCP 服务器失败：${String(err)}` })
      }
      break
    }

    // 全局搜索：跨会话消息 + 文件名 + 会话标题。
    // 纯内存/索引扫描，不做任何写操作，也不碰文件系统权限之外的东西。
    case 'search': {
      try {
        const q = String(msg.query ?? '')
        const r = await searchAll(q, { limit: Number(msg.limit) || undefined })
        send(ws, { type: 'search_results', ...r })
      } catch (err) {
        send(ws, { type: 'error', message: `搜索失败：${String(err)}` })
      }
      break
    }

    case 'list_files': {
      try {
        send(ws, { type: 'files', files: await listIndexedFiles() })
      } catch (err) {
        send(ws, { type: 'error', message: `文件列表失败：${String(err)}` })
      }
      break
    }

    case 'run_command': {
      const s = requireSession(ws, msg.sessionId)
      if (!s) return
      const [name, ...rest] = String(msg.command ?? '').replace(/^\//, '').split(/\s+/)
      const output = await runCommand(s, name, rest.join(' '), ws, registry)
      send(ws, { type: 'command_result', sessionId: s.id, output })
      broadcastSessions()
      break
    }

    case 'user_message': {
      const s = requireSession(ws, msg.sessionId)
      if (!s) return
      const text = String(msg.text ?? '')

      // 斜杠命令走命令通道
      if (text.startsWith('/')) {
        const [name, ...rest] = text.slice(1).split(/\s+/)
        const output = await runCommand(s, name, rest.join(' '), ws, registry)
        const sysMessage = {
          id: newMessageId(),
          role: 'system',
          text: output,
          timestamp: Date.now(),
        }
        s.messages.push(sysMessage)
        s.updatedAt = Date.now()
        broadcast({ type: 'user_message', sessionId: s.id, message: { ...sysMessage, role: 'user', text } })
        send(ws, { type: 'command_result', sessionId: s.id, output })
        broadcastSessions()
        schedulePersist()
        return
      }

      s.cancelled = false
      if (s.title === '新会话' && s.messages.length === 0) {
        s.title = text.slice(0, 24) || '新会话'
      }

      // 图片输入：校验大小与协议前缀后随消息一起存
      const images = Array.isArray(msg.images)
        ? msg.images
            .filter(i => typeof i?.dataUrl === 'string' && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(i.dataUrl))
            .slice(0, 4)
            .map(i => ({ dataUrl: i.dataUrl, name: String(i.name ?? 'image') }))
        : []

      const userMessage = {
        id: newMessageId(),
        role: 'user',
        text,
        images: images.length > 0 ? images : undefined,
        timestamp: Date.now(),
      }
      s.messages.push(userMessage)
      s.updatedAt = Date.now()
      broadcast({ type: 'user_message', sessionId: s.id, message: userMessage })
      broadcastSessions()

      // ---- 排队消息（上游 CLI 原型 同款）：回合进行中再发消息不打断、不吞掉，
      // ---- 排进队列，当前回合结束后按序自动处理。此前这里会被并发守卫
      // ---- 静默吞掉（消息入库了但永远得不到回复）。
      if (isTurnActive(s.id)) {
        ;(s.messageQueue ??= []).push({ text, at: Date.now() })
        broadcast({ type: 'notice', sessionId: s.id, text: `回合进行中，这条消息已排队（当前还有 ${s.messageQueue.length} 条待处理），回合结束后自动执行。` })
        schedulePersist()
        break
      }

      const messageId = newMessageId()
      broadcast({ type: 'assistant_start', sessionId: s.id, messageId })
      await runTurn(s, text, messageId)
      break
    }

    default:
      break
  }
}
