import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LimkenionConnection, resolveWsToken } from './api'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { StatusBar } from './components/StatusBar'
import { ModelSelector } from './components/ModelSelector'
import { SettingsControls } from './components/SettingsControls'
import { RequestLogPanel } from './components/RequestLogPanel'
import { PermissionDialog, type PermissionRequest } from './components/PermissionDialog'
import { QuestionDialog } from './components/QuestionDialog'
import { PreviewPanel } from './components/PreviewPanel'
import { TeamPanel } from './components/TeamPanel'
import { SearchPanel } from './components/SearchPanel'
import type { TeamInfo } from './types'
import type {
  RequestLogEntry,
  RequestSummary,
  AskQuestion,
  ChatMessage,
  CommandInfo,
  ImageAttachment,
  ModelInfo,
  QuestionAnswer,
  SearchHit,
  ServerMessage,
  SessionInfo,
  Settings,
  TokenUsage,
  UsageStats,
} from './types'

interface QuestionRequest {
  requestId: string
  questions: AskQuestion[]
}

export function App() {
  const connection = useMemo(() => new LimkenionConnection(), [])
  const [connState, setConnState] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [currentModel, setCurrentModel] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [planMode, setPlanMode] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [requests, setRequests] = useState<RequestLogEntry[]>([])
  const [requestSummary, setRequestSummary] = useState<RequestSummary | null>(null)
  const [showRequests, setShowRequests] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updateMsg, setUpdateMsg] = useState('')
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)
  const [questionRequest, setQuestionRequest] = useState<QuestionRequest | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  // Agent Teams 工作台：面板开关、团队快照、每个成员的事件流
  const [teamOpen, setTeamOpen] = useState(false)
  const [teamData, setTeamData] = useState<TeamInfo | null>(null)
  const [teamStreams, setTeamStreams] = useState<Record<string, Record<string, unknown>[]>>({})
  // 全局搜索：面板开关、结果、以及"跳转过来的那条消息"的高亮 id
  const [showSearch, setShowSearch] = useState(false)
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchComplete, setSearchComplete] = useState(true)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const connectionRef = useRef(connection)
  // 记录当前会话 id，这样稳定的消息处理函数无需重新订阅
  // 也能始终读到最新值。
  const activeSessionIdRef = useRef<string | null>(null)

  const refreshStats = useCallback(() => {
    const id = activeSessionIdRef.current
    if (id !== null) connectionRef.current.send({ type: 'get_stats' })
  }, [])

  const refreshRequests = useCallback(() => {
    connectionRef.current.send({ type: 'get_requests' })
  }, [])

  const clearRequests = useCallback(() => {
    connectionRef.current.send({ type: 'clear_requests' })
  }, [])

  /** 会话导出：收到 Markdown 后触发浏览器下载。 */
  const downloadExport = useCallback((filename: string, markdown: string) => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [])

  /** 检查更新：先询问服务端是否有新版，有则触发应用（服务端会下载覆盖并重启）。 */
  const onCheckUpdate = useCallback(async () => {
    try {
      setUpdateMsg('检查中…')
      // 两个更新接口都要求带一次性 token 头（防跨站页面触发，见 static.mjs 的说明）。
      const headers = { 'x-limkenion-token': await resolveWsToken() }
      const r = await (await fetch('/api/check-update', { headers })).json()
      if (!r.available) {
        setUpdateMsg(`已是最新 (${r.current})`)
        setTimeout(() => setUpdateMsg(''), 3000)
        return
      }
      setUpdateMsg(`更新到 ${r.latest} 中…`)
      await fetch('/api/update', { method: 'POST', headers })
      setUpdateMsg('正在重启以完成更新…')
    } catch {
      setUpdateMsg('更新检查失败')
      setTimeout(() => setUpdateMsg(''), 3000)
    }
  }, [])

  const handleServerMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'hello':
          setSessions(msg.sessions)
          if (msg.sessions.length > 0) {
            const latest = [...msg.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
            connectionRef.current.send({ type: 'select_session', sessionId: latest.id })
          }
          break
        case 'sessions_changed':
          setSessions(msg.sessions)
          break
        case 'search_results':
          setSearchHits(msg.hits)
          setSearchComplete(msg.complete)
          setSearchTruncated(msg.truncated)
          break
        case 'session_messages':
          setActiveSessionId(msg.sessionId)
          activeSessionIdRef.current = msg.sessionId
          setMessages(msg.messages)
          setStreamingMessageId(null)
          break
        case 'session_deleted':
          if (activeSessionIdRef.current === msg.sessionId) {
            setActiveSessionId(null)
            setMessages([])
          }
          break
        case 'user_message':
          if (msg.sessionId === activeSessionIdRef.current) {
            setMessages(prev => [...prev, msg.message])
          }
          break
        case 'assistant_start':
          if (msg.sessionId === activeSessionIdRef.current) {
            setStreamingMessageId(msg.messageId)
            setMessages(prev => [
              ...prev,
              { id: msg.messageId, role: 'assistant', text: '', streaming: true, toolCalls: [], timestamp: Date.now() },
            ])
          }
          break
        case 'assistant_reasoning':
          if (msg.sessionId === activeSessionIdRef.current) {
            setMessages(prev =>
              prev.map(m =>
                m.id === msg.messageId
                  ? { ...m, reasoning: (m.reasoning ?? '') + msg.delta, reasoningStreaming: true }
                  : m,
              ),
            )
          }
          break
        case 'assistant_delta':
          if (msg.sessionId === activeSessionIdRef.current) {
            setMessages(prev =>
              prev.map(m =>
                m.id === msg.messageId
                  ? { ...m, text: m.text + msg.delta, reasoningStreaming: false }
                  : m,
              ),
            )
          }
          break
        case 'tool_call':
          if (msg.sessionId === activeSessionIdRef.current) {
            setMessages(prev =>
              prev.map(m =>
                m.id === msg.messageId
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), msg.toolCall] }
                  : m,
              ),
            )
          }
          break
        case 'tool_result':
          if (msg.sessionId === activeSessionIdRef.current) {
            setMessages(prev =>
              prev.map(m =>
                m.id === msg.messageId
                  ? {
                      ...m,
                      toolCalls: (m.toolCalls ?? []).map(tc =>
                        tc.id === msg.toolCallId
                          ? {
                              ...tc,
                              status: msg.ok ? 'done' : 'error',
                              result: msg.result,
                              durationMs: msg.durationMs,
                              diff: msg.diff ?? tc.diff,
                            }
                          : tc,
                      ),
                    }
                  : m,
              ),
            )
          }
          break
        case 'turn_complete':
          setLastUsage(msg.usage)
          setStreamingMessageId(null)
          setMessages(prev =>
            prev.map(m =>
              m.id === msg.messageId ? { ...m, streaming: false, reasoningStreaming: false, usage: msg.usage } : m,
            ),
          )
          refreshStats()
          break
        case 'turn_cancelled':
          setStreamingMessageId(null)
          setMessages(prev =>
            prev.map(m =>
              m.id === msg.messageId
                ? { ...m, streaming: false, reasoningStreaming: false, text: m.text + '\n\n_[已中断]_' }
                : m,
            ),
          )
          break
        case 'commands':
          setCommands(msg.commands)
          break
        case 'models':
          setModels(msg.models)
          setCurrentModel(msg.current)
          break
        case 'model_changed':
          // 设置是会话级的：只应用属于当前会话（或全局默认）的变更
          if (msg.sessionId == null || msg.sessionId === activeSessionIdRef.current) {
            setCurrentModel(msg.model)
          }
          break
        case 'settings':
          if (msg.sessionId == null || msg.sessionId === activeSessionIdRef.current) {
            setSettings(msg.settings)
          }
          break
        case 'files':
          setFiles(msg.files)
          break
        case 'plan_mode_changed':
          if (msg.sessionId == null || msg.sessionId === activeSessionIdRef.current) {
            setPlanMode(msg.active)
          }
          break
        case 'notice':
          setMessages(prev => [
            ...prev,
            { id: `notice_${Date.now()}`, role: 'system', text: `ℹ️ ${msg.text}`, timestamp: Date.now() },
          ])
          break
        case 'session_export':
          downloadExport(msg.filename, msg.markdown)
          break
        case 'stats':
          setStats(msg.stats)
          break
        case 'requests':
          setRequests(msg.requests)
          setRequestSummary(msg.summary)
          break
        case 'permission_request':
          setPermissionRequest({
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            escalate: msg.escalate ?? null,
          })
          break
        case 'preview_open':
          setPreviewUrl(msg.url)
          break
        case 'team':
          setTeamData(msg.team)
          break
        case 'team_event':
          setTeamStreams(prev => ({
            ...prev,
            [msg.member]: [...(prev[msg.member] ?? []), msg.payload],
          }))
          break

        case 'question_request':
          setQuestionRequest({ requestId: msg.requestId, questions: msg.questions })
          break
        case 'command_result':
          if (msg.sessionId === activeSessionIdRef.current) {
            setMessages(prev => [
              ...prev,
              { id: `sys_${Date.now()}`, role: 'system', text: msg.output, timestamp: Date.now() },
            ])
          }
          refreshStats()
          break
        case 'error':
          setError(msg.message)
          setTimeout(() => setError(null), 6000)
          break
      }
    },
    [refreshStats, downloadExport],
  )

  useEffect(() => {
    const conn = connectionRef.current
    const offMsg = conn.onMessage(handleServerMessage)
    const offState = conn.onStateChange(open => setConnState(open ? 'open' : 'closed'))
    conn.connect()
    return () => {
      offMsg()
      offState()
      conn.disconnect()
    }
  }, [handleServerMessage])

  // 主题：把设置同步到 <html data-theme>（system 跟随系统偏好）
  useEffect(() => {
    const theme = settings?.theme ?? 'dark'
    const apply = () => {
      const resolved =
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'dark'
          : theme
      document.documentElement.setAttribute('data-theme', resolved)
    }
    apply()
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings?.theme])

  const onSelectSession = useCallback((id: string) => {
    connectionRef.current.send({ type: 'select_session', sessionId: id })
  }, [])

  const onNewSession = useCallback(() => {
    connectionRef.current.send({ type: 'new_session' })
  }, [])

  const onRenameSession = useCallback((id: string, title: string) => {
    connectionRef.current.send({ type: 'rename_session', sessionId: id, title })
  }, [])

  const onDeleteSession = useCallback((id: string) => {
    connectionRef.current.send({ type: 'delete_session', sessionId: id })
  }, [])

  const onExportSession = useCallback((id: string) => {
    connectionRef.current.send({ type: 'export_session', sessionId: id })
  }, [])

  /** 分叉会话（对应 CLI 的 /branch）。服务端会回 session_forked + session_messages，自动切过去。 */
  const onForkSession = useCallback((id: string, title?: string) => {
    connectionRef.current.send({ type: 'fork_session', sessionId: id, title })
  }, [])

  const onSend = useCallback((text: string, images?: ImageAttachment[]) => {
    const sessionId = activeSessionIdRef.current
    if (sessionId === null) {
      setError('没有活动会话，请先新建会话')
      return
    }
    connectionRef.current.send({ type: 'user_message', sessionId, text, images })
  }, [])

  const onCancel = useCallback(() => {
    const sessionId = activeSessionIdRef.current
    if (sessionId !== null) connectionRef.current.send({ type: 'cancel', sessionId })
  }, [])

  const onSelectModel = useCallback((model: string) => {
    connectionRef.current.send({ type: 'set_model', model, sessionId: activeSessionIdRef.current ?? undefined })
  }, [])

  const onSetSetting = useCallback(
    (key: 'theme' | 'permissionMode' | 'effortLevel' | 'outputStyle', value: string | null) => {
      connectionRef.current.send({
        type: 'set_setting',
        key,
        value,
        sessionId: activeSessionIdRef.current ?? undefined,
      })
    },
    [],
  )

  const onRequestFiles = useCallback(() => {
    connectionRef.current.send({ type: 'list_files' })
  }, [])

  const onPermissionRespond = useCallback(
    (requestId: string, decision: 'allow' | 'always' | 'deny') => {
      setPermissionRequest(null)
      connectionRef.current.send({ type: 'permission_response', requestId, decision })
    },
    [],
  )

  const onQuestionRespond = useCallback((requestId: string, answers: QuestionAnswer[]) => {
    setQuestionRequest(null)
    connectionRef.current.send({ type: 'question_response', requestId, answers })
  }, [])

  // ---- 全局搜索 ----

  // Cmd+K / Ctrl+K 开关搜索面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setShowSearch(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onSearchQuery = useCallback((query: string) => {
    if (query.trim().length === 0) {
      setSearchHits([])
      return
    }
    connectionRef.current.send({ type: 'search', query })
  }, [])

  /** 选中一条命中：切到对应会话（必要时），并定位到那条消息。 */
  const onSearchPick = useCallback((hit: SearchHit) => {
    setShowSearch(false)
    if (hit.kind === 'file') {
      // 文件路径目前只展示（要插入输入框得把 Composer 的输入状态提到 App，留作后续）
      return
    }
    const target = hit.sessionId
    if (target !== activeSessionIdRef.current) {
      connectionRef.current.send({ type: 'select_session', sessionId: target })
      activeSessionIdRef.current = target
      setActiveSessionId(target)
    }
    if (hit.kind === 'message') setHighlightId(hit.messageId)
  }, [])

  // 命中消息：等该会话的消息渲染出来后滚动过去并闪一下
  useEffect(() => {
    if (!highlightId) return
    const t = setTimeout(() => {
      document
        .querySelector(`[data-message-id="${highlightId}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
    // 闪完就撤，避免一直高亮
    const clear = setTimeout(() => setHighlightId(null), 2000)
    return () => {
      clearTimeout(t)
      clearTimeout(clear)
    }
  }, [highlightId, messages])

  return (
    <div className="app">
      {permissionRequest && (
        <PermissionDialog request={permissionRequest} onRespond={onPermissionRespond} />
      )}
      {questionRequest && (
        <QuestionDialog
          requestId={questionRequest.requestId}
          questions={questionRequest.questions}
          onRespond={onQuestionRespond}
        />
      )}
      {previewUrl && (
        <PreviewPanel url={previewUrl} onClose={() => setPreviewUrl(null)} />
      )}
      {teamOpen && (
        <TeamPanel
          sessionId={activeSessionId ?? ''}
          team={teamData}
          streams={teamStreams}
          onSend={(member, text) => connectionRef.current.send({ type: 'team_message', sessionId: activeSessionId ?? '', member, text })}
          onClose={() => setTeamOpen(false)}
        />
      )}
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        stats={stats}
        onSelect={onSelectSession}
        onNew={onNewSession}
        onRename={onRenameSession}
        onDelete={onDeleteSession}
        onExport={onExportSession}
        onFork={onForkSession}
        onOpenTeam={() => {
            setTeamOpen(true)
            connectionRef.current.send({ type: 'get_team', sessionId: activeSessionId ?? '' })
          }} />

      <main className="main">
        <header className="chat-header">
          <ModelSelector models={models} current={currentModel} onSelect={onSelectModel} />
          <SettingsControls settings={settings} onSet={onSetSetting} />
          <button
            className="request-log-btn"
            onClick={() => setShowRequests(v => !v)}
            title="查看每次模型请求的耗时与状态"
          >
            请求追踪{requestSummary && requestSummary.failed > 0 ? ` (${requestSummary.failed} 失败)` : ''}
          </button>
          <button className="update-btn" onClick={onCheckUpdate} title="检查并安装更新">
            {updateMsg || '检查更新'}
          </button>
          <span className="chat-header-hint">键入 / 浏览 {commands.length} 个命令</span>
        </header>
        {planMode && (
          <div className="plan-banner">
            计划模式已开启：模型只做只读探查并给出方案，不会修改文件。再次执行 /plan 退出。
          </div>
        )}
        {showRequests && (
          <RequestLogPanel
            requests={requests}
            summary={requestSummary}
            onRefresh={refreshRequests}
            onClear={clearRequests}
            onClose={() => setShowRequests(false)}
          />
        )}
        {showSearch && (
          <SearchPanel
            hits={searchHits}
            complete={searchComplete}
            truncated={searchTruncated}
            onQuery={onSearchQuery}
            onPick={onSearchPick}
            onClose={() => setShowSearch(false)}
          />
        )}
        <ChatView
          messages={messages}
          streaming={streamingMessageId !== null}
          highlightId={highlightId}
        />
        <Composer
          commands={commands}
          files={files}
          onSend={onSend}
          onCancel={onCancel}
          streaming={streamingMessageId !== null}
          onRequestFiles={onRequestFiles}
        />
      </main>
      <StatusBar
        state={connState}
        sessionCount={sessions.length}
        lastUsage={lastUsage}
        settings={settings}
        planMode={planMode}
        error={error}
      />
    </div>
  )
}
