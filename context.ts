import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  getAdditionalDirectoriesForLimkenionMd,
  setCachedLimkenionMdContent,
} from './bootstrap/state.js'
import { getLocalISODate } from './constants/common.js'
import {
  filterInjectedMemoryFiles,
  getLimkenionMds,
  getMemoryFiles,
} from './utils/limkenionmd.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { execFileNoThrow } from './utils/execFileNoThrow.js'
import { getBranch, getDefaultBranch, getIsGit, gitExe } from './utils/git.js'
import { shouldIncludeGitInstructions } from './utils/gitSettings.js'
import { logError } from './utils/log.js'

const MAX_STATUS_CHARS = 2000

// 用于击穿缓存的 system 提示词注入（仅 ant，临时调试状态）
let systemPromptInjection: string | null = null

export function getSystemPromptInjection(): string | null {
  return systemPromptInjection
}

export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  // 注入内容变化时立即清空 context 缓存
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
}

export const getGitStatus = memoize(async (): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test') {
    // 避免测试中产生循环依赖
    return null
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'git_status_started')

  const isGitStart = Date.now()
  const isGit = await getIsGit()
  logForDiagnosticsNoPII('info', 'git_is_git_check_completed', {
    duration_ms: Date.now() - isGitStart,
    is_git: isGit,
  })

  if (!isGit) {
    logForDiagnosticsNoPII('info', 'git_status_skipped_not_git', {
      duration_ms: Date.now() - startTime,
    })
    return null
  }

  try {
    const gitCmdsStart = Date.now()
    const [branch, mainBranch, status, log, userName] = await Promise.all([
      getBranch(),
      getDefaultBranch(),
      execFileNoThrow(gitExe(), ['--no-optional-locks', 'status', '--short'], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(
        gitExe(),
        ['--no-optional-locks', 'log', '--oneline', '-n', '5'],
        {
          preserveOutputOnError: false,
        },
      ).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(gitExe(), ['config', 'user.name'], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
    ])

    logForDiagnosticsNoPII('info', 'git_commands_completed', {
      duration_ms: Date.now() - gitCmdsStart,
      status_length: status.length,
    })

    // 检查状态是否超出字符数上限
    const truncatedStatus =
      status.length > MAX_STATUS_CHARS
        ? status.substring(0, MAX_STATUS_CHARS) +
          '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using BashTool)'
        : status

    logForDiagnosticsNoPII('info', 'git_status_completed', {
      duration_ms: Date.now() - startTime,
      truncated: status.length > MAX_STATUS_CHARS,
    })

    return [
      `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
      `Current branch: ${branch}`,
      `Main branch (you will usually use this for PRs): ${mainBranch}`,
      ...(userName ? [`Git user: ${userName}`] : []),
      `Status:\n${truncatedStatus || '(clean)'}`,
      `Recent commits:\n${log}`,
    ].join('\n\n')
  } catch (error) {
    logForDiagnosticsNoPII('error', 'git_status_failed', {
      duration_ms: Date.now() - startTime,
    })
    logError(error)
    return null
  }
})

/**
 * 该 context 会被前置到每一次对话中，并在对话存续期间被缓存。
 */
export const getSystemContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'system_context_started')

    // 在 CCR 中跳过 git status（恢复时是不必要的开销），或在禁用 git 指令时跳过
    const gitStatus =
      isEnvTruthy(process.env.LIMKENION_REMOTE) ||
      !shouldIncludeGitInstructions()
        ? null
        : await getGitStatus()

    // 若设置了 system 提示词注入则包含它（用于击穿缓存，仅 ant）
    const injection = feature('BREAK_CACHE_COMMAND')
      ? getSystemPromptInjection()
      : null

    logForDiagnosticsNoPII('info', 'system_context_completed', {
      duration_ms: Date.now() - startTime,
      has_git_status: gitStatus !== null,
      has_injection: injection !== null,
    })

    return {
      ...(gitStatus && { gitStatus }),
      ...(feature('BREAK_CACHE_COMMAND') && injection
        ? {
            cacheBreaker: `[CACHE_BREAKER: ${injection}]`,
          }
        : {}),
    }
  },
)

/**
 * 该 context 会被前置到每一次对话中，并在对话存续期间被缓存。
 */
export const getUserContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'user_context_started')

    // LIMKENION_DISABLE_LIMKENION_MDS：硬性关闭，始终如此。
    // --bare：跳过自动发现（cwd 遍历），但会遵循显式的 --add-dir。
    // --bare 的含义是「跳过我没有要求的」，而不是「忽略我要求的」。
    const shouldDisableLimkenionMd =
      isEnvTruthy(process.env.LIMKENION_DISABLE_LIMKENION_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForLimkenionMd().length === 0)
    // 等待异步 I/O（readFile / readdir 目录遍历）完成，好让事件
    // 循环在第一个 fs.readFile 处自然让出。
    const limkenionMd = shouldDisableLimkenionMd
      ? null
      : getLimkenionMds(filterInjectedMemoryFiles(await getMemoryFiles()))
    // 供 auto 模式分类器使用的缓存（yoloClassifier.ts 读这个，
    // 而不是直接 import limkenionmd.ts —— 那会经由
    // permissions/filesystem → permissions → yoloClassifier 形成循环）。
    setCachedLimkenionMdContent(limkenionMd || null)

    logForDiagnosticsNoPII('info', 'user_context_completed', {
      duration_ms: Date.now() - startTime,
      limkenionmd_length: limkenionMd?.length ?? 0,
      limkenionmd_disabled: Boolean(shouldDisableLimkenionMd),
    })

    return {
      ...(limkenionMd && { limkenionMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
