import axios from 'axios'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../../services/analytics/growthbook.js'
import {
  ensureLocalAuthAvailable,
  getLimkenionAIOAuthTokens,
  isLimkenionAISubscriber,
} from '../../auth.js'
import { getCwd } from '../../cwd.js'
import { logForDebugging } from '../../debug.js'
import { detectCurrentRepository } from '../../detectRepository.js'
import { errorMessage } from '../../errors.js'
import { findGitRoot, getIsClean } from '../../git.js'
import { getOAuthHeaders } from '../../teleport/api.js'
import { fetchEnvironments } from '../../teleport/environments.js'

/**
 * 检查用户是否需要用 Limkenion.ai 登录
 * 从 TeleportError.tsx 的 getTeleportErrors() 中提取
 * @returns 需要登录返回 true，否则返回 false
 */
export async function checkNeedsLimkenionAiLogin(): Promise<boolean> {
  if (!isLimkenionAISubscriber()) {
    return false
  }
  return ensureLocalAuthAvailable()
}

/**
 * 检查 git 工作目录是否干净（无未提交更改）
 * 忽略未跟踪文件，因为切换分支时它们不会丢失
 * 从 TeleportError.tsx 的 getTeleportErrors() 中提取
 * @returns git 干净返回 true，否则返回 false
 */
export async function checkIsGitClean(): Promise<boolean> {
  const isClean = await getIsClean({ ignoreUntracked: true })
  return isClean
}

/**
 * 检查用户是否至少可访问一个远程环境
 * @returns 有远程环境则返回 true，否则返回 false
 */
export async function checkHasRemoteEnvironment(): Promise<boolean> {
  try {
    const environments = await fetchEnvironments()
    return environments.length > 0
  } catch (error) {
    logForDebugging(`checkHasRemoteEnvironment 失败：${errorMessage(error)}`)
    return false
  }
}

/**
 * 检查当前目录是否位于 git 仓库内（存在 .git/）。
 * 与 checkHasGitRemote 不同——仅本地仓库可通过此检查但无法通过那个。
 */
export function checkIsInGitRepo(): boolean {
  return findGitRoot(getCwd()) !== null
}

/**
 * 检查当前仓库是否配置了 GitHub 远程。
 * 仅本地仓库（git init 且无 `origin`）返回 false。
 */
export async function checkHasGitRemote(): Promise<boolean> {
  const repository = await detectCurrentRepository()
  return repository !== null
}

/**
 * 检查特定仓库上是否安装了 GitHub 应用
 * @param owner 仓库所有者（如 "limkenions"）
 * @param repo 仓库名（如 "limkenion-cli-internal"）
 * @returns 已安装返回 true，否则返回 false
 */
export async function checkGithubAppInstalled(
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const accessToken = getLimkenionAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logForDebugging(
        'checkGithubAppInstalled: 未找到访问令牌，假定应用未安装',
      )
      return false
    }

    // Limkenion 无远程账号/OAuth 档案，无组织 UUID 可取。
    const orgUUID = null
    if (!orgUUID) {
      logForDebugging(
        'checkGithubAppInstalled: 未找到组织 UUID，假定应用未安装',
      )
      return false
    }

    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/code/repos/${owner}/${repo}`
    const headers = {
      ...getOAuthHeaders(accessToken),
      'x-organization-uuid': orgUUID,
    }

    logForDebugging(`正在检查 ${owner}/${repo} 上的 GitHub 应用安装情况`)

    const response = await axios.get<{
      repo: {
        name: string
        owner: { login: string }
        default_branch: string
      }
      status: {
        app_installed: boolean
        relay_enabled: boolean
      } | null
    }>(url, {
      headers,
      timeout: 15000,
      signal,
    })

    if (response.status === 200) {
      if (response.data.status) {
        const installed = response.data.status.app_installed
        logForDebugging(
          `GitHub 应用${installed ? '已' : '未'}安装于 ${owner}/${repo}`,
        )
        return installed
      }
      // status 为 null——应用未安装在此仓库
      logForDebugging(
        `GitHub 应用未安装于 ${owner}/${repo}（status 为 null）`,
      )
      return false
    }

    logForDebugging(
      `checkGithubAppInstalled: 意外的响应状态 ${response.status}`,
    )
    return false
  } catch (error) {
    // 4XX 错误通常表示应用未安装或仓库不可访问
    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      if (status && status >= 400 && status < 500) {
        logForDebugging(
          `checkGithubAppInstalled: 收到 ${status} 错误，应用很可能未安装于 ${owner}/${repo}`,
        )
        return false
      }
    }

    logForDebugging(`checkGithubAppInstalled 错误：${errorMessage(error)}`)
    return false
  }
}

/**
 * 检查用户是否已通过 /web-setup 同步其 GitHub 凭据
 * @returns 已同步返回 true，否则返回 false
 */
export async function checkGithubTokenSynced(): Promise<boolean> {
  try {
    const accessToken = getLimkenionAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logForDebugging('checkGithubTokenSynced: 未找到访问令牌')
      return false
    }

    // Limkenion 无远程账号/OAuth 档案，无组织 UUID 可取。
    const orgUUID = null
    if (!orgUUID) {
      logForDebugging('checkGithubTokenSynced: 未找到组织 UUID')
      return false
    }

    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/sync/github/auth`
    const headers = {
      ...getOAuthHeaders(accessToken),
      'x-organization-uuid': orgUUID,
    }

    logForDebugging('正在检查 GitHub 令牌是否已通过 web-setup 同步')

    const response = await axios.get(url, {
      headers,
      timeout: 15000,
    })

    const synced =
      response.status === 200 && response.data?.is_authenticated === true
    logForDebugging(
      `GitHub 令牌同步：${synced}（status=${response.status}，data=${JSON.stringify(response.data)}）`,
    )
    return synced
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      if (status && status >= 400 && status < 500) {
        logForDebugging(
          `checkGithubTokenSynced: 收到 ${status}，令牌未同步`,
        )
        return false
      }
    }

    logForDebugging(`checkGithubTokenSynced 错误：${errorMessage(error)}`)
    return false
  }
}

type RepoAccessMethod = 'github-app' | 'token-sync' | 'none'

/**
 * 分层检查某 GitHub 仓库是否可用于远程操作。
 * 1. 仓库上安装了 GitHub 应用
 * 2. 通过 /web-setup 同步了 GitHub 令牌
 * 3. 两者皆无——调用方应提示用户设置访问权限
 */
export async function checkRepoForRemoteAccess(
  owner: string,
  repo: string,
): Promise<{ hasAccess: boolean; method: RepoAccessMethod }> {
  if (await checkGithubAppInstalled(owner, repo)) {
    return { hasAccess: true, method: 'github-app' }
  }
  if (
    getFeatureValue_CACHED_MAY_BE_STALE('limkenion_cobalt_lantern', false) &&
    (await checkGithubTokenSynced())
  ) {
    return { hasAccess: true, method: 'token-sync' }
  }
  return { hasAccess: false, method: 'none' }
}
