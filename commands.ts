// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import addDir from './commands/add-dir/index.js'
import autofixPr from './commands/autofix-pr/index.js'
import backfillSessions from './commands/backfill-sessions/index.js'
import btw from './commands/btw/index.js'
import goodLimkenion from './commands/good-limkenion/index.js'
import issue from './commands/issue/index.js'
import feedback from './commands/feedback/index.js'
import clear from './commands/clear/index.js'
import color from './commands/color/index.js'
import commit from './commands/commit.js'
import copy from './commands/copy/index.js'
import desktop from './commands/desktop/index.js'
import commitPushPr from './commands/commit-push-pr.js'
import compact from './commands/compact/index.js'
import config from './commands/config/index.js'
import { context, contextNonInteractive } from './commands/context/index.js'
import cost from './commands/cost/index.js'
import diff from './commands/diff/index.js'
import ctx_viz from './commands/ctx_viz/index.js'
import doctor from './commands/doctor/index.js'
import memory from './commands/memory/index.js'
import help from './commands/help/index.js'
import ide from './commands/ide/index.js'
import init from './commands/init.js'
import initVerifiers from './commands/init-verifiers.js'
import keybindings from './commands/keybindings/index.js'
import login from './commands/login/index.js'
import logout from './commands/logout/index.js'
import installGitHubApp from './commands/install-github-app/index.js'
import installSlackApp from './commands/install-slack-app/index.js'
import breakCache from './commands/break-cache/index.js'
import mcp from './commands/mcp/index.js'
import mobile from './commands/mobile/index.js'
import onboarding from './commands/onboarding/index.js'
import pr_comments from './commands/pr_comments/index.js'
import releaseNotes from './commands/release-notes/index.js'
import rename from './commands/rename/index.js'
import resume from './commands/resume/index.js'
import review, { ultrareview } from './commands/review.js'
import session from './commands/session/index.js'
import share from './commands/share/index.js'
import skills from './commands/skills/index.js'
import status from './commands/status/index.js'
import tasks from './commands/tasks/index.js'
import teleport from './commands/teleport/index.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const agentsPlatform =
  null
/* eslint-enable @typescript-eslint/no-require-imports */
import securityReview from './commands/security-review.js'
import bughunter from './commands/bughunter/index.js'
import terminalSetup from './commands/terminalSetup/index.js'
import usage from './commands/usage/index.js'
import theme from './commands/theme/index.js'
import vim from './commands/vim/index.js'
import { feature } from 'bun:bundle'
// 死代码消除：条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const proactive =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./commands/proactive.js').default
    : null
const briefCommand =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? require('./commands/brief.js').default
    : null
const assistantCommand = feature('KAIROS')
  ? require('./commands/assistant/index.js').default
  : null
// bridge / remote-control / voice 命令已随其模块一起移除。
const bridge = null
const remoteControlServerCommand = null
const voiceCommand = null
const forceSnip = feature('HISTORY_SNIP')
  ? require('./commands/force-snip.js').default
  : null
const workflowsCmd = feature('WORKFLOW_SCRIPTS')
  ? (
      require('./commands/workflows/index.js') as typeof import('./commands/workflows/index.js')
    ).default
  : null
const webCmd = feature('CCR_REMOTE_SETUP')
  ? (
      require('./commands/remote-setup/index.js') as typeof import('./commands/remote-setup/index.js')
    ).default
  : null
const clearSkillIndexCache = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (
      require('./services/skillSearch/localSearch.js') as typeof import('./services/skillSearch/localSearch.js')
    ).clearSkillIndexCache
  : null
const subscribePr = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./commands/subscribe-pr.js').default
  : null
const ultraplan = feature('ULTRAPLAN')
  ? require('./commands/ultraplan.js').default
  : null
const torch = feature('TORCH') ? require('./commands/torch.js').default : null
const peersCmd = feature('UDS_INBOX')
  ? (
      require('./commands/peers/index.js') as typeof import('./commands/peers/index.js')
    ).default
  : null
