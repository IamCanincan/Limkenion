import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { saveGlobalConfig } from 'src/utils/config.js'
import {
  CODE_REVIEW_PLUGIN_WORKFLOW_CONTENT,
  PR_BODY,
  PR_TITLE,
  WORKFLOW_CONTENT,
} from '../../constants/github-app.js'
import { openBrowser } from '../../utils/browser.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { logError } from '../../utils/log.js'
import type { Workflow } from './types.js'

async function createWorkflowFile(
  repoName: string,
  branchName: string,
  workflowPath: string,
  workflowContent: string,
  secretName: string,
  message: string,
  context?: {
    useCurrentRepo?: boolean
    workflowExists?: boolean
    secretExists?: boolean
  },
): Promise<void> {
  // 检查工作流文件是否已存在
  const checkFileResult = await execFileNoThrow('gh', [
    'api',
    `repos/${repoName}/contents/${workflowPath}`,
    '--jq',
    '.sha',
  ])

  let fileSha: string | null = null
  if (checkFileResult.code === 0) {
    fileSha = checkFileResult.stdout.trim()
  }

  let content = workflowContent
  if (secretName === 'LIMKENION_OAUTH_TOKEN') {
    // 对 OAuth 令牌，使用 limkenion_oauth_token 参数
    content = workflowContent.replace(
      /limkenion_api_key: \$\{\{ secrets\.LIMKENION_API_KEY \}\}/g,
      `limkenion_oauth_token: \${{ secrets.LIMKENION_OAUTH_TOKEN }}`,
    )
  } else if (secretName !== 'LIMKENION_API_KEY') {
    // 对其它自定义密钥名，继续使用 limkenion_api_key 参数
    content = workflowContent.replace(
      /limkenion_api_key: \$\{\{ secrets\.LIMKENION_API_KEY \}\}/g,
      `limkenion_api_key: \${{ secrets.${secretName} }}`,
    )
  }
  const base64Content = Buffer.from(content).toString('base64')

  const apiParams = [
    'api',
    '--method',
    'PUT',
    `repos/${repoName}/contents/${workflowPath}`,
    '-f',
    `message=${fileSha ? `"Update ${message}"` : `"${message}"`}`,
    '-f',
    `content=${base64Content}`,
    '-f',
    `branch=${branchName}`,
  ]

  if (fileSha) {
    apiParams.push('-f', `sha=${fileSha}`)
  }

  const createFileResult = await execFileNoThrow('gh', apiParams)
  if (createFileResult.code !== 0) {
    if (
      createFileResult.stderr.includes('422') &&
      createFileResult.stderr.includes('sha')
    ) {
      logEvent('limkenion_setup_github_actions_failed', {
        reason:
          'failed_to_create_workflow_file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: createFileResult.code,
        ...context,
      })
      throw new Error(
        `创建工作流文件 ${workflowPath} 失败：此仓库中已存在一个 Limkenion 工作流文件。请先移除它，或手动更新。`,
      )
    }

    logEvent('limkenion_setup_github_actions_failed', {
      reason:
        'failed_to_create_workflow_file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      exit_code: createFileResult.code,
      ...context,
    })

    const helpText =
      '\n\n需要帮助？常见问题：\n' +
      '· 权限被拒 → 运行：gh auth refresh -h github.com -s repo,workflow\n' +
      '· 未授权 → 确保你对仓库拥有管理员访问权限\n' +
      '· 手动设置 → 访问：https://github.com/limkenions/limkenion-action'

    throw new Error(
      `创建工作流文件 ${workflowPath} 失败：${createFileResult.stderr}${helpText}`,
    )
  }
}

