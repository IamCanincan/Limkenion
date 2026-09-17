import { execa } from 'execa';
import React, { useCallback, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { WorkflowMultiselectDialog } from '../../components/WorkflowMultiselectDialog.js';
import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box } from '../../ink.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getLimkenionApiKey } from '../../utils/auth.js';
import { openBrowser } from '../../utils/browser.js';
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';
import { getGithubRepo } from '../../utils/git.js';
import { plural } from '../../utils/stringUtils.js';
import { ApiKeyStep } from './ApiKeyStep.js';
import { CheckExistingSecretStep } from './CheckExistingSecretStep.js';
import { CheckGitHubStep } from './CheckGitHubStep.js';
import { ChooseRepoStep } from './ChooseRepoStep.js';
import { CreatingStep } from './CreatingStep.js';
import { ErrorStep } from './ErrorStep.js';
import { ExistingWorkflowStep } from './ExistingWorkflowStep.js';
import { InstallAppStep } from './InstallAppStep.js';
import { SuccessStep } from './SuccessStep.js';
import { setupGitHubActions } from './setupGitHubActions.js';
import type { State, Warning, Workflow } from './types.js';
import { WarningsStep } from './WarningsStep.js';
const INITIAL_STATE: State = {
  step: 'check-gh',
  selectedRepoName: '',
  currentRepo: '',
  useCurrentRepo: false,
  // 默认为 false，若检测到仓库则设为 true
  apiKeyOrOAuthToken: '',
  useExistingKey: true,
  currentWorkflowInstallStep: 0,
  warnings: [],
  secretExists: false,
  secretName: 'LIMKENION_API_KEY',
  useExistingSecret: true,
  workflowExists: false,
  selectedWorkflows: ['limkenion', 'limkenion-review'] as Workflow[],
  selectedApiKeyOption: 'new' as 'existing' | 'new',
  authType: 'api_key'
};
function InstallGitHubApp(props: {
  onDone: (message: string) => void;
}): React.ReactNode {
  const [existingApiKey] = useState(() => getLimkenionApiKey());
  const [state, setState] = useState({
    ...INITIAL_STATE,
    useExistingKey: !!existingApiKey,
    selectedApiKeyOption: (existingApiKey ? 'existing' : 'new') as 'existing' | 'new'
  });
  useExitOnCtrlCDWithKeybindings();
  React.useEffect(() => {
    logEvent('limkenion_install_github_app_started', {});
  }, []);
  const checkGitHubCLI = useCallback(async () => {
    const warnings: Warning[] = [];

    // 检查是否已安装 gh
    const ghVersionResult = await execa('gh --version', {
      shell: true,
      reject: false
    });
    if (ghVersionResult.exitCode !== 0) {
      warnings.push({
        title: '未找到 GitHub CLI',
        message: 'GitHub CLI（gh）似乎未安装或无法访问。',
        instructions: ['从 https://cli.github.com/ 安装 GitHub CLI', 'macOS：brew install gh', 'Windows：winget install --id GitHub.cli', 'Linux：查看 https://github.com/cli/cli#installation 上的安装说明']
      });
    }

    // 检查认证状态
    const authResult = await execa('gh auth status -a', {
      shell: true,
      reject: false
    });
    if (authResult.exitCode !== 0) {
      warnings.push({
        title: 'GitHub CLI 未登录',
        message: 'GitHub CLI 似乎未登录。',
        instructions: ['运行：gh auth login', '按照提示使用 GitHub 登录', '或使用环境变量或其他方法设置登录认证']
      });
    } else {
      // 检查 Token scopes 行中是否包含所需作用域
      const tokenScopesMatch = authResult.stdout.match(/Token scopes:.*$/m);
      if (tokenScopesMatch) {
        const scopes = tokenScopesMatch[0];
        const missingScopes: string[] = [];
        if (!scopes.includes('repo')) {
          missingScopes.push('repo');
        }
        if (!scopes.includes('workflow')) {
          missingScopes.push('workflow');
        }
        if (missingScopes.length > 0) {
          // 缺少必要作用域 - 立即退出
          setState(prev => ({
            ...prev,
            step: 'error',
            error: `GitHub CLI 缺少必要的权限：${missingScopes.join(', ')}。`,
            errorReason: '缺少必要的作用域',
            errorInstructions: [`你的 GitHub CLI 登录认证缺少管理 GitHub Actions 和 secrets 所需的"${missingScopes.join('"和"')}"${plural(missingScopes.length, 'scope')}。`, '', '要修复此问题，请运行：', '  gh auth refresh -h github.com -s repo,workflow', '', '这将为管理工作流和 secrets 添加所需权限。']
          }));
          return;
        }
      }
    }

    // 检查是否位于 git 仓库中并获取远程 URL
    const currentRepo = (await getGithubRepo()) ?? '';
    logEvent('limkenion_install_github_app_step_completed', {
      step: 'check-gh' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    setState(prev_0 => ({
      ...prev_0,
      warnings,
      currentRepo,
      selectedRepoName: currentRepo,
      useCurrentRepo: !!currentRepo,
      // 若未检测到仓库则设为 false
      step: warnings.length > 0 ? 'warnings' : 'choose-repo'
    }));
  }, []);
  React.useEffect(() => {
    if (state.step === 'check-gh') {
      void checkGitHubCLI();
    }
  }, [state.step, checkGitHubCLI]);
  const runSetupGitHubActions = useCallback(async (apiKeyOrOAuthToken: string | null, secretName: string) => {
    setState(prev_1 => ({
      ...prev_1,
      step: 'creating',
      currentWorkflowInstallStep: 0
    }));
    try {
      await setupGitHubActions(state.selectedRepoName, apiKeyOrOAuthToken, secretName, () => {
        setState(prev_4 => ({
          ...prev_4,
          currentWorkflowInstallStep: prev_4.currentWorkflowInstallStep + 1
        }));
      }, state.workflowAction === 'skip', state.selectedWorkflows, state.authType, {
        useCurrentRepo: state.useCurrentRepo,
        workflowExists: state.workflowExists,
        secretExists: state.secretExists
      });
      logEvent('limkenion_install_github_app_step_completed', {
        step: 'creating' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      setState(prev_5 => ({
        ...prev_5,
        step: 'success'
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '设置 GitHub Actions 失败';
      if (errorMessage.includes('workflow file already exists')) {
        logEvent('limkenion_install_github_app_error', {
          reason: 'workflow_file_exists' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        setState(prev_2 => ({
          ...prev_2,
          step: 'error',
          error: '此仓库中已存在 Limkenion 工作流文件。',
          errorReason: '工作流文件冲突',
          errorInstructions: ['文件 .github/workflows/limkenion.yml 已存在', '你可以选择：', '  1. 删除现有文件并重新运行此命令', '  2. 使用模板手动更新现有文件，模板来自：', `     ${GITHUB_ACTION_SETUP_DOCS_URL}`]
        }));
      } else {
        logEvent('limkenion_install_github_app_error', {
          reason: 'setup_github_actions_failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        setState(prev_3 => ({
          ...prev_3,
          step: 'error',
          error: errorMessage,
          errorReason: 'GitHub Actions 设置失败',
          errorInstructions: []
        }));
      }
    }
  }, [state.selectedRepoName, state.workflowAction, state.selectedWorkflows, state.useCurrentRepo, state.workflowExists, state.secretExists, state.authType]);
  async function openGitHubAppInstallation() {
    const installUrl = '';
    await openBrowser(installUrl);
  }
  async function checkRepositoryPermissions(repoName: string): Promise<{
    hasAccess: boolean;
    error?: string;
  }> {
    try {
      const result = await execFileNoThrow('gh', ['api', `repos/${repoName}`, '--jq', '.permissions.admin']);
      if (result.code === 0) {
        const hasAdmin = result.stdout.trim() === 'true';
        return {
          hasAccess: hasAdmin
        };
      }
      if (result.stderr.includes('404') || result.stderr.includes('Not Found')) {
        return {
          hasAccess: false,
          error: 'repository_not_found'
        };
      }
      return {
        hasAccess: false
      };
    } catch {
      return {
        hasAccess: false
      };
    }
  }
  async function checkExistingWorkflowFile(repoName_0: string): Promise<boolean> {
    const checkFileResult = await execFileNoThrow('gh', ['api', `repos/${repoName_0}/contents/.github/workflows/limkenion.yml`, '--jq', '.sha']);
    return checkFileResult.code === 0;
  }
  async function checkExistingSecret() {
    const checkSecretsResult = await execFileNoThrow('gh', ['secret', 'list', '--app', 'actions', '--repo', state.selectedRepoName]);
    if (checkSecretsResult.code === 0) {
      const lines = checkSecretsResult.stdout.split('\n');
      const hasLimkenionKey = lines.some((line: string) => {
        return /^LIMKENION_API_KEY\s+/.test(line);
      });
      if (hasLimkenionKey) {
        setState(prev_6 => ({
          ...prev_6,
          secretExists: true,
          step: 'check-existing-secret'
        }));
      } else {
        // 未找到现有 secret
        if (existingApiKey) {
          // 用户有本地密钥，使用它直接进入创建流程
          setState(prev_7 => ({
            ...prev_7,
            apiKeyOrOAuthToken: existingApiKey,
            useExistingKey: true
          }));
          await runSetupGitHubActions(existingApiKey, state.secretName);
        } else {
          // 无本地密钥，进入 API 密钥步骤
          setState(prev_8 => ({
            ...prev_8,
            step: 'api-key'
          }));
        }
      }
    } else {
      // 检查 secrets 时出错
      if (existingApiKey) {
        // 用户有本地密钥，使用它直接进入创建流程
        setState(prev_9 => ({
          ...prev_9,
          apiKeyOrOAuthToken: existingApiKey,
          useExistingKey: true
        }));
        await runSetupGitHubActions(existingApiKey, state.secretName);
      } else {
        // 无本地密钥，进入 API 密钥步骤
        setState(prev_10 => ({
          ...prev_10,
          step: 'api-key'
        }));
      }
    }
  }
  const handleSubmit = async () => {
    if (state.step === 'warnings') {
      logEvent('limkenion_install_github_app_step_completed', {
        step: 'warnings' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      setState(prev_11 => ({
        ...prev_11,
        step: 'install-app'
      }));
      setTimeout(openGitHubAppInstallation, 0);
    } else if (state.step === 'choose-repo') {
      let repoName_1 = state.useCurrentRepo ? state.currentRepo : state.selectedRepoName;
      if (!repoName_1.trim()) {
        return;
      }
      const repoWarnings: Warning[] = [];
      if (repoName_1.includes('github.com')) {
        const match = repoName_1.match(/github\.com[:/]([^/]+\/[^/]+)(\.git)?$/);
        if (!match) {
          repoWarnings.push({
            title: 'GitHub URL 格式无效',
            message: '仓库 URL 格式似乎无效。',
            instructions: ['使用格式：owner/repo 或 https://github.com/owner/repo', '示例：limkenions/limkenion-cli']
          });
        } else {
          repoName_1 = match[1]?.replace(/\.git$/, '') || '';
        }
      }
      if (!repoName_1.includes('/')) {
        repoWarnings.push({
          title: '仓库格式警告',
          message: '仓库应采用 "owner/repo" 格式',
          instructions: ['使用格式：owner/repo', '示例：limkenions/limkenion-cli']
        });
      }
      const permissionCheck = await checkRepositoryPermissions(repoName_1);
      if (permissionCheck.error === 'repository_not_found') {
        repoWarnings.push({
          title: '仓库不存在',
          message: `未找到仓库 ${repoName_1}，或你没有访问权限。`,
          instructions: [`请确认仓库名称是否正确：${repoName_1}`, '请确保你有权访问此仓库', '对于私有仓库，请确保你的 GitHub token 具有 "repo" 作用域', '你可以通过以下命令添加 repo 作用域：gh auth refresh -h github.com -s repo,workflow']
        });
      } else if (!permissionCheck.hasAccess) {
        repoWarnings.push({
          title: '需要管理员权限',
          message: `你或许需要 ${repoName_1} 的管理员权限才能设置 GitHub Actions。`,
          instructions: ['仓库管理员可以安装 GitHub Apps 并设置 secrets', '如果设置失败，请让仓库管理员运行此命令', '此外，你也可以查看手动设置说明']
        });
      }
      const workflowExists = await checkExistingWorkflowFile(repoName_1);
      if (repoWarnings.length > 0) {
        const allWarnings = [...state.warnings, ...repoWarnings];
        setState(prev_12 => ({
          ...prev_12,
          selectedRepoName: repoName_1,
          workflowExists,
          warnings: allWarnings,
          step: 'warnings'
        }));
      } else {
        logEvent('limkenion_install_github_app_step_completed', {
          step: 'choose-repo' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        setState(prev_13 => ({
          ...prev_13,
          selectedRepoName: repoName_1,
          workflowExists,
          step: 'install-app'
        }));
        setTimeout(openGitHubAppInstallation, 0);
      }
    } else if (state.step === 'install-app') {
      logEvent('limkenion_install_github_app_step_completed', {
        step: 'install-app' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      if (state.workflowExists) {
        setState(prev_14 => ({
          ...prev_14,
          step: 'check-existing-workflow'
        }));
      } else {
        setState(prev_15 => ({
          ...prev_15,
          step: 'select-workflows'
        }));
      }
    } else if (state.step === 'check-existing-workflow') {
      return;
    } else if (state.step === 'select-workflows') {
      // 由 WorkflowMultiselectDialog 组件处理
      return;
    } else if (state.step === 'check-existing-secret') {
      logEvent('limkenion_install_github_app_step_completed', {
        step: 'check-existing-secret' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      if (state.useExistingSecret) {
        await runSetupGitHubActions(null, state.secretName);
      } else {
        // 用户希望使用新 secret 名称配合其 API 密钥
        await runSetupGitHubActions(state.apiKeyOrOAuthToken, state.secretName);
      }
    } else if (state.step === 'api-key') {
      // 在此新流程中，仅当用户没有现有密钥时才出现 api-key 步骤
      // 使用 API 密钥（现有或新输入的）

      // 如果用户选择 'existing' 选项，则使用现有的 API 密钥
      const apiKeyToUse = state.selectedApiKeyOption === 'existing' ? existingApiKey : state.apiKeyOrOAuthToken;
      if (!apiKeyToUse) {
        logEvent('limkenion_install_github_app_error', {
          reason: 'api_key_missing' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        setState(prev_16 => ({
          ...prev_16,
          step: 'error',
          error: '需要 API 密钥'
        }));
        return;
      }

      // 存储正在使用的 API 密钥（现有或新输入的）
      setState(prev_17 => ({
        ...prev_17,
        apiKeyOrOAuthToken: apiKeyToUse,
        useExistingKey: state.selectedApiKeyOption === 'existing'
      }));

      // 检查 LIMKENION_API_KEY secret 是否已存在
      const checkSecretsResult_0 = await execFileNoThrow('gh', ['secret', 'list', '--app', 'actions', '--repo', state.selectedRepoName]);
      if (checkSecretsResult_0.code === 0) {
        const lines_0 = checkSecretsResult_0.stdout.split('\n');
        const hasLimkenionKey_0 = lines_0.some((line_0: string) => {
          return /^LIMKENION_API_KEY\s+/.test(line_0);
        });
        if (hasLimkenionKey_0) {
          logEvent('limkenion_install_github_app_step_completed', {
            step: 'api-key' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          setState(prev_18 => ({
            ...prev_18,
            secretExists: true,
            step: 'check-existing-secret'
          }));
        } else {
          logEvent('limkenion_install_github_app_step_completed', {
            step: 'api-key' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          // 无现有 secret，继续进入创建流程
          await runSetupGitHubActions(apiKeyToUse, state.secretName);
        }
      } else {
        logEvent('limkenion_install_github_app_step_completed', {
          step: 'api-key' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        // 检查 secrets 时出错，无论如何继续
        await runSetupGitHubActions(apiKeyToUse, state.secretName);
      }
    }
  };
  const handleRepoUrlChange = (value: string) => {
    setState(prev_19 => ({
      ...prev_19,
      selectedRepoName: value
    }));
  };
  const handleApiKeyChange = (value_0: string) => {
    setState(prev_20 => ({
      ...prev_20,
      apiKeyOrOAuthToken: value_0
    }));
  };
  const handleApiKeyOptionChange = (option: 'existing' | 'new') => {
    setState(prev_21 => ({
      ...prev_21,
      selectedApiKeyOption: option
    }));
  };
  const handleSecretNameChange = (value_1: string) => {
    if (value_1 && !/^[a-zA-Z0-9_]+$/.test(value_1)) return;
    setState(prev_25 => ({
      ...prev_25,
      secretName: value_1
    }));
  };
  const handleToggleUseCurrentRepo = (useCurrentRepo: boolean) => {
    setState(prev_26 => ({
      ...prev_26,
      useCurrentRepo,
      selectedRepoName: useCurrentRepo ? prev_26.currentRepo : ''
    }));
  };
  const handleToggleUseExistingKey = (useExistingKey: boolean) => {
    setState(prev_27 => ({
      ...prev_27,
      useExistingKey
    }));
  };
  const handleToggleUseExistingSecret = (useExistingSecret: boolean) => {
    setState(prev_28 => ({
      ...prev_28,
      useExistingSecret,
      secretName: useExistingSecret ? 'LIMKENION_API_KEY' : ''
    }));
  };
  const handleWorkflowAction = async (action: 'update' | 'skip' | 'exit') => {
    if (action === 'exit') {
      props.onDone('安装已被用户取消');
      return;
    }
    logEvent('limkenion_install_github_app_step_completed', {
      step: 'check-existing-workflow' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    setState(prev_29 => ({
      ...prev_29,
      workflowAction: action
    }));
    if (action === 'skip' || action === 'update') {
      // 检查用户是否已有本地 API 密钥
      if (existingApiKey) {
        await checkExistingSecret();
      } else {
        // 无本地密钥，直接进入 API 密钥步骤
        setState(prev_30 => ({
          ...prev_30,
          step: 'api-key'
        }));
      }
    }
  };
  function handleDismissKeyDown(e: KeyboardEvent): void {
    e.preventDefault();
    if (state.step === 'success') {
      logEvent('limkenion_install_github_app_completed', {});
    }
    props.onDone(state.step === 'success' ? 'GitHub Actions 设置完成！' : state.error ? `无法安装 GitHub App：${state.error}\n如需手动设置说明，请查看：${GITHUB_ACTION_SETUP_DOCS_URL}` : `GitHub App 安装失败\n如需手动设置说明，请查看：${GITHUB_ACTION_SETUP_DOCS_URL}`);
  }
  switch (state.step) {
    case 'check-gh':
      return <CheckGitHubStep />;
    case 'warnings':
      return <WarningsStep warnings={state.warnings} onContinue={handleSubmit} />;
    case 'choose-repo':
      return <ChooseRepoStep currentRepo={state.currentRepo} useCurrentRepo={state.useCurrentRepo} repoUrl={state.selectedRepoName} onRepoUrlChange={handleRepoUrlChange} onToggleUseCurrentRepo={handleToggleUseCurrentRepo} onSubmit={handleSubmit} />;
    case 'install-app':
      return <InstallAppStep repoUrl={state.selectedRepoName} onSubmit={handleSubmit} />;
    case 'check-existing-workflow':
      return <ExistingWorkflowStep repoName={state.selectedRepoName} onSelectAction={handleWorkflowAction} />;
    case 'check-existing-secret':
      return <CheckExistingSecretStep useExistingSecret={state.useExistingSecret} secretName={state.secretName} onToggleUseExistingSecret={handleToggleUseExistingSecret} onSecretNameChange={handleSecretNameChange} onSubmit={handleSubmit} />;
    case 'api-key':
      return <ApiKeyStep existingApiKey={existingApiKey} useExistingKey={state.useExistingKey} apiKeyOrOAuthToken={state.apiKeyOrOAuthToken} onApiKeyChange={handleApiKeyChange} onToggleUseExistingKey={handleToggleUseExistingKey} onSubmit={handleSubmit} selectedOption={state.selectedApiKeyOption} onSelectOption={handleApiKeyOptionChange} />;
    case 'creating':
      return <CreatingStep currentWorkflowInstallStep={state.currentWorkflowInstallStep} secretExists={state.secretExists} useExistingSecret={state.useExistingSecret} secretName={state.secretName} skipWorkflow={state.workflowAction === 'skip'} selectedWorkflows={state.selectedWorkflows} />;
    case 'success':
      return <Box tabIndex={0} autoFocus onKeyDown={handleDismissKeyDown}>
          <SuccessStep secretExists={state.secretExists} useExistingSecret={state.useExistingSecret} secretName={state.secretName} skipWorkflow={state.workflowAction === 'skip'} />
        </Box>;
    case 'error':
      return <Box tabIndex={0} autoFocus onKeyDown={handleDismissKeyDown}>
          <ErrorStep error={state.error} errorReason={state.errorReason} errorInstructions={state.errorInstructions} />
        </Box>;
    case 'select-workflows':
      return <WorkflowMultiselectDialog defaultSelections={state.selectedWorkflows} onSubmit={selectedWorkflows => {
        logEvent('limkenion_install_github_app_step_completed', {
          step: 'select-workflows' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        setState(prev_31 => ({
          ...prev_31,
          selectedWorkflows
        }));
        // 检查用户是否已有本地 API 密钥
        if (existingApiKey) {
          void checkExistingSecret();
        } else {
          // 无本地密钥，直接进入 API 密钥步骤
          setState(prev_32 => ({
            ...prev_32,
            step: 'api-key'
          }));
        }
      }} />;
  }
}
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <InstallGitHubApp onDone={onDone} />;
}