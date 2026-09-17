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
import { runCommand, exportSessionMarkdown } from './commands.mjs'
import { newMessageId, runTurn } from './engine.mjs'
import { resolvePermission, resolveQuestions } from './interactions.mjs'
import { clearRequests, listRequests, requestSummary } from './requestLog.mjs'
import { checkHandshake } from './security.mjs'
import {
  allSessionInfo,
  broadcastSessions,
  collectStats,
  createSession,
  deleteSession,
  getSession,
  schedulePersist,
} from './sessions.mjs'
import { listIndexedFiles } from './workspace.mjs'

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
      void handleClientMessage(ws, msg, registry)
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
      if (s) s.cancelled = true
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

    case 'get_settings': {
      const s = getSession(msg.sessionId)
      send(ws, { type: 'settings', sessionId: s?.id ?? null, settings: publicSettings(s ?? null) })
      break
    }

    case 'set_setting': {
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

      const messageId = newMessageId()
      broadcast({ type: 'assistant_start', sessionId: s.id, messageId })
      await runTurn(s, text, messageId)
      break
    }

    default:
      break
  }
}
