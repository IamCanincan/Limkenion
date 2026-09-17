/* eslint-disable custom-rules/no-process-exit */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getCwd } from 'src/utils/cwd.js'
import { checkForReleaseNotes } from 'src/utils/releaseNotes.js'
import { setCwd } from 'src/utils/Shell.js'
import { initSinks } from 'src/utils/sinks.js'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from './bootstrap/state.js'
import { getCommands } from './commands.js'
import { initSessionMemory } from './services/SessionMemory/sessionMemory.js'
import { asSessionId } from './types/ids.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { checkAndRestoreTerminalBackup } from './utils/appleTerminalBackup.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from './utils/auth.js'
import { clearMemoryFileCaches } from './utils/limkenionmd.js'
import { getCurrentProjectConfig, getGlobalConfig } from './utils/config.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { env } from './utils/env.js'
import { envDynamic } from './utils/envDynamic.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { errorMessage } from './utils/errors.js'
import { findCanonicalGitRoot, findGitRoot, getIsGit } from './utils/git.js'
import { initializeFileChangedWatcher } from './utils/hooks/fileChangedWatcher.js'
import {
  captureHooksConfigSnapshot,
  updateHooksConfigSnapshot,
} from './utils/hooks/hooksConfigSnapshot.js'
import { hasWorktreeCreateHook } from './utils/hooks.js'
import { checkAndRestoreITerm2Backup } from './utils/iTermBackup.js'
import { logError } from './utils/log.js'
import { getRecentActivity } from './utils/logoV2Utils.js'
import { lockCurrentVersion } from './utils/nativeInstaller/index.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { getPlanSlug } from './utils/plans.js'
import { saveWorktreeState } from './utils/sessionStorage.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
} from './utils/worktree.js'

