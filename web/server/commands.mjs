/**
 * 斜杠命令语义。
 *
 * 分三类：
 *   - web 端有真实语义（WEB_IMPLEMENTED）：会话/设置/统计/内容查看/工具管理；
 *   - CLI 终端专属（TERMINAL_ONLY）：逐条写明不可用的具体原因，不糊弄；
 *   - 其余：明确报「未知命令」。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { send, broadcast } from './bus.mjs'
import {
  applySessionSetting,
  CLI_ROOT,
  COMMANDS_DIR,
  engineName,
  HAS_CLI_SOURCE,
  MODELS,
  PERMISSION_MODES,
  PORT,
  publicSettings,
  SERVER_VERSION,
  settingsFor,
  startedAt,
  THEMES,
  WORKSPACE_ROOT,
} from './config.mjs'
import { clearCronsForSession, cronCount, cronList } from './engine.mjs'
import { pendingCounts } from './interactions.mjs'
import { allSessions, broadcastSessions, collectStats, sessionCount } from './sessions.mjs'
import { executeTool, TOOL_SCHEMAS } from './tools.mjs'
import { enableTools, toolsOverview } from './toolindex.mjs'
import { fileIndexStatus, listIndexedFiles } from './workspace.mjs'

// ---------------------------------------------------------------------------
// 命令注册表（静态扫描 CLI 源码，不执行任何 CLI 代码）
// ---------------------------------------------------------------------------

/**
 * 扫描 commands 目录下 index.ts 提取 name / description / aliases / argumentHint。
 */
