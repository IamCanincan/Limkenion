/**
 * 斜杠命令语义。
 *
 * 分四类：
 *   - web 端有真实语义（WEB_IMPLEMENTED）：会话/设置/统计/内容查看/工具管理；
 *   - CLI 终端专属（TERMINAL_ONLY）：逐条写明不可用的具体原因，不糊弄；
 *   - 本构建里不存在（NOT_IN_BUILD）：上游有名字但实现是占位桩、或已停用、
 *     或依赖本构建没有的云端账号体系；
 *   - 其余：明确报「未知命令」。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { send, broadcast } from './bus.mjs'
import { compactSession } from './compact.mjs'
import { clearCheckpoints, restoreCheckpoints } from './checkpoints.mjs'
import {
  applySessionSetting,
  CLI_ROOT,
  COMMANDS_DIR,
  EFFORT_LEVELS,
  engineName,
  HAS_CLI_SOURCE,
  MODELS,
  modelSupportsMaxEffort,
  PERMISSION_MODES,
  PORT,
  publicSettings,
  resolveEffort,
  SERVER_VERSION,
  settingsFor,
  startedAt,
  THEMES,
  workspaceRoot,
} from './config.mjs'
import { chatCompletion, getApiKey } from './deepseek.mjs'
import { bypassDisabled, getSettings, loadSettings, settingsSummary, unhonoredRules } from './settings.mjs'
import { clearCronsForSession, cronCount, cronList, newMessageId, removeCron, runTurn } from './engine.mjs'
import { pendingCounts } from './interactions.mjs'
import {
  allSessions,
  broadcastSessions,
  collectStats,
  forkSession,
  rewindSession,
  sessionCount,
} from './sessions.mjs'
import { executeTool, TOOL_SCHEMAS } from './tools.mjs'
import { enableTools, toolsOverview } from './toolindex.mjs'
import { DEFAULT_WORKSPACE_ROOT, isInsideWorkspace, workspaceRoot as scopeRoot } from './paths.mjs'
import { HOOK_EVENT, runEventHooks } from './hooks.mjs'
import { fileIndexStatus, listIndexedFiles } from './workspace.mjs'
import { hooksSummary, refreshHooks } from './hooks.mjs'
import { mcpSummary, reloadMcp } from './mcp.mjs'
import { generateInsights, insightsSummary } from './insights.mjs'
import { formatRun, loadRun, workflowsSummary } from './workflow.mjs'
import { worktreeSummary } from './worktree.mjs'

// ---------------------------------------------------------------------------
// 命令注册表
// ---------------------------------------------------------------------------

/**
 * 命令清单：由 CLI 侧 `scripts/gen-command-manifest.mjs` 用 **TypeScript AST**
 * 生成，提交在仓库里。web 端直接读它 —— 既不依赖 CLI 构建，也不再解析 CLI 源码。
 *
 * 为什么不自己扫源码：原来这里用正则扫 `commands/` 下的 .ts 文本，靠
 * "取缩进最浅的那个 `name:`" 猜命令名。只要文件里别处出现一个 name 字段就会误判，
 * 真的出过事：`commands/insights.ts` 里报告分节的 `name: 'project_areas'`（缩进 4）
 * 盖过了真正的命令名 `insights`（缩进 2，在 1600 行之后），注册表里于是多了一个
 * 不存在的命令、少了一个真实命令，而且毫无报错。
 * AST 只取导出对象字面量的**直接属性**，嵌套字段天然不会被误取。
 */
const MANIFEST_PATH = new URL('./data/commands-manifest.json', import.meta.url)

/** 读清单。读不到（文件缺失 / 格式不对）返回 null，由调用方降级。 */
async function readCommandManifest() {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf8')
    const m = JSON.parse(raw)
    if (m?.version !== 1 || !Array.isArray(m.commands)) return null
    return m
  } catch {
    return null
  }
}

