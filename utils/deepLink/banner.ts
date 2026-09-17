/**
 * 深度链接来源横幅
 *
 * 构建当会话由外部的 limkenion-cli:// 深度链接打开时显示的警告文本。
 * Linux xdg-open 和设置了"始终允许"的浏览器会不经 OS 层确认直接分发
 * 链接，因此应用程序提供自己的来源信号——镜像 limkenion.ai 对外部来源
 * 预填内容的安全插页。
 *
 * 用户必须按 Enter 才能提交；此横幅提示他们阅读 prompt（可能用同形字或
 * 填充隐藏指令），并注意加载的是哪个目录——从而知道哪份 LIMKENION.md
 * 被加载。
 */

import { stat } from 'fs/promises'
import { homedir } from 'os'
import { join, sep } from 'path'
import { formatNumber, formatRelativeTimeAgo } from '../format.js'
import { getCommonDir } from '../git/gitFilesystem.js'
import { getGitDir } from '../git.js'

const STALE_FETCH_WARN_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 超过此长度时，预填的 prompt 不再适合单屏显示
 * （80 列终端上约 12-15 行）。横幅从"仔细审阅"切换为明确的
 * "滚动以审阅整个 prompt"，使埋在 60 行之后的恶意尾部不会悄悄
 * 落到屏幕之外。
 */
const LONG_PREFILL_THRESHOLD = 1000

export type DeepLinkBannerInfo = {
  /** 会话启动时解析得到的工作目录。 */
  cwd: string
  /** 输入框中预填的 ?q= prompt 长度。Undefined = 无预填。 */
  prefillLength?: number
  /** 若 cwd 是从 githubRepoPaths MRU 解析的，则为 ?repo= 短名。 */
  repo?: string
  /** 仓库的上次拉取时间戳（FETCH_HEAD mtime）。Undefined = 从未拉取或非 git 仓库。 */
  lastFetch?: Date
}

/**
 * 为深度链接来源的会话构建多行警告横幅。
 *
 * 始终显示工作目录，使用户能知道将加载哪份 LIMKENION.md。当链接预填了
 * prompt 时，追加第二行提示用户审阅它——prompt 本身在输入框中可见。
 *
 * 当 cwd 由 ?repo= 短名解析而来时，还显示短名和克隆的上次拉取年龄，
 * 使用户知道选择了哪个本地克隆，以及其 LIMKENION.md 相对于上游是否
 * 可能过期。
 */
export function buildDeepLinkBanner(info: DeepLinkBannerInfo): string {
  const lines = [
    `此会话由 ${tildify(info.cwd)} 中的外部深度链接打开`,
  ]
  if (info.repo) {
    const age = info.lastFetch ? formatRelativeTimeAgo(info.lastFetch) : 'never'
    const stale =
      !info.lastFetch ||
      Date.now() - info.lastFetch.getTime() > STALE_FETCH_WARN_MS
    lines.push(
      `从本地克隆解析到 ${info.repo} · 上次拉取 ${age}${stale ? ' — LIMKENION.md 可能已过期' : ''}`,
    )
  }
  if (info.prefillLength) {
    lines.push(
      info.prefillLength > LONG_PREFILL_THRESHOLD
        ? `下面的 prompt（${formatNumber(info.prefillLength)} 字符）由链接提供 — 按 Enter 前请滚动审阅整个 prompt。`
        : '下面的 prompt 由链接提供 — 按 Enter 前请仔细审阅。',
    )
  }
  return lines.join('\n')
}

/**
 * 读取 .git/FETCH_HEAD 的 mtime，git 在每次 fetch 或 pull 时更新它。
 * 若目录不是 git 仓库或从未拉取过则返回 undefined。
 *
 * FETCH_HEAD 是每工作树（worktree）的——从主工作树拉取不会触及兄弟
 * 工作树的 FETCH_HEAD。当 cwd 是工作树时，我们两者都检查并返回较新的，
 * 这样最近拉取过的主仓库不会仅仅因为深度链接落在工作树里就被读作
 * "从未拉取"。
 */
export async function readLastFetchTime(
  cwd: string,
): Promise<Date | undefined> {
  const gitDir = await getGitDir(cwd)
  if (!gitDir) return undefined
  const commonDir = await getCommonDir(gitDir)
  const [local, common] = await Promise.all([
    mtimeOrUndefined(join(gitDir, 'FETCH_HEAD')),
    commonDir
      ? mtimeOrUndefined(join(commonDir, 'FETCH_HEAD'))
      : Promise.resolve(undefined),
  ])
  if (local && common) return local > common ? local : common
  return local ?? common
}

async function mtimeOrUndefined(p: string): Promise<Date | undefined> {
  try {
    const { mtime } = await stat(p)
    return mtime
  } catch {
    return undefined
  }
}

/**
 * 把以 home 目录为前缀的路径缩短为用于横幅的 ~ 记法。
 * 不使用 getDisplayPath()，因为 cwd 是当前工作目录，
 * 相对路径分支会把其折叠为空字符串。
 */
function tildify(p: string): string {
  const home = homedir()
  if (p === home) return '~'
  if (p.startsWith(home + sep)) return '~' + p.slice(home.length)
  return p
}