export async function loadCommandRegistry() {
  const commands = []
  const scanSource = (src, fallbackName) => {
    const name = src.match(/^\s*name:\s*'([^']+)'/m)?.[1] ?? fallbackName
    if (!name) return
    const description =
      src.match(/^\s*description:\s*'([^']+)'/m)?.[1] ??
      src.match(/^\s*description:\s*`([^`]+)`/m)?.[1] ??
      src.match(/return\s+`([^`]+)`/m)?.[1] ??
      ''
    const aliases = [...src.matchAll(/aliases:\s*\[([^\]]*)\]/g)]
      .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]))
    const argumentHint =
      src.match(/argumentHint:\s*'([^']*)'/)?.[1] ??
      src.match(/argumentHint:\s*`([^`]*)`/)?.[1]
    commands.push({ name, description, aliases, argumentHint })
  }

  if (HAS_CLI_SOURCE) {
    try {
      const entries = await readdir(COMMANDS_DIR, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            scanSource(await readFile(join(COMMANDS_DIR, entry.name, 'index.ts'), 'utf8'))
          } catch { /* 无 index.ts 的目录跳过 */ }
        } else if (entry.name.endsWith('.ts')) {
          try {
            scanSource(
              await readFile(join(COMMANDS_DIR, entry.name), 'utf8'),
              entry.name.replace(/\.ts$/, ''),
            )
          } catch { /* 读失败跳过 */ }
        }
      }
    } catch (err) {
      console.warn(`命令注册表扫描失败（${COMMANDS_DIR}）：`, String(err))
    }
  } else {
    console.warn(`未在 ${CLI_ROOT} 找到 commands/ 目录，斜杠命令注册表仅有 web 自带命令。`)
    console.warn('若要在 CLI 源码树里工作，请设置 LIMKENION_CLI_ROOT，或在该仓库目录下启动。')
  }

  // web 自身的命令
  commands.push({ name: 'web', description: 'Start the Limkenion web UI server', aliases: [], argumentHint: undefined })
  commands.sort((a, b) => a.name.localeCompare(b.name))
  return commands
}

/** CLI 终端专属命令 → 降级说明（web 端无对应基础设施）。 */
const TERMINAL_ONLY = {
  login: 'OAuth 登录需要在终端里完成浏览器回调',
  logout: '凭证存储在本机 CLI 配置中，web 端不改动',
  'oauth-refresh': '凭证刷新属于 CLI 进程职责',
  passes: '通行证属于 CLI 账户体系',
  'extra-usage': '额外用量属于 CLI 账户体系',
  'rate-limit-options': '限流选项属于 CLI 账户体系',
  'reset-limits': '额度重置属于 CLI 账户体系',
  'mock-limits': '仅用于 CLI 限流调试',
  ide: '需要检测本地 IDE 进程',
  mobile: '需要终端二维码与设备配对',
  chrome: '需要控制本机 Chrome 进程',
  desktop: '需要桌面客户端进程',
  teleport: '需要在终端里与本地仓库交互',
  'remote-env': '远端环境属于 CLI 托管能力',
  'remote-setup': '远端配置属于 CLI 托管能力',
  'remote-control-server': '远端控制服务属于 CLI 托管能力',
  'add-dir': 'web 端沙箱固定为工作区根（LIMKENION_WEB_WORKSPACE）',
  'sandbox-toggle': 'CLI 沙箱开关；web 端沙箱固定为工作区根',
  install: '安装/升级 CLI 属于终端操作',
  upgrade: '升级 CLI 属于终端操作',
  'install-github-app': '需要 GitHub App 授权回调',
  'install-slack-app': '需要 Slack App 授权回调',
  terminalSetup: '需要写入终端配置文件',
  'reload-plugins': '插件加载在 CLI 进程内',
  plugin: '插件管理写入 CLI 配置，web 端只读展示',
  mcp: 'MCP 客户端未在 web 服务端挂载',
  hooks: 'hooks 由 CLI 进程执行',
  commit: '需要 git 仓库（当前工作区未初始化 git）',
  'commit-push-pr': '需要 git 仓库与 GitHub 凭证',
  'autofix-pr': '需要 GitHub CLI 凭证',
  pr_comments: '需要 GitHub CLI 凭证',
  'pr-comments': '需要 GitHub CLI 凭证',
  review: '代码评审需要 git 变更集（当前工作区未初始化 git）',
  'security-review': '安全评审需要 git 变更集（当前工作区未初始化 git）',
  createMovedToPluginCommand: '插件命令迁移提示',
  vim: 'web 端使用浏览器原生输入，编辑器模式不适用',
  keybindings: 'web 端键位固定（Enter 发送 / Shift+Enter 换行 / Esc 中断）',
  copy: '浏览器可直接选中复制',
  stickers: '贴纸属于 CLI 交互彩蛋',
  'good-limkenion': '属于 CLI 交互彩蛋',
  heapdump: '堆快照写入 CLI 进程目录',
  'debug-tool-call': '工具调用调试面向 CLI 转录流',
  'break-cache': '提示词缓存调试面向 CLI',
  'ant-trace': '内部诊断命令',
  ant: '内部诊断命令',
  'backfill-sessions': '会话回填属于 CLI 存储维护',
  rewind: '会话回溯依赖 CLI 的检查点机制',
  doctor: 'CLI 环境体检；web 端可用 /status 查看服务状态',
  feedback: '反馈通道由 CLI 上报',
  'perf-issue': '性能问题上报由 CLI 上报',
  issue: '问题上报由 CLI 上报',
  'release-notes': '发布说明随 CLI 版本',
  advisor: '需要 CLI 侧的顾问模型配置',
  'init-verifiers': '需要写入项目校验器配置',
  bughunter: '需要多代理编排基础设施',
}

/** web 端有真实语义的命令。 */
export const WEB_IMPLEMENTED = [
  'help', 'clear', 'compact', 'rename', 'model', 'theme', 'permissions', 'plan',
  'cost', 'status', 'context', 'version', 'session', 'resume', 'export', 'diff',
  'files', 'memory', 'skills', 'tasks', 'todos', 'agents', 'summary', 'tag',
  'config', 'env', 'output-style', 'tools', 'cron', 'web', 'exit',
]
const WEB_COMMANDS = new Set(WEB_IMPLEMENTED)

const COMMAND_ALIASES = {
  stats: 'cost',
  usage: 'cost',
  quit: 'exit',
  todo: 'todos',
  ctx_viz: 'context',
  color: 'theme',
  doctor: 'status',
}

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

/**
 * 执行一条斜杠命令。
 * @param {object} session
 * @param {string} rawName 不含前导 /
 * @param {string} argString 参数原文
 * @param {object} ws 发起连接（仅用于需要定向回包的命令，如 /export）
 * @param {object} registry 命令注册表
 * @returns {Promise<string>} 命令输出（Markdown 文本）
 */
export async function runCommand(session, rawName, argString, ws, registry) {
  const name = COMMAND_ALIASES[rawName] ?? rawName
  const cmd = registry.find(c => c.name === name || c.aliases.includes(name))
  if (!WEB_COMMANDS.has(name) && !cmd) {
    return `未知命令：/${rawName}。输入 / 查看全部命令。`
  }
  const arg = argString.trim()
  const settings = settingsFor(session)

  // ---- 会话与上下文 ----
  if (name === 'clear') {
    session.messages = []
    session.todos = []
    session.tasks = []
    session.filesChanged = []
    session.usage = { inputTokens: 0, outputTokens: 0 }
    session.turnCount = 0
    session.toolCallCount = 0
    broadcastSessions()
    return '会话已清空（消息、待办、任务、改动记录、用量计数）。'
  }
  if (name === 'compact') {
    const count = session.messages.length
    session.messages = []
    broadcastSessions()
    return `已压缩：清空 ${count} 条历史消息。新对话从干净上下文开始（会话列表与用量计数保留）。`
  }
  if (name === 'rename') {
    if (arg) {
      session.title = arg.slice(0, 40)
      broadcastSessions()
      return `会话已重命名为「${session.title}」。`
    }
    return '用法：/rename <新名称>'
  }
  if (name === 'resume' || name === 'session') {
    const list = [...allSessions()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(s => `- ${s.id}  「${s.title}」 ${s.messages.length} 条${s.id === session.id ? '  ← 当前' : ''}`)
    return `当前会话：${session.id}「${session.title}」\n共 ${sessionCount()} 个会话：\n${list.join('\n')}\n\n（web 端直接点侧栏切换）`
  }
  if (name === 'tag') {
    if (arg) {
      session.tags = [...new Set([...(session.tags ?? []), arg])]
      broadcastSessions()
      return `已打标签：${session.tags.join('、')}`
    }
    return session.tags?.length ? `标签：${session.tags.join('、')}` : '当前无标签。用法：/tag <名称>'
  }
  if (name === 'summary') {
    return (
      `会话摘要\n标题：${session.title}\n消息：${session.messages.length} 条\n` +
      `回合：${session.turnCount}，工具调用：${session.toolCallCount}\n` +
      `Tokens：↑${session.usage.inputTokens} ↓${session.usage.outputTokens}\n` +
      `待办：${session.todos?.length ?? 0}，任务：${session.tasks?.length ?? 0}\n` +
      `改动文件：${session.filesChanged.length ? session.filesChanged.join('、') : '无'}`
    )
  }

  // ---- 模型与设置 ----
  if (name === 'model') {
    if (arg && MODELS.some(m => m.value === arg)) {
      applySessionSetting(session, 'model', arg)
      return `模型已切换为 ${arg}（仅本会话）。`
    }
    return (
      `当前模型：${settings.model}\n可用模型：\n` +
      MODELS.map(m => `- ${m.value}：${m.description}`).join('\n')
    )
  }
  if (name === 'theme') {
    if (THEMES.includes(arg)) {
      applySessionSetting(session, 'theme', arg)
      return `主题已切换为 ${arg}（仅本会话）。`
    }
    return `当前主题：${settings.theme}\n用法：/theme <${THEMES.join('|')}>`
  }
  if (name === 'permissions') {
    if (PERMISSION_MODES.includes(arg)) {
      applySessionSetting(session, 'permissionMode', arg)
      return `权限模式已切换为 ${arg}（仅本会话）。`
    }
    return (
      `当前权限模式：${settings.permissionMode}\n可选：\n` +
      '- default：危险工具每次确认\n' +
      '- acceptEdits：自动放行文件编辑，执行类仍需确认\n' +
      '- plan：计划模式，禁止一切有副作用的操作\n' +
      '- bypassPermissions：全部放行（注意：shell 守卫与不可信内容升级确认仍会生效）'
    )
  }
  if (name === 'config') {
    return `当前设置（本会话）：\n${Object.entries(publicSettings(session)).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n\n用 /model /theme /permissions 修改。`
  }
  if (name === 'plan') {
    session.planMode = !session.planMode
    broadcast({ type: 'plan_mode_changed', sessionId: session.id, active: session.planMode })
    broadcastSessions()
    return session.planMode
      ? '已进入计划模式：模型只会做只读探查并给出方案，不会修改文件或执行有副作用的命令。\n再次执行 /plan 退出。'
      : '已退出计划模式。'
  }
  if (name === 'output-style') {
    return `当前输出风格：${settings.outputStyle}（web 端渲染统一为 Markdown，风格仅记录在设置里）`
  }

  // ---- 统计与状态 ----
  if (name === 'cost') {
    const s = collectStats(session, startedAt)
    return (
      `会话数：${s.sessionCount}，回合数：${s.turnCount}，工具调用：${s.toolCallCount}\n` +
      `累计 tokens：↑${s.total.inputTokens} ↓${s.total.outputTokens}\n` +
      `当前会话：↑${s.session.inputTokens} ↓${s.session.outputTokens}`
    )
  }
  if (name === 'status') {
    const s = collectStats(session, startedAt)
    const idx = fileIndexStatus()
    const pending = pendingCounts()
    return (
      `引擎：${engineName() === 'deepseek' ? 'DeepSeek（真实）' : 'mock（未设 DEEPSEEK_API_KEY）'}\n` +
      `模型：${settings.model}　主题：${settings.theme}　权限：${settings.permissionMode}\n` +
      `计划模式：${session.planMode ? '开' : '关'}\n` +
      `工作区：${WORKSPACE_ROOT}\n` +
      `工具：可调用 ${TOOL_SCHEMAS.length} 个中按需启用（详见 /tools）\n` +
      `文件索引：${idx.count} 个文件${idx.ageMs === null ? '' : `（缓存 ${Math.round(idx.ageMs / 1000)}s 前）`}\n` +
      `会话：${session.title}（${session.messages.length} 条消息）\n` +
      `定时任务：${cronCount()} 个　待确认：${pending.permissions}　待作答：${pending.questions}\n` +
      `运行时长：${Math.round((Date.now() - startedAt) / 1000)}s\n` +
      `服务版本：${SERVER_VERSION}，Node ${process.version}`
    )
  }
  if (name === 'context') {
    return (
      `工作区：${WORKSPACE_ROOT}\n` +
      `上下文消息数：${session.messages.length + 1}（含系统提示）\n` +
      `本会话已加载工具：${[...(session.enabledTools ?? [])].length} 个延迟工具 + 常驻集\n` +
      `思维链：${session.lastReasoning ? `上一回合 ${session.lastReasoning.length} 字` : '无'}\n` +
      `待办：${session.todos?.length ?? 0}，任务：${session.tasks?.length ?? 0}\n` +
      `改动文件：${session.filesChanged.length ? session.filesChanged.join('、') : '无'}`
    )
  }
  if (name === 'version') {
    return `Limkenion web ${SERVER_VERSION}\n引擎：${engineName()}\nNode ${process.version}`
  }
  if (name === 'exit') {
    return 'web 界面无需退出命令——关闭浏览器标签页即可。CLI 中 /exit 会结束 REPL。'
  }
  if (name === 'env') {
    const keys = [
      'LIMKENION_WEB_PORT', 'LIMKENION_WEB_HOST', 'LIMKENION_WEB_WORKSPACE', 'LIMKENION_CLI_ROOT',
      'LIMKENION_WEB_STATE_DIR', 'LIMKENION_WEB_SHELL', 'LIMKENION_WEB_SEARCH_ENDPOINT',
      'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
    ]
    return (
      '环境变量：\n' +
      keys
        .map(k => `- ${k}：${k === 'DEEPSEEK_API_KEY' ? (process.env[k] ? '已设置' : '未设置') : (process.env[k] ?? '（未设置）')}`)
        .join('\n')
    )
  }

  // ---- 工具管理 ----
  if (name === 'tools') {
    if (arg.startsWith('enable')) {
      const names = arg.replace(/^enable\s*/, '').split(/[\s,]+/).filter(Boolean)
      if (names.length === 0) return '用法：/tools enable <工具名> [工具名…]'
      const newly = enableTools(session, names)
      return newly.length > 0
        ? `已启用：${newly.join('、')}（下一轮生效）`
        : '这些工具要么已启用，要么是常驻工具，要么名字不存在。'
    }
    return toolsOverview(session)
  }
  if (name === 'cron') {
    const list = cronList()
    if (arg === 'clear') {
      const n = clearCronsForSession(session.id)
      return n > 0 ? `已清理本会话的 ${n} 个定时任务。` : '本会话没有定时任务。'
    }
    if (list.length === 0) return '当前没有定时任务。模型可通过 CronCreate 创建。'
    return (
      `定时任务 ${list.length} 个：\n` +
      list
        .map(c => `- ${c.id}（会话 ${c.sessionId}）：每 ${Math.round(c.everyMs / 1000)}s「${c.prompt.slice(0, 60)}」`)
        .join('\n') +
      '\n\n用 /cron clear 清理本会话的定时任务。'
    )
  }

  // ---- 内容查看 ----
  if (name === 'diff') {
    if (session.filesChanged.length === 0) {
      return '本次会话还没有文件改动。（工作区未初始化 git，无法对比历史版本）'
    }
    return `本次会话改动过的文件（${session.filesChanged.length}）：\n${session.filesChanged.map(f => `- ${f}`).join('\n')}\n\n展开对应工具调用可查看 diff。`
  }
  if (name === 'files') {
    const changed = session.filesChanged
    // 用 listIndexedFiles 而不是 fileIndexStatus：后者只读缓存，
    // 冷启动时会误报 0 个文件。
    const indexed = await listIndexedFiles()
    return (
      (changed.length ? `会话内改动的文件：\n${changed.map(f => `- ${f}`).join('\n')}\n\n` : '本次会话还没有文件改动。\n\n') +
      `工作区索引：${indexed.length} 个文件（@ 引用补全用）。`
    )
  }
  if (name === 'memory') {
    const memDir = join(WORKSPACE_ROOT, '.workbuddy-ai', 'memory')
    if (!existsSync(memDir)) return `工作区记忆目录不存在：${memDir}\n（CLI 会在首次写入时创建）`
    try {
      const entries = await readdir(memDir, { withFileTypes: true })
      const files = entries.filter(e => e.isFile()).map(e => e.name)
      if (files.length === 0) return `记忆目录为空：${memDir}`
      const parts = []
      for (const f of files.slice(0, 5)) {
        const body = await readFile(join(memDir, f), 'utf8')
        parts.push(`--- ${f} ---\n${body.slice(0, 1200)}`)
      }
      return `记忆文件 ${files.length} 个（${memDir}）：\n\n${parts.join('\n\n')}`
    } catch (e) {
      return `读取记忆失败：${e.message}`
    }
  }
  if (name === 'skills') {
    const r = await executeTool('Skill', {}, { session })
    return typeof r === 'string' ? r : r.text
  }
  if (name === 'tasks') {
    const r = await executeTool('TaskList', {}, { session })
    return typeof r === 'string' ? r : r.text
  }
  if (name === 'todos') {
    if (!session.todos || session.todos.length === 0) return '当前无待办。模型会在多步任务中通过 TodoWrite 自动维护。'
    return session.todos
      .map(t => `${t.status === 'completed' ? '●' : t.status === 'in_progress' ? '◐' : '○'} ${t.content}`)
      .join('\n')
  }
  if (name === 'agents') {
    const dir = join(CLI_ROOT, 'tools', 'AgentTool')
    if (!existsSync(dir)) return '未找到 AgentTool 目录。'
    const files = await readdir(dir)
    return `Agent 工具实现文件（${files.length}）：\n${files.map(f => `- ${f}`).join('\n')}\n\nweb 端用 Agent 工具派只读子代理。`
  }
  if (name === 'export') {
    const md = exportSessionMarkdown(session)
    send(ws, {
      type: 'session_export',
      sessionId: session.id,
      filename: `${session.title || 'session'}.md`,
      markdown: md,
    })
    return `已导出 ${session.messages.length} 条消息（Markdown），浏览器应已开始下载。`
  }

  // ---- 帮助 ----
  if (name === 'help') {
    return (
      `共 ${registry.length} 个命令（输入框键入 / 浏览全部）。\n\n` +
      `web 端有真实语义（${WEB_IMPLEMENTED.length} 个）：\n` +
      WEB_IMPLEMENTED.map(r => `- /${r}`).join('\n') +
      `\n\n工具共 ${TOOL_SCHEMAS.length} 个，常驻一部分、其余按需启用（/tools 查看）。\n\n` +
      `其余命令为 CLI 终端专属（登录/Git/插件管理等），web 上返回说明。`
    )
  }
  if (name === 'web') {
    return `Limkenion web 服务已在运行：http://localhost:${PORT}\nWebSocket：ws://localhost:${PORT}/ws\n版本：${SERVER_VERSION}`
  }

  // ---- CLI 终端专属 ----
  const reason = TERMINAL_ONLY[name]
  return (
    `/${name} 在 web 端不可用：${reason ?? `该命令为 CLI 终端专属（${cmd?.description ?? '仅终端可用'}）`}。\n\n` +
    `用 /help 查看 web 端可用命令。`
  )
}