/**
 * CLI 源码在侧时，重算一遍内容哈希与清单比对。
 * 目的：发现"命令改了但清单没重新生成"——这种漂移是静默的，不比对根本看不出来。
 */
async function manifestIsStale(manifest) {
  if (!HAS_CLI_SOURCE || !manifest?.sourceHash) return false
  try {
    // 收集规则与哈希输入必须与生成器的 collectFiles() **完全一致**，否则每次启动
    // 都会误报"清单过期"。两个易错点：① 目录只在真的有 index.ts 时才计入；
    // ② 哈希用的是**相对 CLI 根**的路径（生成器里是 relative(ROOT, ...)），
    //    不是相对 commands/ —— 前缀不同哈希就永远对不上。
    const files = []
    for (const entry of await readdir(COMMANDS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const p = join(COMMANDS_DIR, entry.name, 'index.ts')
        if (existsSync(p)) files.push(p)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(join(COMMANDS_DIR, entry.name))
      }
    }
    files.sort()
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256')
    for (const file of files) {
      hash.update(relative(CLI_ROOT, file).replace(/\\/g, '/'))
      hash.update('\0')
      try {
        hash.update(await readFile(file))
      } catch {
        // 读不到的文件按空内容计入 —— 哈希不一致正好提示清单该重新生成了
      }
      hash.update('\0')
    }
    return hash.digest('hex').slice(0, 16) !== manifest.sourceHash
  } catch {
    return false // 比不出来就别吓唬人
  }
}

/** web 自身提供的命令（CLI 里没有）。 */
const WEB_OWN_COMMAND = {
  name: 'web',
  description: 'Start the Limkenion web UI server',
  aliases: [],
  argumentHint: undefined,
}

export async function loadCommandRegistry() {
  // ---- 主路径：读生成的清单 ----
  const manifest = await readCommandManifest()
  if (manifest) {
    if (await manifestIsStale(manifest)) {
      console.warn(
        '命令清单已过期：CLI 的 commands/ 有改动，但 web/server/data/commands-manifest.json 没重新生成。\n' +
          '  在仓库根执行：node scripts/gen-command-manifest.mjs',
      )
    }
    const commands = manifest.commands.map(c => ({
      // 描述是运行时才拼出来的那几个（如 /fast、/model），清单里是空的 ——
      // 给个占位，免得界面上出现一片空白又看不出原因。
      name: c.name,
      description: c.description || '（描述在运行时生成）',
      aliases: c.aliases ?? [],
      argumentHint: c.argumentHint,
    }))
    commands.push(WEB_OWN_COMMAND)
    commands.sort((a, b) => a.name.localeCompare(b.name))
    return commands
  }

  // ---- 降级：清单缺失时退回扫描源码（比没有强，但已知不可靠）----
  console.warn('未找到命令清单（web/server/data/commands-manifest.json），退回扫描 CLI 源码 —— 该方式不可靠。')
  return await scanCommandsFromSource()
}

/**
 * @deprecated 仅作降级路径。会误判嵌套字段，见上面 loadCommandRegistry 的说明。
 */