const forkCmd = feature('FORK_SUBAGENT')
  ? (
      require('./commands/fork/index.js') as typeof import('./commands/fork/index.js')
    ).default
  : null
const buddy = feature('BUDDY')
  ? (
      require('./commands/buddy/index.js') as typeof import('./commands/buddy/index.js')
    ).default
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import thinkback from './commands/thinkback/index.js'
import thinkbackPlay from './commands/thinkback-play/index.js'
import permissions from './commands/permissions/index.js'
import plan from './commands/plan/index.js'
import fast from './commands/fast/index.js'
import passes from './commands/passes/index.js'
import privacySettings from './commands/privacy-settings/index.js'
import hooks from './commands/hooks/index.js'
import files from './commands/files/index.js'
import branch from './commands/branch/index.js'
import agents from './commands/agents/index.js'
import plugin from './commands/plugin/index.js'
import reloadPlugins from './commands/reload-plugins/index.js'
import rewind from './commands/rewind/index.js'
import heapDump from './commands/heapdump/index.js'
import mockLimits from './commands/mock-limits/index.js'
import version from './commands/version.js'
import summary from './commands/summary/index.js'
import {
  resetLimits,
  resetLimitsNonInteractive,
} from './commands/reset-limits/index.js'
import antTrace from './commands/ant-trace/index.js'
import perfIssue from './commands/perf-issue/index.js'
import sandboxToggle from './commands/sandbox-toggle/index.js'
import chrome from './commands/chrome/index.js'
import stickers from './commands/stickers/index.js'
import advisor from './commands/advisor.js'
import { logError } from './utils/log.js'
import { toError } from './utils/errors.js'
import { logForDebugging } from './utils/debug.js'
import {
  getSkillDirCommands,
  clearSkillCaches,
  getDynamicSkills,
} from './skills/loadSkillsDir.js'
import { getBundledSkills } from './skills/bundledSkills.js'
import { getBuiltinPluginSkillCommands } from './plugins/builtinPlugins.js'
import {
  getPluginCommands,
  clearPluginCommandCache,
  getPluginSkills,
  clearPluginSkillsCache,
} from './utils/plugins/loadPluginCommands.js'
import memoize from 'lodash-es/memoize.js'
import { isUsing3PServices, isLimkenionAISubscriber } from './utils/auth.js'
import { isFirstPartyLimkenionBaseUrl } from './utils/model/providers.js'
import env from './commands/env/index.js'
import exit from './commands/exit/index.js'
import web from './commands/web/index.js'
import exportCommand from './commands/export/index.js'
import model from './commands/model/index.js'
import tag from './commands/tag/index.js'
import outputStyle from './commands/output-style/index.js'
import remoteEnv from './commands/remote-env/index.js'
import upgrade from './commands/upgrade/index.js'
import {
  extraUsage,
  extraUsageNonInteractive,
} from './commands/extra-usage/index.js'
import rateLimitOptions from './commands/rate-limit-options/index.js'
import statusline from './commands/statusline.js'
import effort from './commands/effort/index.js'
import stats from './commands/stats/index.js'
// insights.ts 有 113KB（3200 行，内含 diffLines/html 渲染）。用延迟
// shim 把这个重型模块推迟到 /insights 真正被调用时再加载。
const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  description: 'Generate a report analyzing your Limkenion sessions',
  contentLength: 0,
  progressMessage: 'analyzing your sessions',
  source: 'builtin',
  async getPromptForCommand(args, context) {
    const real = (await import('./commands/insights.js')).default
    if (real.type !== 'prompt') throw new Error('unreachable')
    return real.getPromptForCommand(args, context)
  },
}
import oauthRefresh from './commands/oauth-refresh/index.js'
import debugToolCall from './commands/debug-tool-call/index.js'
import { getSettingSourceName } from './utils/settings/constants.js'
import {
  type Command,
  getCommandName,
  isCommandEnabled,
} from './types/command.js'

// 从统一位置重新导出类型
export type {
  Command,
  CommandBase,
  CommandResultDisplay,
  LocalCommandResult,
  LocalJSXCommandContext,
  PromptCommand,
  ResumeEntrypoint,
} from './types/command.js'
export { getCommandName, isCommandEnabled } from './types/command.js'