export async function setupGitHubActions(
  repoName: string,
  apiKeyOrOAuthToken: string | null,
  secretName: string,
  updateProgress: () => void,
  skipWorkflow = false,
  selectedWorkflows: Workflow[],
  authType: 'api_key' | 'oauth_token',
  context?: {
    useCurrentRepo?: boolean
    workflowExists?: boolean
    secretExists?: boolean
  },
) {
  try {
    logEvent('limkenion_setup_github_actions_started', {
      skip_workflow: skipWorkflow,
      has_api_key: !!apiKeyOrOAuthToken,
      using_default_secret_name: secretName === 'LIMKENION_API_KEY',
      selected_limkenion_workflow: selectedWorkflows.includes('limkenion'),
      selected_limkenion_review_workflow:
        selectedWorkflows.includes('limkenion-review'),
      ...context,
    })

    // 检查仓库是否存在
    const repoCheckResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}`,
      '--jq',
      '.id',
    ])
    if (repoCheckResult.code !== 0) {
      logEvent('limkenion_setup_github_actions_failed', {
        reason:
          'repo_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: repoCheckResult.code,
        ...context,
      })
      throw new Error(
        `无法访问仓库 ${repoName}：${repoCheckResult.stderr}`,
      )
    }

    // 获取默认分支
    const defaultBranchResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}`,
      '--jq',
      '.default_branch',
    ])
    if (defaultBranchResult.code !== 0) {
      logEvent('limkenion_setup_github_actions_failed', {
        reason:
          'failed_to_get_default_branch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: defaultBranchResult.code,
        ...context,
      })
      throw new Error(
        `无法获取默认分支：${defaultBranchResult.stderr}`,
      )
    }
    const defaultBranch = defaultBranchResult.stdout.trim()

    // 获取默认分支的 SHA
    const shaResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}/git/ref/heads/${defaultBranch}`,
      '--jq',
      '.object.sha',
    ])
    if (shaResult.code !== 0) {
      logEvent('limkenion_setup_github_actions_failed', {
        reason:
          'failed_to_get_branch_sha' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: shaResult.code,
        ...context,
      })
      throw new Error(`无法获取分支 SHA：${shaResult.stderr}`)
    }
    const sha = shaResult.stdout.trim()

    let branchName: string | null = null

    if (!skipWorkflow) {
      updateProgress()
      // 创建新分支
      branchName = `add-limkenion-github-actions-${Date.now()}`
      const createBranchResult = await execFileNoThrow('gh', [
        'api',
        '--method',
        'POST',
        `repos/${repoName}/git/refs`,
        '-f',
        `ref=refs/heads/${branchName}`,
        '-f',
        `sha=${sha}`,
      ])
      if (createBranchResult.code !== 0) {
        logEvent('limkenion_setup_github_actions_failed', {
          reason:
            'failed_to_create_branch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_code: createBranchResult.code,
          ...context,
        })
        throw new Error(`创建分支失败：${createBranchResult.stderr}`)
      }

      updateProgress()
      // 创建所选工作流文件
      const workflows = []

      if (selectedWorkflows.includes('limkenion')) {
        workflows.push({
          path: '.github/workflows/limkenion.yml',
          content: WORKFLOW_CONTENT,
          message: 'Limkenion PR Assistant workflow',
        })
      }

      if (selectedWorkflows.includes('limkenion-review')) {
        workflows.push({
          path: '.github/workflows/limkenion-review.yml',
          content: CODE_REVIEW_PLUGIN_WORKFLOW_CONTENT,
          message: 'Limkenion Review workflow',
        })
      }

      for (const workflow of workflows) {
        await createWorkflowFile(
          repoName,
          branchName,
          workflow.path,
          workflow.content,
          secretName,
          workflow.message,
          context,
        )
      }
    }

    updateProgress()
    // 如果提供了 API 密钥，则作为密钥设置
    if (apiKeyOrOAuthToken) {
      const setSecretResult = await execFileNoThrow('gh', [
        'secret',
        'set',
        secretName,
        '--body',
        apiKeyOrOAuthToken,
        '--repo',
        repoName,
      ])
      if (setSecretResult.code !== 0) {
        logEvent('limkenion_setup_github_actions_failed', {
          reason:
            'failed_to_set_api_key_secret' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_code: setSecretResult.code,
          ...context,
        })

        const helpText =
          '\n\n需要帮助？常见问题：\n' +
          '· 权限被拒 → 运行：gh auth refresh -h github.com -s repo\n' +
          '· 未授权 → 确保你对仓库拥有管理员访问权限\n' +
          '· 手动设置 → 访问：https://github.com/limkenions/limkenion-action'

        throw new Error(
          `设置 API 密钥失败：${setSecretResult.stderr || '未知错误'}${helpText}`,
        )
      }
    }

    if (!skipWorkflow && branchName) {
      updateProgress()
      // 直接创建 PR 模板 URL，而不是直接创建 PR
      const compareUrl = `https://github.com/${repoName}/compare/${defaultBranch}...${branchName}?quick_pull=1&title=${encodeURIComponent(PR_TITLE)}&body=${encodeURIComponent(PR_BODY)}`

      await openBrowser(compareUrl)
    }

    logEvent('limkenion_setup_github_actions_completed', {
      skip_workflow: skipWorkflow,
      has_api_key: !!apiKeyOrOAuthToken,
      auth_type:
        authType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      using_default_secret_name: secretName === 'LIMKENION_API_KEY',
      selected_limkenion_workflow: selectedWorkflows.includes('limkenion'),
      selected_limkenion_review_workflow:
        selectedWorkflows.includes('limkenion-review'),
      ...context,
    })
    saveGlobalConfig(current => ({
      ...current,
      githubActionSetupCount: (current.githubActionSetupCount ?? 0) + 1,
    }))
  } catch (error) {
    if (
      !error ||
      !(error instanceof Error) ||
      !error.message.includes('Failed to')
    ) {
      logEvent('limkenion_setup_github_actions_failed', {
        reason:
          'unexpected_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...context,
      })
    }
    if (error instanceof Error) {
      logError(error)
    }
    throw error
  }
}
