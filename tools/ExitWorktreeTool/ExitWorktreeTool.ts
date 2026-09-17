import { z } from 'zod/v4'
import {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { count } from '../../utils/array.js'
import { clearMemoryFileCaches } from '../../utils/limkenionmd.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { updateHooksConfigSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { saveWorktreeState } from '../../utils/sessionStorage.js'
import {
  cleanupWorktree,
  getCurrentWorktreeSession,
  keepWorktree,
  killTmuxSession,
} from '../../utils/worktree.js'
import { EXIT_WORKTREE_TOOL_NAME } from './constants.js'
import { getExitWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['keep', 'remove'])
      .describe(
        '"keep" 会将工作树和分支保留在磁盘上；"remove" 则两者都删除。',
      ),
    discard_changes: z
      .boolean()
      .optional()
      .describe(
        '当 action 为 "remove" 且工作树含有未提交文件或未合并提交时，必须为 true。否则工具会拒绝并列出这些更改。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.enum(['keep', 'remove']),
    originalCwd: z.string(),
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    tmuxSessionName: z.string().optional(),
    discardedFiles: z.number().optional(),
    discardedCommits: z.number().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type ChangeSummary = {
  changedFiles: number
  commits: number
}

/**
 * 当状态无法可靠判定时返回 null——把它用作安全门控的调用方
 * 必须将 null 视为“未知，按不安全处理”
 * （失败即关闭）。静默返回 0/0 会让 cleanupWorktree 破坏真实工作。
 *
 * 以下情况返回 null：
 * - git status 或 rev-list 退出码非零（锁文件、索引损坏、引用非法）
 * - originalHeadCommit 为 undefined 但 git status 成功——这是
 *   基于钩子的 worktree 包裹 git 的情形（worktree.ts:525-532 未设置
 *   originalHeadCommit）。我们能看出工作树是 git，但没有基线就无法统计
 *   提交数，因此无法证明该分支是干净的。
 */
async function countWorktreeChanges(
  worktreePath: string,
  originalHeadCommit: string | undefined,
): Promise<ChangeSummary | null> {
  const status = await execFileNoThrow('git', [
    '-C',
    worktreePath,
    'status',
    '--porcelain',
  ])
  if (status.code !== 0) {
    return null
  }
  const changedFiles = count(status.stdout.split('\n'), l => l.trim() !== '')

  if (!originalHeadCommit) {
    // git status 成功 → 这是一个 git 仓库，但没有基线
    // 提交就无法统计提交数。宁可失败即关闭，也不谎称 0。
    return null
  }

  const revList = await execFileNoThrow('git', [
    '-C',
    worktreePath,
    'rev-list',
    '--count',
    `${originalHeadCommit}..HEAD`,
  ])
  if (revList.code !== 0) {
    return null
  }
  const commits = parseInt(revList.stdout.trim(), 10) || 0

  return { changedFiles, commits }
}

/**
 * 恢复会话状态以反映原始目录。
 * 这是 EnterWorktreeTool.call() 中会话级改动的逆操作。
 *
 * keepWorktree()/cleanupWorktree() 负责 process.chdir 和 currentWorktreeSession；
 * 此处负责 worktree 工具层之上的所有内容。
 */
function restoreSessionToOriginalCwd(
  originalCwd: string,
  projectRootIsWorktree: boolean,
): void {
  setCwd(originalCwd)
  // EnterWorktree 会把 originalCwd 设为 *worktree* 路径（有意为之——见
  // state.ts 中 getProjectRoot 的注释）。重置为真正的原始值。
  setOriginalCwd(originalCwd)
  // --worktree 启动时会把 projectRoot 设为该 worktree；会话中途的
  // EnterWorktreeTool 则不会。仅在其确实被改动时才恢复——
  // 否则我们会把 projectRoot 移到用户在进入 worktree 之前
  // cd 到的位置（session.originalCwd），破坏“稳定项目
  // 标识”的约定。
  if (projectRootIsWorktree) {
    setProjectRoot(originalCwd)
    // setup.ts 的 --worktree 分支调用了 updateHooksConfigSnapshot() 以重新
    // 从 worktree 读取钩子。此处对称地恢复。（会话中途的
    // EnterWorktreeTool 从未改动该快照，故那里为空操作。）
    updateHooksConfigSnapshot()
  }
  saveWorktreeState(null)
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()
}

export const ExitWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_WORKTREE_TOOL_NAME,
  searchHint: 'exit a worktree session and return to the original directory',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Exits a worktree session created by EnterWorktree and restores the original working directory'
  },
  async prompt() {
    return getExitWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Exiting worktree'
  },
  shouldDefer: true,
  isDestructive(input) {
    return input.action === 'remove'
  },
  toAutoClassifierInput(input) {
    return input.action
  },
  async validateInput(input) {
    // 作用域守卫：除非 EnterWorktree（具体是 createWorktreeForSession）
    // 在本次会话中运行过，否则 getCurrentWorktreeSession() 为 null。由
    // `git worktree add` 创建的，或由之前会话中的 EnterWorktree 创建的
    // worktree 不会填充它。这是唯一的入口门控——此点之后的
    // 一切都作用于 EnterWorktree 创建的路径。
    const session = getCurrentWorktreeSession()
    if (!session) {
      return {
        result: false,
        message:
          'No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made.',
        errorCode: 1,
      }
    }

    if (input.action === 'remove' && !input.discard_changes) {
      const summary = await countWorktreeChanges(
        session.worktreePath,
        session.originalHeadCommit,
      )
      if (summary === null) {
        return {
          result: false,
          message: `Could not verify worktree state at ${session.worktreePath}. Refusing to remove without explicit confirmation. Re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.`,
          errorCode: 3,
        }
      }
      const { changedFiles, commits } = summary
      if (changedFiles > 0 || commits > 0) {
        const parts: string[] = []
        if (changedFiles > 0) {
          parts.push(
            `${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`,
          )
        }
        if (commits > 0) {
          parts.push(
            `${commits} ${commits === 1 ? 'commit' : 'commits'} on ${session.worktreeBranch ?? 'the worktree branch'}`,
          )
        }
        return {
          result: false,
          message: `Worktree has ${parts.join(' and ')}. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
          errorCode: 2,
        }
      }
    }

    return { result: true }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    const session = getCurrentWorktreeSession()
    if (!session) {
      // validateInput 已作防护，但该会话是模块级的可变
      // 状态——需防御校验与执行之间的竞态。
      throw new Error('Not in a worktree session')
    }

    // 在 keepWorktree/cleanupWorktree 将 currentWorktreeSession 置空之前先捕获。
    const {
      originalCwd,
      worktreePath,
      worktreeBranch,
      tmuxSessionName,
      originalHeadCommit,
    } = session

    // --worktree 启动时会在 setCwd(worktreePath) 之后紧接着调用
    // setOriginalCwd(getCwd()) 和 setProjectRoot(getCwd())
    // （setup.ts:235/239），因此两者持有相同的 realpath 值，BashTool
    // 的 cd 也不会触及它们。会话中途的 EnterWorktreeTool 会设置 originalCwd
    // 但不会设置 projectRoot。（不能用 getCwd()——BashTool 每次
    // cd 都会改动它。不能用 session.worktreePath——它是 join() 出来的，未经 realpath。）
    const projectRootIsWorktree = getProjectRoot() === getOriginalCwd()

    // 在执行时重新统计，以获得准确的遥测与输出——validateInput 时的
    // worktree 状态现在可能已不匹配。null（git 失败）会降级为
    // 0/0；安全门控已在 validateInput 中完成，
    // 因此这只影响遥测和消息文案。
    const { changedFiles, commits } = (await countWorktreeChanges(
      worktreePath,
      originalHeadCommit,
    )) ?? { changedFiles: 0, commits: 0 }

    if (input.action === 'keep') {
      await keepWorktree()
      restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree)

      logEvent('limkenion_worktree_kept', {
        mid_session: true,
        commits,
        changed_files: changedFiles,
      })

      const tmuxNote = tmuxSessionName
        ? ` Tmux session ${tmuxSessionName} is still running; reattach with: tmux attach -t ${tmuxSessionName}`
        : ''
      return {
        data: {
          action: 'keep' as const,
          originalCwd,
          worktreePath,
          worktreeBranch,
          tmuxSessionName,
          message: `Exited worktree. Your work is preserved at ${worktreePath}${worktreeBranch ? ` on branch ${worktreeBranch}` : ''}. Session is now back in ${originalCwd}.${tmuxNote}`,
        },
      }
    }

    // action === 'remove'
    if (tmuxSessionName) {
      await killTmuxSession(tmuxSessionName)
    }
    await cleanupWorktree()
    restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree)

    logEvent('limkenion_worktree_removed', {
      mid_session: true,
      commits,
      changed_files: changedFiles,
    })

    const discardParts: string[] = []
    if (commits > 0) {
      discardParts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'}`)
    }
    if (changedFiles > 0) {
      discardParts.push(
        `${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`,
      )
    }
    const discardNote =
      discardParts.length > 0 ? ` Discarded ${discardParts.join(' and ')}.` : ''
    return {
      data: {
        action: 'remove' as const,
        originalCwd,
        worktreePath,
        worktreeBranch,
        discardedFiles: changedFiles,
        discardedCommits: commits,
        message: `Exited and removed worktree at ${worktreePath}.${discardNote} Session is now back in ${originalCwd}.`,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