// 从外部构建中剔除的命令
export const INTERNAL_ONLY_COMMANDS = [
  backfillSessions,
  breakCache,
  bughunter,
  commit,
  commitPushPr,
  ctx_viz,
  goodLimkenion,
  issue,
  initVerifiers,
  ...(forceSnip ? [forceSnip] : []),
  mockLimits,
  version,
  ...(ultraplan ? [ultraplan] : []),
  ...(subscribePr ? [subscribePr] : []),
  resetLimits,
  resetLimitsNonInteractive,
  onboarding,
  share,
  summary,
  teleport,
  antTrace,
  perfIssue,
  env,
  oauthRefresh,
  debugToolCall,
  agentsPlatform,
  autofixPr,
].filter(Boolean)

// 声明为函数，这样在 getCommands 被调用之前不会执行 ——
// 因为底层函数会读取 config，而 config 在模块初始化阶段无法读取
const COMMANDS = memoize((): Command[] => [
  addDir,
  advisor,
  agents,
  branch,
  btw,
  chrome,
  clear,
  color,
  compact,
  config,
  copy,
  desktop,
  context,
  contextNonInteractive,
  cost,
  diff,
  doctor,
  effort,
  exit,
  fast,
  files,
  web,
  heapDump,
  help,
  ide,
  init,
  keybindings,
  installGitHubApp,
  installSlackApp,
  mcp,
  memory,
  mobile,
  model,
  outputStyle,
  remoteEnv,
  plugin,
  pr_comments,
  releaseNotes,
  reloadPlugins,
  rename,
  resume,
  session,
  skills,
  stats,
  status,
  statusline,
  stickers,
  tag,
  theme,
  feedback,
  review,
  ultrareview,
  rewind,
  securityReview,
  terminalSetup,
  upgrade,
  extraUsage,
  extraUsageNonInteractive,
  rateLimitOptions,
  usage,
  usageReport,
  vim,
  ...(webCmd ? [webCmd] : []),
  ...(forkCmd ? [forkCmd] : []),
  ...(buddy ? [buddy] : []),
  ...(proactive ? [proactive] : []),
  ...(briefCommand ? [briefCommand] : []),
  ...(assistantCommand ? [assistantCommand] : []),
  ...(bridge ? [bridge] : []),
  ...(remoteControlServerCommand ? [remoteControlServerCommand] : []),
  ...(voiceCommand ? [voiceCommand] : []),
  thinkback,
  thinkbackPlay,
  permissions,
  plan,
  privacySettings,
  hooks,
  exportCommand,
  sandboxToggle,
  ...(!isUsing3PServices() ? [logout, login()] : []),
  passes,
  ...(peersCmd ? [peersCmd] : []),
  tasks,
  ...(workflowsCmd ? [workflowsCmd] : []),
  ...(torch ? [torch] : []),
  ...([]),
])

export const builtInCommandNames = memoize(
  (): Set<string> =>
    new Set(COMMANDS().flatMap(_ => [_.name, ...(_.aliases ?? [])])),
)

