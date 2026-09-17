/**
 * 遥传达成的 /ultrareview 执行。用当前仓库创建 CCR 会话，
 * 将审查提示词作为初始消息发送，并注册
 * RemoteAgentTask，让轮询循环通过 task-notification 把结果回传本地
 * 会话。与 /ultraplan → CCR 流程相呼应。
 *
 * TODO(#22051): 待 useBundleMode 落地后传入，以便捕获仅本地/未提交的
 * 仓库状态。GitHub 克隆路径（当前）只适用于已推送的分支，且需在安装了
 * Limkenion GitHub app 的仓库上进行。
 */

import type { ContentBlockParam } from '../../types/llm-protocol.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { fetchUltrareviewQuota } from '../../services/api/ultrareviewQuota.js'
import { fetchUtilization } from '../../services/api/usage.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  checkRemoteAgentEligibility,
  formatPreconditionError,
  getRemoteTaskSessionUrl,
  registerRemoteAgentTask,
} from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import { isEnterpriseSubscriber, isTeamSubscriber } from '../../utils/auth.js'
import { detectCurrentRepositoryWithHost } from '../../utils/detectRepository.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getDefaultBranch, gitExe } from '../../utils/git.js'
import { teleportToRemote } from '../../utils/teleport.js'

// 一次性会话标志：一旦用户通过对话框确认超额计费，
// 本会话中后续所有 /ultrareview 调用将不再重复提示。
let sessionOverageConfirmed = false

export function confirmOverage(): void {
  sessionOverageConfirmed = true
}

export type OverageGate =
  | { kind: 'proceed'; billingNote: string }
  | { kind: 'not-enabled' }
  | { kind: 'low-balance'; available: number }
  | { kind: 'needs-confirm' }

/**
 * 判断用户能否启动 ultrareview 以及适用何种
 * 计费条件。并行获取配额与用量。
 */
export async function checkOverageGate(): Promise<OverageGate> {
  // Team 与 Enterprise 套餐包含 ultrareview——无需免费审查配额
  // 或 Extra Usage 对话框。配额端点只针对消费者套餐
  // （pro/max）；在 team/ent 上调用会弹出令人困惑的对话框。
  if (isTeamSubscriber() || isEnterpriseSubscriber()) {
    return { kind: 'proceed', billingNote: '' }
  }

  const [quota, utilization] = await Promise.all([
    fetchUltrareviewQuota(),
    fetchUtilization().catch(() => null),
  ])

  // 没有配额信息（非订阅用户或端点不可用）——直接放行，
  // 由服务端计费处理。
  if (!quota) {
    return { kind: 'proceed', billingNote: '' }
  }

  if (quota.reviews_remaining > 0) {
    return {
      kind: 'proceed',
      billingNote: ` This is free ultrareview ${quota.reviews_used + 1} of ${quota.reviews_limit}.`,
    }
  }

  // 用量获取失败（瞬时网络错误、超时等）——
  // 直接放行，理由与上方配额回退相同。
  if (!utilization) {
    return { kind: 'proceed', billingNote: '' }
  }

  // 免费审查已耗尽——检查 Extra Usage 设置。
  const extraUsage = utilization.extra_usage
  if (!extraUsage?.is_enabled) {
    logEvent('limkenion_review_overage_not_enabled', {})
    return { kind: 'not-enabled' }
  }

  // 检查可用余额（monthly_limit 为 null 表示不限量）。
  const monthlyLimit = extraUsage.monthly_limit
  const usedCredits = extraUsage.used_credits ?? 0
  const available =
    monthlyLimit === null || monthlyLimit === undefined
      ? Infinity
      : monthlyLimit - usedCredits

  if (available < 10) {
    logEvent('limkenion_review_overage_low_balance', { available })
    return { kind: 'low-balance', available }
  }

  if (!sessionOverageConfirmed) {
    logEvent('limkenion_review_overage_dialog_shown', {})
    return { kind: 'needs-confirm' }
  }

  return {
    kind: 'proceed',
    billingNote: ' This review bills as Extra Usage.',
  }
}