/** 把会话导出为 Markdown。 */
export function exportSessionMarkdown(session) {
  const esc = s => String(s ?? '').replace(/^#/gm, '\\#')
  const lines = [
    `# ${esc(session.title)}`,
    '',
    `- 会话 ID：${session.id}`,
    `- 导出时间：${new Date().toISOString()}`,
    `- 消息数：${session.messages.length}`,
    `- Tokens：↑${session.usage.inputTokens} ↓${session.usage.outputTokens}`,
    '',
    '---',
    '',
  ]
  for (const m of session.messages) {
    const who = m.role === 'user' ? '## 用户' : m.role === 'assistant' ? '## Limkenion' : '## 系统'
    lines.push(who, '')
    if (m.reasoning) {
      lines.push('<details><summary>思维链</summary>', '', '```', m.reasoning.replace(/```/g, '``\u200b`'), '```', '', '</details>', '')
    }
    if (m.toolCalls?.length) {
      lines.push(`> 工具调用 ${m.toolCalls.length} 次：${m.toolCalls.map(t => t.name).join('、')}`, '')
    }
    lines.push(m.text ? esc(m.text) : '（空）', '')
    if (m.usage) lines.push(`_↑${m.usage.inputTokens} ↓${m.usage.outputTokens} tokens_`, '')
  }
  return lines.join('\n')
}