async function getSkills(cwd: string): Promise<{
  skillDirCommands: Command[]
  pluginSkills: Command[]
  bundledSkills: Command[]
  builtinPluginSkills: Command[]
}> {
  try {
    const [skillDirCommands, pluginSkills] = await Promise.all([
      getSkillDirCommands(cwd).catch(err => {
        logError(toError(err))
        logForDebugging(
          'Skill directory commands failed to load, continuing without them',
        )
        return []
      }),
      getPluginSkills().catch(err => {
        logError(toError(err))
        logForDebugging('Plugin skills failed to load, continuing without them')
        return []
      }),
    ])
    // 内置技能在启动时同步注册
    const bundledSkills = getBundledSkills()
    // 内置插件技能来自已启用的内置插件
    const builtinPluginSkills = getBuiltinPluginSkillCommands()
    logForDebugging(
      `getSkills returning: ${skillDirCommands.length} skill dir commands, ${pluginSkills.length} plugin skills, ${bundledSkills.length} bundled skills, ${builtinPluginSkills.length} builtin plugin skills`,
    )
    return {
      skillDirCommands,
      pluginSkills,
      bundledSkills,
      builtinPluginSkills,
    }
  } catch (err) {
    // 我们在 Promise 层已经 catch 过，理论上不该走到这里，但做一次防御
    logError(toError(err))
    logForDebugging('Unexpected error in getSkills, returning empty')
    return {
      skillDirCommands: [],
      pluginSkills: [],
      bundledSkills: [],
      builtinPluginSkills: [],
    }
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const getWorkflowCommands = feature('WORKFLOW_SCRIPTS')
  ? (
      require('./tools/WorkflowTool/createWorkflowCommand.js') as typeof import('./tools/WorkflowTool/createWorkflowCommand.js')
    ).getWorkflowCommands
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 按命令声明的 `availability`（认证/供应商要求）过滤命令。
 * 没有声明 `availability` 的命令视为通用命令。
 * 这一步在 `isEnabled()` 之前运行，因此无论特性开关状态如何，
 * 受供应商限制的命令都会被隐藏。
 *
 * 不做记忆化 —— 认证状态可能在会话中途变化（例如执行 /login 之后），
 * 所以每次 getCommands() 调用都必须重新求值。
 */
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) return true
  for (const a of cmd.availability) {
    switch (a) {
      case 'cloud-subscriber':
        if (isLimkenionAISubscriber()) return true
        break
      case 'console':
        // Console API key 用户 = 直接的 1P API 客户（不是 3P，也不是 远端服务）。
        // 排除 3P（Bedrock/Vertex/Foundry）—— 它们不设置 LIMKENION_BASE_URL；
        // 也排除通过自定义 base URL 走网关的用户。
        if (
          !isLimkenionAISubscriber() &&
          !isUsing3PServices() &&
          isFirstPartyLimkenionBaseUrl()
        )
          return true
        break
      default: {
        const _exhaustive: never = a
        void _exhaustive
        break
      }
    }
  }
  return false
}

/**
 * 加载所有命令来源（技能、插件、工作流）。按 cwd 做记忆化，
 * 因为加载开销很大（磁盘 I/O、动态导入）。
 */
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    getSkills(cwd),
    getPluginCommands(),
    getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
  ])

  return [
    ...bundledSkills,
    ...builtinPluginSkills,
    ...skillDirCommands,
    ...workflowCommands,
    ...pluginCommands,
    ...pluginSkills,
    ...COMMANDS(),
  ]
})

/**
 * 返回当前用户可用的命令。开销大的加载过程会被记忆化，
 * 但 availability 与 isEnabled 检查每次调用都重新执行，
 * 因此认证变化（例如 /login）能立即生效。
 */
export async function getCommands(cwd: string): Promise<Command[]> {
  const allCommands = await loadAllCommands(cwd)

  // 获取在文件操作过程中发现的动态技能
  const dynamicSkills = getDynamicSkills()

  // 构建不含动态技能的基础命令集
  const baseCommands = allCommands.filter(
    _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
  )

  if (dynamicSkills.length === 0) {
    return baseCommands
  }

  // 动态技能去重 —— 只有尚不存在时才添加
  const baseCommandNames = new Set(baseCommands.map(c => c.name))
  const uniqueDynamicSkills = dynamicSkills.filter(
    s =>
      !baseCommandNames.has(s.name) &&
      meetsAvailabilityRequirement(s) &&
      isCommandEnabled(s),
  )

  if (uniqueDynamicSkills.length === 0) {
    return baseCommands
  }

  // 把动态技能插在插件技能之后、内置命令之前
  const builtInNames = new Set(COMMANDS().map(c => c.name))
  const insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))

  if (insertIndex === -1) {
    return [...baseCommands, ...uniqueDynamicSkills]
  }

  return [
    ...baseCommands.slice(0, insertIndex),
    ...uniqueDynamicSkills,
    ...baseCommands.slice(insertIndex),
  ]
}