/**
 * 启动遥传达成的审查会话。返回用于注入本地对话的 ContentBlockParam[]，
 * 描述启动结果（随后模型会据此内容被查询，因此它可以向用户叙述启动过程）。
 *
 * 对可恢复的失败（缺少 merge-base、空 diff、包过大），返回带用户可读错误消息的
 * ContentBlockParam[]；对其他失败返回 null，让调用方回退到本地审查提示词。
 * 原因会记录到分析中。
 *
 * 调用方必须先调用 checkOverageGate() 再调用此函数
 * （由 ultrareviewCommand.tsx 处理对话框）。
 */
export async function launchRemoteReview(
  args: string,
  context: ToolUseContext,
  billingNote?: string,
): Promise<ContentBlockParam[] | null> {
  const eligibility = await checkRemoteAgentEligibility()
  // 合成的 DEFAULT_CODE_REVIEW_ENVIRONMENT_ID 无需按组织划分的 CCR
  // 设置即可工作，因此 no_remote_environment 不是阻塞项。服务端配额
  // 在创建会话时扣除计费：前 N 次零费率，其后按
  // limkenion:cccr org-service-key（仅超额）计费。
  if (!eligibility.eligible) {
    const blockers = eligibility.errors.filter(
      e => e.type !== 'no_remote_environment',
    )
    if (blockers.length > 0) {
      logEvent('limkenion_review_remote_precondition_failed', {
        precondition_errors: blockers
          .map(e => e.type)
          .join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const reasons = blockers.map(formatPreconditionError).join('\n')
      return [
        {
          type: 'text',
          text: `Ultrareview 无法启动：\n${reasons}`,
        },
      ]
    }
  }

  const resolvedBillingNote = billingNote ?? ''

  const prNumber = args.trim()
  const isPrNumber = /^\d+$/.test(prNumber)
  // 合成的 code_review 环境。Go 的 taggedid.FromUUID(TagEnvironment,
  // UUID{...,0x02}) 以 '01' 版本前缀编码——不是 Python
  // 的旧式 tagged_id() 格式。已在生产环境验证。
  const CODE_REVIEW_ENV_ID = 'env_011111111111111111111113'
  // Lite-review 完全绕过 bughunter.go，因此它看不到
  // webhook 的 bug_hunter_config（不同的 GB 项目）。这些环境变量是
  // 唯一的调优入口——没有它们，run_hunt.sh 会套用 bash 默认值
  // （60 分钟、120 秒 agent 超时），而 120 秒会在验证器运行中途将其杀掉，
  // 导致无限重生成。
  //
  // total_wallclock 必须保持低于 RemoteAgentTask 的 30 分钟轮询超时，
  // 并为最终化（约 3 分钟合成）留出余量。各字段的守卫
  // 与 autoDream.ts 一致——GB 缓存可能返回过期的错误类型值。
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    unknown
  > | null>('limkenion_review_bughunter_config', null)
  const posInt = (v: unknown, fallback: number, max?: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    const n = Math.floor(v)
    if (n <= 0) return fallback
    return max !== undefined && n > max ? fallback : n
  }
  // 上限：wallclock 27 分钟可为最终化在 RemoteAgentTask 的 30 分钟
  // 轮询超时下留出约 3 分钟。如果 GB 设置超过该值，
  // 我们正在修复的卡死问题会卷土重来——改为回退到安全默认值。
  const commonEnvVars = {
    BUGHUNTER_DRY_RUN: '1',
    BUGHUNTER_FLEET_SIZE: String(posInt(raw?.fleet_size, 5, 20)),
    BUGHUNTER_MAX_DURATION: String(posInt(raw?.max_duration_minutes, 10, 25)),
    BUGHUNTER_AGENT_TIMEOUT: String(
      posInt(raw?.agent_timeout_seconds, 600, 1800),
    ),
    BUGHUNTER_TOTAL_WALLCLOCK: String(
      posInt(raw?.total_wallclock_minutes, 22, 27),
    ),
    ...(process.env.BUGHUNTER_DEV_BUNDLE_B64 && {
      BUGHUNTER_DEV_BUNDLE_B64: process.env.BUGHUNTER_DEV_BUNDLE_B64,
    }),
  }

  let session
  let command
  let target
  if (isPrNumber) {
    // PR 模式：通过 github.com 使用 refs/pull/N/head。编排器为 --pr N。
    const repo = await detectCurrentRepositoryWithHost()
    if (!repo || repo.host !== 'github.com') {
      logEvent('limkenion_review_remote_precondition_failed', {})
      return null
    }
    session = await teleportToRemote({
      initialMessage: null,
      description: `ultrareview: ${repo.owner}/${repo.name}#${prNumber}`,
      signal: context.abortController.signal,
      branchName: `refs/pull/${prNumber}/head`,
      environmentId: CODE_REVIEW_ENV_ID,
      environmentVariables: {
        BUGHUNTER_PR_NUMBER: prNumber,
        BUGHUNTER_REPOSITORY: `${repo.owner}/${repo.name}`,
        ...commonEnvVars,
      },
    })
    command = `/ultrareview ${prNumber}`
    target = `${repo.owner}/${repo.name}#${prNumber}`
  } else {
    // 分支模式：打包工作树，编排器对 fork 点做 diff。
    // 没有 PR、没有既有评论、没有去重。
    const baseBranch = (await getDefaultBranch()) || 'main'
    // 环境管理器的 `git remote remove origin`（在 bundle 克隆之后）
    // 会删除 refs/remotes/origin/*——基础分支名在
    // 容器中无法解析。改传 merge-base SHA：它可从
    // HEAD 的历史到达，因此无需具名 ref 即可执行 `git diff <sha>`。
    const { stdout: mbOut, code: mbCode } = await execFileNoThrow(
      gitExe(),
      ['merge-base', baseBranch, 'HEAD'],
      { preserveOutputOnError: false },
    )
    const mergeBaseSha = mbOut.trim()
    if (mbCode !== 0 || !mergeBaseSha) {
      logEvent('limkenion_review_remote_precondition_failed', {})
      return [
        {
          type: 'text',
          text: `无法与 ${baseBranch} 找到 merge-base。请确保你在一个带 ${baseBranch} 分支的 git 仓库中。`,
        },
      ]
    }

    // 对空 diff 提前返回，而不是启动一个只会回显 "no changes" 的容器。
    const { stdout: diffStat, code: diffCode } = await execFileNoThrow(
      gitExe(),
      ['diff', '--shortstat', mergeBaseSha],
      { preserveOutputOnError: false },
    )
    if (diffCode === 0 && !diffStat.trim()) {
      logEvent('limkenion_review_remote_precondition_failed', {})
      return [
        {
          type: 'text',
          text: `相对于 ${baseBranch} 分支点没有更改。请先提交一些更改或暂存文件。`,
        },
      ]
    }

    session = await teleportToRemote({
      initialMessage: null,
      description: `ultrareview: ${baseBranch}`,
      signal: context.abortController.signal,
      useBundle: true,
      environmentId: CODE_REVIEW_ENV_ID,
      environmentVariables: {
        BUGHUNTER_BASE_BRANCH: mergeBaseSha,
        ...commonEnvVars,
      },
    })
    if (!session) {
      logEvent('limkenion_review_remote_teleport_failed', {})
      return [
        {
          type: 'text',
          text: '仓库太大。请推送一个 PR 并改用 `/ultrareview <PR#>`。',
        },
      ]
    }
    command = '/ultrareview'
    target = baseBranch
  }

  if (!session) {
    logEvent('limkenion_review_remote_teleport_failed', {})
    return null
  }
  registerRemoteAgentTask({
    remoteTaskType: 'ultrareview',
    session,
    command,
    context,
    isRemoteReview: true,
  })
  logEvent('limkenion_review_remote_launched', {})
  const sessionUrl = getRemoteTaskSessionUrl(session.id)
  // 简明扼要——tool 输出块对用户可见，因此模型
  // 不应复述同样的信息。只要足够让 Limkenion 确认
  // 这次启动即可，不必重述目标/URL（两者上面都已打印）。
  return [
    {
      type: 'text',
      text: `Ultrareview 已为 ${target} 启动（约 10–20 分钟，在云端运行）。跟踪：${sessionUrl}${resolvedBillingNote} 发现会通过 task-notification 到达。请向用户简短确认启动，不要重复目标或 URL——两者以上工具输出中均已可见。`,
    },
  ]
}