export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'setup_started')

  // 检查 Node.js 版本是否低于 18
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion) < 18) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      chalk.bold.red(
        'Error: Limkenion requires Node.js version 18 or higher.',
      ),
    )
    process.exit(1)
  }

  // 若提供了自定义会话 ID 则进行设置
  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }

  // --bare / SIMPLE：跳过 UDS 消息服务与 teammate 快照。
  // 脚本化调用不会收到注入消息，也不使用 swarm teammate。
  // 显式传入 --messaging-socket-path 是逃生舱（沿用 #23222 的门禁模式）。
  if (!isBareMode() || messagingSocketPath !== undefined) {
    // 启动 UDS 消息服务（仅 Mac/Linux）。
    // 对 ant 默认启用 —— 若未传 --messaging-socket-path，就在 tmpdir 中
    // 创建一个 socket。这里要 await，确保在任何钩子（尤其是 SessionStart）
    // 派生子进程并快照 process.env 之前，服务已绑定且
    // $LIMKENION_MESSAGING_SOCKET 已导出。
    if (feature('UDS_INBOX')) {
      const m = await import('./utils/udsMessaging.js')
      await m.startUdsMessaging(
        messagingSocketPath ?? m.getDefaultUdsSocketPath(),
        { isExplicit: messagingSocketPath !== undefined },
      )
    }
  }

  // Teammate 快照 —— 仅 SIMPLE 的门禁（没有逃生舱，bare 下不使用 swarm）
  if (!isBareMode() && isAgentSwarmsEnabled()) {
    const { captureTeammateModeSnapshot } = await import(
      './utils/swarm/backends/teammateModeSnapshot.js'
    )
    captureTeammateModeSnapshot()
  }

  // 终端备份恢复 —— 仅交互模式。print 模式不与终端设置交互；
  // 下一次交互式会话会检测并恢复任何被中断的设置。
  if (!getIsNonInteractiveSession()) {
    // 仅在启用 swarm 时检查 iTerm2 备份
    if (isAgentSwarmsEnabled()) {
      const restoredIterm2Backup = await checkAndRestoreITerm2Backup()
      if (restoredIterm2Backup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.yellow(
            'Detected an interrupted iTerm2 setup. Your original settings have been restored. You may need to restart iTerm2 for the changes to take effect.',
          ),
        )
      } else if (restoredIterm2Backup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            `Failed to restore iTerm2 settings. Please manually restore your original settings with: defaults import com.googlecode.iterm2 ${restoredIterm2Backup.backupPath}.`,
          ),
        )
      }
    }

    // 若设置过程曾被中断，则检查并恢复 Terminal.app 备份
    try {
      const restoredTerminalBackup = await checkAndRestoreTerminalBackup()
      if (restoredTerminalBackup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.yellow(
            'Detected an interrupted Terminal.app setup. Your original settings have been restored. You may need to restart Terminal.app for the changes to take effect.',
          ),
        )
      } else if (restoredTerminalBackup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            `Failed to restore Terminal.app settings. Please manually restore your original settings with: defaults import com.apple.Terminal ${restoredTerminalBackup.backupPath}.`,
          ),
        )
      }
    } catch (error) {
      // 若 Terminal.app 备份恢复失败则记录日志，但不要崩溃
      logError(error)
    }
  }

  // 重要：setCwd() 必须在任何其他依赖 cwd 的代码之前调用
  setCwd(cwd)

  // 捕获钩子配置的快照，以避免隐藏的钩子修改。
  // 重要：必须在 setCwd() 之后调用，好让钩子从正确的目录加载
  const hooksStart = Date.now()
  captureHooksConfigSnapshot()
  logForDiagnosticsNoPII('info', 'setup_hooks_captured', {
    duration_ms: Date.now() - hooksStart,
  })

  // 初始化 FileChanged 钩子监听器 —— 同步执行，读取钩子配置快照
  initializeFileChangedWatcher(cwd)

  // 若请求了则处理 worktree 创建
  // 重要：这必须在 getCommands() 之前调用，否则 /eject 将不可用。
  if (worktreeEnabled) {
    // 与 bridgeMain.ts 对应：由钩子配置的会话可以在没有 git 的情况下继续，
    // 这样 createWorktreeForSession() 才能委派给钩子（非 git 的 VCS）。
    const hasHook = hasWorktreeCreateHook()
    const inGit = await getIsGit()
    if (!hasHook && !inGit) {
      process.stderr.write(
        chalk.red(
          `Error: Can only use --worktree in a git repository, but ${chalk.bold(cwd)} is not a git repository. ` +
            `Configure a WorktreeCreate hook in settings.json to use --worktree with other VCS systems.\n`,
        ),
      )
      process.exit(1)
    }

    const slug = worktreePRNumber
      ? `pr-${worktreePRNumber}`
      : (worktreeName ?? getPlanSlug())

    // 只要我们在 git 仓库中，就会执行 git preamble —— 即使配置了钩子 ——
    // 这样 --tmux 对同时配置了 WorktreeCreate 钩子的 git 用户仍然可用。
    // 只有纯钩子（非 git）模式才会跳过它。
    let tmuxSessionName: string | undefined
    if (inGit) {
      // 解析到主仓库根目录（处理从 worktree 内部被调用的情况）。
      // findCanonicalGitRoot 是同步的、只访问文件系统、且带记忆化；
      // 底层的 findGitRoot 缓存已由上面的 getIsGit() 预热，因此这里几乎免费。
      const mainRepoRoot = findCanonicalGitRoot(getCwd())
      if (!mainRepoRoot) {
        process.stderr.write(
          chalk.red(
            `Error: Could not determine the main git repository root.\n`,
          ),
        )
        process.exit(1)
      }

      // 如果我们在 worktree 内部，就切到主仓库去创建 worktree
      if (mainRepoRoot !== (findGitRoot(getCwd()) ?? getCwd())) {
        logForDiagnosticsNoPII('info', 'worktree_resolved_to_main_repo')
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }

      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(mainRepoRoot, worktreeBranchName(slug))
        : undefined
    } else {
      // 非 git 钩子模式：没有规范根目录可解析，因此用 cwd 命名
      // tmux 会话 —— generateTmuxSessionName 只取路径的最后一段。
      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(getCwd(), worktreeBranchName(slug))
        : undefined
    }

    let worktreeSession: Awaited<ReturnType<typeof createWorktreeForSession>>
    try {
      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        tmuxSessionName,
        worktreePRNumber ? { prNumber: worktreePRNumber } : undefined,
      )
    } catch (error) {
      process.stderr.write(
        chalk.red(`Error creating worktree: ${errorMessage(error)}\n`),
      )
      process.exit(1)
    }

    logEvent('limkenion_worktree_created', { tmux_enabled: tmuxEnabled })

    // 若已启用，则为 worktree 创建 tmux 会话
    if (tmuxEnabled && tmuxSessionName) {
      const tmuxResult = await createTmuxSessionForWorktree(
        tmuxSessionName,
        worktreeSession.worktreePath,
      )
      if (tmuxResult.created) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.green(
            `Created tmux session: ${chalk.bold(tmuxSessionName)}\nTo attach: ${chalk.bold(`tmux attach -t ${tmuxSessionName}`)}`,
          ),
        )
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.yellow(
            `Warning: Failed to create tmux session: ${tmuxResult.error}`,
          ),
        )
      }
    }

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    // --worktree 意味着该 worktree 就是本次会话的项目，
    // 因此技能/钩子/cron 等都应在此解析。（会话中途的
    // EnterWorktreeTool 不会改动 projectRoot —— 那是一次性的
    // worktree，项目保持不变。）
    setProjectRoot(getCwd())
    saveWorktreeState(worktreeSession)
    // 清空记忆文件缓存，因为 originalCwd 已改变
    clearMemoryFileCaches()
    // 设置缓存已在 init() 中（通过 applySafeConfigEnvironmentVariables）
    // 以及上面 captureHooksConfigSnapshot() 时填充过，两者都来自
    // 原目录的 .limkenion/settings.json。现在从 worktree 重新读取
    // 并重新捕获钩子。
    updateHooksConfigSnapshot()
  }

  // 后台任务 —— 只保留必须在首次查询之前完成的关键注册
  logForDiagnosticsNoPII('info', 'setup_background_jobs_starting')
  // 内置技能/插件在 main.tsx 中、于并行的 getCommands() 启动之前注册
  // —— 参见那里的注释。从 setup() 中移出是因为上面的 await 点
  // （startUdsMessaging，约 20ms）会让 getCommands() 抢跑并
  // 记忆化出一个空的 bundledSkills 列表。
  if (!isBareMode()) {
    initSessionMemory() // 同步执行 —— 注册钩子，门禁检查延迟进行
    if (feature('CONTEXT_COLLAPSE')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js')
      ).initContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  void lockCurrentVersion() // 锁定当前版本，防止被其他进程删除
  logForDiagnosticsNoPII('info', 'setup_background_jobs_launched')

  profileCheckpoint('setup_before_prefetch')
  // 预取 promise —— 只保留渲染前需要的项
  logForDiagnosticsNoPII('info', 'setup_prefetch_starting')
  // 当设置了 LIMKENION_SYNC_PLUGIN_INSTALL 时，跳过所有插件预取。
  // print.ts 中的同步安装路径会在安装后调用 refreshPluginState()，
  // 重新加载命令、钩子与 agent。在这里预取会与安装产生竞态
  // （对同一目录并发执行 copyPluginToVersionedCache / cachePlugin），
  // 而且热重载处理器会在 policySettings 到达时触发
  // clearPluginCache()，打断安装过程。
  const skipPluginPrefetch =
    (getIsNonInteractiveSession() &&
      isEnvTruthy(process.env.LIMKENION_SYNC_PLUGIN_INSTALL)) ||
    // --bare：loadPluginHooks → loadAllPlugins 是文件系统操作，
    // 而 --bare 下 executeHooks 本来就会提前返回，做了也是白做。
    isBareMode()
  if (!skipPluginPrefetch) {
    void getCommands(getProjectRoot())
  }
  void import('./utils/plugins/loadPluginHooks.js').then(m => {
    if (!skipPluginPrefetch) {
      void m.loadPluginHooks() // 预加载插件钩子（在渲染前由 processSessionStartHooks 消费）
      m.setupPluginHookHotReload() // 当设置变化时，为插件钩子设置热重载
    }
  })
  // --bare：跳过归属钩子安装 + 仓库分类 +
  // 会话文件访问统计 + 团队记忆监听器。这些是为提交归属与用量指标
  // 做的后台记账 —— 脚本化调用不会提交代码，而且归属钩子那
  // 49ms 的 stat 检查（实测）纯属开销。这里不是提前返回：
  // --dangerously-skip-permissions 的安全门禁、limkenion_started
  // 信标，以及下面的 apiKeyHelper 预取仍然必须执行。
  if (!isBareMode()) {
    
    if (feature('COMMIT_ATTRIBUTION')) {
      // 用动态导入以启用死代码消除（该模块含有被排除的字符串）。
      // 推迟到下一个 tick，好让 git 子进程的派发发生在首次渲染之后，
      // 而不是在 setup() 的微任务窗口内。
      setImmediate(() => {
        void import('./utils/attributionHooks.js').then(
          ({ registerAttributionHooks }) => {
            registerAttributionHooks() // 注册归属跟踪钩子（仅 ant 特性）
          },
        )
      })
    }
    void import('./utils/sessionFileAccessHooks.js').then(m =>
      m.registerSessionFileAccessHooks(),
    ) // 注册会话文件访问统计钩子
    if (feature('TEAMMEM')) {
      void import('./services/teamMemorySync/watcher.js').then(m =>
        m.startTeamMemoryWatcher(),
      ) // 启动团队记忆同步监听器
    }
  }
  initSinks() // 挂上错误日志与遥测 sink，并排空排队的事件

  // 会话成功率的分母。在遥测 sink 挂上之后立即上报 ——
  // 放在任何可能抛错的解析、请求或 I/O 之前。
  // inc-3694（P0 CHANGELOG 崩溃）就是在下面的
  // checkForReleaseNotes 处抛错的；此后每个事件都发不出来。
  // 这个信标是发布健康监控中最早可靠的「进程已启动」信号。
  logEvent('limkenion_started', {})

  void prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession()) // 安全预取 —— 只有在信任已确认后才执行
  profileCheckpoint('setup_after_prefetch')

  // 为 Logo v2 预取数据 —— await 以确保在 logo 渲染前就绪。
  // --bare / SIMPLE：跳过 —— 发布说明是交互式 UI 的展示数据，
  // 而 getRecentActivity() 会读取多达 10 个会话 JSONL 文件。
  if (!isBareMode()) {
    const { hasReleaseNotes } = await checkForReleaseNotes(
      getGlobalConfig().lastReleaseNotesSeen,
    )
    if (hasReleaseNotes) {
      await getRecentActivity()
    }
  }

  // 如果权限模式设为 bypass，则校验我们处于安全环境中
  if (
    permissionMode === 'bypassPermissions' ||
    allowDangerouslySkipPermissions
  ) {
    // 检查在类 Unix 系统上是否以 root/sudo 运行
    // 若在沙箱中则允许 root（例如需要 root 的 TPU devspaces）
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.LIMKENION_BUBBLEWRAP)
    ) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(
        `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`,
      )
      process.exit(1)
    }

    
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

  // 记录上一个会话的 limkenion_exit 事件？
  const projectConfig = getCurrentProjectConfig()
  if (
    projectConfig.lastCost !== undefined &&
    projectConfig.lastDuration !== undefined
  ) {
    logEvent('limkenion_exit', {
      last_session_cost: projectConfig.lastCost,
      last_session_api_duration: projectConfig.lastAPIDuration,
      last_session_tool_duration: projectConfig.lastToolDuration,
      last_session_duration: projectConfig.lastDuration,
      last_session_lines_added: projectConfig.lastLinesAdded,
      last_session_lines_removed: projectConfig.lastLinesRemoved,
      last_session_total_input_tokens: projectConfig.lastTotalInputTokens,
      last_session_total_output_tokens: projectConfig.lastTotalOutputTokens,
      last_session_total_cache_creation_input_tokens:
        projectConfig.lastTotalCacheCreationInputTokens,
      last_session_total_cache_read_input_tokens:
        projectConfig.lastTotalCacheReadInputTokens,
      last_session_fps_average: projectConfig.lastFpsAverage,
      last_session_fps_low_1_pct: projectConfig.lastFpsLow1Pct,
      last_session_id:
        projectConfig.lastSessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...projectConfig.lastSessionMetrics,
    })
    // Note: We intentionally don't clear these values after logging.
    // They're needed for cost restoration when resuming sessions.
    // The values will be overwritten when the next session exits.
  }
}