/**
 * 只清除命令的记忆化缓存，不清除技能缓存。
 * 当新增动态技能需要让缓存的命令列表失效时用它。
 */
export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache?.clear?.()
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
  // skillSearch/localSearch.ts 里的 getSkillIndex 是构建在
  // getSkillToolCommands/getCommands 之上的另一层记忆化。只清除内层缓存
  // 对外层没有任何作用 —— lodash 的 memoize 会直接返回缓存结果，
  // 根本不会再走到已被清空的内层。必须显式清除它。
  clearSkillIndexCache?.()
}

export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()
  clearPluginCommandCache()
  clearPluginSkillsCache()
  clearSkillCaches()
}

/**
 * 把 AppState.mcp.commands 过滤为 MCP 提供的技能（prompt 类型、
 * 可被模型调用、从 MCP 加载）。这些技能位于 getCommands() 之外，
 * 因此需要在技能索引中包含 MCP 技能的调用方要另行把它们串进来。
 */
export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  if (feature('MCP_SKILLS')) {
    return mcpCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        cmd.loadedFrom === 'mcp' &&
        !cmd.disableModelInvocation,
    )
  }
  return []
}

// SkillTool 会展示模型可调用的、所有基于 prompt 的命令
// 这既包括技能（来自 /skills/），也包括命令（来自 /commands/）
export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const allCommands = await getCommands(cwd)
    return allCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        !cmd.disableModelInvocation &&
        cmd.source !== 'builtin' &&
        // 始终包含来自 /skills/ 目录的技能、内置技能，以及旧式 /commands/ 条目
        // （在 frontmatter 缺失时，它们都会从首行自动推导出描述）。
        // 插件/MCP 命令仍需显式提供描述才会出现在列表中。
        (cmd.loadedFrom === 'bundled' ||
          cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'commands_DEPRECATED' ||
          cmd.hasUserSpecifiedDescription ||
          cmd.whenToUse),
    )
  },
)

// 把命令过滤为只含技能。技能是为模型提供专用能力的命令，
// 通过 loadedFrom 为 'skills'、'plugin' 或 'bundled'，
// 或带有 disableModelInvocation 来识别。
export const getSlashCommandToolSkills = memoize(
  async (cwd: string): Promise<Command[]> => {
    try {
      const allCommands = await getCommands(cwd)
      return allCommands.filter(
        cmd =>
          cmd.type === 'prompt' &&
          cmd.source !== 'builtin' &&
          (cmd.hasUserSpecifiedDescription || cmd.whenToUse) &&
          (cmd.loadedFrom === 'skills' ||
            cmd.loadedFrom === 'plugin' ||
            cmd.loadedFrom === 'bundled' ||
            cmd.disableModelInvocation),
      )
    } catch (error) {
      logError(toError(error))
      // 返回空数组而不是抛错 —— 技能不是关键功能
      // 这可以避免技能加载失败拖垮整个系统
      logForDebugging('Returning empty skills array due to load failure')
      return []
    }
  },
)

/**
 * 在远程模式（--remote）下可以安全使用的命令。
 * 这些命令只影响本地 TUI 状态，不依赖本地文件系统、
 * git、shell、IDE、MCP 或其他本地执行上下文。
 *
 * 用在两处：
 * 1. 在 REPL 渲染之前于 main.tsx 中预过滤命令（避免与 CCR 初始化产生竞态）
 * 2. 在 REPL 的 handleRemoteInit 中，于 CCR 过滤之后保留仅本地可用的命令
 */
export const REMOTE_SAFE_COMMANDS: Set<Command> = new Set([
  session, // 显示远程会话的二维码 / URL
  exit, // 退出 TUI
  clear, // 清屏
  help, // 显示帮助
  theme, // 更换终端主题
  color, // 更换 agent 配色
  vim, // 切换 vim 模式
  cost, // 显示会话成本（本地成本统计）
  usage, // 显示用量信息
  copy, // 复制上一条消息
  btw, // 快速笔记
  feedback, // 发送反馈
  plan, // plan 模式开关
  keybindings, // 快捷键管理
  statusline, // 状态栏开关
  stickers, // 贴纸
  mobile, // 手机二维码
])