async function scanCommandsFromSource() {
  const commands = []
  const scanSource = (src, fallbackName) => {
    // name 取**缩进最浅**的那个匹配，而不是第一个匹配。
    //
    // 原来取第一个匹配，结果 `commands/insights.ts` 被注册成了 `project_areas`
    // —— 那是 /insights 报告里一个嵌套的分节名（缩进 4），而真正的命令名
    // `insights`（缩进 2）在 1600 行之后，根本没被扫到。于是注册表里多了一个
    // 不存在的命令、又少了一个真实命令。
    const nameMatches = [...src.matchAll(/^([ \t]*)name:\s*'([^']+)'/gm)]
    const best = nameMatches.length > 0
      ? nameMatches.reduce((a, b) => (b[1].length < a[1].length ? b : a))
      : null
    const name = best?.[2] ?? fallbackName
    if (!name) return

    // description / aliases / argumentHint 只在 name 之后的窗口里找，
    // 免得又抓到这个文件里别的对象（比如报告分节的字段）。
    const after = best ? src.slice(best.index, best.index + 3000) : src
    const description =
      after.match(/^\s*description:\s*'([^']+)'/m)?.[1] ??
      after.match(/^\s*description:\s*`([^`]+)`/m)?.[1] ??
      after.match(/return\s+`([^`]+)`/m)?.[1] ??
      src.match(/^\s*description:\s*'([^']+)'/m)?.[1] ??
      ''
    const aliases = [...after.matchAll(/aliases:\s*\[([^\]]*)\]/g)]
      .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]))
    const argumentHint =
      after.match(/argumentHint:\s*'([^']*)'/)?.[1] ??
      after.match(/argumentHint:\s*`([^`]*)`/)?.[1]
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

  commands.push(WEB_OWN_COMMAND)
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
  'add-dir': '追加目录暂未实现；web 端用 /cwd 收窄工作区根',
  // 注意：这个命令在 commands/sandbox-toggle/index.ts 里，但 name 是 'sandbox'。
  // 原来这里只写了 'sandbox-toggle'，键名对不上，于是 /sandbox 会落到
  // 兜底的"CLI 终端专属（描述）"上，说明不够准确。两个键都留着。
  sandbox: 'CLI 沙箱开关；web 端沙箱固定为工作区根',
  'sandbox-toggle': 'CLI 沙箱开关；web 端沙箱固定为工作区根',
  install: '安装/升级 CLI 属于终端操作',
  upgrade: '升级 CLI 属于终端操作',
  'install-github-app': '需要 GitHub App 授权回调',
  'install-slack-app': '需要 Slack App 授权回调',
  terminalSetup: '需要写入终端配置文件',
  // 同上：真实 name 是 'terminal-setup'（commands/terminalSetup/index.ts）。
  'terminal-setup': '需要写入终端配置文件',
  'reload-plugins': '插件加载在 CLI 进程内',
  plugin: '插件管理写入 CLI 配置，web 端只读展示',
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
  doctor: 'CLI 环境体检；web 端可用 /status 查看服务状态',
  feedback: '反馈通道由 CLI 上报',
  'perf-issue': '性能问题上报由 CLI 上报',
  issue: '问题上报由 CLI 上报',
  'release-notes': '发布说明随 CLI 版本',
  advisor: '需要 CLI 侧的顾问模型配置',
  'init-verifiers': '需要写入项目校验器配置',
  bughunter: '需要多代理编排基础设施',
}

/**
 * 上游有这个名字、但**本构建里没有实现**的命令。
 *
 * 与 TERMINAL_ONLY 分开，是因为"没有实现"和"只在终端里可用"是两件事 ——
 * 全都塞进 TERMINAL_ONLY 会给出不准确的说明（用户会以为换个环境就能用）。
 *
 * 三类来源：
 *   ① 上游专属的 feature-gated 模块，本构建里被替换成 Proxy 占位桩
 *      （见 bun-bundle-stub.ts 的注释）；
 *   ② 已被停用的命令；
 *   ③ 依赖云端账号体系的命令（本仓库没有任何网站与云服务）。
 */
const NOT_IN_BUILD = {
  assistant: '上游专属功能，本构建里是占位桩，没有实现',
  peers: '上游专属功能，本构建里是占位桩，没有实现',
  'force-snip': '上游专属功能，本构建里是占位桩，没有实现',
  proactive: '上游专属功能，本构建里是占位桩，没有实现',
  'subscribe-pr': '上游专属功能，本构建里是占位桩，没有实现',
  torch: '上游专属功能，本构建里是占位桩，没有实现',
  brief: 'KAIROS 能力在本构建里被关闭（见 bun-bundle-stub.ts 的 UNSUPPORTED_UPSTREAM_FEATURES），/brief 无法启用',
  'think-back': '已停用',
  'thinkback-play': '已停用',
  fast: '需要云端订阅（本构建没有云端账号体系）',
  'web-setup': '需要云端订阅（本构建没有云端账号体系）',
  // 注意：/usage 不在这里 —— 它被 COMMAND_ALIASES 映射到 /cost 了（见上面的注释）。
  'privacy-settings': '需要云端订阅（本构建没有云端账号体系）',
  project_areas: '这不是命令 —— 它是 /insights 报告里的一个分节名（注册表扫描的误报）',
}

/** web 端有真实语义的命令。 */
export const WEB_IMPLEMENTED = [
  'help', 'clear', 'compact', 'rename', 'model', 'theme', 'permissions', 'plan',
  'cost', 'status', 'context', 'version', 'session', 'resume', 'export', 'diff',
  'hooks',       // 工具前后钩子（与 CLI 同款 settings.json 的 hooks 段）
  'mcp',         // MCP 服务器连接状态与重连
  'insights',    // 使用洞察报告（web 自己的会话存储）
  'files', 'memory', 'skills', 'tasks', 'todos', 'agents', 'summary', 'tag',
  'config', 'env', 'output-style', 'tools', 'cron', 'web', 'exit',
  // ---- 以下是从 CLI 搬过来的 ----
  'effort',      // 推理强度（与 CLI 的 EFFORT_LEVELS 对齐）
  'branch',      // 会话分叉
  'rewind',      // 对话回退
  'btw',         // 旁路提问
  'init',        // 生成 LIMKENION.md
  'schedule',    // 与 /cron 同一实现（CLI 叫 /schedule）
  'workflows',   // 动态工作流运行（web 端未挂载该工具，如实说明）
  'cwd',         // 切换工作区根（收窄到子目录；触发 cwd-changed 钩子）
]
const WEB_COMMANDS = new Set(WEB_IMPLEMENTED)

const COMMAND_ALIASES = {
  stats: 'cost',
  // CLI 的 /usage 是「显示套餐用量限制」，需要云端订阅 —— 本构建里是死路径。
  // web 端没有套餐概念，映射到 /cost（会话与累计 token 用量）更有用。
  usage: 'cost',
  quit: 'exit',
  todo: 'todos',
  ctx_viz: 'context',
  color: 'theme',
  doctor: 'status',
  // CLI 的 /fork 就是 /branch（commands/branch/index.ts 在 FORK_SUBAGENT 关闭时
  // 自己带 'fork' 别名）。web 端没有独立的 /fork，直接映射过去。
  fork: 'branch',
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
  // 注册表里没有、web 也没实现 —— 但如果我们能说清它为什么不可用，
  // 就交给下面的分类分支去说，别一律报「未知命令」。
  // （比如 /assistant 是个没有 index.ts 的占位桩目录，注册表里根本扫不到。）
  if (!WEB_COMMANDS.has(name) && !cmd && !NOT_IN_BUILD[name] && !TERMINAL_ONLY[name]) {
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
    clearCheckpoints(session.id)
    broadcastSessions()
    return '会话已清空（消息、待办、任务、改动记录、用量计数、文件检查点）。'
  }
  if (name === 'compact') {
    // 真压缩：把历史交给模型总结成摘要，用一条摘要消息替换全部历史。
    // （2026-09-18 之前是直接清空 —— 模型彻底失忆，和压缩不是一回事。）
    try {
      const r = await compactSession(session, { reason: arg || '手动压缩' })
      broadcastSessions()
      if (!r.ok) return `未压缩：${r.skipped}`
      return `已压缩：${r.removed} 条消息 → 1 条摘要（${r.summaryChars} 字）。上下文从摘要重新开始，模型仍记得目标和进度。`
    } catch (err) {
      return '压缩失败：' + String(err.message ?? err) + '（历史消息保留未动）'
    }
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

  if (name === 'branch') {
    // CLI 的 /branch [name]：在当前会话的此处分叉出一个分支。
    // web 端同理，但分叉出来的是一条**独立会话**（侧栏里能看到、能单独继续）。
    const forked = forkSession(session, arg)
    if (!forked) return '分叉失败：找不到当前会话。'
    broadcastSessions()
    return (
      `已从当前会话分叉：${forked.id}「${forked.title}」\n` +
      `带过去 ${forked.messages.length} 条消息、${forked.filesChanged.length} 个改动文件记录。\n\n` +
      '新会话是独立的一份，在侧栏里点它即可继续；改它不会影响原会话。'
    )
  }
  if (name === 'rewind') {
    // CLI 的 /rewind 会连同代码检查点一起回退；web 端没有文件快照，
    // 只能回退对话本身 —— 这一点必须说清楚，别让用户以为文件也回滚了。
    const total = session.messages.length
    if (!arg) {
      const shown = session.messages.slice(-10)
      const start = Math.max(0, total - shown.length)
      return (
        `当前会话共 ${total} 条消息。最近 ${shown.length} 条：\n` +
        shown
          .map((m, i) => {
            const idx = start + i
            const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '模型' : '系统'
            const text = (m.text ?? '').replace(/\s+/g, ' ').slice(0, 50)
            return `- [${idx}] ${who}：${text}`
          })
          .join('\n') +
        '\n\n用法：/rewind <保留条数> —— 例如 /rewind 4 表示只保留前 4 条。\n' +
        '注意：会回退**对话**，并把保留窗口之后 Write/Edit 的文件改动一并回滚（文件检查点在内存中，服务重启后丢失）。'
      )
    }
    const keep = Number.parseInt(arg, 10)
    if (!Number.isFinite(keep) || keep < 0) {
      return `参数无效：${arg}。用法：/rewind <保留条数>（0 表示清空对话）`
    }
    const { removed, kept } = rewindSession(session, keep)
    // 文件回滚：保留窗口之后发生的 Write/Edit 改动全部还原
    const cp = await restoreCheckpoints(session, kept)
    broadcastSessions()
    return (
      `已回退：删掉 ${removed} 条消息，保留 ${kept} 条。\n` +
      `文件检查点：回滚了 ${cp.restored} 个文件的改动${cp.failed ? `，${cp.failed} 个失败` : ``}；服务重启后新增的改动不在快照里。`
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
  if (name === 'insights') {
    const wantNarrative = !/^--stats|^no-ai/.test(arg.trim())
    const result = await generateInsights({ narrative: wantNarrative })
    return insightsSummary(result)
  }
  if (name === 'mcp') {
    const sub = String(arg ?? '').trim().toLowerCase()
    if (sub === 'reload' || sub === 'reconnect') {
      const r = await reloadMcp()
      return (
        `MCP 重连完成：成功 ${r.connected}、失败 ${r.failed}、不支持 ${r.skipped}\n\n` + mcpSummary()
      )
    }
    return mcpSummary()
  }
  if (name === 'hooks') {
    // 顺带刷新一次（用户改完 settings.json 不用重启服务）
    refreshHooks()
    return hooksSummary()
  }
  if (name === 'permissions') {
    if (PERMISSION_MODES.includes(arg)) {
      if (!applySessionSetting(session, 'permissionMode', arg)) {
        return `无法切换到 ${arg}：设置文件里写了 disableBypassPermissionsMode，bypassPermissions 被禁用。`
      }
      return `权限模式已切换为 ${arg}（仅本会话）。`
    }
    // 顺带重读设置文件 —— 改完 settings.json 不用重启服务
    loadSettings()
    const unhonored = unhonoredRules()
    const rules = getSettings().permissions
    const ruleLines =
      rules.allow.length + rules.deny.length + rules.ask.length === 0
        ? '（设置文件里没有权限规则）'
        : [
            rules.deny.length ? `- deny（硬拦截，不弹确认）：${rules.deny.join('、')}` : '',
            rules.ask.length ? `- ask（强制确认）：${rules.ask.join('、')}` : '',
            rules.allow.length ? `- allow（免确认）：${rules.allow.join('、')}` : '',
          ]
            .filter(Boolean)
            .join('\n')
    return (
      `当前权限模式：${settings.permissionMode}\n\n` +
      '可选模式：\n' +
      '- default：危险工具每次确认\n' +
      '- acceptEdits：自动放行文件编辑，执行类仍需确认\n' +
      '- plan：计划模式，禁止一切有副作用的操作\n' +
      '- bypassPermissions：全部放行（注意：shell 守卫与不可信内容升级确认仍会生效）\n' +
      (bypassDisabled() ? '（设置文件里已禁用 bypassPermissions）\n' : '') +
      '\n设置文件里的权限规则（与 CLI 同一套 settings.json）：\n' +
      ruleLines +
      (unhonored.length > 0
        ? `\n\n⚠️ 有 ${unhonored.length} 条规则在 web 端**不会生效**` +
          `（该工具的 specifier 语义未实现）：${unhonored.map(u => `${u.kind}:${u.rule}`).join('、')}\n` +
          '  尤其是 deny 规则 —— 别以为它在这里挡住了什么。'
        : '')
    )
  }
  if (name === 'cwd') {
    const base = session.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT
    if (!arg) {
      return (
      `当前工作区根：${base}\n` +
      '用法：/cwd <当前根内的子目录> —— 工具沙箱随之收窄到该子目录；\n' +
      '/cwd . —— 重置回默认根。'
    )
    }
    const fireCwdHook = (from, to) => void runEventHooks(HOOK_EVENT.CWD_CHANGED, {
      hookInput: { session_id: session?.id ?? '', from, to },
    }).catch(() => {})
    if (arg === '.' || arg === 'reset') {
      const from = base
      session.workspaceRoot = null
      fireCwdHook(from, DEFAULT_WORKSPACE_ROOT)
      return `工作区根已重置：${from} → ${DEFAULT_WORKSPACE_ROOT}`
    }
    const target = resolve(join(base, arg))
    if (target === base) return `目标与当前根相同：${target}`
    if (!isInsideWorkspace(target)) {
      return `拒绝：目标必须位于当前根内部（防逃逸）。当前根：${base}`
    }
    if (!existsSync(target)) return `目录不存在：${target}`
    session.workspaceRoot = target
    fireCwdHook(base, target)
    return `工作区根已切换：${base} → ${target}`
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
    return `当前输出风格：${settings.outputStyle ?? 'default'}（内置 default/concise/explanatory/learning，其他值作为自定义指令注入系统提示；用 /style 切换或设置面板选择）`
  }
  if (name === 'effort') {
    const cur = settings.effortLevel ?? null
    const eff = resolveEffort(settings.model, cur)
    if (!arg) {
      return (
        `当前推理强度：${cur ?? '（未设置 —— 用服务端默认，思考链开启）'}\n` +
        `当前模型：${settings.model}\n` +
        `实际发给 API：${eff ?? '（不带 reasoning_effort 参数）'}\n\n` +
        `用法：/effort <${EFFORT_LEVELS.join('|')}|default>\n` +
        '- low / medium / high：思考链长度递增\n' +
        '- max：最深的思考（仅 deepseek-v4-pro 支持）\n' +
        '- default：清除设置，回到服务端默认\n' +
        (modelSupportsMaxEffort(settings.model)
          ? ''
          : `\n注意：当前模型不支持 max，设成 max 会被降级为 high（与 CLI 行为一致）。`)
      )
    }
    const v = arg === 'default' || arg === 'clear' || arg === 'off' ? null : arg
    if (v !== null && !EFFORT_LEVELS.includes(v)) {
      return `未知档位：${arg}\n可选：${EFFORT_LEVELS.join(' | ')} | default`
    }
    applySessionSetting(session, 'effortLevel', v)
    if (v === null) return '已清除推理强度设置（回到服务端默认：思考链开启）。'
    const actual = resolveEffort(settings.model, v)
    return actual === v
      ? `推理强度已设为 ${v}（仅本会话）。`
      : `推理强度已设为 ${v}，但当前模型 ${settings.model} 不支持 ${v}，实际按 ${actual} 生效。`
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
      `工作区：${workspaceRoot()}\n` +
      `worktree：${worktreeSummary(session)}\n` +
      `工具：可调用 ${TOOL_SCHEMAS.length} 个中按需启用（详见 /tools）\n` +
      `文件索引：${idx.count} 个文件${idx.ageMs === null ? '' : `（缓存 ${Math.round(idx.ageMs / 1000)}s 前）`}\n` +
      `会话：${session.title}（${session.messages.length} 条消息）\n` +
      `定时任务：${cronCount()} 个　待确认：${pending.permissions}　待作答：${pending.questions}\n` +
      `${settingsSummary()}\n` +
      `运行时长：${Math.round((Date.now() - startedAt) / 1000)}s\n` +
      `服务版本：${SERVER_VERSION}，Node ${process.version}`
    )
  }
  if (name === 'context') {
    return (
      `工作区：${workspaceRoot()}\n` +
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
  if (name === 'cron' || name === 'schedule') {
    // CLI 叫 /schedule（commands/schedule/），web 端原先只有 /cron。两个名字都认。
    const list = cronList()
    if (arg === 'clear') {
      const n = clearCronsForSession(session.id)
      return n > 0 ? `已清理本会话的 ${n} 个定时任务。` : '本会话没有定时任务。'
    }
    if (arg.startsWith('remove')) {
      const id = arg.replace(/^remove\s*/, '').trim()
      if (!id) return '用法：/schedule remove <id>'
      return removeCron(id) ? `已删除定时任务 ${id}。` : `没有找到定时任务 ${id}。`
    }
    if (list.length === 0) return '当前没有定时任务。模型可通过 CronCreate 创建。'
    return (
      `定时任务 ${list.length} 个：\n` +
      list
        .map(c => `- ${c.id}（会话 ${c.sessionId}）：每 ${Math.round(c.everyMs / 1000)}s「${c.prompt.slice(0, 60)}」`)
        .join('\n') +
      '\n\n用 /schedule remove <id> 删掉某一个，或用 /schedule clear 清理本会话的全部。'
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
    const memDir = join(workspaceRoot(), '.workbuddy-ai', 'memory')
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
    // 连接可能已经断开（客户端关标签页 / 命令由程序化调用触发）。
    // 这种情况必须说出来 —— 否则用户看到"已开始下载"却在浏览器里什么都没有。
    const delivered = send(ws, {
      type: 'session_export',
      sessionId: session.id,
      filename: `${session.title || 'session'}.md`,
      markdown: md,
    })
    const head = `已导出 ${session.messages.length} 条消息（Markdown，${md.length} 字符）。`
    return delivered
      ? head + '浏览器应已开始下载。'
      : head + '但当前连接不可用，下载没有发出 —— 请在已打开的页面里重新执行 /export。'
  }

  // ---- 旁路提问 / 初始化 / 工作流 ----

  if (name === 'btw') {
    // CLI 的 /btw：不打断主对话地快速问一个问题（immediate 命令，不进历史）。
    // web 端同理：答案作为命令输出返回，而命令输出在 session.messages 里是
    // role:'system' —— engine 的 sessionToWireMessages 会跳过 system，
    // 所以这段内容**不会**进入模型下一轮的上下文。语义与 CLI 一致。
    if (!arg) {
      return '用法：/btw <问题>\n在不打断主对话的前提下问一个问题；回答不会进入后续对话上下文。'
    }
    if (!getApiKey()) return '未配置 DEEPSEEK_API_KEY，无法提问。'
    try {
      const res = await chatCompletion({
        model: settings.model,
        messages: [
          {
            role: 'system',
            content:
              '你是 Limkenion。用户提的是一个「旁路问题」——它不进入主对话上下文。' +
              '直接、简短地回答这个问题本身，不要调用工具，不要展开成实施方案。',
          },
          { role: 'user', content: arg },
        ],
        tools: [],
        reasoningEffort: resolveEffort(settings.model, settings.effortLevel),
        onDelta: () => {},
      })
      const answer = (res.text ?? '').trim()
      return `**旁路回答**（不进主对话上下文，模型下一轮看不到这段）\n\n${answer || '（模型没有返回内容）'}`
    } catch (err) {
      return `旁路提问失败：${err?.message ?? String(err)}`
    }
  }

  if (name === 'init') {
    // 改写自 CLI 的 commands/init/index.ts（NEW_INIT_PROMPT 的精简版）。
    const prompt =
      '为当前仓库搭建一份精简的 LIMKENION.md。\n\n' +
      '要求：\n' +
      '1. LIMKENION.md 会被加载进每一个会话，必须保持简洁 —— 只写「缺少它就会犯错」的内容。\n' +
      '2. 必须包含：常用命令（构建 / lint / 测试，以及如何只跑单个测试）、需要读多个文件才能理解的架构要点。\n' +
      '3. 如果已存在 LIMKENION.md，不要重写，改为提出改进建议。\n' +
      '4. 不要写显而易见的内容（如"写有帮助的错误信息""不要提交密钥"），不要罗列一眼就能发现的目录结构，不要写通用开发实践。\n' +
      '5. 如果存在 README.md、.cursor/rules/、.cursorrules、.github/copilot-instructions.md，把其中的重要部分纳入。\n' +
      '6. 不要编造。\n' +
      '7. 文件开头固定为：\n\n' +
      '# LIMKENION.md\n\n' +
      'This file provides guidance to Limkenion when working with code in this repository.\n\n' +
      '先探查仓库（读 README、package.json 等），再写文件。'

    const userMessage = { id: newMessageId(), role: 'user', text: prompt, timestamp: Date.now() }
    session.messages.push(userMessage)
    session.updatedAt = Date.now()
    broadcast({ type: 'user_message', sessionId: session.id, message: userMessage })

    const messageId = newMessageId()
    broadcast({ type: 'assistant_start', sessionId: session.id, messageId })
    // 不 await：命令要立刻返回，回合在后台跑完（事件照常 broadcast 给前端）。
    void runTurn(session, prompt, messageId)

    return '已开始生成 LIMKENION.md —— 模型会先探查仓库结构，再写文件（写文件前会请求你确认）。'
  }

  if (name === 'workflows') {
    const sub = String(arg ?? '').trim()
    if (sub.startsWith('show ') || sub.startsWith('查看 ')) {
      const id = sub.replace(/^(show|查看)\s+/, '').trim()
      const run = await loadRun(id)
      if (!run) return `找不到这次运行：${id}（用 /workflows 看列表）`
      return formatRun(run, { verbose: true })
    }
    return workflowsSummary()
  }

  // ---- 帮助 ----
  if (name === 'help') {
    return (
      `共 ${registry.length} 个命令（输入框键入 / 浏览全部）。\n\n` +
      `web 端有真实语义（${WEB_IMPLEMENTED.length} 个）：\n` +
      WEB_IMPLEMENTED.map(r => `- /${r}`).join('\n') +
      `\n\n工具共 ${TOOL_SCHEMAS.length} 个，常驻一部分、其余按需启用（/tools 查看）。\n\n` +
      `其余命令分两类：CLI 终端专属（登录 / Git / 插件管理等），以及本构建里没有实现的` +
      `（上游占位桩、已停用、需要云端账号体系）。执行它们会给出具体原因。`
    )
  }
  if (name === 'web') {
    return `Limkenion web 服务已在运行：http://localhost:${PORT}\nWebSocket：ws://localhost:${PORT}/ws\n版本：${SERVER_VERSION}`
  }

  // ---- 本构建里没有实现 ----
  const notInBuild = NOT_IN_BUILD[name]
  if (notInBuild) {
    return `/${name} 在本构建里不可用：${notInBuild}。\n\n用 /help 查看 web 端可用命令。`
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