/**
 * 类型为 'local'、且经由 Remote Control bridge 收到输入时可以安全执行的
 * 内置命令。它们产生文本输出并流回移动/Web 客户端，且没有仅终端可见的
 * 副作用。
 *
 * 'local-jsx' 命令按类型被阻断（它们渲染 Ink UI），
 * 'prompt' 命令按类型被放行（它们会展开成发送给模型的文本）——
 * 这个集合只对 'local' 命令起作用。
 *
 * 新增一个需要在手机端可用的 'local' 命令时，请加到这里。
 * 默认是阻断的。
 */
export const BRIDGE_SAFE_COMMANDS: Set<Command> = new Set(
  [
    compact, // 压缩上下文 —— 用手机在会话中途操作很有用
    clear, // 清空 transcript
    cost, // 显示会话成本
    summary, // 总结对话
    releaseNotes, // 显示更新日志
    files, // 列出被跟踪的文件
  ].filter((c): c is Command => c !== null),
)

/**
 * 某个斜杠命令在输入来自 Remote Control bridge（移动/Web 客户端）时
 * 是否可以安全执行。
 *
 * PR #19134 一刀切地阻断了来自 bridge 入站的所有斜杠命令，因为 iOS 上的
 * `/model` 会弹出本地的 Ink 选择器。这个谓词用一份显式白名单放宽了该限制：
 * 'prompt' 命令（技能）展开为文本，天然安全；'local' 命令需要通过
 * BRIDGE_SAFE_COMMANDS 显式选择加入；'local-jsx' 命令渲染 Ink UI，保持阻断。
 */
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') return false
  if (cmd.type === 'prompt') return true
  return BRIDGE_SAFE_COMMANDS.has(cmd)
}

/**
 * 把命令过滤为只包含远程模式下安全的那些。
 * 用于在 --remote 模式下渲染 REPL 时预过滤命令，
 * 防止仅本地可用的命令在 CCR 初始化消息到达之前短暂可用。
 */
export function filterCommandsForRemoteMode(commands: Command[]): Command[] {
  return commands.filter(cmd => REMOTE_SAFE_COMMANDS.has(cmd))
}

export function findCommand(
  commandName: string,
  commands: Command[],
): Command | undefined {
  return commands.find(
    _ =>
      _.name === commandName ||
      getCommandName(_) === commandName ||
      _.aliases?.includes(commandName),
  )
}

export function hasCommand(commandName: string, commands: Command[]): boolean {
  return findCommand(commandName, commands) !== undefined
}

export function getCommand(commandName: string, commands: Command[]): Command {
  const command = findCommand(commandName, commands)
  if (!command) {
    throw ReferenceError(
      `Command ${commandName} not found. Available commands: ${commands
        .map(_ => {
          const name = getCommandName(_)
          return _.aliases ? `${name} (aliases: ${_.aliases.join(', ')})` : name
        })
        .sort((a, b) => a.localeCompare(b))
        .join(', ')}`,
    )
  }

  return command
}

/**
 * 把命令的描述与其来源标注一起格式化，用于面向用户的 UI。
 * 用于输入提示、帮助页面，以及其他需要让用户看到命令来源的地方。
 *
 * 面向模型的提示词（如 SkillTool）请直接使用 cmd.description。
 */
export function formatDescriptionWithSource(cmd: Command): string {
  if (cmd.type !== 'prompt') {
    return cmd.description
  }

  if (cmd.kind === 'workflow') {
    return `${cmd.description} (workflow)`
  }

  if (cmd.source === 'plugin') {
    const pluginName = cmd.pluginInfo?.pluginManifest.name
    if (pluginName) {
      return `(${pluginName}) ${cmd.description}`
    }
    return `${cmd.description} (plugin)`
  }

  if (cmd.source === 'builtin' || cmd.source === 'mcp') {
    return cmd.description
  }

  if (cmd.source === 'bundled') {
    return `${cmd.description} (bundled)`
  }

  return `${cmd.description} (${getSettingSourceName(cmd.source)})`
}
