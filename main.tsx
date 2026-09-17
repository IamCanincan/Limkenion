// 这些副作用必须先于所有其他 import 运行：
// 1. profileCheckpoint 在大量模块求值开始前标记入口
// 2. startMdmRawRead 触发 MDM 子进程（plutil/reg query），使其与下面剩余的
//    约 135ms 的 import 并行执行
// 3. startKeychainPrefetch 并行触发两次 macOS 钥匙串读取（OAuth + 旧版 API
//    密钥）——否则 isRemoteManagedSettingsEligible() 会在
//    applySafeConfigEnvironmentVariables() 内部通过同步 spawn 依次读取
//    （每次 macOS 启动约 65ms）
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_entry');
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startMdmRawRead();
import { ensureKeychainPrefetchCompleted, startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startKeychainPrefetch();
import { feature } from 'bun:bundle';
import { Command as CommanderCommand, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import mapValues from 'lodash-es/mapValues.js';
import pickBy from 'lodash-es/pickBy.js';
import uniqBy from 'lodash-es/uniqBy.js';
import React from 'react';
import { getOauthConfig } from './constants/oauth.js';
import { getSystemContext, getUserContext } from './context.js';
import { init, initializeTelemetryAfterTrust } from './entrypoints/init.js';
import { addToHistory } from './history.js';
import type { Root } from './ink.js';
import { launchRepl } from './replLauncher.js';
import { hasGrowthBookEnvOverride, initializeGrowthBook, refreshGrowthBookAfterAuthChange } from './services/analytics/growthbook.js';
import { fetchBootstrapData } from './services/api/bootstrap.js';
import { type DownloadResult, downloadSessionFiles, type FilesApiConfig, parseFileSpecs } from './services/api/filesApi.js';
import { prefetchPassesEligibility } from './services/api/referral.js';
import { prefetchOfficialMcpUrls } from './services/mcp/officialRegistry.js';
import type { McpSdkServerConfig, McpServerConfig, ScopedMcpServerConfig } from './services/mcp/types.js';
import { isPolicyAllowed, loadPolicyLimits, refreshPolicyLimits, waitForPolicyLimitsToLoad } from './services/policyLimits/index.js';
import { loadRemoteManagedSettings, refreshRemoteManagedSettings } from './services/remoteManagedSettings/index.js';
import type { ToolInputJSONSchema } from './Tool.js';
import { createSyntheticOutputTool, isSyntheticOutputToolEnabled } from './tools/SyntheticOutputTool/SyntheticOutputTool.js';
import { getTools } from './tools.js';
import { canUserConfigureAdvisor, getInitialAdvisorSetting, isAdvisorEnabled, isValidAdvisorModel, modelSupportsAdvisor } from './utils/advisor.js';
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js';
import { count, uniq } from './utils/array.js';
import { installAsciicastRecorder } from './utils/asciicast.js';
import { getSubscriptionType, isLimkenionAISubscriber, prefetchAwsCredentialsAndBedRockInfoIfSafe, prefetchGcpCredentialsIfSafe, validateForceLoginOrg } from './utils/auth.js';
import { checkHasTrustDialogAccepted, getGlobalConfig, getRemoteControlAtStartup, isAutoUpdaterDisabled, saveGlobalConfig } from './utils/config.js';
import { seedEarlyInput, stopCapturingEarlyInput } from './utils/earlyInput.js';
import { getInitialEffortSetting, parseEffortValue } from './utils/effort.js';
import { getInitialFastModeSetting, isFastModeEnabled, prefetchFastModeStatus, resolveFastModeStatusFromCache } from './utils/fastMode.js';
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js';
import { createSystemMessage, createUserMessage } from './utils/messages.js';
import { getPlatform } from './utils/platform.js';
import { getBaseRenderOptions } from './utils/renderOptions.js';
import { getSessionIngressAuthToken } from './utils/sessionIngressAuth.js';
import { settingsChangeDetector } from './utils/settings/changeDetector.js';
import { skillChangeDetector } from './utils/skills/skillChangeDetector.js';
import { jsonParse, writeFileSync_DEPRECATED } from './utils/slowOperations.js';
import { computeInitialTeamContext } from './utils/swarm/reconnection.js';
import { initializeWarningHandler } from './utils/warningHandler.js';
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js';

// 延迟 require 以避免循环依赖：teammate.ts -> AppState.tsx -> ... -> main.tsx
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeammateUtils = () => require('./utils/teammate.js') as typeof import('./utils/teammate.js');
const getTeammatePromptAddendum = () => require('./utils/swarm/teammatePromptAddendum.js') as typeof import('./utils/swarm/teammatePromptAddendum.js');
const getTeammateModeSnapshot = () => require('./utils/swarm/backends/teammateModeSnapshot.js') as typeof import('./utils/swarm/backends/teammateModeSnapshot.js');
/* eslint-enable @typescript-eslint/no-require-imports */
// 死代码消除：COORDINATOR_MODE 的条件 import
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE') ? require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
// 死代码消除：KAIROS（助手模式）的条件 import
/* eslint-disable @typescript-eslint/no-require-imports */
const assistantModule = feature('KAIROS') ? require('./assistant/index.js') as typeof import('./assistant/index.js') : null;
const kairosGate = feature('KAIROS') ? require('./assistant/gate.js') as typeof import('./assistant/gate.js') : null;
import { relative, resolve } from 'path';
import { isAnalyticsDisabled } from 'src/services/analytics/config.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { initializeAnalyticsGates } from 'src/services/analytics/sink.js';
import { getOriginalCwd, setAdditionalDirectoriesForLimkenionMd, setIsRemoteMode, setMainLoopModelOverride, setMainThreadAgentType, setTeleportedSessionInfo } from './bootstrap/state.js';
import { filterCommandsForRemoteMode, getCommands } from './commands.js';
import type { StatsStore } from './context/stats.js';
import { launchAssistantInstallWizard, launchAssistantSessionChooser, launchInvalidSettingsDialog, launchResumeChooser, launchSnapshotUpdateDialog, launchTeleportRepoMismatchDialog, launchTeleportResumeWrapper } from './dialogLaunchers.js';
import { SHOW_CURSOR } from './ink/termio/dec.js';
import { exitWithError, exitWithMessage, getRenderContext, renderAndRun, showSetupScreens } from './interactiveHelpers.js';
import { initBuiltinPlugins } from './plugins/bundled/index.js';
/* eslint-enable @typescript-eslint/no-require-imports */
import { checkQuotaStatus } from './services/limkenionAiLimits.js';
import { getMcpToolsCommandsAndResources, prefetchAllMcpResources } from './services/mcp/client.js';
import { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES } from './services/plugins/pluginCliCommands.js';
import { initBundledSkills } from './skills/bundled/index.js';
import type { AgentColorName } from './tools/AgentTool/agentColorManager.js';
import { getActiveAgentsFromList, getAgentDefinitionsWithOverrides, isBuiltInAgent, isCustomAgent, parseAgentsFromJson } from './tools/AgentTool/loadAgentsDir.js';
import type { LogOption } from './types/logs.js';
import type { Message as MessageType } from './types/message.js';
import { assertMinVersion } from './utils/autoUpdater.js';
import { LIMKENION_IN_CHROME_SKILL_HINT, LIMKENION_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER } from './utils/limkenionInChrome/prompt.js';
import { setupLimkenionInChrome, shouldAutoEnableLimkenionInChrome, shouldEnableLimkenionInChrome } from './utils/limkenionInChrome/setup.js';
import { getContextWindowForModel } from './utils/context.js';
import { loadConversationForResume } from './utils/conversationRecovery.js';
import { buildDeepLinkBanner } from './utils/deepLink/banner.js';
import { hasNodeOption, isBareMode, isEnvTruthy, isInProtectedNamespace } from './utils/envUtils.js';
import { refreshExampleCommands } from './utils/exampleCommands.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import { getWorktreePaths } from './utils/getWorktreePaths.js';
import { findGitRoot, getBranch, getIsGit, getWorktreeCount } from './utils/git.js';
import { getGhAuthStatus } from './utils/github/ghAuthStatus.js';
import { safeParseJSON } from './utils/json.js';
import { logError } from './utils/log.js';
import { getModelDeprecationWarning } from './utils/model/deprecation.js';
import { getDefaultMainLoopModel, getUserSpecifiedModelSetting, normalizeModelStringForAPI, parseUserSpecifiedModel } from './utils/model/model.js';
import { ensureModelStringsInitialized } from './utils/model/modelStrings.js';
import { PERMISSION_MODES } from './utils/permissions/PermissionMode.js';
import { checkAndDisableBypassPermissions, getAutoModeEnabledStateIfCached, initializeToolPermissionContext, initialPermissionModeFromCLI, isDefaultPermissionModeAuto, parseToolListFromCLI, removeDangerousPermissions, stripDangerousPermissionsForAutoMode, verifyAutoModeGateAccess } from './utils/permissions/permissionSetup.js';
import { cleanupOrphanedPluginVersionsInBackground } from './utils/plugins/cacheUtils.js';
import { initializeVersionedPlugins } from './utils/plugins/installedPluginsManager.js';
import { getManagedPluginNames } from './utils/plugins/managedPlugins.js';
import { getGlobExclusionsForPluginCache } from './utils/plugins/orphanedPluginFilter.js';
import { getPluginSeedDirs } from './utils/plugins/pluginDirectories.js';
import { countFilesRoundedRg } from './utils/ripgrep.js';
import { processSessionStartHooks, processSetupHooks } from './utils/sessionStart.js';
import { cacheSessionTitle, getSessionIdFromLog, loadTranscriptFromFile, saveAgentSetting, saveMode, searchSessionsByCustomTitle, sessionIdExists } from './utils/sessionStorage.js';
import { ensureMdmSettingsLoaded } from './utils/settings/mdm/settings.js';
import { getInitialSettings, getManagedSettingsKeysForLogging, getSettingsForSource, getSettingsWithErrors } from './utils/settings/settings.js';
import { resetSettingsCache } from './utils/settings/settingsCache.js';
import type { ValidationError } from './utils/settings/validation.js';
import { DEFAULT_TASKS_MODE_TASK_LIST_ID, TASK_STATUSES } from './utils/tasks.js';
import { logPluginLoadErrors, logPluginsEnabledForSession } from './utils/telemetry/pluginTelemetry.js';
import { logSkillsLoaded } from './utils/telemetry/skillLoadedEvent.js';
import { generateTempFilePath } from './utils/tempfile.js';
import { validateUuid } from './utils/uuid.js';
// 插件启动检查现已在 REPL.tsx 中非阻塞地处理

import { registerMcpAddCommand } from 'src/commands/mcp/addCommand.js';
import { registerMcpXaaIdpCommand } from 'src/commands/mcp/xaaIdpCommand.js';
import { logPermissionContextForAnts } from 'src/services/internalLogging.js';
import { fetchLimkenionAIMcpConfigsIfEligible } from 'src/services/mcp/limkenionai.js';
import { clearServerCache } from 'src/services/mcp/client.js';
import { areMcpConfigsAllowedWithEnterpriseMcpConfig, dedupLimkenionAiMcpServers, doesEnterpriseMcpConfigExist, filterMcpServersByPolicy, getLimkenionMcpConfigs, getMcpServerSignature, parseMcpConfig, parseMcpConfigFromFilePath } from 'src/services/mcp/config.js';
import { excludeCommandsByServer, excludeResourcesByServer } from 'src/services/mcp/utils.js';
import { isXaaEnabled } from 'src/services/mcp/xaaIdpLogin.js';
import { getRelevantTips } from 'src/services/tips/tipRegistry.js';
import { logContextMetrics } from 'src/utils/api.js';
import { LIMKENION_IN_CHROME_MCP_SERVER_NAME, isLimkenionInChromeMCPServer } from 'src/utils/limkenionInChrome/common.js';
import { registerCleanup } from 'src/utils/cleanupRegistry.js';
import { eagerParseCliFlag } from 'src/utils/cliArgs.js';
import { createEmptyAttributionState } from 'src/utils/commitAttribution.js';
import { countConcurrentSessions, registerSession, updateSessionName } from 'src/utils/concurrentSessions.js';
import { getCwd } from 'src/utils/cwd.js';
import { logForDebugging, setHasFormattedOutput } from 'src/utils/debug.js';
import { errorMessage, getErrnoCode, isENOENT, TeleportOperationError, toError } from 'src/utils/errors.js';
import { getFsImplementation, safeResolvePath } from 'src/utils/fsOperations.js';
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import { setAllHookEventsEnabled } from 'src/utils/hooks/hookEvents.js';
import { peekForStdinData, writeToStderr } from 'src/utils/process.js';
import { setCwd } from 'src/utils/Shell.js';
import { type ProcessedResume, processResumedConversation } from 'src/utils/sessionRestore.js';
import { parseSettingSourcesFlag } from 'src/utils/settings/constants.js';
import { plural } from 'src/utils/stringUtils.js';
import { type ChannelEntry, getInitialMainLoopModel, getIsNonInteractiveSession, getSdkBetas, getSessionId, getUserMsgOptIn, setAllowedChannels, setAllowedSettingSources, setChromeFlagOverride, setClientType, setCwdState, setDirectConnectServerUrl, setFlagSettingsPath, setInitialMainLoopModel, setInlinePlugins, setIsInteractive, setKairosActive, setOriginalCwd, setQuestionPreviewFormat, setSdkBetas, setSessionBypassPermissionsMode, setSessionPersistenceDisabled, setSessionSource, setUserMsgOptIn, switchSession } from './bootstrap/state.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER') ? require('./utils/permissions/autoModeState.js') as typeof import('./utils/permissions/autoModeState.js') : null;

// TeleportRepoMismatchDialog、TeleportResumeWrapper 在调用处动态导入
import { migrateAutoUpdatesToSettings } from './migrations/migrateAutoUpdatesToSettings.js';
import { migrateBypassPermissionsAcceptedToSettings } from './migrations/migrateBypassPermissionsAcceptedToSettings.js';
import { migrateEnableAllProjectMcpServersToSettings } from './migrations/migrateEnableAllProjectMcpServersToSettings.js';
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from './migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.js';
import { resetAutoModeOptInForDefaultOffer } from './migrations/resetAutoModeOptInForDefaultOffer.js';
/* eslint-enable @typescript-eslint/no-require-imports */
// teleportWithProgress 在调用处动态导入
import { initializeLspServerManager } from './services/lsp/manager.js';
import { shouldEnablePromptSuggestion } from './services/PromptSuggestion/promptSuggestion.js';
import { type AppState, getDefaultAppState, IDLE_SPECULATION_STATE } from './state/AppStateStore.js';
import { onChangeAppState } from './state/onChangeAppState.js';
import { createStore } from './state/store.js';
import { asSessionId } from './types/ids.js';
import { filterAllowedSdkBetas } from './utils/betas.js';
import { isInBundledMode, isRunningWithBun } from './utils/bundledMode.js';
import { logForDiagnosticsNoPII } from './utils/diagLogs.js';
import { filterExistingPaths, getKnownPathsForRepo } from './utils/githubRepoPathMapping.js';
import { clearPluginCache, loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js';
import { migrateChangelogFromConfig } from './utils/releaseNotes.js';
import { SandboxManager } from './utils/sandbox/sandbox-adapter.js';
import { fetchSession, prepareApiRequest } from './utils/teleport/api.js';
import { checkOutTeleportedSessionBranch, processMessagesForTeleportResume, teleportToRemoteWithErrorHandling, validateGitState, validateSessionRepository } from './utils/teleport.js';
import { shouldEnableThinkingByDefault, type ThinkingConfig } from './utils/thinking.js';
import { initUser, resetUserCache } from './utils/user.js';
import { getTmuxInstallInstructions, isTmuxAvailable, parsePRReference } from './utils/worktree.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_imports_loaded');

/**
 * 将受管设置键记录到 Statsig 以供分析。
 * 在 init() 完成后调用，以确保设置已加载、环境变量已应用，
 * 再进行模型解析。
 */
function logManagedSettings(): void {
  try {
    const policySettings = getSettingsForSource('policySettings');
    if (policySettings) {
      const allKeys = getManagedSettingsKeysForLogging(policySettings);
      logEvent('limkenion_managed_settings_loaded', {
        keyCount: allKeys.length,
        keys: allKeys.join(',') as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
    }
  } catch {
    // 静默忽略错误——仅为分析使用
  }
}

// 检查是否处于调试/检查模式
function isBeingDebugged() {
  const isBun = isRunningWithBun();

  // 在进程参数中检查 inspect 标志（包括所有变体）
  const hasInspectArg = process.execArgv.some(arg => {
    if (isBun) {
      // 注意：Bun 在单文件可执行文件上存在一个问题，即 process.argv 中
      // 的应用程序参数会泄漏到 process.execArgv 中（类似
      // https://github.com/oven-sh/bun/issues/11673）。如果省略该分支，
      // 会破坏 --debug 模式的使用。
      // 我们可以安全地跳过这个检查，因为 Bun 不支持 Node.js 旧版的
      // --debug 或 --debug-brk 标志
      return /--inspect(-brk)?/.test(arg);
    } else {
      // 在 Node.js 中，同时检查 --inspect 和旧版 --debug 标志
      return /--inspect(-brk)?|--debug(-brk)?/.test(arg);
    }
  });

  // 检查 NODE_OPTIONS 是否包含 inspect 标志
  const hasInspectEnv = process.env.NODE_OPTIONS && /--inspect(-brk)?|--debug(-brk)?/.test(process.env.NODE_OPTIONS);

  // 检查 inspector 是否可用并处于活动状态（表示正在调试）
  try {
    // 动态 import 更好但是异步的——改用全局对象
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspector = (global as any).require('inspector');
    const hasInspectorUrl = !!inspector.url();
    return hasInspectorUrl || hasInspectArg || hasInspectEnv;
  } catch {
    // 忽略错误并回退到参数检测
    return hasInspectArg || hasInspectEnv;
  }
}

// 若检测到 node 调试或检查则退出
if ((isBeingDebugged())) {
  // 此处直接使用 process.exit，因为我们在所有 import 之前的顶层代码中，
  // 此时 gracefulShutdown 尚不可用
  // eslint-disable-next-line custom-rules/no-top-level-side-effects
  process.exit(1);
}

/**
 * 每次会话的技能/插件埋点。从交互式路径和非交互式 -p 路径
 * （runHeadless 之前）两处调用——两者都经由 main.tsx，但在交互式启动路径
 * 之前分支，因此这里需要两个调用点，而不是这里一个 + QueryEngine 一个。
 */
function logSessionTelemetry(): void {
  const model = parseUserSpecifiedModel(getInitialMainLoopModel() ?? getDefaultMainLoopModel());
  void logSkillsLoaded(getCwd(), getContextWindowForModel(model, getSdkBetas()));
  void loadAllPluginsCacheOnly().then(({
    enabled,
    errors
  }) => {
    const managedNames = getManagedPluginNames();
    logPluginsEnabledForSession(enabled, managedNames, getPluginSeedDirs());
    logPluginLoadErrors(errors, managedNames);
  }).catch(err => logError(err));
}
function getCertEnvVarTelemetry(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (process.env.NODE_EXTRA_CA_CERTS) {
    result.has_node_extra_ca_certs = true;
  }
  if (process.env.LIMKENION_CLIENT_CERT) {
    result.has_client_cert = true;
  }
  if (hasNodeOption('--use-system-ca')) {
    result.has_use_system_ca = true;
  }
  if (hasNodeOption('--use-openssl-ca')) {
    result.has_use_openssl_ca = true;
  }
  return result;
}
async function logStartupTelemetry(): Promise<void> {
  if (isAnalyticsDisabled()) return;
  const [isGit, worktreeCount, ghAuthStatus] = await Promise.all([getIsGit(), getWorktreeCount(), getGhAuthStatus()]);
  logEvent('limkenion_startup_telemetry', {
    is_git: isGit,
    worktree_count: worktreeCount,
    gh_auth_status: ghAuthStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sandbox_enabled: SandboxManager.isSandboxingEnabled(),
    are_unsandboxed_commands_allowed: SandboxManager.areUnsandboxedCommandsAllowed(),
    is_auto_bash_allowed_if_sandbox_enabled: SandboxManager.isAutoAllowBashIfSandboxedEnabled(),
    auto_updater_disabled: isAutoUpdaterDisabled(),
    prefers_reduced_motion: getInitialSettings().prefersReducedMotion ?? false,
    ...getCertEnvVarTelemetry()
  });
}

// 上游的模型版本迁移（deepseek-flash/deepseek-v4-pro 各代之间的设置改写）已全部删除 ——
// 那些模型在本构建里不存在，迁移只会把用户设置改写成无效的模型名。
// 添加新的同步迁移时递增此值，使现有用户重新运行整组迁移。
const CURRENT_MIGRATION_VERSION = 11;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    migrateEnableAllProjectMcpServersToSettings();
    migrateReplBridgeEnabledToRemoteControlAtStartup();
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer();
    }
    
    saveGlobalConfig(prev => prev.migrationVersion === CURRENT_MIGRATION_VERSION ? prev : {
      ...prev,
      migrationVersion: CURRENT_MIGRATION_VERSION
    });
  }
  // 异步迁移——fire and forget，因为它是非阻塞的
  migrateChangelogFromConfig().catch(() => {
    // 静默忽略迁移错误——将在下次启动时重试
  });
}

/**
 * 仅当安全时预取系统上下文（包括 git 状态）。
 * Git 命令可能通过 hooks 和配置（例如 core.fsmonitor、diff.external）
 * 执行任意代码，因此只有在信任已建立后才运行它们，或在
 * 信任隐含成立的非交互模式下运行。
 */
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession();

  // 在非交互模式（--print）下会跳过信任对话框，
  // 执行被视为可信（如帮助文本所述）
  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive');
    void getSystemContext();
    return;
  }

  // 在交互模式下，仅当信任已建立时才预取
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust');
    void getSystemContext();
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust');
  }
  // 否则不预取——等待先建立信任
}

/**
 * 启动首次渲染之前不必执行的预取与后台维护。
 * 它们从 setup() 中延迟到此，以减少关键启动路径上的事件循环竞争
 * 与子进程生成。
 * 在 REPL 渲染完成后调用此函数。
 */
export function startDeferredPrefetches(): void {
  // 此函数在首次渲染后运行，因此不会阻塞首屏。
  // 但生成的子进程和异步工作仍会占用 CPU 与事件循环时间，
  // 从而影响启动基准测试（CPU 剖析、首屏时间测量）。
  // 当仅测量启动性能时跳过所有这些。
  if (isEnvTruthy(process.env.LIMKENION_EXIT_AFTER_FIRST_RENDER) ||
  // --bare：跳过所有预取。这些是针对 REPL 首轮响应性的缓存预热
  // （initUser、getUserContext、tips、countFiles、modelCapabilities、
  // change detectors）。脚本化 -p 调用没有可以隐藏这些工作的
  // “用户正在输入”窗口——在关键路径上完全是开销。
  isBareMode()) {
    return;
  }

  // 生成子进程的预取（在首次 API 调用时被消费，用户仍在输入）
  void initUser();
  void getUserContext();
  prefetchSystemContextIfSafe();
  void getRelevantTips();
  if (isEnvTruthy(process.env.LIMKENION_USE_BEDROCK) && !isEnvTruthy(process.env.LIMKENION_SKIP_BEDROCK_AUTH)) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe();
  }
  if (isEnvTruthy(process.env.LIMKENION_USE_VERTEX) && !isEnvTruthy(process.env.LIMKENION_SKIP_VERTEX_AUTH)) {
    void prefetchGcpCredentialsIfSafe();
  }
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), []);

  // 分析与功能开关初始化
  void initializeAnalyticsGates();
  void prefetchOfficialMcpUrls();

  // 从 init() 延迟到首次渲染后的文件变更检测器
  void settingsChangeDetector.initialize();
  if (!isBareMode()) {
    void skillChangeDetector.initialize();
  }

  // 事件循环卡死检测器——当主线程被阻塞超过 500ms 时记录日志
  
}
function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim();
    const looksLikeJson = trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}');
    let settingsPath: string;
    if (looksLikeJson) {
      // 它是 JSON 字符串——校验并创建临时文件
      const parsedJson = safeParseJSON(trimmedSettings);
      if (!parsedJson) {
        process.stderr.write(chalk.red('错误：提供给 --settings 的 JSON 无效\n'));
        process.exit(1);
      }

      // 创建临时文件并将 JSON 写入其中。
      // 使用基于内容哈希的路径而非随机 UUID，以避免
      // 破坏 Limkenion API prompt 缓存。设置路径最终会出现在
      // Bash 工具的沙箱 denyWithinAllow 列表中，该列表是发送给 API 的
      // 工具描述的一部分。每次 query() 调用时，每个子进程中的随机 UUID
      // 都会改变工具描述，使缓存前缀失效，并导致约 12 倍的输入 token 成本惩罚。
      // 内容哈希确保相同的设置在跨进程边界（每次 SDK query() 都会
      // 生成一个新进程）生成相同的路径。
      settingsPath = generateTempFilePath('limkenion-settings', '.json', {
        contentHash: trimmedSettings
      });
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8');
    } else {
      // 它是文件路径——通过尝试读取来解析并校验
      const {
        resolvedPath: resolvedSettingsPath
      } = safeResolvePath(getFsImplementation(), settingsFile);
      try {
        readFileSync(resolvedSettingsPath, 'utf8');
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(chalk.red(`错误：未找到设置文件：${resolvedSettingsPath}\n`));
          process.exit(1);
        }
        throw e;
      }
      settingsPath = resolvedSettingsPath;
    }
    setFlagSettingsPath(settingsPath);
    resetSettingsCache();
  } catch (error) {
    if (error instanceof Error) {
      logError(error);
    }
    process.stderr.write(chalk.red(`处理设置出错：${errorMessage(error)}\n`));
    process.exit(1);
  }
}
function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg);
    setAllowedSettingSources(sources);
    resetSettingsCache();
  } catch (error) {
    if (error instanceof Error) {
      logError(error);
    }
    process.stderr.write(chalk.red(`处理 --setting-sources 出错：${errorMessage(error)}\n`));
    process.exit(1);
  }
}

/**
 * 尽早解析并加载设置标志，在 init() 之前
 * 这样可确保从初始化开始，设置就已被过滤
 */
function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start');
  // 尽早解析 --settings 标志，确保在 init() 之前加载设置
  const settingsFile = eagerParseCliFlag('--settings');
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile);
  }

  // 尽早解析 --setting-sources 标志，控制加载哪些来源
  const settingSourcesArg = eagerParseCliFlag('--setting-sources');
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg);
  }
  profileCheckpoint('eagerLoadSettings_end');
}
function initializeEntrypoint(isNonInteractive: boolean): void {
  // 如果已设置则跳过（例如由 SDK 或其他入口设置）
  if (process.env.LIMKENION_ENTRYPOINT) {
    return;
  }
  const cliArgs = process.argv.slice(2);

  // 检查 MCP serve 命令（在 mcp serve 之前处理标志，例如 --debug mcp serve）
  const mcpIndex = cliArgs.indexOf('mcp');
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.LIMKENION_ENTRYPOINT = 'mcp';
    return;
  }
  if (isEnvTruthy(process.env.LIMKENION_ACTION)) {
    process.env.LIMKENION_ENTRYPOINT = 'limkenion-github-action';
    return;
  }

  // 注意：'local-agent' 入口由本地 agent 模式启动器通过
  // LIMKENION_ENTRYPOINT 环境变量设置（由上面的提前 return 处理）

  // 根据交互状态设置
  process.env.LIMKENION_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli';
}

// 当检测到 `limkenion open <url>` 时，由早期 argv 处理设置（仅交互模式）
type PendingConnect = {
  url: string | undefined;
  authToken: string | undefined;
  dangerouslySkipPermissions: boolean;
};
const _pendingConnect: PendingConnect | undefined = feature('DIRECT_CONNECT') ? {
  url: undefined,
  authToken: undefined,
  dangerouslySkipPermissions: false
} : undefined;

// 当检测到 `limkenion assistant [sessionId]` 时，由早期 argv 处理设置
type PendingAssistantChat = {
  sessionId?: string;
  discover: boolean;
};
const _pendingAssistantChat: PendingAssistantChat | undefined = feature('KAIROS') ? {
  sessionId: undefined,
  discover: false
} : undefined;

// `limkenion ssh <host> [dir]`——从 argv 早期解析（与上面的
// DIRECT_CONNECT 相同模式），以便主命令路径能够拾取它并把
// REPL 交给一个基于 SSH 的会话而不是本地会话。
type PendingSSH = {
  host: string | undefined;
  cwd: string | undefined;
  permissionMode: string | undefined;
  dangerouslySkipPermissions: boolean;
  /** --local：直接生成子 CLI，跳过 ssh/探测/部署。e2e 测试模式。 */
  local: boolean;
  /** 初始生成时转发给远程 CLI 的额外 CLI 参数（--resume、-c）。 */
  extraCliArgs: string[];
};
const _pendingSSH: PendingSSH | undefined = feature('SSH_REMOTE') ? {
  host: undefined,
  cwd: undefined,
  permissionMode: undefined,
  dangerouslySkipPermissions: false,
  local: false,
  extraCliArgs: []
} : undefined;
export async function main() {
  profileCheckpoint('main_function_start');

  // 安全：防止 Windows 从当前目录执行命令
  // 必须在任何命令执行之前设置，以防 PATH 劫持攻击
  // 参见：https://docs.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-searchpathw
  process.env.NoDefaultCurrentDirectoryInExePath = '1';

  // 尽早初始化警告处理器以捕获警告
  initializeWarningHandler();
  process.on('exit', () => {
    resetCursor();
  });
  process.on('SIGINT', () => {
    // 在 print 模式下，print.ts 注册了自己的 SIGINT 处理器以中止
    // 进行中的查询并调用 gracefulShutdown；此处跳过以避免
    // 用同步的 process.exit() 抢先处理它。
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return;
    }
    process.exit(0);
  });
  profileCheckpoint('main_warning_handler_initialized');

  // 检查 argv 中是否存在 cc:// 或 cc+unix:// URL——改写以便主命令
  // 处理它，提供完整的交互式 TUI，而不是精简的子命令。
  // 对于 headless（-p），我们改写为内部的 `open` 子命令。

  // 尽早处理深链接 URI——这由操作系统协议处理器调用，
  // 应在完整初始化之前退出，因为它只需解析 URI 并打开终端。
  if (feature('LODESTONE')) {
    const handleUriIdx = process.argv.indexOf('--handle-uri');
    if (handleUriIdx !== -1 && process.argv[handleUriIdx + 1]) {
      const {
        enableConfigs
      } = await import('./utils/config.js');
      enableConfigs();
      const uri = process.argv[handleUriIdx + 1]!;
      const {
        handleDeepLinkUri
      } = await import('./utils/deepLink/protocolHandler.js');
      const exitCode = await handleDeepLinkUri(uri);
      process.exit(exitCode);
    }

    // macOS URL 处理器：当 LaunchServices 启动我们的 .app bundle 时，
    // URL 通过 Apple Event（而非 argv）到达。LaunchServices 会把
    // __CFBundleIdentifier 改写为启动 bundle 的 ID，这是一个精确的
    // 正信号——比引入并通过启发式猜测更便宜。
    if (process.platform === 'darwin' && process.env.__CFBundleIdentifier === 'com.limkenion.limkenion-url-handler') {
      const {
        enableConfigs
      } = await import('./utils/config.js');
      enableConfigs();
      const {
        handleUrlSchemeLaunch
      } = await import('./utils/deepLink/protocolHandler.js');
      const urlSchemeResult = await handleUrlSchemeLaunch();
      process.exit(urlSchemeResult ?? 1);
    }
  }

  // `limkenion assistant [sessionId]`——存储并剥离，以便主
  // 命令处理它，提供完整的交互式 TUI。仅位置 0
  // （与下面的 ssh 模式匹配）——indexOf 会对
  // `limkenion -p "explain assistant"` 误报。根标志在子命令之前
  // （例如 `--debug assistant`）会落到 stub，后者
  // 打印用法。
  if (feature('KAIROS') && _pendingAssistantChat) {
    const rawArgs = process.argv.slice(2);
    if (rawArgs[0] === 'assistant') {
      const nextArg = rawArgs[1];
      if (nextArg && !nextArg.startsWith('-')) {
        _pendingAssistantChat.sessionId = nextArg;
        rawArgs.splice(0, 2); // 丢弃 'assistant' 和 sessionId
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs];
      } else if (!nextArg) {
        _pendingAssistantChat.discover = true;
        rawArgs.splice(0, 1); // 丢弃 'assistant'
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs];
      }
      // 否则：`limkenion assistant --help` → 落到 stub
    }
  }

  // `limkenion ssh <host> [dir]` — 从 argv 中剥离，以便主命令处理器
  // 运行（完整交互式 TUI），将 host/dir 暂存起来供稍后
  //（约 3720 行处）的 REPL 分支拾取。Headless（-p）模式在 v1 中不支持：
  // SSH 会话需要本地 REPL 来驱动它们（中断、权限）。
  if (feature('SSH_REMOTE') && _pendingSSH) {
    const rawCliArgs = process.argv.slice(2);
    // SSH 专属标志会出现在 host 位置参数之前（例如
    // `ssh --permission-mode auto host /tmp`——标准的 POSIX 标志在
    // 位置参数之前）。先在判断是否提供了 host 之前把它们全部取出，
    // 使 `limkenion ssh --permission-mode auto host` 与 `limkenion ssh host
    // --permission-mode auto` 等价。下面的 host 检查只需
    // 防范 -h/--help（commander 应处理它们）。
    if (rawCliArgs[0] === 'ssh') {
      const localIdx = rawCliArgs.indexOf('--local');
      if (localIdx !== -1) {
        _pendingSSH.local = true;
        rawCliArgs.splice(localIdx, 1);
      }
      const dspIdx = rawCliArgs.indexOf('--dangerously-skip-permissions');
      if (dspIdx !== -1) {
        _pendingSSH.dangerouslySkipPermissions = true;
        rawCliArgs.splice(dspIdx, 1);
      }
      const pmIdx = rawCliArgs.indexOf('--permission-mode');
      if (pmIdx !== -1 && rawCliArgs[pmIdx + 1] && !rawCliArgs[pmIdx + 1]!.startsWith('-')) {
        _pendingSSH.permissionMode = rawCliArgs[pmIdx + 1];
        rawCliArgs.splice(pmIdx, 2);
      }
      const pmEqIdx = rawCliArgs.findIndex(a => a.startsWith('--permission-mode='));
      if (pmEqIdx !== -1) {
        _pendingSSH.permissionMode = rawCliArgs[pmEqIdx]!.split('=')[1];
        rawCliArgs.splice(pmEqIdx, 1);
      }
      // 将会话恢复与模型标志转发到远程 CLI 的初始生成。
      // --continue/-c 和 --resume <uuid> 作用于远程的会话历史
      //（其持久化在远程的 ~/.limkenion/projects/<cwd>/ 下）。
      // --model 控制远程使用的模型。
      const extractFlag = (flag: string, opts: {
        hasValue?: boolean;
        as?: string;
      } = {}) => {
        const i = rawCliArgs.indexOf(flag);
        if (i !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag);
          const val = rawCliArgs[i + 1];
          if (opts.hasValue && val && !val.startsWith('-')) {
            _pendingSSH.extraCliArgs.push(val);
            rawCliArgs.splice(i, 2);
          } else {
            rawCliArgs.splice(i, 1);
          }
        }
        const eqI = rawCliArgs.findIndex(a => a.startsWith(`${flag}=`));
        if (eqI !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag, rawCliArgs[eqI]!.slice(flag.length + 1));
          rawCliArgs.splice(eqI, 1);
        }
      };
      extractFlag('-c', {
        as: '--continue'
      });
      extractFlag('--continue');
      extractFlag('--resume', {
        hasValue: true
      });
      extractFlag('--model', {
        hasValue: true
      });
    }
    // 预提取之后，[1] 处剩余的 dash 参数要么是 -h/--help
    // （commander 处理）要么是 ssh 未知的标志（落回 commander，
    // 让它报出合适的错误）。只有非 dash 参数才是 host。
    if (rawCliArgs[0] === 'ssh' && rawCliArgs[1] && !rawCliArgs[1].startsWith('-')) {
      _pendingSSH.host = rawCliArgs[1];
      // 可选的位置参数 cwd。
      let consumed = 2;
      if (rawCliArgs[2] && !rawCliArgs[2].startsWith('-')) {
        _pendingSSH.cwd = rawCliArgs[2];
        consumed = 3;
      }
      const rest = rawCliArgs.slice(consumed);

      // v1 中 SSH 不支持 headless（-p）模式——尽早拒绝，
      // 以免该标志被静默当作本地执行。
      if (rest.includes('-p') || rest.includes('--print')) {
        process.stderr.write('错误：limkenion ssh 不支持 headless（-p/--print）模式\n');
        gracefulShutdownSync(1);
        return;
      }

      // 改写 argv，使主命令看到剩余的标志但不含 `ssh`。
      process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
    }
  }

  // 尽早检查 -p/--print 与 --init-only 标志，在 init() 之前设置 isInteractiveSession。
  // 这是因为 telemetry 初始化会调用需要此标志的认证函数。
  const cliArgs = process.argv.slice(2);
  const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print');
  const hasInitOnlyFlag = cliArgs.includes('--init-only');
  const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'));
  // 是否进入非交互模式。我们只把*显式*标志当作信号
  //（--print / --init-only / --sdk-url）。此处检查 stdout.isTTY
  // 是错误的：从 .bat 脚本启动时，node 的 stdout 是管道，
  // 会报告 !isTTY，因此即使双击 bat 并预期得到 REPL，CLI 也会静默退出。
  // 终端能否做精美渲染是输出层的关注点，而非控制流的问题。
  const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl;

  // 对非交互模式停止捕获早期输入
  if (isNonInteractive) {
    stopCapturingEarlyInput();
  }

  // 设置简化的追踪字段
  const isInteractive = !isNonInteractive;
  setIsInteractive(isInteractive);

  // 根据模式初始化入口——须在任何事件被记录之前设置
  initializeEntrypoint(isNonInteractive);

  // 确定客户端类型
  const clientType = (() => {
    if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-action';
    if (process.env.LIMKENION_ENTRYPOINT === 'sdk-ts') return 'sdk-typescript';
    if (process.env.LIMKENION_ENTRYPOINT === 'sdk-py') return 'sdk-python';
    if (process.env.LIMKENION_ENTRYPOINT === 'sdk-cli') return 'sdk-cli';
    if (process.env.LIMKENION_ENTRYPOINT === 'limkenion-vscode') return 'limkenion-vscode';
    if (process.env.LIMKENION_ENTRYPOINT === 'local-agent') return 'local-agent';
    if (process.env.LIMKENION_ENTRYPOINT === 'limkenion-desktop') return 'limkenion-desktop';

    // 检查是否提供了会话入口令牌（表示远程会话）
    const hasSessionIngressToken = process.env.LIMKENION_SESSION_ACCESS_TOKEN || process.env.LIMKENION_WEBSOCKET_AUTH_FILE_DESCRIPTOR;
    if (process.env.LIMKENION_ENTRYPOINT === 'remote' || hasSessionIngressToken) {
      return 'remote';
    }
    return 'cli';
  })();
  setClientType(clientType);
  const previewFormat = process.env.LIMKENION_QUESTION_PREVIEW_FORMAT;
  if (previewFormat === 'markdown' || previewFormat === 'html') {
    setQuestionPreviewFormat(previewFormat);
  } else if (!clientType.startsWith('sdk-') &&
  // 桌面版和 CCR 通过 toolConfig 传递 previewFormat；当该功能被
  // 门禁关闭时它们会传递 undefined——不要用 markdown 覆盖它。
  clientType !== 'limkenion-desktop' && clientType !== 'local-agent' && clientType !== 'remote') {
    setQuestionPreviewFormat('markdown');
  }

  // 标记经由 `limkenion remote-control` 创建的会话，使后端能识别它们
  if (process.env.LIMKENION_ENVIRONMENT_KIND === 'bridge') {
    setSessionSource('remote-control');
  }
  profileCheckpoint('main_client_type_determined');

  // 尽早解析并加载设置标志，init() 之前
  eagerLoadSettings();
  profileCheckpoint('main_before_run');
  await run();
  profileCheckpoint('main_after_run');
}
async function getInputPrompt(prompt: string, inputFormat: 'text' | 'stream-json'): Promise<string | AsyncIterable<string>> {
  if (!process.stdin.isTTY &&
  // 输入劫持会破坏 MCP。
  !process.argv.includes('mcp')) {
    if (inputFormat === 'stream-json') {
      return process.stdin;
    }
    process.stdin.setEncoding('utf8');
    let data = '';
    const onData = (chunk: string) => {
      data += chunk;
    };
    process.stdin.on('data', onData);
    // 若 3 秒内没有数据到达，则停止等待并告警。stdin 很可能是从
    // 一个未写入的父进程继承的管道（未显式处理 stdin 的子进程）。
    // 3 秒可覆盖较慢的生产者，如 curl、大文件上的 jq、带 import 开销的
    // python。对于更慢的罕见生产者，告警也能让静默的数据丢失可见。
    const timedOut = await peekForStdinData(process.stdin, 3000);
    process.stdin.off('data', onData);
    if (timedOut) {
      process.stderr.write('警告：3 秒内未收到 stdin 数据，将在没有该数据的情况下继续。' + '如果是从较慢的命令进行管道输入，请显式重定向 stdin：使用 < /dev/null 跳过，或等待更长时间。\n');
    }
    return [prompt, data].filter(Boolean).join('\n');
  }
  return prompt;
}
async function run(): Promise<CommanderCommand> {
  profileCheckpoint('run_function_start');

  // 创建按长选项名排序选项的帮助配置。
  // Commander 在运行时支持 compareOptions，但 @commander-js/extra-typings
  // 未在其类型定义中包含它，因此我们用 Object.assign 来添加它。
  function createSortedHelpConfig(): {
    sortSubcommands: true;
    sortOptions: true;
  } {
    const getOptionSortKey = (opt: Option): string => opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? '';
    return Object.assign({
      sortSubcommands: true,
      sortOptions: true
    } as const, {
      compareOptions: (a: Option, b: Option) => getOptionSortKey(a).localeCompare(getOptionSortKey(b))
    });
  }
  const program = new CommanderCommand().configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  profileCheckpoint('run_commander_initialized');

  // 使用 preAction hook 仅在执行命令时运行初始化，
  // 而不是在显示帮助时。这避免了使用环境变量传递信号。
  program.hook('preAction', async thisCommand => {
    profileCheckpoint('preAction_start');
    // 等待模块求值阶段（第 12-20 行）启动的异步子进程加载完成。
    // 几乎零成本——子进程在下面约 135ms 的 import 期间完成。
    // 必须在 init() 之前完成，init() 会触发第一次设置读取
    //（applySafeConfigEnvironmentVariables → getSettingsForSource('policySettings')
    // → isRemoteManagedSettingsEligible → 否则同步钥匙串读取约 65ms）。
    await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
    profileCheckpoint('preAction_after_mdm');
    await init();
    profileCheckpoint('preAction_after_init');

    // Windows 上的 process.title 直接设置控制台标题；在 POSIX 上，
    // 终端 shell 集成可能把进程名镜像到标签页。
    // 放在 init() 之后，这样 settings.json 环境也可门控它（gh-4765）。
    if (!isEnvTruthy(process.env.LIMKENION_DISABLE_TERMINAL_TITLE)) {
      process.title = 'limkenion';
    }

    // 挂接日志 sink，使子命令处理器可以使用 logEvent/logError。
    // PR #11106 之前 logEvent 是直接分发的；之后，事件会被排队，
    // 直到 sink 挂接。setup() 为默认命令挂接 sink，但
    // 子命令（doctor、mcp、plugin、auth）从不调用 setup()，会导致
    // 事件在 process.exit() 时被静默丢弃。两个 init 都是幂等的。
    const {
      initSinks
    } = await import('./utils/sinks.js');
    initSinks();
    profileCheckpoint('preAction_after_sinks');

    // gh-33508：--plugin-dir 是顶层的 program 选项。默认
    // action 会从其自身的 options 解构中读取它，但子命令
    //（plugin list、plugin install、mcp *）有自己的 action，
    // 永远看不到它。在这里接线，使 getInlinePlugins() 处处可用。
    // 因为此 hook 在链中 .option('--plugin-dir', ...) 之前挂接，
    // thisCommand.opts() 的类型是 {}——extra-typings
    // 会随选项的添加来构建类型。用运行时守卫收窄；
    // collect 累加器 + [] 默认值实际保证了 string[]。
    const pluginDir = thisCommand.getOptionValue('pluginDir');
    if (Array.isArray(pluginDir) && pluginDir.length > 0 && pluginDir.every(p => typeof p === 'string')) {
      setInlinePlugins(pluginDir);
      clearPluginCache('preAction: --plugin-dir inline plugins');
    }
    runMigrations();
    profileCheckpoint('preAction_after_migrations');

    // 为企业客户加载远程受管设置（非阻塞）
    // 失败开放——若拉取失败，则继续而无需远程设置
    // 设置到达后通过热重载应用
    // 必须在 init() 之后，以确保允许读取配置
    void loadRemoteManagedSettings();
    void loadPolicyLimits();
    profileCheckpoint('preAction_after_remote_settings');

    // 同步加载设置（非阻塞、失败开放）
    // CLI：将本地设置上传到远程（CCR 下载由 print.ts 处理）
    if (feature('UPLOAD_USER_SETTINGS')) {
      void import('./services/settingsSync/index.js').then(m => m.uploadUserSettingsInBackground());
    }
    profileCheckpoint('preAction_after_settings_sync');
  });
  program.name('limkenion').description(`Limkenion - 默认启动交互式会话，如需非交互输出请使用 -p/--print`).argument('[prompt]', '你的提示词', String)
  // 子命令通过 commander 的 copyInheritedSettings 继承 helpOption——
  // 在此设置一次即可覆盖 mcp、plugin、auth 及所有其他子命令。
  .helpOption('-h, --help', '显示命令帮助').option('-d, --debug [filter]', '启用调试模式，可按类别过滤（如 "api,hooks" 或 "!1p,!file"）', (_value: string | true) => {
    // 若提供了值，它就是过滤字符串
    // 若未提供但标志存在，则值为 true
    // 实际的过滤在 debug.ts 中通过解析 process.argv 处理
    return true;
  })// 注意：原来是 '-d2e, --debug-to-stderr'。Commander 拒绝多字符短标志
//（"-d2e" 是 3 个字符）；它只允许单个 dash + 单个字符。该选项
// 本来就是隐藏的，因此去掉短形式，保留长形式。
.addOption(new Option('--debug-to-stderr', '启用调试模式（输出到 stderr）').argParser(Boolean).hideHelp()).option('--debug-file <path>', '将调试日志写入指定文件路径（同时隐式启用调试模式）', () => true).option('--verbose', '用配置覆盖详细输出模式设置', () => true).option('-p, --print', '打印响应后退出（适合管道使用）。注意：以 -p 模式运行时跳过工作区信任对话框。请仅在可信目录中使用此标志。', () => true).option('--bare', '极简模式：跳过 hooks、LSP、插件同步、归属、自动记忆、后台预取、钥匙串读取和 LIMKENION.md 自动发现。将 LIMKENION_SIMPLE 设为 1。Limkenion 认证仅使用 LIMKENION_API_KEY 或通过 --settings 的 apiKeyHelper（从不读取 OAuth 与钥匙串）。三方云（Bedrock/Vertex/Foundry）使用各自的凭据。技能仍通过 /skill-name 解析。请通过以下方式显式提供上下文：--system-prompt[-file]、--append-system-prompt[-file]、--add-dir（LIMKENION.md 目录）、--mcp-config、--settings、--agents、--plugin-dir。', () => true).addOption(new Option('--init', '运行初始化触发器的 Setup hooks，然后继续').hideHelp()).addOption(new Option('--init-only', '运行 Setup 与 SessionStart:startup hooks，然后退出').hideHelp()).addOption(new Option('--maintenance', '运行维护触发器的 Setup hooks，然后继续').hideHelp()).addOption(new Option('--output-format <format>', '输出格式（仅对 --print 生效）："text"（默认）、"json"（单条结果）或 "stream-json"（实时流式输出）').choices(['text', 'json', 'stream-json'])).addOption(new Option('--json-schema <schema>', '用于结构化输出校验的 JSON Schema。' + '示例：{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}').argParser(String)).option('--include-hook-events', '在输出流中包含所有 hook 生命周期事件（仅对 --output-format=stream-json 生效）', () => true).option('--include-partial-messages', '在片段到达时包含部分消息（仅对 --print 和 --output-format=stream-json 生效）', () => true).addOption(new Option('--input-format <format>', '输入格式（仅对 --print 生效）："text"（默认）或 "stream-json"（实时流式输入）').choices(['text', 'stream-json'])).option('--mcp-debug', '[已弃用，请改用 --debug] 启用 MCP 调试模式（显示 MCP 服务器错误）', () => true).option('--dangerously-skip-permissions', '跳过所有权限检查。仅建议在无网络访问的沙箱中使用。', () => true).option('--allow-dangerously-skip-permissions', '将绕过所有权限检查作为可选项启用，而非默认启用。仅建议在无网络访问的沙箱中使用。', () => true).addOption(new Option('--thinking <mode>', '思考模式：enabled（等同 adaptive）、disabled').choices(['enabled', 'adaptive', 'disabled']).hideHelp()).addOption(new Option('--max-thinking-tokens <tokens>', '[已弃用，新模型请改用 --thinking] 最大思考 token 数（仅对 --print 生效）').argParser(Number).hideHelp()).addOption(new Option('--max-turns <turns>', '非交互模式下的最大 agent 轮数。达到指定轮数后对话将提前结束。（仅对 --print 生效）').argParser(Number).hideHelp()).addOption(new Option('--max-budget-usd <amount>', '用于 API 调用的最大花费美元金额（仅对 --print 生效）').argParser(value => {
    const amount = Number(value);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('--max-budget-usd 必须是大于 0 的正数');
    }
    return amount;
  })).addOption(new Option('--task-budget <tokens>', 'API-side task budget in tokens (output_config.task_budget)').argParser(value => {
    const tokens = Number(value);
    if (isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
      throw new Error('--task-budget 必须是正整数');
    }
    return tokens;
  }).hideHelp()).option('--replay-user-messages', '将来自 stdin 的用户消息重新回显到 stdout 以示确认（仅对 --input-format=stream-json 和 --output-format=stream-json 生效）', () => true).addOption(new Option('--enable-auth-status', '在 SDK 模式下启用认证状态消息').default(false).hideHelp()).option('--allowedTools, --allowed-tools <tools...>', '允许的工具名列表，用逗号或空格分隔（如 "Bash(git:*) Edit"）').option('--tools <tools...>', '从内置工具集中指定可用工具列表。使用 "" 禁用所有工具，使用 "default" 使用所有工具，或指定工具名（如 "Bash,Edit,Read"）。').option('--disallowedTools, --disallowed-tools <tools...>', '要拒绝的工具名列表，用逗号或空格分隔（如 "Bash(git:*) Edit"）').option('--mcp-config <configs...>', '从 JSON 文件或字符串加载 MCP 服务器（空格分隔）').addOption(new Option('--permission-prompt-tool <tool>', '用于权限提示的 MCP 工具（仅对 --print 生效）').argParser(String).hideHelp()).addOption(new Option('--system-prompt <prompt>', '用于会话的系统提示词').argParser(String)).addOption(new Option('--system-prompt-file <file>', '从文件中读取系统提示词').argParser(String).hideHelp()).addOption(new Option('--append-system-prompt <prompt>', '将系统提示词追加到默认系统提示词之后').argParser(String)).addOption(new Option('--append-system-prompt-file <file>', '从文件中读取系统提示词并追加到默认系统提示词之后').argParser(String).hideHelp()).addOption(new Option('--permission-mode <mode>', '会话使用的权限模式').argParser(String).choices(PERMISSION_MODES)).option('-c, --continue', '继续当前目录中最近的对话', () => true).option('-r, --resume [value]', '按会话 ID 恢复会话，或打开带可选搜索词的交互相应式选择器', value => value || true).option('--fork-session', '恢复时创建新的会话 ID 而非复用原 ID（与 --resume 或 --continue 一起使用）', () => true).addOption(new Option('--prefill <text>', '用文本预填 prompt 输入但不会提交').hideHelp()).addOption(new Option('--deep-link-origin', '标记此会话由深链接启动').hideHelp()).addOption(new Option('--deep-link-repo <slug>', '深链接 ?repo= 参数解析到当前 cwd 的仓库标识').hideHelp()).addOption(new Option('--deep-link-last-fetch <ms>', '深链接 trampoline 预计算的 FETCH_HEAD 修改时间（epoch 毫秒）').argParser(v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }).hideHelp()).option('--from-pr [value]', '按 PR 编号/URL 恢复与 PR 关联的会话，或打开带可选搜索词的交互相应式选择器', value => value || true).option('--no-session-persistence', '禁用会话持久化——会话不会被保存到磁盘，也无法恢复（仅对 --print 生效）').addOption(new Option('--resume-session-at <message id>', '恢复时只恢复 <message.id> 及之前的消息（在 print 模式下与 --resume 搭配使用）').argParser(String).hideHelp()).addOption(new Option('--rewind-files <user-message-id>', '将文件恢复到指定用户消息时的状态并退出（需要 --resume）').hideHelp())
  // @[MODEL LAUNCH]: 更新 --model 帮助文本中的示例模型 ID。
  .option('--model <model>', `当前会话使用的模型。可提供最新模型的别名（如 'sonnet' 或 'opus'），或模型的完整名称（如 'limkenion-sonnet-4-6'）。`).addOption(new Option('--effort <level>', `当前会话的努力程度（low、medium、high、max）`).argParser((rawValue: string) => {
    const value = rawValue.toLowerCase();
    const allowed = ['low', 'medium', 'high', 'max'];
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`必须是以下之一：${allowed.join(', ')}`);
    }
    return value;
  })).option('--agent <agent>', `当前会话使用的 agent。覆盖 'agent' 设置。`).option('--betas <betas...>', '要包含在 API 请求中的 Beta 头（仅限 API key 用户）').option('--fallback-model <model>', '当默认模型过载时，自动回退到指定模型（仅对 --print 生效）').addOption(new Option('--workload <tag>', '计费头归属的工作负载标签（cc_workload）。进程级作用域；由为 cron 任务派生子进程的 SDK 守护进程调用方设置。（仅对 --print 生效）').hideHelp()).option('--settings <file-or-json>', '设置 JSON 文件的路径，或用于加载额外设置的 JSON 字符串').option('--add-dir <directories...>', '允许工具访问的其他目录').option('--ide', '启动时若恰好存在一个有效 IDE 则自动连接', () => true).option('--strict-mcp-config', '仅使用 --mcp-config 中的 MCP 服务器，忽略所有其他 MCP 配置', () => true).option('--session-id <uuid>', '为对话使用指定的会话 ID（必须是有效的 UUID）').option('-n, --name <name>', '为此会话设置显示名称（显示在 /resume 和终端标题中）').option('--agents <json>', '定义自定义 agent 的 JSON 对象（如 \'{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}\'）').option('--setting-sources <sources>', '要加载的设置来源列表，用逗号分隔（user、project、local）。')
  // gh-33508：<paths...>（可变参数）会吞掉下一个 --flag 之前的所有内容。
  // `limkenion --plugin-dir /path mcp add --transport http` 会把 `mcp`
  // 和 `add` 当作 paths，然后在遇到未知的顶层选项 --transport 时出错。
  // 单值 + collect 累加器意味着每个 --plugin-dir 恰好取一个参数；
  // 重复该标志即可指定多个目录。
  .option('--plugin-dir <path>', '仅对本次会话从目录加载插件（可重复：--plugin-dir A --plugin-dir B）', (val: string, prev: string[]) => [...prev, val], [] as string[]).option('--disable-slash-commands', '禁用所有技能', () => true).option('--chrome', '启用 Limkenion Chrome 集成').option('--no-chrome', '禁用 Limkenion Chrome 集成').option('--file <specs...>', '启动时下载的文件资源。格式：file_id:relative_path（如 --file file_abc:doc.txt file_def:img.png）').action(async (prompt, options) => {
    profileCheckpoint('action_handler_start');

    // --bare = 一键极简模式。设置 SIMPLE 使所有现有门控生效
    //（LIMKENION.md、技能、executeHooks 内的 hooks、agent
    // 目录遍历）。必须在 setup() / 任何受门控的工作运行之前设置。
    if ((options as {
      bare?: boolean;
    }).bare) {
      process.env.LIMKENION_SIMPLE = '1';
    }

    // 将 "code" 忽略作为 prompt——与无 prompt 同等对待
    if (prompt === 'code') {
      logEvent('limkenion_code_prompt_ignored', {});
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.warn(chalk.yellow('Tip: You can launch Limkenion with just `limkenion`'));
      prompt = undefined;
    }

    // 为任意单词 prompt 记录事件
    if (prompt && typeof prompt === 'string' && !/\s/.test(prompt) && prompt.length > 0) {
      logEvent('limkenion_single_word_prompt', {
        length: prompt.length
      });
    }

    // 助手模式：当 .limkenion/settings.json 中 assistant: true 且
    // limkenion_kairos GrowthBook 门控为开时，强制启用 brief。权限
    // 模式留给用户——settings defaultMode 或 --permission-mode
    // 照常生效。REPL 输入的消息已默认 'next'
    // 优先级（messageQueueManager.enqueue），即在工具调用之间于回合内
    // 排空。SendUserMessage（BriefTool）通过 brief 环境变量启用。
    // SleepTool 保持禁用（其 isEnabled() 依赖 proactive 门控）。
    // kairosEnabled 在此计算一次，供下方更远的
    // getAssistantSystemPromptAddendum() 调用点复用。
    //
    // 信任门控：.limkenion/settings.json 在不受信任的克隆中可由攻击者控制。
    // 我们在 showSetupScreens() 显示信任对话框前运行约 1000 行代码，
    // 而到那时我们已经把 .limkenion/agents/assistant.md 追加到了系统提示词中。
    // 在目录被显式信任之前拒绝激活。
    let kairosEnabled = false;
    let assistantTeamContext: Awaited<ReturnType<NonNullable<typeof assistantModule>['initializeAssistantTeam']>> | undefined;
    if (feature('KAIROS') && (options as {
      assistant?: boolean;
    }).assistant && assistantModule) {
      // --assistant（Agent SDK 守护进程模式）：在下面的
      // isAssistantMode() 运行之前强制设置闩锁。守护进程已检查过
      // entitlement——不要让子进程重新检查 limkenion_kairos。
      assistantModule.markAssistantForced();
    }
    if (feature('KAIROS') && assistantModule?.isAssistantMode() &&
    // 生成的队友共享 leader 的 cwd 与 settings.json，因此
    // isAssistantMode() 对它们也为真。设置了 --agent-id
    // 意味着我们就是生成的队友（extractTeammateOptions 约 170 行之后
    // 才运行，所以要检查原始的 commander 选项）——不要
    // 重新初始化团队或覆盖 teammateMode/proactive/brief。
    !(options as {
      agentId?: unknown;
    }).agentId && kairosGate) {
      if (!checkHasTrustDialogAccepted()) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.warn(chalk.yellow('Assistant mode disabled: directory is not trusted. Accept the trust dialog and restart.'));
      } else {
        // 阻塞式门控检查——缓存命中立即返回 `true`；若磁盘
        // 缓存为 false/缺失，则惰性初始化 GrowthBook 并获取最新结果
        //（最长约 5s）。--assistant 完全跳过该门控（守护进程
        // 已预授权）。
        kairosEnabled = assistantModule.isAssistantForced() || (await kairosGate.isKairosEnabled());
        if (kairosEnabled) {
          const opts = options as {
            brief?: boolean;
          };
          opts.brief = true;
          setKairosActive(true);
          // 预置一个进程内团队，使 Agent(name: "foo") 无需 TeamCreate
          // 即可生成队友。必须在 setup() 捕获 teammateMode
          // 快照之前运行（initializeAssistantTeam 内部会调用
          // setCliTeammateModeOverride）。
          assistantTeamContext = await assistantModule.initializeAssistantTeam();
        }
      }
    }
    const {
      debug = false,
      debugToStderr = false,
      dangerouslySkipPermissions,
      allowDangerouslySkipPermissions = false,
      tools: baseTools = [],
      allowedTools = [],
      disallowedTools = [],
      mcpConfig = [],
      permissionMode: permissionModeCli,
      addDir = [],
      fallbackModel,
      betas = [],
      ide = false,
      sessionId,
      includeHookEvents,
      includePartialMessages
    } = options;
    if (options.prefill) {
      seedEarlyInput(options.prefill);
    }

    // 文件下载的 Promise——提前启动，在 REPL 渲染前等待
    let fileDownloadPromise: Promise<DownloadResult[]> | undefined;
    const agentsJson = options.agents;
    const agentCli = options.agent;
    if (feature('BG_SESSIONS') && agentCli) {
      process.env.LIMKENION_AGENT = agentCli;
    }

    // 注意：LSP manager 的初始化有意延迟到信任对话框被接受之后。
    // 这可以防止插件 LSP 服务器在用户同意之前于不受信任的目录中执行代码。

    // 分开提取这些项，以便需要时可以被修改
    let outputFormat = options.outputFormat;
    let inputFormat = options.inputFormat;
    let verbose = options.verbose ?? getGlobalConfig().verbose;
    let print = options.print;
    const init = options.init ?? false;
    const initOnly = options.initOnly ?? false;
    const maintenance = options.maintenance ?? false;

    // 提取禁用技能命令标志
    const disableSlashCommands = options.disableSlashCommands || false;

    // 提取 tasks 模式选项（仅 Ant）
    const tasksOption = false;
    const taskListId = tasksOption ? typeof tasksOption === 'string' ? tasksOption : DEFAULT_TASKS_MODE_TASK_LIST_ID : undefined;
    

    // 提取 worktree 选项
    // worktree 可以是 true（无值标志）或字符串（自定义名称或 PR 引用）
    const worktreeOption = isWorktreeModeEnabled() ? (options as {
      worktree?: boolean | string;
    }).worktree : undefined;
    let worktreeName = typeof worktreeOption === 'string' ? worktreeOption : undefined;
    const worktreeEnabled = worktreeOption !== undefined;

    // 检查 worktree 名称是否为 PR 引用（#N 或 GitHub PR URL）
    let worktreePRNumber: number | undefined;
    if (worktreeName) {
      const prNum = parsePRReference(worktreeName);
      if (prNum !== null) {
        worktreePRNumber = prNum;
        worktreeName = undefined; // slug 将在 setup() 中生成
      }
    }

    // 提取 tmux 选项（需要 --worktree）
    const tmuxEnabled = isWorktreeModeEnabled() && (options as {
      tmux?: boolean;
    }).tmux === true;

    // 校验 tmux 选项
    if (tmuxEnabled) {
      if (!worktreeEnabled) {
        process.stderr.write(chalk.red('错误：--tmux 需要同时指定 --worktree\n'));
        process.exit(1);
      }
      if (getPlatform() === 'windows') {
        process.stderr.write(chalk.red('错误：Windows 不支持 --tmux\n'));
        process.exit(1);
      }
      if (!(await isTmuxAvailable())) {
        process.stderr.write(chalk.red(`错误：未安装 tmux。\n${getTmuxInstallInstructions()}\n`));
        process.exit(1);
      }
    }

    // 提取队友选项（用于 tmux 生成的 agent）
    // 声明在 if 块之外，以便稍后为系统提示词附加内容所用
    let storedTeammateOpts: TeammateOptions | undefined;
    if (isAgentSwarmsEnabled()) {
      // 提取 agent 身份选项（用于 tmux 生成的 agent）
      // 这些会替换 LIMKENION_* 环境变量
      const teammateOpts = extractTeammateOptions(options);
      storedTeammateOpts = teammateOpts;

      // 若提供了任一队友身份选项，则三个必填项都必须存在
      const hasAnyTeammateOpt = teammateOpts.agentId || teammateOpts.agentName || teammateOpts.teamName;
      const hasAllRequiredTeammateOpts = teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName;
      if (hasAnyTeammateOpt && !hasAllRequiredTeammateOpts) {
        process.stderr.write(chalk.red('错误：--agent-id、--agent-name 与 --team-name 必须同时提供\n'));
        process.exit(1);
      }

      // 若通过 CLI 提供队友身份，则设置 dynamicTeamContext
      if (teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName) {
        getTeammateUtils().setDynamicTeamContext?.({
          agentId: teammateOpts.agentId,
          agentName: teammateOpts.agentName,
          teamName: teammateOpts.teamName,
          color: teammateOpts.agentColor,
          planModeRequired: teammateOpts.planModeRequired ?? false,
          parentSessionId: teammateOpts.parentSessionId
        });
      }

      // 若提供了队友模式 CLI 覆盖则设置之
      // 必须在 setup() 捕获快照之前完成
      if (teammateOpts.teammateMode) {
        getTeammateModeSnapshot().setCliTeammateModeOverride?.(teammateOpts.teammateMode);
      }
    }

    // 提取远程 sdk 选项
    const sdkUrl = (options as {
      sdkUrl?: string;
    }).sdkUrl ?? undefined;

    // 允许通过环境变量启用部分消息（沙箱网关用于 baku）
    const effectiveIncludePartialMessages = includePartialMessages || isEnvTruthy(process.env.LIMKENION_INCLUDE_PARTIAL_MESSAGES);

    // 当通过 SDK 选项显式请求，或在 LIMKENION_REMOTE 模式下
    // 运行时启用所有 hook 事件类型（CCR 需要它们）。
    // 否则，只会发出 SessionStart 和 Setup 事件。
    if (includeHookEvents || isEnvTruthy(process.env.LIMKENION_REMOTE)) {
      setAllHookEventsEnabled(true);
    }

    // 提供 SDK URL 时自动设置输入/输出格式、详细模式与 print 模式
    if (sdkUrl) {
      // 若提供 SDK URL，除非显式设置，否则自动使用 stream-json 格式
      if (!inputFormat) {
        inputFormat = 'stream-json';
      }
      if (!outputFormat) {
        outputFormat = 'stream-json';
      }
      // 除非显式禁用或已设置，否则自动启用详细模式
      if (options.verbose === undefined) {
        verbose = true;
      }
      // 除非显式禁用，否则自动启用 print 模式
      if (!options.print) {
        print = true;
      }
    }

    // 提取 teleport 选项
    const teleport = (options as {
      teleport?: string | true;
    }).teleport ?? null;

    // 提取 remote 选项（可为 true[无描述时] 或字符串）
    const remoteOption = (options as {
      remote?: string | true;
    }).remote;
    const remote = remoteOption === true ? '' : remoteOption ?? null;

    // 提取 --remote-control / --rc 标志（在交互式会话中启用桥接）
    const remoteControlOption = (options as {
      remoteControl?: string | true;
    }).remoteControl ?? (options as {
      rc?: string | true;
    }).rc;
    // 实际的桥接检查延迟到 showSetupScreens() 之后，
    // 以便建立信任且 GrowthBook 带有认证头。
    let remoteControl = false;
    const remoteControlName = typeof remoteControlOption === 'string' && remoteControlOption.length > 0 ? remoteControlOption : undefined;

    // 若提供会话 ID 则进行校验
    if (sessionId) {
      // 检查冲突的标志
      // --session-id 可与 --continue 或 --resume 一起使用，前提是同时提供 --fork-session
      //（用于为 fork 出来的会话指定自定义 ID）
      if ((options.continue || options.resume) && !options.forkSession) {
        process.stderr.write(chalk.red('错误：只有同时指定 --fork-session 时，--session-id 才能与 --continue 或 --resume 一起使用。\n'));
        process.exit(1);
      }

      // 当提供 --sdk-url 时（bridge/远程模式），会话 ID 是服务端分配的
      // 带标签的 ID（如 "session_local_01..."），而非 UUID。
      // 该情况下跳过 UUID 校验与本地存在性检查。
      if (!sdkUrl) {
        const validatedSessionId = validateUuid(sessionId);
        if (!validatedSessionId) {
          process.stderr.write(chalk.red('错误：无效的会话 ID，必须是有效的 UUID。\n'));
          process.exit(1);
        }

        // 检查会话 ID 是否已存在
        if (sessionIdExists(validatedSessionId)) {
          process.stderr.write(chalk.red(`错误：会话 ID ${validatedSessionId} 已在使用中。\n`));
          process.exit(1);
        }
      }
    }

    // 若通过 --file 标志指定，则下载文件资源
    const fileSpecs = (options as {
      file?: string[];
    }).file;
    if (fileSpecs && fileSpecs.length > 0) {
      // 获取会话接入令牌（由 EnvManager 通过 LIMKENION_SESSION_ACCESS_TOKEN 提供）
      const sessionToken = getSessionIngressAuthToken();
      if (!sessionToken) {
        process.stderr.write(chalk.red('错误：下载文件需要会话令牌。必须设置 LIMKENION_SESSION_ACCESS_TOKEN。\n'));
        process.exit(1);
      }

      // 解析会话 ID：优先使用远程会话 ID，回退到内部会话 ID
      const fileSessionId = process.env.LIMKENION_REMOTE_SESSION_ID || getSessionId();
      const files = parseFileSpecs(fileSpecs);
      if (files.length > 0) {
        // 若设置了 LIMKENION_BASE_URL（由 EnvManager）则使用之，否则使用 OAuth 配置
        // 这确保所有环境与会话接入 API 保持一致
        const config: FilesApiConfig = {
          baseUrl: process.env.LIMKENION_BASE_URL || getOauthConfig().BASE_API_URL,
          oauthToken: sessionToken,
          sessionId: fileSessionId
        };

        // 以不阻塞启动的方式开始下载——在 REPL 渲染前等待
        fileDownloadPromise = downloadSessionFiles(files, config);
      }
    }

    // 从 state 获取 isNonInteractiveSession（在 init() 之前已设置）
    const isNonInteractiveSession = getIsNonInteractiveSession();

    // 校验回退模型与主模型不同
    if (fallbackModel && options.model && fallbackModel === options.model) {
      process.stderr.write(chalk.red('错误：回退模型（--fallback-model）不能与主模型相同。请为 --fallback-model 指定不同的模型。\n'));
      process.exit(1);
    }

    // 处理系统提示词选项
    let systemPrompt = options.systemPrompt;
    if (options.systemPromptFile) {
      if (options.systemPrompt) {
        process.stderr.write(chalk.red('错误：不能同时使用 --system-prompt 和 --system-prompt-file，请只使用其中一个。\n'));
        process.exit(1);
      }
      try {
        const filePath = resolve(options.systemPromptFile);
        systemPrompt = readFileSync(filePath, 'utf8');
      } catch (error) {
        const code = getErrnoCode(error);
        if (code === 'ENOENT') {
          process.stderr.write(chalk.red(`错误：未找到系统提示词文件：${resolve(options.systemPromptFile)}\n`));
          process.exit(1);
        }
        process.stderr.write(chalk.red(`读取系统提示词文件出错：${errorMessage(error)}\n`));
        process.exit(1);
      }
    }

    // 处理追加系统提示词选项
    let appendSystemPrompt = options.appendSystemPrompt;
    if (options.appendSystemPromptFile) {
      if (options.appendSystemPrompt) {
        process.stderr.write(chalk.red('错误：不能同时使用 --append-system-prompt 和 --append-system-prompt-file，请只使用其中一个。\n'));
        process.exit(1);
      }
      try {
        const filePath = resolve(options.appendSystemPromptFile);
        appendSystemPrompt = readFileSync(filePath, 'utf8');
      } catch (error) {
        const code = getErrnoCode(error);
        if (code === 'ENOENT') {
          process.stderr.write(chalk.red(`错误：未找到追加系统提示词文件：${resolve(options.appendSystemPromptFile)}\n`));
          process.exit(1);
        }
        process.stderr.write(chalk.red(`读取追加系统提示词文件出错：${errorMessage(error)}\n`));
        process.exit(1);
      }
    }

    // 为 tmux 队友添加队友专属的系统提示词附加内容
    if (isAgentSwarmsEnabled() && storedTeammateOpts?.agentId && storedTeammateOpts?.agentName && storedTeammateOpts?.teamName) {
      const addendum = getTeammatePromptAddendum().TEAMMATE_SYSTEM_PROMPT_ADDENDUM;
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${addendum}` : addendum;
    }
    const {
      mode: permissionMode,
      notification: permissionModeNotification
    } = initialPermissionModeFromCLI({
      permissionModeCli,
      dangerouslySkipPermissions
    });

    // 存储会话绕过权限模式，供信任对话框检查使用
    setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions');
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      // autoModeFlagCli 是“用户是否打算本次会话使用自动模式”的信号。
      // 在以下情况设置：--enable-auto-mode、--permission-mode auto、解析出的模式
      // 为 auto，或 settings defaultMode 为 auto 但门控拒绝
      //（permissionMode 解析为 default 且无显式 CLI 覆盖）。
      // verifyAutoModeGateAccess 用它来决定是否在 auto 不可用时发出通知，
      // limkenion_auto_mode_config 可选加入轮播也用到它。
      if ((options as {
        enableAutoMode?: boolean;
      }).enableAutoMode || permissionModeCli === 'auto' || permissionMode === 'auto' || !permissionModeCli && isDefaultPermissionModeAuto()) {
        autoModeStateModule?.setAutoModeFlagCli(true);
      }
    }

    // 若提供了 MCP 配置文件/字符串则进行解析
    let dynamicMcpConfig: Record<string, ScopedMcpServerConfig> = {};
    if (mcpConfig && mcpConfig.length > 0) {
      // 处理 mcpConfig 数组
      const processedConfigs = mcpConfig.map(config => config.trim()).filter(config => config.length > 0);
      let allConfigs: Record<string, McpServerConfig> = {};
      const allErrors: ValidationError[] = [];
      for (const configItem of processedConfigs) {
        let configs: Record<string, McpServerConfig> | null = null;
        let errors: ValidationError[] = [];

        // 首先尝试作为 JSON 字符串解析
        const parsedJson = safeParseJSON(configItem);
        if (parsedJson) {
          const result = parseMcpConfig({
            configObject: parsedJson,
            filePath: 'command line',
            expandVars: true,
            scope: 'dynamic'
          });
          if (result.config) {
            configs = result.config.mcpServers;
          } else {
            errors = result.errors;
          }
        } else {
          // 尝试作为文件路径
          const configPath = resolve(configItem);
          const result = parseMcpConfigFromFilePath({
            filePath: configPath,
            expandVars: true,
            scope: 'dynamic'
          });
          if (result.config) {
            configs = result.config.mcpServers;
          } else {
            errors = result.errors;
          }
        }
        if (errors.length > 0) {
          allErrors.push(...errors);
        } else if (configs) {
          // 合并配置，后指定的覆盖先前指定的
          allConfigs = {
            ...allConfigs,
            ...configs
          };
        }
      }
      if (allErrors.length > 0) {
        const formattedErrors = allErrors.map(err => `${err.path ? err.path + ': ' : ''}${err.message}`).join('\n');
        logForDebugging(`--mcp-config validation failed (${allErrors.length} errors): ${formattedErrors}`, {
          level: 'error'
        });
        process.stderr.write(`错误：无效的 MCP 配置：\n${formattedErrors}\n`);
        process.exit(1);
      }
      if (Object.keys(allConfigs).length > 0) {
        // SDK 宿主（Nest/Desktop）拥有自己的服务器命名，可复用内置
        // 名称——对 type:'sdk' 跳过保留名称检查。
        const nonSdkConfigNames = Object.entries(allConfigs).filter(([, config]) => config.type !== 'sdk').map(([name]) => name);
        let reservedNameError: string | null = null;
        if (nonSdkConfigNames.some(isLimkenionInChromeMCPServer)) {
          reservedNameError = `无效的 MCP 配置："${LIMKENION_IN_CHROME_MCP_SERVER_NAME}" 是保留的 MCP 名称。`;
        } else if (feature('CHICAGO_MCP')) {
          const {
            isComputerUseMCPServer,
            COMPUTER_USE_MCP_SERVER_NAME
          } = await import('src/utils/computerUse/common.js');
          if (nonSdkConfigNames.some(isComputerUseMCPServer)) {
            reservedNameError = `无效的 MCP 配置："${COMPUTER_USE_MCP_SERVER_NAME}" 是保留的 MCP 名称。`;
          }
        }
        if (reservedNameError) {
          // stderr+exit(1) —— 若此处 throw，在 stream-json 模式下会变成
          // 静默未处理的 rejection（cli.tsx 中的 void main()）。
          process.stderr.write(`Error: ${reservedNameError}\n`);
          process.exit(1);
        }

        // 为所有配置添加 dynamic 作用域。type:'sdk' 条目原样通过——
        // 它们在下方被提取到 sdkMcpConfigs 并传给 print.ts。
        // Python SDK 依赖此路径（它不在 initialize 消息中发送
        // sdkMcpServers）。丢弃它们会破坏 Coworker（inc-5122）。下面的策略过滤
        // 已豁免 type:'sdk'，且这些条目在没有 stdin 上的 SDK 传输时是惰性的，
        // 因此放行它们不存在绕过风险。
        const scopedConfigs = mapValues(allConfigs, config => ({
          ...config,
          scope: 'dynamic' as const
        }));

        // 对 --mcp-config 服务器强制执行受管策略
        //（allowedMcpServers / deniedMcpServers）。否则，CLI 标志会绕过
        // 在 getLimkenionMcpConfigs 中 user/project/local 配置所经过的
        // 企业允许列表——调用方会把 dynamicMcpConfig 展开回
        // 过滤结果的顶部。在此源头过滤，让所有
        // 下游消费者都能看到策略过滤后的集合。
        const {
          allowed,
          blocked
        } = filterMcpServersByPolicy(scopedConfigs);
        if (blocked.length > 0) {
          process.stderr.write(`Warning: MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`);
        }
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...allowed
        };
      }
    }

    // 提取 Limkenion in Chrome 选项并强制 远端服务 订阅者检查（除非用户是 Ant）
    const chromeOpts = options as {
      chrome?: boolean;
    };
    // 存储显式的 CLI 标志，以便队友继承
    setChromeFlagOverride(chromeOpts.chrome);
    const enableLimkenionInChrome = shouldEnableLimkenionInChrome(chromeOpts.chrome) && ((isLimkenionAISubscriber()));
    const autoEnableLimkenionInChrome = !enableLimkenionInChrome && shouldAutoEnableLimkenionInChrome();
    if (enableLimkenionInChrome) {
      const platform = getPlatform();
      try {
        logEvent('limkenion_limkenion_in_chrome_setup', {
          platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        const {
          mcpConfig: chromeMcpConfig,
          allowedTools: chromeMcpTools,
          systemPrompt: chromeSystemPrompt
        } = setupLimkenionInChrome();
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...chromeMcpConfig
        };
        allowedTools.push(...chromeMcpTools);
        if (chromeSystemPrompt) {
          appendSystemPrompt = appendSystemPrompt ? `${chromeSystemPrompt}\n\n${appendSystemPrompt}` : chromeSystemPrompt;
        }
      } catch (error) {
        logEvent('limkenion_limkenion_in_chrome_setup_failed', {
          platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        logForDebugging(`[Limkenion in Chrome] Error: ${error}`);
        logError(error);
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`错误：Limkenion Chrome 集成运行失败。`);
        process.exit(1);
      }
    } else if (autoEnableLimkenionInChrome) {
      try {
        const {
          mcpConfig: chromeMcpConfig
        } = setupLimkenionInChrome();
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...chromeMcpConfig
        };
        const hint = feature('WEB_BROWSER_TOOL') && typeof Bun !== 'undefined' && 'WebView' in Bun ? LIMKENION_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER : LIMKENION_IN_CHROME_SKILL_HINT;
        appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${hint}` : hint;
      } catch (error) {
        // 静默跳过自动启用时的任何错误
        logForDebugging(`[Limkenion in Chrome] Error (auto-enable): ${error}`);
      }
    }

    // 提取严格的 MCP 配置标志
    const strictMcpConfig = options.strictMcpConfig || false;

    // 检查是否存在企业 MCP 配置。若存在，仅允许包含特
    // 殊服务器类型（sdk）的动态 MCP 配置
    if (doesEnterpriseMcpConfigExist()) {
      if (strictMcpConfig) {
        process.stderr.write(chalk.red('You cannot use --strict-mcp-config when an enterprise MCP config is present'));
        process.exit(1);
      }

      // 对企业 MCP 配置来说，--mcp-config 仅当所有服务器均为内部类型（sdk）时允许
      if (dynamicMcpConfig && !areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)) {
        process.stderr.write(chalk.red('You cannot dynamically configure MCP servers when an enterprise MCP config is present'));
        process.exit(1);
      }
    }

    // chicago MCP：受门控的 Computer Use（应用白名单 + 前台门控 +
    // SCContentFilter 截屏）。仅 Ant、GrowthBook 门控——失败
    // 静默（属内部试用）。平台 + 交互式检查内联
    // 执行，使非 macOS / print 模式的 Ant 完全跳过繁重的
    // @ant/computer-use-mcp import。gates.js 很轻（仅类型导入包）。
    //
    // 位于企业 MCP 配置检查之后：该检查会拒绝任何
    // `type !== 'sdk'` 的 dynamicMcpConfig 条目，而我们的配置是
    // `type: 'stdio'`。否则，开启 GB 门控的企业配置 Ant 会在
    // process.exit(1)。Chrome 存在同样的潜在问题但一直
    // 未出事故；chicago 正确地放置了自己。
    if (feature('CHICAGO_MCP') && getPlatform() === 'macos' && !getIsNonInteractiveSession()) {
      try {
        const {
          getChicagoEnabled
        } = await import('src/utils/computerUse/gates.js');
        if (getChicagoEnabled()) {
          const {
            setupComputerUseMCP
          } = await import('src/utils/computerUse/setup.js');
          const {
            mcpConfig,
            allowedTools: cuTools
          } = setupComputerUseMCP();
          dynamicMcpConfig = {
            ...dynamicMcpConfig,
            ...mcpConfig
          };
          allowedTools.push(...cuTools);
        }
      } catch (error) {
        logForDebugging(`[Computer Use MCP] Setup failed: ${errorMessage(error)}`);
      }
    }

    // 为 LIMKENION.md 加载存储额外目录（由环境变量控制）
    setAdditionalDirectoriesForLimkenionMd(addDir);

    // --channels 标志的频道服务器白名单——其入站
    // 推送通知应注册本会话的服务器。该选项
    // 在 feature() 块内添加，因此 TS 在 options 类型上
    // 并不知道它——与 main.tsx:1824 处的 --assistant 模式相同。
    // devChannels 被延迟：showSetupScreens 显示确认对话框，
    // 仅在接受时追加到 allowedChannels。
    let devChannels: ChannelEntry[] | undefined;
    if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
      // 将 plugin:name@marketplace / server:Y 标签解析成类型化条目。
      // 标签决定下游的信任模型：plugin 类命中市场
      // 验证 + GrowthBook 白名单，server 类在未设置 dev 标志时始终
      // 匹配失败白名单（schema 仅允许插件）。未打标签或无市场的
      // 插件条目是硬错误——在门控中静默不匹配会让人觉得频道
      // “已开启”但从未触发任何东西。
      const parseChannelEntries = (raw: string[], flag: string): ChannelEntry[] => {
        const entries: ChannelEntry[] = [];
        const bad: string[] = [];
        for (const c of raw) {
          if (c.startsWith('plugin:')) {
            const rest = c.slice(7);
            const at = rest.indexOf('@');
            if (at <= 0 || at === rest.length - 1) {
              bad.push(c);
            } else {
              entries.push({
                kind: 'plugin',
                name: rest.slice(0, at),
                marketplace: rest.slice(at + 1)
              });
            }
          } else if (c.startsWith('server:') && c.length > 7) {
            entries.push({
              kind: 'server',
              name: c.slice(7)
            });
          } else {
            bad.push(c);
          }
        }
        if (bad.length > 0) {
          process.stderr.write(chalk.red(`${flag} entries must be tagged: ${bad.join(', ')}\n` + `  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n` + `  server:<name>                — manually configured MCP server\n`));
          process.exit(1);
        }
        return entries;
      };
      const channelOpts = options as {
        channels?: string[];
        dangerouslyLoadDevelopmentChannels?: string[];
      };
      const rawChannels = channelOpts.channels;
      const rawDev = channelOpts.dangerouslyLoadDevelopmentChannels;
      // 始终解析并设置。ChannelsNotice 读取 getAllowedChannels() 并
      // 在启动画面中渲染相应分支（disabled/noAuth/policyBlocked/
      // listening）。gateChannelServer() 执行强制。
      // --channels 在交互式和 print/SDK 模式下均可用；dev-channels
      // 保持仅交互式（需要确认对话框）。
      let channelEntries: ChannelEntry[] = [];
      if (rawChannels && rawChannels.length > 0) {
        channelEntries = parseChannelEntries(rawChannels, '--channels');
        setAllowedChannels(channelEntries);
      }
      if (!isNonInteractiveSession) {
        if (rawDev && rawDev.length > 0) {
          devChannels = parseChannelEntries(rawDev, '--dangerously-load-development-channels');
        }
      }
      // 标志使用遥测。记录插件标识符（与
      // limkenion_plugin_installed 同层——公开注册表风格名称）；server 类
      // 名称不记录（MCP 服务器名层级，其他地方仅可选加入）。
      // 每个服务器的门控结果在服务器连接后落入
      // limkenion_mcp_channel_gate。dev 条目在此之后经过确认对话框——
      // dev_plugins 捕获的是所输入的内容，而非被接受的内容。
      if (channelEntries.length > 0 || (devChannels?.length ?? 0) > 0) {
        const joinPluginIds = (entries: ChannelEntry[]) => {
          const ids = entries.flatMap(e => e.kind === 'plugin' ? [`${e.name}@${e.marketplace}`] : []);
          return ids.length > 0 ? ids.sort().join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS : undefined;
        };
        logEvent('limkenion_mcp_channel_flags', {
          channels_count: channelEntries.length,
          dev_count: devChannels?.length ?? 0,
          plugins: joinPluginIds(channelEntries),
          dev_plugins: joinPluginIds(devChannels ?? [])
        });
      }
    }

    // 通过 --tools 对 SendUserMessage 进行 SDK 可选加入。所有会话都需要
    // 显式可选加入；在 --tools 中列出它表示意图。它在
    // initializeToolPermissionContext 之前运行，使 getToolsForDefaultPreset()
    // 在计算基础工具禁用过滤器时将该工具视为已启用。
    // 条件 require 避免把工具名泄漏到
    // 外部构建中。
    if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && baseTools.length > 0) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const {
        BRIEF_TOOL_NAME,
        LEGACY_BRIEF_TOOL_NAME
      } = require('./tools/BriefTool/prompt.js') as typeof import('./tools/BriefTool/prompt.js');
      const {
        isBriefEntitled
      } = require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const parsed = parseToolListFromCLI(baseTools);
      if ((parsed.includes(BRIEF_TOOL_NAME) || parsed.includes(LEGACY_BRIEF_TOOL_NAME)) && isBriefEntitled()) {
        setUserMsgOptIn(true);
      }
    }

    // 此 await 替换了原本已在启动路径中的阻塞式 existsSync/statSync 调用。
    // 墙钟时间不变；我们只是在 fs I/O 期间让出事件循环
    // 而不是阻塞它。参见 #19661。
    const initResult = await initializeToolPermissionContext({
      allowedToolsCli: allowedTools,
      disallowedToolsCli: disallowedTools,
      baseToolsCli: baseTools,
      permissionMode,
      allowDangerouslySkipPermissions,
      addDirs: addDir
    });
    let toolPermissionContext = initResult.toolPermissionContext;
    const {
      warnings,
      dangerousPermissions,
      overlyBroadBashPermissions
    } = initResult;

    // 为 Ant 用户处理过宽的 shell 允许规则（Bash(*)、PowerShell(*)）
    
    if (feature('TRANSCRIPT_CLASSIFIER') && dangerousPermissions.length > 0) {
      toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext);
    }

    // 打印初始化产生的任何警告
    warnings.forEach(warning => {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(warning);
    });
    void assertMinVersion();

    // 远端服务 配置获取：仅 -p 模式（交互式使用 useManageMCPConnections
    // 两阶段加载）。在此触发以与 setup() 重叠；在 runHeadless
    // 之前等待，使单轮 -p 能看到连接器。在企业/
    // 严格 MCP 下跳过以保持策略边界。
    const limkenionaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>> = isNonInteractiveSession && !strictMcpConfig && !doesEnterpriseMcpConfigExist() &&
    // --bare / SIMPLE：跳过 远端服务 代理服务器（datadog、Gmail、
    // Slack、BigQuery、PubMed——每个连通需 6-14s）。需要 MCP 的脚本化调用
    // 通过 --mcp-config 显式传入。
    !isBareMode() ? fetchLimkenionAIMcpConfigsIfEligible().then(configs => {
      const {
        allowed,
        blocked
      } = filterMcpServersByPolicy(configs);
      if (blocked.length > 0) {
        process.stderr.write(`Warning: limkenion.ai MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`);
      }
      return allowed;
    }) : Promise.resolve({});

    // 尽早启动 MCP 配置加载（安全——只读取文件，不执行）。
    // 交互式和 -p 都使用 getLimkenionMcpConfigs（仅本地文件读取）。
    // 本地 Promise 稍后才被等待（位于 prefetchAllMcpResources 之前），以便
    // 使配置 I/O 与 setup()、命令加载和信任对话框重叠。
    logForDebugging('[STARTUP] Loading MCP configs...');
    const mcpConfigStart = Date.now();
    let mcpConfigResolvedMs: number | undefined;
    // --bare 跳过自动发现的 MCP（.mcp.json、用户设置、插件）——
    // 只有显式的 --mcp-config 生效。dynamicMcpConfig 在下游被展开到
    // allMcpConfigs 上，因此该跳过得以保留。
    const mcpConfigPromise = (strictMcpConfig || isBareMode() ? Promise.resolve({
      servers: {} as Record<string, ScopedMcpServerConfig>
    }) : getLimkenionMcpConfigs(dynamicMcpConfig)).then(result => {
      mcpConfigResolvedMs = Date.now() - mcpConfigStart;
      return result;
    });

    // 注意：我们这里不调用 prefetchAllMcpResources——它被延迟到信任对话框之后

    if (inputFormat && inputFormat !== 'text' && inputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: Invalid input format "${inputFormat}".`);
      process.exit(1);
    }
    if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: --input-format=stream-json requires output-format=stream-json.`);
      process.exit(1);
    }

    // 校验 sdkUrl 只与相应格式一起使用（格式已在上面自动设置）
    if (sdkUrl) {
      if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`错误：--sdk-url 需要同时使用 --input-format=stream-json 和 --output-format=stream-json。`);
        process.exit(1);
      }
    }

    // 校验 replayUserMessages 只与 stream-json 格式一起使用
    if (options.replayUserMessages) {
      if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`错误：--replay-user-messages 需要同时使用 --input-format=stream-json 和 --output-format=stream-json。`);
        process.exit(1);
      }
    }

    // 校验 includePartialMessages 只与 print 模式和 stream-json 输出一起使用
    if (effectiveIncludePartialMessages) {
      if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
        writeToStderr(`错误：--include-partial-messages 需要 --print 和 --output-format=stream-json。`);
        process.exit(1);
      }
    }

    // 校验 --no-session-persistence 只与 print 模式一起使用
    if (options.sessionPersistence === false && !isNonInteractiveSession) {
      writeToStderr(`Error: --no-session-persistence can only be used with --print mode.`);
      process.exit(1);
    }
    const effectivePrompt = prompt || '';
    let inputPrompt = await getInputPrompt(effectivePrompt, (inputFormat ?? 'text') as 'text' | 'stream-json');
    profileCheckpoint('action_after_input_prompt');

    // 在 getTools() 之前激活 proactive 模式，使 SleepTool.isEnabled()
    //（它返回 isProactiveActive()）通过，Sleep 被包含进来。
    // 后面的 REPL 路径 maybeActivateProactive() 调用是幂等的。
    maybeActivateProactive(options);
    let tools = getTools(toolPermissionContext);

    // 为无头路径应用协调器模式的工具过滤
    //（与 REPL/交互式路径的 useMergedTools.ts 过滤对应）
    if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.LIMKENION_COORDINATOR_MODE)) {
      const {
        applyCoordinatorToolFilter
      } = await import('./utils/toolPool.js');
      tools = applyCoordinatorToolFilter(tools);
    }
    profileCheckpoint('action_tools_loaded');
    let jsonSchema: ToolInputJSONSchema | undefined;
    if (isSyntheticOutputToolEnabled({
      isNonInteractiveSession
    }) && options.jsonSchema) {
      jsonSchema = jsonParse(options.jsonSchema) as ToolInputJSONSchema;
    }
    if (jsonSchema) {
      const syntheticOutputResult = createSyntheticOutputTool(jsonSchema);
      if ('tool' in syntheticOutputResult) {
        // 在 getTools() 过滤之后将 SyntheticOutputTool 添加到工具数组。
        // 该工具被排除在常规过滤之外（参见 tools.ts），因为它是
        // 结构化输出的实现细节，而非用户可控的工具。
        tools = [...tools, syntheticOutputResult.tool];
        logEvent('limkenion_structured_output_enabled', {
          schema_property_count: Object.keys(jsonSchema.properties as Record<string, unknown> || {}).length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          has_required_fields: Boolean(jsonSchema.required) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      } else {
        logEvent('limkenion_structured_output_failure', {
          error: 'Invalid JSON schema' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      }
    }

    // 重要：必须在任何依赖 cwd 或 worktree 设置的其他代码之前调用 setup()
    profileCheckpoint('action_before_setup');
    logForDebugging('[STARTUP] Running setup()...');
    const setupStart = Date.now();
    const {
      setup
    } = await import('./setup.js');
    const messagingSocketPath = feature('UDS_INBOX') ? (options as {
      messagingSocketPath?: string;
    }).messagingSocketPath : undefined;
    // 将 setup() 与命令+agent 加载并行化。setup() 的约 28ms
    // 主要是 startUdsMessaging（socket 绑定，约 20ms）——非磁盘密集型，
    // 因此不会与 getCommands 的文件读取争用。因 !worktreeEnabled
    // 而门控，因为 --worktree 会使 setup() process.chdir()（setup.ts:203），
    // 而命令/agent 需要 chdir 之后的 cwd。
    const preSetupCwd = getCwd();
    // 在触发 getCommands() 之前注册内置技能/插件——它们是
    // 纯粹的进程内数组推送（<1ms、零 I/O），由 getBundledSkills()
    // 同步读取。此前在 setup() 内约 20ms 的等待点之后运行，导致
    // 并行的 getCommands() 把空列表记忆化了。
    if (process.env.LIMKENION_ENTRYPOINT !== 'local-agent') {
      initBuiltinPlugins();
      initBundledSkills();
    }
    const setupPromise = setup(preSetupCwd, permissionMode, allowDangerouslySkipPermissions, worktreeEnabled, worktreeName, tmuxEnabled, sessionId ? validateUuid(sessionId) : undefined, worktreePRNumber, messagingSocketPath);
    const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd);
    const agentDefsPromise = worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd);
    // 若这些 Promise 在下面约 28ms 的 setupPromise await 期间、被 Promise.all
    // 汇聚之前 reject，则抑制瞬态的 unhandledRejection。
    commandsPromise?.catch(() => {});
    agentDefsPromise?.catch(() => {});
    await setupPromise;
    logForDebugging(`[STARTUP] setup() completed in ${Date.now() - setupStart}ms`);
    profileCheckpoint('action_after_setup');

    // 仅当套接字被显式请求时，才将用户消息重放到 stream-json。
    // 自动生成的套接字是被动的——它让工具按需注入，
    // 但默认开启不应重塑不接触它的 SDK 消费者的 stream-json。
    // 既注入又想这些注入在流中可见的调用方会显式传入
    // --messaging-socket-path（或 --replay-user-messages）。
    let effectiveReplayUserMessages = !!options.replayUserMessages;
    if (feature('UDS_INBOX')) {
      if (!effectiveReplayUserMessages && outputFormat === 'stream-json') {
        effectiveReplayUserMessages = !!(options as {
          messagingSocketPath?: string;
        }).messagingSocketPath;
      }
    }
    if (getIsNonInteractiveSession()) {
      // 现在应用完整合并后的设置环境（包括项目级
      // .limkenion/settings.json 的 PATH/GIT_DIR/GIT_WORK_TREE），使 gitExe() 和
      // 下面的 git spawn 能看到它。-p 模式中信任是隐式的；managedEnv.ts:96-97
      // 的文档字符串说这会从所有
      // 来源应用 “潜在危险的环境变量，如 LD_PRELOAD、PATH”。
      // 下面 isNonInteractiveSession 块中稍后的调用是幂等的
      //（Object.assign，configureGlobalAgents 会弹出先前的
      // 拦截器）并拾取插件初始化后任何插件贡献的环境变量。
      // 项目设置在这里已经加载：
      // init() 中的 applySafeConfigEnvironmentVariables 调用了
      // managedEnv.ts:86 的 getSettings_DEPRECATED，后者合并所有已启用的
      // 来源，包括 projectSettings/localSettings。
      applyConfigEnvironmentVariables();

      // 现在派生 git status/log/branch，使子进程执行与
      // 下面的 getCommands await 及 startDeferredPrefetches 重叠。在
      // setup() 之后（cwd 已成为最终值，setup.ts:254 可能为 --worktree
      // 执行 process.chdir(worktreePath)），并在上面的 applyConfigEnvironmentVariables
      // 之后（使来自所有来源 [受信 + 项目] 的
      // PATH/GIT_DIR/GIT_WORK_TREE 被应用）。getSystemContext 是记忆化的；
      // startDeferredPrefetches 中的 prefetchSystemContextIfSafe 调用变成
      // 缓存命中。await getIsGit() 产生的微任务在
      // 下面的 getCommands Promise.all await 处排空。-p 模式中信任是隐式的
      //（与 prefetchSystemContextIfSafe 相同的门控）。
      void getSystemContext();
      // 现在也触发 getUserContext——它的第一个 await（在
      // getMemoryFiles 中的 fs.readFile）自然让出，因此在 print.ts 中
      // 上下文 Promise.all 汇聚前约 280ms 的重叠窗口内，
      // LIMKENION.md 目录遍历得以运行。startDeferredPrefetches
      // 中的 void getUserContext() 变成记忆化缓存命中。
      void getUserContext();
      // 现在触发 ensureModelStringsInitialized——对 Bedrock，这会触发
      // 之前在 print.ts:739 串行等待的 100-200ms profile 获取。
      // updateBedrockModelStrings 被 sequential() 包裹，使
      // await 能接入进行中的获取。非 Bedrock 是同步
      // 提前返回（零成本）。
      void ensureModelStringsInitialized();
    }

    // 应用 --name：仅缓存，使会话 ID 被 --continue/--resume 最终确定之前
    // 不会创建孤儿文件。materializeSessionFile 在第一条用户消息
    // 时持久化它；REPL 的 useTerminalTitle 通过 getCurrentSessionTitle 读取它。
    const sessionNameArg = options.name?.trim();
    if (sessionNameArg) {
      cacheSessionTitle(sessionNameArg);
    }

    // Ant 模型别名（capybara-fast 等）通过
    // limkenion_ant_model_override GrowthBook 标志解析。_CACHED_MAY_BE_STALE 同步
    // 读取磁盘；磁盘由一次 fire-and-forget 写入填充。缓存冷时，
    // parseUserSpecifiedModel 返回未解析的别名，API 返回 404，-p
    // 在异步写入落盘前退出——在全新 pod 上会崩溃循环。
    // 在此等待 init 会填充 _CACHED_MAY_BE_STALE 现在
    // 首先检查的内存负载映射。门控使热路径保持
    // 非阻塞：
    //  - 通过 --model 或 LIMKENION_MODEL 显式模型（都进入别名解析）
    //  - 无环境覆盖（在访问磁盘前会短路 _CACHED_MAY_BE_STALE）
    //  - 磁盘上无标志（== null 也捕获 #22279 之前的毒化 null）
    const explicitModel = options.model || process.env.LIMKENION_MODEL;
    

    // 特殊处理带 null 关键字的默认模型
    // 注意：模型解析发生在 setup() 之后，以确保在 AWS 认证前建立信任
    const userSpecifiedModel = options.model === 'default' ? getDefaultMainLoopModel() : options.model;
    const userSpecifiedFallbackModel = fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel;

    // 复用 preSetupCwd，除非 setup() chdir 了（worktreeEnabled）。在
    // 常见路径中省去一次 getCwd() 系统调用。
    const currentCwd = worktreeEnabled ? getCwd() : preSetupCwd;
    logForDebugging('[STARTUP] Loading commands and agents...');
    const commandsStart = Date.now();
    // 汇聚在 setup() 之前触发的 Promise（若 worktreeEnabled 门控了
    // 提前触发，则重新开始）。两者都按 cwd 记忆化。
    const [commands, agentDefinitionsResult] = await Promise.all([commandsPromise ?? getCommands(currentCwd), agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd)]);
    logForDebugging(`[STARTUP] Commands and agents loaded in ${Date.now() - commandsStart}ms`);
    profileCheckpoint('action_commands_loaded');

    // 若通过 --agents 标志提供，解析 CLI agent
    let cliAgents: typeof agentDefinitionsResult.activeAgents = [];
    if (agentsJson) {
      try {
        const parsedAgents = safeParseJSON(agentsJson);
        if (parsedAgents) {
          cliAgents = parseAgentsFromJson(parsedAgents, 'flagSettings');
        }
      } catch (error) {
        logError(error);
      }
    }

    // 将 CLI agent 与现有 agent 合并
    const allAgents = [...agentDefinitionsResult.allAgents, ...cliAgents];
    const agentDefinitions = {
      ...agentDefinitionsResult,
      allAgents,
      activeAgents: getActiveAgentsFromList(allAgents)
    };

    // 从 CLI 标志或设置中查找主线程 agent
    const agentSetting = agentCli ?? getInitialSettings().agent;
    let mainThreadAgentDefinition: (typeof agentDefinitions.activeAgents)[number] | undefined;
    if (agentSetting) {
      mainThreadAgentDefinition = agentDefinitions.activeAgents.find(agent => agent.agentType === agentSetting);
      if (!mainThreadAgentDefinition) {
        logForDebugging(`Warning: agent "${agentSetting}" not found. ` + `Available agents: ${agentDefinitions.activeAgents.map(a => a.agentType).join(', ')}. ` + `Using default behavior.`);
      }
    }

    // 将主线程 agent 类型存入 bootstrap state，使 hooks 可以访问它
    setMainThreadAgentType(mainThreadAgentDefinition?.agentType);

    // 记录 agent 标志使用情况——仅对内置 agent 记录 agent 名称，以避免泄漏自定义 agent 名称
    if (mainThreadAgentDefinition) {
      logEvent('limkenion_agent_flag', {
        agentType: isBuiltInAgent(mainThreadAgentDefinition) ? mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS : 'custom' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(agentCli && {
          source: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        })
      });
    }

    // 将 agent 设置持久化到会话记录，供恢复视图展示与还原
    if (mainThreadAgentDefinition?.agentType) {
      saveAgentSetting(mainThreadAgentDefinition.agentType);
    }

    // 为非交互式会话应用 agent 的系统提示词
    //（交互式模式改用 buildEffectiveSystemPrompt）
    if (isNonInteractiveSession && mainThreadAgentDefinition && !systemPrompt && !isBuiltInAgent(mainThreadAgentDefinition)) {
      const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt();
      if (agentSystemPrompt) {
        systemPrompt = agentSystemPrompt;
      }
    }

    // initialPrompt 放在最前，使其斜杠命令（若有）被处理；
    // 用户提供的文本成为尾部上下文。
    // 仅当 inputPrompt 是字符串时才拼接。当它是
    // AsyncIterable（SDK stream-json 模式）时，模板插值会
    // 调用 .toString() 产生 "[object Object]"。AsyncIterable 情形
    // 在 print.ts 中通过 structuredIO.prependUserMessage() 处理。
    if (mainThreadAgentDefinition?.initialPrompt) {
      if (typeof inputPrompt === 'string') {
        inputPrompt = inputPrompt ? `${mainThreadAgentDefinition.initialPrompt}\n\n${inputPrompt}` : mainThreadAgentDefinition.initialPrompt;
      } else if (!inputPrompt) {
        inputPrompt = mainThreadAgentDefinition.initialPrompt;
      }
    }

    // 尽早计算有效模型，使 hooks 能与 MCP 并行运行
    // 若用户未指定模型但 agent 有，则使用 agent 的模型
    let effectiveModel = userSpecifiedModel;
    if (!effectiveModel && mainThreadAgentDefinition?.model && mainThreadAgentDefinition.model !== 'inherit') {
      effectiveModel = parseUserSpecifiedModel(mainThreadAgentDefinition.model);
    }
    setMainLoopModelOverride(effectiveModel);

    // 为 hooks 计算解析后的模型（启动时使用用户指定的模型）
    setInitialMainLoopModel(getUserSpecifiedModelSetting() || null);
    const initialMainLoopModel = getInitialMainLoopModel();
    const resolvedInitialModel = parseUserSpecifiedModel(initialMainLoopModel ?? getDefaultMainLoopModel());
    let advisorModel: string | undefined;
    if (isAdvisorEnabled()) {
      const advisorOption = canUserConfigureAdvisor() ? (options as {
        advisor?: string;
      }).advisor : undefined;
      if (advisorOption) {
        logForDebugging(`[AdvisorTool] --advisor ${advisorOption}`);
        if (!modelSupportsAdvisor(resolvedInitialModel)) {
          process.stderr.write(chalk.red(`Error: The model "${resolvedInitialModel}" does not support the advisor tool.\n`));
          process.exit(1);
        }
        const normalizedAdvisorModel = normalizeModelStringForAPI(parseUserSpecifiedModel(advisorOption));
        if (!isValidAdvisorModel(normalizedAdvisorModel)) {
          process.stderr.write(chalk.red(`Error: The model "${advisorOption}" cannot be used as an advisor.\n`));
          process.exit(1);
        }
      }
      advisorModel = canUserConfigureAdvisor() ? advisorOption ?? getInitialAdvisorSetting() : advisorOption;
      if (advisorModel) {
        logForDebugging(`[AdvisorTool] Advisor model: ${advisorModel}`);
      }
    }

    // 对带 --agent-type 的 tmux 队友，追加自定义 agent 的提示词
    if (isAgentSwarmsEnabled() && storedTeammateOpts?.agentId && storedTeammateOpts?.agentName && storedTeammateOpts?.teamName && storedTeammateOpts?.agentType) {
      // 查找自定义 agent 定义
      const customAgent = agentDefinitions.activeAgents.find(a => a.agentType === storedTeammateOpts.agentType);
      if (customAgent) {
        // 获取提示词——需要同时处理内置和自定义 agent
        let customPrompt: string | undefined;
        if (customAgent.source === 'built-in') {
          // 内置 agent 的 getSystemPrompt 接收 toolUseContext
          // 这里无法访问完整的 toolUseContext，故暂时跳过
          logForDebugging(`[teammate] Built-in agent ${storedTeammateOpts.agentType} - skipping custom prompt (not supported)`);
        } else {
          // 自定义 agent 的 getSystemPrompt 不接收参数
          customPrompt = customAgent.getSystemPrompt();
        }

        // 为 tmux 队友记录 agent 记忆加载事件
        if (customAgent.memory) {
          logEvent('limkenion_agent_memory_loaded', {
            
            scope: customAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            source: 'teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
        }
        if (customPrompt) {
          const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`;
          appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${customInstructions}` : customInstructions;
        }
      } else {
        logForDebugging(`[teammate] Custom agent ${storedTeammateOpts.agentType} not found in available agents`);
      }
    }
    maybeActivateBrief(options);
    // defaultView: 'chat' 是持久化的可选加入——检查 entitlement 并设置
    // userMsgOptIn，使工具与提示区段激活。仅交互式：
    // defaultView 是显示偏好；SDK 会话没有显示，且
    // assistant 安装器会把 defaultView:'chat' 写入 settings.local.json，
    // 否则这会泄漏到同一目录下的 --print 会话中。
    // 紧接 maybeActivateBrief() 之后运行，使所有启动可选加入路径在
    // 下方任何 isBriefEnabled() 读取前触发（proactive 提示的
    // briefVisibility）。GB 下架开关之后的持久化 'chat'
    // 会失效（entitlement 检查失败）。
    if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && !getIsNonInteractiveSession() && !getUserMsgOptIn() && getInitialSettings().defaultView === 'chat') {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const {
        isBriefEntitled
      } = require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      if (isBriefEntitled()) {
        setUserMsgOptIn(true);
      }
    }
    // 协调器模式有自己的系统提示词并过滤掉 Sleep，因此
    // 通用 proactive 提示会告诉它调用一个它无法访问的
    // 工具，并与委派指令冲突。
    if ((feature('PROACTIVE') || feature('KAIROS')) && ((options as {
      proactive?: boolean;
    }).proactive || isEnvTruthy(process.env.LIMKENION_PROACTIVE)) && !coordinatorModeModule?.isCoordinatorMode()) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const briefVisibility = feature('KAIROS') || feature('KAIROS_BRIEF') ? (require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')).isBriefEnabled() ? 'Call SendUserMessage at checkpoints to mark where things stand.' : 'The user will see any text you output.' : 'The user will see any text you output.';
      /* eslint-enable @typescript-eslint/no-require-imports */
      const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. ${briefVisibility}`;
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${proactivePrompt}` : proactivePrompt;
    }
    if (feature('KAIROS') && kairosEnabled && assistantModule) {
      const assistantAddendum = assistantModule.getAssistantSystemPromptAddendum();
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${assistantAddendum}` : assistantAddendum;
    }

    // Ink 根仅用于交互式会话——Ink 构造函数中的 patchConsole 会
    // 在无头模式吞噬 console 输出。
    let root!: Root;
    let getFpsMetrics!: () => FpsMetrics | undefined;
    let stats!: StatsStore;

    // 命令加载后显示设置画面
    if (!isNonInteractiveSession) {
      const ctx = getRenderContext(false);
      getFpsMetrics = ctx.getFpsMetrics;
      stats = ctx.stats;
      // 在 Ink 挂载前安装 asciicast 录制器（仅 Ant、通过 LIMKENION_TERMINAL_RECORDING=1 可选加入）
      
      const {
        createRoot
      } = await import('./ink.js');
      root = await createRoot(ctx.renderOptions);

      // 现在记录启动时间，在任何阻塞式对话框渲染之前。从 REPL 的
      // 首次渲染（旧位置）记录会包含用户停留在
      // trust/OAuth/onboarding/resume 选择器上的时长——p99 约为 70s，
      // 且主要由对话框等待时间主导，而非代码路径启动。
      logEvent('limkenion_timer', {
        event: 'startup' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs: Math.round(process.uptime() * 1000)
      });
      logForDebugging('[STARTUP] Running showSetupScreens()...');
      const setupScreensStart = Date.now();
      const onboardingShown = await showSetupScreens(root, permissionMode, allowDangerouslySkipPermissions, commands, enableLimkenionInChrome, devChannels);
      logForDebugging(`[STARTUP] showSetupScreens() completed in ${Date.now() - setupScreensStart}ms`);

      // Remote Control 桥接已被移除——--rc 不再受支持。
      if (remoteControlOption !== undefined) {
        process.stderr.write(chalk.yellow('Remote Control (--rc) is no longer supported.\n--rc flag ignored.\n'));
      }

      // 检查待处理的 agent 记忆快照更新（仅 --agent 模式、仅 Ant）
      if (feature('AGENT_MEMORY_SNAPSHOT') && mainThreadAgentDefinition && isCustomAgent(mainThreadAgentDefinition) && mainThreadAgentDefinition.memory && mainThreadAgentDefinition.pendingSnapshotUpdate) {
        const agentDef = mainThreadAgentDefinition;
        const choice = await launchSnapshotUpdateDialog(root, {
          agentType: agentDef.agentType,
          scope: agentDef.memory!,
          snapshotTimestamp: agentDef.pendingSnapshotUpdate!.snapshotTimestamp
        });
        if (choice === 'merge') {
          const {
            buildMergePrompt
          } = await import('./components/agents/SnapshotUpdateDialog.js');
          const mergePrompt = buildMergePrompt(agentDef.agentType, agentDef.memory!);
          inputPrompt = inputPrompt ? `${mergePrompt}\n\n${inputPrompt}` : mergePrompt;
        }
        agentDef.pendingSnapshotUpdate = undefined;
      }

      // 若我们刚刚完成为其准备的 onboarding，则跳过执行 /login
      if (onboardingShown && prompt?.trim().toLowerCase() === '/login') {
        prompt = '';
      }
      if (onboardingShown) {
        // 现在用户已在 onboarding 期间登录，刷新依赖认证的服务。
        // 与 src/commands/login.tsx 中的登录后逻辑保持同步。
        void refreshRemoteManagedSettings();
        void refreshPolicyLimits();
        // 在 GrowthBook 刷新前清除用户数据缓存，使其拾取到新凭据
        resetUserCache();
        // 登录后刷新 GrowthBook 以获取更新的功能标志（例如用于 远端服务 MCP 的）
        refreshGrowthBookAfterAuthChange();
      }

      // 校验活动令牌的 org 与 forceLoginOrgUUID 匹配（若在
      // 受管设置中设置）。在 onboarding 之后运行，
      // 使受管设置和登录状态完全加载。
      const orgValidation = await validateForceLoginOrg();
      if (!orgValidation.valid) {
        await exitWithError(root, orgValidation.message);
      }
    }

    // 若已发起 gracefulShutdown（例如用户拒绝了信任对话框），
    // process.exitCode 将被设置。跳过一切可能在进程退出前
    // 触发代码执行的后续操作（例如如果信任未建立，
    // 我们不想运行 apiKeyHelper）。
    if (process.exitCode !== undefined) {
      logForDebugging('Graceful shutdown initiated, skipping further initialization');
      return;
    }

    // 在信任建立后（或在非交互模式下，信任是隐式的）初始化 LSP manager。
    // 这可以防止插件 LSP 服务器在用户同意之前于不受信任的目录中执行
    // 代码。
    // 必须在内联插件设置之后（若有），使 --plugin-dir LSP 服务器被包含。
    initializeLspServerManager();

    // 在信任建立后显示设置校验错误
    // MCP 配置错误不阻止设置加载，故排除它们
    if (!isNonInteractiveSession) {
      const {
        errors
      } = getSettingsWithErrors();
      const nonMcpErrors = errors.filter(e => !e.mcpErrorMetadata);
      if (nonMcpErrors.length > 0) {
        await launchInvalidSettingsDialog(root, {
          settingsErrors: nonMcpErrors,
          onExit: () => gracefulShutdownSync(1)
        });
      }
    }

    // 在信任建立后检查配额状态、快速模式、passes 资格与 bootstrap 数据。
    // 这些会发起 API 调用，可能触发
    // apiKeyHelper 执行。
    // --bare / SIMPLE：跳过——这些是用于 REPL
    // 首轮响应性的缓存预热（quota、passes、fastMode、bootstrap data）。快速
    // 模式无论如何都不适用于 Agent SDK（参见 getFastModeUnavailableReason）。
    const bgRefreshThrottleMs = getFeatureValue_CACHED_MAY_BE_STALE('limkenion_cicada_nap_ms', 0);
    const lastPrefetched = getGlobalConfig().startupPrefetchedAt ?? 0;
    const skipStartupPrefetches = isBareMode() || bgRefreshThrottleMs > 0 && Date.now() - lastPrefetched < bgRefreshThrottleMs;
    if (!skipStartupPrefetches) {
      const lastPrefetchedInfo = lastPrefetched > 0 ? ` last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago` : '';
      logForDebugging(`Starting background startup prefetches${lastPrefetchedInfo}`);
      checkQuotaStatus().catch(error => logError(error));

      // 从服务端获取 bootstrap 数据并更新所有缓存值。
      void fetchBootstrapData();

      // TODO: 将其他预取整合到单个 bootstrap 请求中。
      void prefetchPassesEligibility();
      if (!getFeatureValue_CACHED_MAY_BE_STALE('limkenion_miraculo_the_bard', false)) {
        void prefetchFastModeStatus();
      } else {
        // 下架开关跳过网络调用，而非跳过组织策略执行。
        // 从缓存解析，使 orgStatus 不保持 'pending'（被
        // getFastModeUnavailableReason 视为宽松）。
        resolveFastModeStatusFromCache();
      }
      if (bgRefreshThrottleMs > 0) {
        saveGlobalConfig(current => ({
          ...current,
          startupPrefetchedAt: Date.now()
        }));
      }
    } else {
      logForDebugging(`Skipping startup prefetches, last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`);
      // 从缓存解析 fast mode 组织状态（无网络）
      resolveFastModeStatusFromCache();
    }
    if (!isNonInteractiveSession) {
      void refreshExampleCommands(); // 预取示例命令（运行 git log，不发 API 调用）
    }

    // 解析 MCP 配置（早期开始，与 setup/信任对话框工作重叠）
    const {
      servers: existingMcpConfigs
    } = await mcpConfigPromise;
    logForDebugging(`[STARTUP] MCP configs resolved in ${mcpConfigResolvedMs}ms (awaited at +${Date.now() - mcpConfigStart}ms)`);
    // CLI 标志（--mcp-config）应覆盖基于文件的配置，以匹配设置优先级
    const allMcpConfigs = {
      ...existingMcpConfigs,
      ...dynamicMcpConfig
    };

    // 将 SDK 配置与常规 MCP 配置分开
    const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {};
    const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {};
    for (const [name, config] of Object.entries(allMcpConfigs)) {
      const typedConfig = config as ScopedMcpServerConfig | McpSdkServerConfig;
      if (typedConfig.type === 'sdk') {
        sdkMcpConfigs[name] = typedConfig as McpSdkServerConfig;
      } else {
        regularMcpConfigs[name] = typedConfig as ScopedMcpServerConfig;
      }
    }
    profileCheckpoint('action_mcp_configs_loaded');

    // 在信任对话框之后预取 MCP 资源（这里是执行发生的地方）。
    // 仅交互式模式：print 模式把连接推迟到 headlessStore 存在
    // 之后，并按服务器推送（见下），因此 ToolSearch 的 pending-client 处理
    // 可用，且一个慢服务器不会阻塞整批。
    const localMcpPromise = isNonInteractiveSession ? Promise.resolve({
      clients: [],
      tools: [],
      commands: []
    }) : prefetchAllMcpResources(regularMcpConfigs);
    const limkenionaiMcpPromise = isNonInteractiveSession ? Promise.resolve({
      clients: [],
      tools: [],
      commands: []
    }) : limkenionaiConfigPromise.then(configs => Object.keys(configs).length > 0 ? prefetchAllMcpResources(configs) : {
      clients: [],
      tools: [],
      commands: []
    });
    // 按名称去重合并：每次 prefetchAllMcpResources 调用都会独立
    // 通过本地去重标志添加辅助工具（ListMcpResourcesTool、ReadMcpResourceTool），
    // 因此合并两次调用可能产生重复。print.ts
    // 已经对最终工具池做了 uniqBy，但这里去重可让 appState 保持干净。
    const mcpPromise = Promise.all([localMcpPromise, limkenionaiMcpPromise]).then(([local, limkenionai]) => ({
      clients: [...local.clients, ...limkenionai.clients],
      tools: uniqBy([...local.tools, ...limkenionai.tools], 'name'),
      commands: uniqBy([...local.commands, ...limkenionai.commands], 'name')
    }));

    // 尽早启动 hooks，使它们与 MCP 连接并行运行。
    // 对 initOnly/init/maintenance（单独处理）、非交互式
    //（通过 setupTrigger 处理）以及 resume/continue（conversationRecovery.ts
    // 改为触发 'resume'——没有此守卫，/resume 上 hooks 会触发 TWICE，
    // 且第二条 systemMessage 会覆盖第一条。gh-30825）跳过。
    const hooksPromise = initOnly || init || maintenance || isNonInteractiveSession || options.continue || options.resume ? null : processSessionStartHooks('startup', {
      agentType: mainThreadAgentDefinition?.agentType,
      model: resolvedInitialModel
    });

    // MCP 从不阻塞 REPL 渲染或第 1 轮 TTFT。useManageMCPConnections
    // 在服务器连接时异步填充 appState.mcp（connectToServer 被
    // 记忆化——上面的预取调用与 hook 汇聚到相同
    // 连接）。getToolUseContext 通过 computeTools()
    // 每次全新读取 store.getState()，因此第 1 轮会看到查询
    // 时刻已连接的任何内容。慢服务器为第 2 轮+ 填充。
    // 匹配交互式无提示行为。print 模式：按服务器推送到 headlessStore（见下）。
    const hookMessages: Awaited<NonNullable<typeof hooksPromise>> = [];
    // 抑制瞬态 unhandledRejection——预取会预热
    // 记忆化的 connectToServer 缓存，但交互式中无人等待它。
    mcpPromise.catch(() => {});
    const mcpClients: Awaited<typeof mcpPromise>['clients'] = [];
    const mcpTools: Awaited<typeof mcpPromise>['tools'] = [];
    const mcpCommands: Awaited<typeof mcpPromise>['commands'] = [];
    let thinkingEnabled = shouldEnableThinkingByDefault();
    let thinkingConfig: ThinkingConfig = thinkingEnabled !== false ? {
      type: 'adaptive'
    } : {
      type: 'disabled'
    };
    if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
      thinkingEnabled = true;
      thinkingConfig = {
        type: 'adaptive'
      };
    } else if (options.thinking === 'disabled') {
      thinkingEnabled = false;
      thinkingConfig = {
        type: 'disabled'
      };
    } else {
      const maxThinkingTokens = process.env.MAX_THINKING_TOKENS ? parseInt(process.env.MAX_THINKING_TOKENS, 10) : options.maxThinkingTokens;
      if (maxThinkingTokens !== undefined) {
        if (maxThinkingTokens > 0) {
          thinkingEnabled = true;
          thinkingConfig = {
            type: 'enabled',
            budgetTokens: maxThinkingTokens
          };
        } else if (maxThinkingTokens === 0) {
          thinkingEnabled = false;
          thinkingConfig = {
            type: 'disabled'
          };
        }
      }
    }
    logForDiagnosticsNoPII('info', 'started', {
      version: MACRO.VERSION,
      is_native_binary: isInBundledMode()
    });
    registerCleanup(async () => {
      logForDiagnosticsNoPII('info', 'exited');
    });
    void logLimkenionInit({
      hasInitialPrompt: Boolean(prompt),
      hasStdin: Boolean(inputPrompt),
      verbose,
      debug,
      debugToStderr,
      print: print ?? false,
      outputFormat: outputFormat ?? 'text',
      inputFormat: inputFormat ?? 'text',
      numAllowedTools: allowedTools.length,
      numDisallowedTools: disallowedTools.length,
      mcpClientCount: Object.keys(allMcpConfigs).length,
      worktreeEnabled,
      skipWebFetchPreflight: getInitialSettings().skipWebFetchPreflight,
      githubActionInputs: process.env.GITHUB_ACTION_INPUTS,
      dangerouslySkipPermissionsPassed: dangerouslySkipPermissions ?? false,
      permissionMode,
      modeIsBypass: permissionMode === 'bypassPermissions',
      allowDangerouslySkipPermissionsPassed: allowDangerouslySkipPermissions,
      systemPromptFlag: systemPrompt ? options.systemPromptFile ? 'file' : 'flag' : undefined,
      appendSystemPromptFlag: appendSystemPrompt ? options.appendSystemPromptFile ? 'file' : 'flag' : undefined,
      thinkingConfig,
      assistantActivationPath: feature('KAIROS') && kairosEnabled ? assistantModule?.getAssistantActivationPath() : undefined
    });

    // 记录上下文指标一次，位于初始化时
    void logContextMetrics(regularMcpConfigs, toolPermissionContext);
    void logPermissionContextForAnts(null, 'initialization');
    logManagedSettings();

    // 注册 PID 文件用于并发会话检测（~/.limkenion/sessions/）
    // 并触发 multi-clauding 遥测。放在这里（而非 init.ts），使
    // 只有 REPL 路径注册——而不是 `limkenion doctor` 等子命令。链式：
    // count 必须在 register 的写入完成后运行，否则会漏掉我们自己的文件。
    void registerSession().then(registered => {
      if (!registered) return;
      if (sessionNameArg) {
        void updateSessionName(sessionNameArg);
      }
      void countConcurrentSessions().then(count => {
        if (count >= 2) {
          logEvent('limkenion_concurrent_sessions', {
            num_sessions: count
          });
        }
      });
    });

    // 初始化版本化插件系统（需要时触发 V1→V2 迁移）。
    // 然后运行孤儿 GC，再预热 Grep/Glob 排除缓存。
    // 顺序很重要：预热会扫描磁盘上的 .orphaned_at 标记，
    // 因此它必须看到 GC 的第一遍（从重装
    // 版本移除标记）和第二遍（给未标记的孤儿打戳）已经应用。
    // 预热也须在 autoupdate（REPL 首次提交时触发）
    // 可能在底部把本会话的活跃版本变成孤儿之前完成。
    // --bare / SIMPLE：跳过插件版本同步 + 孤儿清理。这些是
    // 脚本化调用不需要的安装/升级簿记——
    // 下次交互式会话会协调。这里的 await
    // 曾阻塞 -p 上的市场往返。
    if (isBareMode()) {
      // 跳过——no-op
    } else if (isNonInteractiveSession) {
      // 无头模式下，等待以确保 CLI 退出前插件同步完成
      await initializeVersionedPlugins();
      profileCheckpoint('action_after_plugins_init');
      void cleanupOrphanedPluginVersionsInBackground().then(() => getGlobExclusionsForPluginCache());
    } else {
      // 交互式模式下 fire-and-forget——这纯粹是簿记，
      // 不影响当前会话的运行时行为
      void initializeVersionedPlugins().then(async () => {
        profileCheckpoint('action_after_plugins_init');
        await cleanupOrphanedPluginVersionsInBackground();
        void getGlobExclusionsForPluginCache();
      });
    }
    const setupTrigger = initOnly || init ? 'init' : maintenance ? 'maintenance' : null;
    if (initOnly) {
      applyConfigEnvironmentVariables();
      await processSetupHooks('init', {
        forceSyncExecution: true
      });
      await processSessionStartHooks('startup', {
        forceSyncExecution: true
      });
      gracefulShutdownSync(0);
      return;
    }

    // --print 模式
    if (isNonInteractiveSession) {
      if (outputFormat === 'stream-json' || outputFormat === 'json') {
        setHasFormattedOutput(true);
      }

      // 在 print 模式下应用完整的环境变量，因为信任对话框被绕过
      // 这包括来自不受信任来源的潜在危险环境变量
      // 但 print 模式被视为受信任（如帮助文本所述）
      applyConfigEnvironmentVariables();

      // 在环境变量应用后初始化遥测，使 OTEL 端点环境变量和
      // otelHeadersHelper（需要信任才能执行）可用。
      initializeTelemetryAfterTrust();

      // 现在触发 SessionStart hooks，使子进程派生与
      // 下面的 MCP 连接 + 插件初始化 + print.ts import 重叠。loadInitialMessages
      // 在 print.ts:4397 加入此 Promise。守卫与 loadInitialMessages 相同——
      // continue/resume/teleport 路径不触发启动 hooks（或在
      // resume 分支中条件触发，那里此 promise 为
      // undefined 且 ?? 回退运行）。setupTrigger 设置时也跳过——
      // 那些路径先运行 setup hooks（print.ts:544），而会话
      // 启动 hooks 必须等待 setup 完成。
      const sessionStartHooksPromise = options.continue || options.resume || teleport || setupTrigger ? undefined : processSessionStartHooks('startup');
      // 若此 Promise 在 loadInitialMessages 等待它之前 reject，抑制瞬态
      // unhandledRejection。下游 await 仍会观察到
      // 该 rejection——这只是防止虚假的全局处理器触发。
      sessionStartHooksPromise?.catch(() => {});
      profileCheckpoint('before_validateForceLoginOrg');
      // 为非交互式会话校验组织限制
      const orgValidation = await validateForceLoginOrg();
      if (!orgValidation.valid) {
        process.stderr.write(orgValidation.message + '\n');
        process.exit(1);
      }

      // 无头模式支持所有 prompt 命令和一些本地命令
      // 若 disableSlashCommands 为 true，返回空数组
      const commandsHeadless = disableSlashCommands ? [] : commands.filter(command => command.type === 'prompt' && !command.disableNonInteractive || command.type === 'local' && command.supportsNonInteractive);
      const defaultState = getDefaultAppState();
      const headlessInitialState: AppState = {
        ...defaultState,
        mcp: {
          ...defaultState.mcp,
          clients: mcpClients,
          commands: mcpCommands,
          tools: mcpTools
        },
        toolPermissionContext,
        effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
        ...(isFastModeEnabled() && {
          fastMode: getInitialFastModeSetting(effectiveModel ?? null)
        }),
        ...(isAdvisorEnabled() && advisorModel && {
          advisorModel
        }),
        // kairosEnabled 门控 executeForkedSlashCommand 中的异步
        // fire-and-forget 路径（processSlashCommand.tsx:132）和
        // AgentTool 的 shouldRunAsync。REPL 的 initialState 在
        // 约 3459 设置此值；无头曾默认 false，导致守护进程子进程的
        // 定时任务和 Agent 工具调用同步运行——生成时就
        // 有 N 个过期的 cron 任务 = N 次串行子 agent 轮次阻塞
        // 用户输入。在 :1620 计算，远早于本分支。
        ...(feature('KAIROS') ? {
          kairosEnabled
        } : {})
      };

      // 初始化 app state
      const headlessStore = createStore(headlessInitialState, onChangeAppState);

      // 根据 Statsig 门控检查是否应禁用 bypassPermissions
      // 这与下面的代码并行运行，以避免阻塞主循环。
      if (toolPermissionContext.mode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
        void checkAndDisableBypassPermissions(toolPermissionContext);
      }

      // 自动模式门控的异步检查——校正状态并在需要时禁用 auto。
      // 门控基于 TRANSCRIPT_CLASSIFIER（而非 USER_TYPE），
      // 使外部构建也运行 GrowthBook 下架开关。
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        void verifyAutoModeGateAccess(toolPermissionContext, headlessStore.getState().fastMode).then(({
          updateContext
        }) => {
          headlessStore.setState(prev => {
            const nextCtx = updateContext(prev.toolPermissionContext);
            if (nextCtx === prev.toolPermissionContext) return prev;
            return {
              ...prev,
              toolPermissionContext: nextCtx
            };
          });
        });
      }

      // 为会话持久化设置全局状态
      if (options.sessionPersistence === false) {
        setSessionPersistenceDisabled(true);
      }

      // 存储 SDK betas 到全局状态，用于上下文窗口计算
      // 只存储允许的 betas（按白名单和订阅者状态过滤）
      setSdkBetas(filterAllowedSdkBetas(betas));

      // print 模式 MCP：按服务器增量推送到 headlessStore。
      // 对应 useManageMCPConnections——先推送 pending（使 ToolSearch 的
      // pending 检查在 ToolSearchTool.ts:334 看到它们），随后在每个
      // 服务器定型时替换为 connected/failed。
      const connectMcpBatch = (configs: Record<string, ScopedMcpServerConfig>, label: string): Promise<void> => {
        if (Object.keys(configs).length === 0) return Promise.resolve();
        headlessStore.setState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: [...prev.mcp.clients, ...Object.entries(configs).map(([name, config]) => ({
              name,
              type: 'pending' as const,
              config
            }))]
          }
        }));
        return getMcpToolsCommandsAndResources(({
          client,
          tools,
          commands
        }) => {
          headlessStore.setState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.some(c => c.name === client.name) ? prev.mcp.clients.map(c => c.name === client.name ? client : c) : [...prev.mcp.clients, client],
              tools: uniqBy([...prev.mcp.tools, ...tools], 'name'),
              commands: uniqBy([...prev.mcp.commands, ...commands], 'name')
            }
          }));
        }, configs).catch(err => logForDebugging(`[MCP] ${label} connect error: ${err}`));
      };
      // 等待所有 MCP 配置——print 模式通常为单轮，因此
      // “迟到的服务器下轮可见”没有帮助。SDK init
      // 消息和第 1 轮工具列表都需要已配置的 MCP 工具就位。
      // 零服务器情形通过 connectMcpBatch 中的提前返回免费。
      // 连接器在 getMcpToolsCommandsAndResources 内部并行化
      //（processBatched 与 Promise.all）。远端服务 也会被等待——其
      // 获取很早被触发（约 2558 行），因此只有残余时间在此阻塞。
      // --bare 完全跳过 远端服务，以兼顾对性能敏感的脚本。
      profileCheckpoint('before_connectMcp');
      await connectMcpBatch(regularMcpConfigs, 'regular');
      profileCheckpoint('after_connectMcp');
      // 去重：抑制重复 远端服务 连接器的插件 MCP 服务器（连接器优先），
      // 然后连接 远端服务 服务器。
      // 限制等待——#23725 使其阻塞，使单轮 -p 能看到
      // 连接器，但 40+ 个慢连接器把 limkenion_startup_perf p99
      // 抬高到 76s。若获取+连接未能及时完成，则继续；
      // promise 继续运行并在后台更新 headlessStore，
      // 使第 2 轮+ 仍能看到连接器。
      const LIMKENION_AI_MCP_TIMEOUT_MS = 5_000;
      const limkenionaiConnect = limkenionaiConfigPromise.then(limkenionaiConfigs => {
        if (Object.keys(limkenionaiConfigs).length > 0) {
          const limkenionaiSigs = new Set<string>();
          for (const config of Object.values(limkenionaiConfigs)) {
            const sig = getMcpServerSignature(config);
            if (sig) limkenionaiSigs.add(sig);
          }
          const suppressed = new Set<string>();
          for (const [name, config] of Object.entries(regularMcpConfigs)) {
            if (!name.startsWith('plugin:')) continue;
            const sig = getMcpServerSignature(config);
            if (sig && limkenionaiSigs.has(sig)) suppressed.add(name);
          }
          if (suppressed.size > 0) {
            logForDebugging(`[MCP] Lazy dedup: suppressing ${suppressed.size} plugin server(s) that duplicate limkenion.ai connectors: ${[...suppressed].join(', ')}`);
            // 在从状态过滤之前断开连接。只有已连接
            // 的服务器需要清理——对从未连接的服务器调用 clearServerCache
            // 会真触发一次连接只是为了杀掉它（记忆化
            // 缓存未命中路径，参见 useManageMCPConnections.ts:870）。
            for (const c of headlessStore.getState().mcp.clients) {
              if (!suppressed.has(c.name) || c.type !== 'connected') continue;
              c.client.onclose = undefined;
              void clearServerCache(c.name, c.config).catch(() => {});
            }
            headlessStore.setState(prev => {
              let {
                clients,
                tools,
                commands,
                resources
              } = prev.mcp;
              clients = clients.filter(c => !suppressed.has(c.name));
              tools = tools.filter(t => !t.mcpInfo || !suppressed.has(t.mcpInfo.serverName));
              for (const name of suppressed) {
                commands = excludeCommandsByServer(commands, name);
                resources = excludeResourcesByServer(resources, name);
              }
              return {
                ...prev,
                mcp: {
                  ...prev.mcp,
                  clients,
                  tools,
                  commands,
                  resources
                }
              };
            });
          }
        }
        // 抑制与已启用手动服务器重复的 远端服务 连接器（URL 签名匹配）。
        // 上面的插件去重只处理 `plugin:*` 键；这会捕获手动的 `.mcp.json` 条目。
        // plugin:* 必须在此排除——第 1 步已抑制
        // 它们（远端服务 优先）；让它们保留会把连接器的
        // 抑制也连带掉，二者都活不下来（gh-39974）。
        const nonPluginConfigs = pickBy(regularMcpConfigs, (_, n) => !n.startsWith('plugin:'));
        const {
          servers: dedupedLimkenionAi
        } = dedupLimkenionAiMcpServers(limkenionaiConfigs, nonPluginConfigs);
        return connectMcpBatch(dedupedLimkenionAi, 'limkenionai');
      });
      let limkenionaiTimer: ReturnType<typeof setTimeout> | undefined;
      const limkenionaiTimedOut = await Promise.race([limkenionaiConnect.then(() => false), new Promise<boolean>(resolve => {
        limkenionaiTimer = setTimeout(r => r(true), LIMKENION_AI_MCP_TIMEOUT_MS, resolve);
      })]);
      if (limkenionaiTimer) clearTimeout(limkenionaiTimer);
      if (limkenionaiTimedOut) {
        logForDebugging(`[MCP] limkenion.ai connectors not ready after ${LIMKENION_AI_MCP_TIMEOUT_MS}ms — proceeding; background connection continues`);
      }
      profileCheckpoint('after_connectMcp_limkenionai');

      // 无头模式下立即启动延迟预取（无用户输入延迟）
      // --bare / SIMPLE：startDeferredPrefetches 内部提前返回。
      // backgroundHousekeeping（initExtractMemories、pruneShellSnapshots、
      // cleanupOldMessageFiles）与 sdkHeapDumpMonitor 都是脚本化
      // 调用不需要的簿记——下次交互式会话协调。
      if (!isBareMode()) {
        startDeferredPrefetches();
        void import('./utils/backgroundHousekeeping.js').then(m => m.startBackgroundHousekeeping());
        
      }
      logSessionTelemetry();
      profileCheckpoint('before_print_import');
      const {
        runHeadless
      } = await import('src/cli/print.js');
      profileCheckpoint('after_print_import');
      void runHeadless(inputPrompt, () => headlessStore.getState(), headlessStore.setState, commandsHeadless, tools, sdkMcpConfigs, agentDefinitions.activeAgents, {
        continue: options.continue,
        resume: options.resume,
        verbose: verbose,
        outputFormat: outputFormat,
        jsonSchema,
        permissionPromptToolName: options.permissionPromptTool,
        allowedTools,
        thinkingConfig,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        taskBudget: options.taskBudget ? {
          total: options.taskBudget
        } : undefined,
        systemPrompt,
        appendSystemPrompt,
        userSpecifiedModel: effectiveModel,
        fallbackModel: userSpecifiedFallbackModel,
        teleport,
        sdkUrl,
        replayUserMessages: effectiveReplayUserMessages,
        includePartialMessages: effectiveIncludePartialMessages,
        forkSession: options.forkSession || false,
        resumeSessionAt: options.resumeSessionAt || undefined,
        rewindFiles: options.rewindFiles,
        enableAuthStatus: options.enableAuthStatus,
        agent: agentCli,
        workload: options.workload,
        setupTrigger: setupTrigger ?? undefined,
        sessionStartHooksPromise
      });
      return;
    }

    // 启动时记录模型配置
    logEvent('limkenion_startup_manual_model_config', {
      cli_flag: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      env_var: process.env.LIMKENION_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      settings_file: (getInitialSettings() || {}).model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      subscriptionType: getSubscriptionType() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agent: agentSetting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });

    // 获取初始模型（resolvedInitialModel 早先为 hooks 并行化计算）的弃用警告
    const deprecationWarning = getModelDeprecationWarning(resolvedInitialModel);

    // 构建初始通知队列
    const initialNotifications: Array<{
      key: string;
      text: string;
      color?: 'warning';
      priority: 'high';
    }> = [];
    if (permissionModeNotification) {
      initialNotifications.push({
        key: 'permission-mode-notification',
        text: permissionModeNotification,
        priority: 'high'
      });
    }
    if (deprecationWarning) {
      initialNotifications.push({
        key: 'model-deprecation-warning',
        text: deprecationWarning,
        color: 'warning',
        priority: 'high'
      });
    }
    if (overlyBroadBashPermissions.length > 0) {
      const displayList = uniq(overlyBroadBashPermissions.map(p => p.ruleDisplay));
      const displays = displayList.join(', ');
      const sources = uniq(overlyBroadBashPermissions.map(p => p.sourceDisplay)).join(', ');
      const n = displayList.length;
      initialNotifications.push({
        key: 'overly-broad-bash-notification',
        text: `${displays} 允许 ${plural(n, '条规则')} 来自 ${sources} ${plural(n, '已被', '已被')} 忽略 \u2014 Ants 不可用，请改用 auto-mode`,
        color: 'warning',
        priority: 'high'
      });
    }
    const effectiveToolPermissionContext = {
      ...toolPermissionContext,
      mode: isAgentSwarmsEnabled() && getTeammateUtils().isPlanModeRequired() ? 'plan' as const : toolPermissionContext.mode
    };
    // 所有启动可选加入路径（--tools、--brief、defaultView）已在上方
    // 触发；initialIsBriefOnly 只读取由此产生的状态。
    const initialIsBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ? getUserMsgOptIn() : false;
    const fullRemoteControl = remoteControl || getRemoteControlAtStartup() || kairosEnabled;
    let ccrMirrorEnabled = false;
    if (feature('CCR_MIRROR') && !fullRemoteControl) {
      // 桥接模块已移除——CCR 镜像模式保持禁用。
      ccrMirrorEnabled = false;
    }
    const initialState: AppState = {
      settings: getInitialSettings(),
      tasks: {},
      agentNameRegistry: new Map(),
      verbose: verbose ?? getGlobalConfig().verbose ?? false,
      mainLoopModel: initialMainLoopModel,
      mainLoopModelForSession: null,
      isBriefOnly: initialIsBriefOnly,
      expandedView: getGlobalConfig().showSpinnerTree ? 'teammates' : getGlobalConfig().showExpandedTodos ? 'tasks' : 'none',
      showTeammateMessagePreview: isAgentSwarmsEnabled() ? false : undefined,
      selectedIPAgentIndex: -1,
      coordinatorTaskIndex: -1,
      viewSelectionMode: 'none',
      footerSelection: null,
      toolPermissionContext: effectiveToolPermissionContext,
      agent: mainThreadAgentDefinition?.agentType,
      agentDefinitions,
      mcp: {
        clients: [],
        tools: [],
        commands: [],
        resources: {},
        pluginReconnectKey: 0
      },
      plugins: {
        enabled: [],
        disabled: [],
        commands: [],
        errors: [],
        installationStatus: {
          marketplaces: [],
          plugins: []
        },
        needsRefresh: false
      },
      statusLineText: undefined,
      kairosEnabled,
      remoteSessionUrl: undefined,
      remoteConnectionStatus: 'connecting',
      remoteBackgroundTaskCount: 0,
      replBridgeEnabled: fullRemoteControl || ccrMirrorEnabled,
      replBridgeExplicit: remoteControl,
      replBridgeOutboundOnly: ccrMirrorEnabled,
      replBridgeConnected: false,
      replBridgeSessionActive: false,
      replBridgeReconnecting: false,
      replBridgeConnectUrl: undefined,
      replBridgeSessionUrl: undefined,
      replBridgeEnvironmentId: undefined,
      replBridgeSessionId: undefined,
      replBridgeError: undefined,
      replBridgeInitialName: remoteControlName,
      showRemoteCallout: false,
      notifications: {
        current: null,
        queue: initialNotifications
      },
      elicitation: {
        queue: []
      },
      todos: {},
      remoteAgentTaskSuggestions: [],
      fileHistory: {
        snapshots: [],
        trackedFiles: new Set(),
        snapshotSequence: 0
      },
      attribution: createEmptyAttributionState(),
      thinkingEnabled,
      promptSuggestionEnabled: shouldEnablePromptSuggestion(),
      sessionHooks: new Map(),
      inbox: {
        messages: []
      },
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null
      },
      speculation: IDLE_SPECULATION_STATE,
      speculationSessionTimeSavedMs: 0,
      skillImprovement: {
        suggestion: null
      },
      workerSandboxPermissions: {
        queue: [],
        selectedIndex: 0
      },
      pendingWorkerRequest: null,
      pendingSandboxRequest: null,
      authVersion: 0,
      initialMessage: inputPrompt ? {
        message: createUserMessage({
          content: String(inputPrompt)
        })
      } : null,
      effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
      activeOverlays: new Set<string>(),
      fastMode: getInitialFastModeSetting(resolvedInitialModel),
      ...(isAdvisorEnabled() && advisorModel && {
        advisorModel
      }),
      // 同步计算 teamContext，避免渲染期间 useEffect setState。
      // KAIROS：assistantTeamContext 优先——在 KAIROS 块中更早设置，
      // 使 Agent(name: "foo") 无需 TeamCreate 即可生成进程内队友。
      // computeInitialTeamContext() 用于 tmux 生成的队友
      // 读取自身身份，而非助手模式的 leader。
      teamContext: feature('KAIROS') ? assistantTeamContext ?? computeInitialTeamContext?.() : computeInitialTeamContext?.()
    };

    // 将 CLI 初始 prompt 添加到历史
    if (inputPrompt) {
      addToHistory(String(inputPrompt));
    }
    const initialTools = mcpTools;

    // 同步递增 numStartups——首次渲染的读取方如
    // shouldShowEffortCallout（经 useState 初始化器）需要
    // setImmediate 触发前更新的值。仅推迟遥测。
    saveGlobalConfig(current => ({
      ...current,
      numStartups: (current.numStartups ?? 0) + 1
    }));
    setImmediate(() => {
      void logStartupTelemetry();
      logSessionTelemetry();
    });

    // 设置每轮会话环境数据上传器（仅 Ant 构建）。
    // 当在 Limkenion 拥有的仓库中工作时，默认对全体 Ant 用户启用。
    // 每轮捕获 git/文件系统状态（非记录），使环境可在任何
    // 用户消息索引处重建。门控：
    //   - 构建时：此 import 在外部构建中被 stub 掉。
    //   - 运行时：上传器检查 github.com/limkenions/* 远程 + gcloud 认证。
    //   - 安全：LIMKENION_DISABLE_SESSION_DATA_UPLOAD=1 绕过（测试设置此值）。
    // import 是动态且异步的，以避免增加启动延迟。
    const sessionUploaderPromise = null;

    // 将会话上传器解析推迟到 onTurnComplete 回调，避免
    // 在 main.tsx（性能关键路径）中新增顶层 await。
    // sessionDataUploader.ts 中的每轮认证逻辑优雅处理
    // 未认证状态（每轮重新检查，因此会话中的认证恢复可行）。
    const uploaderReady = sessionUploaderPromise ? sessionUploaderPromise.then(mod => mod.createSessionTurnUploader()).catch(() => null) : null;
    const sessionConfig = {
      debug: debug || debugToStderr,
      commands: [...commands, ...mcpCommands],
      initialTools,
      mcpClients,
      autoConnectIdeFlag: ide,
      mainThreadAgentDefinition,
      disableSlashCommands,
      dynamicMcpConfig,
      strictMcpConfig,
      systemPrompt,
      appendSystemPrompt,
      taskListId,
      thinkingConfig,
      ...(uploaderReady && {
        onTurnComplete: (messages: MessageType[]) => {
          void uploaderReady.then(uploader => uploader?.(messages));
        }
      })
    };

    // processResumedConversation 调用的共享上下文
    const resumeContext = {
      modeApi: coordinatorModeModule,
      mainThreadAgentDefinition,
      agentDefinitions,
      currentCwd,
      cliAgents,
      initialState
    };
    if (options.continue) {
      // 直接继续最近的对话
      let resumeSucceeded = false;
      try {
        const resumeStart = performance.now();

        // 恢复前清除过期缓存，确保文件/技能发现是新的
        const {
          clearSessionCaches
        } = await import('./commands/clear/caches.js');
        clearSessionCaches();
        const result = await loadConversationForResume(undefined /* sessionId */, undefined /* sourceFile */);
        if (!result) {
          logEvent('limkenion_continue', {
            success: false
          });
          return await exitWithError(root, 'No conversation found to continue');
        }
        const loaded = await processResumedConversation(result, {
          forkSession: !!options.forkSession,
          includeAttribution: true,
          transcriptPath: result.fullPath
        }, resumeContext);
        if (loaded.restoredAgentDef) {
          mainThreadAgentDefinition = loaded.restoredAgentDef;
        }
        maybeActivateProactive(options);
        maybeActivateBrief(options);
        logEvent('limkenion_continue', {
          success: true,
          resume_duration_ms: Math.round(performance.now() - resumeStart)
        });
        resumeSucceeded = true;
        await launchRepl(root, {
          getFpsMetrics,
          stats,
          initialState: loaded.initialState
        }, {
          ...sessionConfig,
          mainThreadAgentDefinition: loaded.restoredAgentDef ?? mainThreadAgentDefinition,
          initialMessages: loaded.messages,
          initialFileHistorySnapshots: loaded.fileHistorySnapshots,
          initialContentReplacements: loaded.contentReplacements,
          initialAgentName: loaded.agentName,
          initialAgentColor: loaded.agentColor
        }, renderAndRun);
      } catch (error) {
        if (!resumeSucceeded) {
          logEvent('limkenion_continue', {
            success: false
          });
        }
        logError(error);
        process.exit(1);
      }
    } else if (options.resume || options.fromPr || teleport) {
      // 处理恢复流程——从文件（仅 Ant）、会话 ID 或交互式选择器

      // 恢复前清除过期缓存，确保文件/技能发现是新的
      const {
        clearSessionCaches
      } = await import('./commands/clear/caches.js');
      clearSessionCaches();
      let messages: MessageType[] | null = null;
      let processedResume: ProcessedResume | undefined = undefined;
      let maybeSessionId = validateUuid(options.resume);
      let searchTerm: string | undefined = undefined;
      // 按自定义标题找到时存储完整的 LogOption（用于跨 worktree 恢复）
      let matchedLog: LogOption | null = null;
      // --from-pr 标志的 PR 过滤器
      let filterByPr: boolean | number | string | undefined = undefined;

      // 处理 --from-pr 标志
      if (options.fromPr) {
        if (options.fromPr === true) {
          // 显示所有关联 PR 的会话
          filterByPr = true;
        } else if (typeof options.fromPr === 'string') {
          // 可能是 PR 编号或 URL
          filterByPr = options.fromPr;
        }
      }

      // 若 resume 值非 UUID，先按自定义标题尝试精确匹配
      if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
        const trimmedValue = options.resume.trim();
        if (trimmedValue) {
          const matches = await searchSessionsByCustomTitle(trimmedValue, {
            exact: true
          });
          if (matches.length === 1) {
            // 找到精确匹配——存储完整 LogOption 用于跨 worktree 恢复
            matchedLog = matches[0]!;
            maybeSessionId = getSessionIdFromLog(matchedLog) ?? null;
          } else {
            // 无匹配或多个匹配——用作选择器的搜索词
            searchTerm = trimmedValue;
          }
        }
      }

      // --teleport 创建/恢复 Limkenion Web（CCR）会话。
      if (teleport) {
        await waitForPolicyLimitsToLoad();
        if (!isPolicyAllowed('allow_remote_sessions')) {
          return await exitWithError(root, "Error: Remote sessions are disabled by your organization's policy.", () => gracefulShutdown(1));
        }
      }
      if (teleport) {
        if (teleport === true || teleport === '') {
          // 交互式模式：显示任务选择器并处理恢复
          logEvent('limkenion_teleport_interactive_mode', {});
          logForDebugging('selectAndResumeTeleportTask: Starting teleport flow...');
          const teleportResult = await launchTeleportResumeWrapper(root);
          if (!teleportResult) {
            // 用户取消或发生错误
            await gracefulShutdown(0);
            process.exit(0);
          }
          const {
            branchError
          } = await checkOutTeleportedSessionBranch(teleportResult.branch);
          messages = processMessagesForTeleportResume(teleportResult.log, branchError);
        } else if (typeof teleport === 'string') {
          logEvent('limkenion_teleport_resume_session', {
            mode: 'direct' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          try {
            // 首先获取会话并校验仓库，再检查 git 状态
            const sessionData = await fetchSession(teleport);
            const repoValidation = await validateSessionRepository(sessionData);

            // 处理仓库不匹配或不在仓库中的情况
            if (repoValidation.status === 'mismatch' || repoValidation.status === 'not_in_repo') {
              const sessionRepo = repoValidation.sessionRepo;
              if (sessionRepo) {
                // 检查已知路径
                const knownPaths = getKnownPathsForRepo(sessionRepo);
                const existingPaths = await filterExistingPaths(knownPaths);
                if (existingPaths.length > 0) {
                  // 显示目录切换对话框
                  const selectedPath = await launchTeleportRepoMismatchDialog(root, {
                    targetRepo: sessionRepo,
                    initialPaths: existingPaths
                  });
                  if (selectedPath) {
                    // 切换到所选目录
                    process.chdir(selectedPath);
                    setCwd(selectedPath);
                    setOriginalCwd(selectedPath);
                  } else {
                    // 用户取消
                    await gracefulShutdown(0);
                  }
                } else {
                  // 无已知路径——显示原始错误
                  throw new TeleportOperationError(`You must run limkenion --teleport ${teleport} from a checkout of ${sessionRepo}.`, chalk.red(`You must run limkenion --teleport ${teleport} from a checkout of ${chalk.bold(sessionRepo)}.\n`));
                }
              }
            } else if (repoValidation.status === 'error') {
              throw new TeleportOperationError(repoValidation.errorMessage || '会话校验失败', chalk.red(`错误：${repoValidation.errorMessage || '会话校验失败'}\n`));
            }
            await validateGitState();

            // 为 teleport 使用进度 UI
            const {
              teleportWithProgress
            } = await import('./components/TeleportProgress.js');
            const result = await teleportWithProgress(root, teleport);
            // 跟踪 teleport 会话，用于可靠性日志记录
            setTeleportedSessionInfo({
              sessionId: teleport
            });
            messages = result.messages;
          } catch (error) {
            if (error instanceof TeleportOperationError) {
              process.stderr.write(error.formattedMessage + '\n');
            } else {
              logError(error);
              process.stderr.write(chalk.red(`Error: ${errorMessage(error)}\n`));
            }
            await gracefulShutdown(1);
          }
        }
      }
      

      // 若尚未作为文件加载，则尝试作为会话 ID
      if (maybeSessionId) {
        // 按 ID 恢复特定会话
        const sessionId = maybeSessionId;
        try {
          const resumeStart = performance.now();
          // 可用时使用 matchedLog（按自定义标题跨 worktree 恢复）
          // 否则回退到 sessionId 字符串（直接 UUID 恢复）
          const result = await loadConversationForResume(matchedLog ?? sessionId, undefined);
          if (!result) {
            logEvent('limkenion_session_resumed', {
              entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: false
            });
            return await exitWithError(root, `No conversation found with session ID: ${sessionId}`);
          }
          const fullPath = matchedLog?.fullPath ?? result.fullPath;
          processedResume = await processResumedConversation(result, {
            forkSession: !!options.forkSession,
            sessionIdOverride: sessionId,
            transcriptPath: fullPath
          }, resumeContext);
          if (processedResume.restoredAgentDef) {
            mainThreadAgentDefinition = processedResume.restoredAgentDef;
          }
          logEvent('limkenion_session_resumed', {
            entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            success: true,
            resume_duration_ms: Math.round(performance.now() - resumeStart)
          });
        } catch (error) {
          logEvent('limkenion_session_resumed', {
            entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            success: false
          });
          logError(error);
          await exitWithError(root, `恢复会话失败：${sessionId}`);
        }
      }

      // 渲染 REPL 前等待文件下载（文件必须可用）
      if (fileDownloadPromise) {
        try {
          const results = await fileDownloadPromise;
          const failedCount = count(results, r => !r.success);
          if (failedCount > 0) {
            process.stderr.write(chalk.yellow(`警告：${failedCount}/${results.length} 个文件下载失败。\n`));
          }
        } catch (error) {
          return await exitWithError(root, `下载文件时出错：${errorMessage(error)}`);
        }
      }

      // 若我们已处理恢复或拥有 teleport 消息，则渲染 REPL
      const resumeData = processedResume ?? (Array.isArray(messages) ? {
        messages,
        fileHistorySnapshots: undefined,
        agentName: undefined,
        agentColor: undefined as AgentColorName | undefined,
        restoredAgentDef: mainThreadAgentDefinition,
        initialState,
        contentReplacements: undefined
      } : undefined);
      if (resumeData) {
        maybeActivateProactive(options);
        maybeActivateBrief(options);
        await launchRepl(root, {
          getFpsMetrics,
          stats,
          initialState: resumeData.initialState
        }, {
          ...sessionConfig,
          mainThreadAgentDefinition: resumeData.restoredAgentDef ?? mainThreadAgentDefinition,
          initialMessages: resumeData.messages,
          initialFileHistorySnapshots: resumeData.fileHistorySnapshots,
          initialContentReplacements: resumeData.contentReplacements,
          initialAgentName: resumeData.agentName,
          initialAgentColor: resumeData.agentColor
        }, renderAndRun);
      } else {
        // 显示交互式选择器（包含同仓库的 worktree）
        // 注意：ResumeConversation 内部加载日志，以确保选择后正确 GC
        await launchResumeChooser(root, {
          getFpsMetrics,
          stats,
          initialState
        }, getWorktreePaths(getOriginalCwd()), {
          ...sessionConfig,
          initialSearchQuery: searchTerm,
          forkSession: options.forkSession,
          filterByPr
        });
      }
    } else {
      // 将未解析的 hooks promise 传给 REPL，使它能立即渲染，
      // 而不是阻塞约 500ms 等待 SessionStart hooks 完成。
      // REPL 会在它们解析时注入 hook 消息，并在首次 API 调用前
      // 等待它们，使模型始终看到 hook 上下文。
      const pendingHookMessages = hooksPromise && hookMessages.length === 0 ? hooksPromise : undefined;
      profileCheckpoint('action_after_hooks');
      maybeActivateProactive(options);
      maybeActivateBrief(options);
      // 为全新会话持久化当前模式，使未来恢复知道使用了哪种模式
      if (feature('COORDINATOR_MODE')) {
        saveMode(coordinatorModeModule?.isCoordinatorMode() ? 'coordinator' : 'normal');
      }

      // 若通过深链接启动，显示来源横幅，使用户
      // 知道会话源自外部。Linux xdg-open 和
      // 设置“始终允许”的浏览器会以无 OS 级
      // 确认的方式派发链接，因此这是用户得到的唯一信号——提示词，
      // 及其隐含的工作目录 / LIMKENION.md——来自
      // 外部来源，而非他们输入的内容。
      let deepLinkBanner: ReturnType<typeof createSystemMessage> | null = null;
      if (feature('LODESTONE')) {
        if (options.deepLinkOrigin) {
          logEvent('limkenion_deep_link_opened', {
            has_prefill: Boolean(options.prefill),
            has_repo: Boolean(options.deepLinkRepo)
          });
          deepLinkBanner = createSystemMessage(buildDeepLinkBanner({
            cwd: getCwd(),
            prefillLength: options.prefill?.length,
            repo: options.deepLinkRepo,
            lastFetch: options.deepLinkLastFetch !== undefined ? new Date(options.deepLinkLastFetch) : undefined
          }), 'warning');
        } else if (options.prefill) {
          deepLinkBanner = createSystemMessage('Launched with a pre-filled prompt — review it before pressing Enter.', 'warning');
        }
      }
      const initialMessages = deepLinkBanner ? [deepLinkBanner, ...hookMessages] : hookMessages.length > 0 ? hookMessages : undefined;
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState
      }, {
        ...sessionConfig,
        initialMessages,
        pendingHookMessages
      }, renderAndRun);
    }
  }).version(`${MACRO.VERSION} (Limkenion)`, '-v, --version', '输出版本号');

  // Worktree 标志
  program.option('-w, --worktree [name]', '为此会话创建新的 git worktree（可选择指定名称）');
  program.option('--tmux', 'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.');
  if (canUserConfigureAdvisor()) {
    program.addOption(new Option('--advisor <model>', 'Enable the server-side advisor tool with the specified model (alias or full ID).').hideHelp());
  }
  
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(new Option('--enable-auto-mode', 'Opt in to auto mode').hideHelp());
  }
  if (feature('PROACTIVE') || feature('KAIROS')) {
    program.addOption(new Option('--proactive', 'Start in proactive autonomous mode'));
  }
  if (feature('UDS_INBOX')) {
    program.addOption(new Option('--messaging-socket-path <path>', 'Unix domain socket path for the UDS messaging server (defaults to a tmp path)'));
  }
  if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
    program.addOption(new Option('--brief', '启用 SendUserMessage 工具，用于 agent 与用户之间的通信'));
  }
  if (feature('KAIROS')) {
    program.addOption(new Option('--assistant', 'Force assistant mode (Agent SDK daemon use)').hideHelp());
  }
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    program.addOption(new Option('--channels <servers...>', 'MCP servers whose channel notifications (inbound push) should register this session. Space-separated server names.').hideHelp());
    program.addOption(new Option('--dangerously-load-development-channels <servers...>', 'Load channel servers not on the approved allowlist. For local channel development only. Shows a confirmation dialog at startup.').hideHelp());
  }

  // 队友身份选项（leader 生成 tmux 队友时设置）
  // 这些会替换 LIMKENION_* 环境变量
  program.addOption(new Option('--agent-id <id>', 'Teammate agent ID').hideHelp());
  program.addOption(new Option('--agent-name <name>', 'Teammate display name').hideHelp());
  program.addOption(new Option('--team-name <name>', 'Team name for swarm coordination').hideHelp());
  program.addOption(new Option('--agent-color <color>', 'Teammate UI color').hideHelp());
  program.addOption(new Option('--plan-mode-required', 'Require plan mode before implementation').hideHelp());
  program.addOption(new Option('--parent-session-id <id>', 'Parent session ID for analytics correlation').hideHelp());
  program.addOption(new Option('--teammate-mode <mode>', 'How to spawn teammates: "tmux", "in-process", or "auto"').choices(['auto', 'tmux', 'in-process']).hideHelp());
  program.addOption(new Option('--agent-type <type>', 'Custom agent type for this teammate').hideHelp());

  // 所有构建都启用 SDK URL，但隐藏在帮助中
  program.addOption(new Option('--sdk-url <url>', 'Use remote WebSocket endpoint for SDK I/O streaming (only with -p and stream-json format)').hideHelp());

  // 为所有构建启用 teleport/remote 标志，但在 GA 前保持未文档化
  program.addOption(new Option('--teleport [session]', 'Resume a teleport session, optionally specify session ID').hideHelp());
  program.addOption(new Option('--remote [description]', 'Create a remote session with the given description').hideHelp());
  if (feature('BRIDGE_MODE')) {
    program.addOption(new Option('--remote-control [name]', 'Start an interactive session with Remote Control enabled (optionally named)').argParser(value => value || true).hideHelp());
    program.addOption(new Option('--rc [name]', 'Alias for --remote-control').argParser(value => value || true).hideHelp());
  }
  if (feature('HARD_FAIL')) {
    program.addOption(new Option('--hard-fail', '在调用 logError 时崩溃而非静默记录').hideHelp());
  }
  profileCheckpoint('run_main_options_built');

  // -p/--print 模式：跳过子命令注册。52 个子命令
  //（mcp、auth、plugin、skill、task、config、doctor、update 等）在
  // print 模式下从不被派发——commander 会把 prompt 路由到
  // 默认 action。子命令注册路径基线测量约 65ms——
  // 主要是 isBridgeEnabled() 调用（25ms 的 settings Zod 解析
  // + 40ms 同步钥匙串子进程），两者都被 try/catch 隐藏，
  // 在 enableConfigs() 前始终返回 false。cc:// URL 在 main() 第
  // 约 851 行此处运行前已被改写为 `open`，因此 argv 检查在这是安全的。
  const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print');
  const isCcUrl = process.argv.some(a => a.startsWith('cc://') || a.startsWith('cc+unix://'));
  if (isPrintMode && !isCcUrl) {
    profileCheckpoint('run_before_parse');
    await program.parseAsync(process.argv);
    profileCheckpoint('run_after_parse');
    return program;
  }

  // limkenion mcp

  const mcp = program.command('mcp').description('配置与管理 MCP 服务器').configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  mcp.command('serve').description(`启动 Limkenion MCP 服务器`).option('-d, --debug', '启用调试模式', () => true).option('--verbose', '覆盖配置中的详细输出模式设置', () => true).action(async ({
    debug,
    verbose
  }: {
    debug?: boolean;
    verbose?: boolean;
  }) => {
    const {
      mcpServeHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpServeHandler({
      debug,
      verbose
    });
  });

  // 注册 mcp add 子命令（为可测试性提取）
  registerMcpAddCommand(mcp);
  if (isXaaEnabled()) {
    registerMcpXaaIdpCommand(mcp);
  }
  mcp.command('remove <name>').description('移除一个 MCP 服务器').option('-s, --scope <scope>', '配置范围（local、user 或 project）——若未指定，则从其所在范围移除').action(async (name: string, options: {
    scope?: string;
  }) => {
    const {
      mcpRemoveHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpRemoveHandler(name, options);
  });
  mcp.command('list').description('列出已配置的 MCP 服务器。注意：会跳过工作区信任对话框，并为做健康检查而启动 .mcp.json 中的 stdio 服务器。请仅在可信目录中使用此命令。').action(async () => {
    const {
      mcpListHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpListHandler();
  });
  mcp.command('get <name>').description('查看某个 MCP 服务器的详情。注意：会跳过工作区信任对话框，并为做健康检查而启动 .mcp.json 中的 stdio 服务器。请仅在可信目录中使用此命令。').action(async (name: string) => {
    const {
      mcpGetHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpGetHandler(name);
  });
  mcp.command('add-json <name> <json>').description('通过 JSON 字符串添加一个 MCP 服务器（stdio 或 SSE）').option('-s, --scope <scope>', '配置范围（local、user 或 project）', 'local').option('--client-secret', '提示输入 OAuth 客户端密钥（或设置 MCP_CLIENT_SECRET 环境变量）').action(async (name: string, json: string, options: {
    scope?: string;
    clientSecret?: true;
  }) => {
    const {
      mcpAddJsonHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpAddJsonHandler(name, json, options);
  });
  mcp.command('add-from-limkenion-desktop').description('从 Limkenion 桌面版导入 MCP 服务器（仅限 Mac 和 WSL）').option('-s, --scope <scope>', '配置范围（local、user 或 project）', 'local').action(async (options: {
    scope?: string;
  }) => {
    const {
      mcpAddFromDesktopHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpAddFromDesktopHandler(options);
  });
  mcp.command('reset-project-choices').description('重置此项目中所有已批准和已拒绝的项目级（.mcp.json）服务器').action(async () => {
    const {
      mcpResetChoicesHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpResetChoicesHandler();
  });

  // limkenion server

  // `limkenion ssh <host> [dir]`——仅在此注册以便 --help 显示它。
  // 实际交互流程由 main() 中的提前 argv 改写处理
  //（与上述 DIRECT_CONNECT/cc:// 模式对应）。若 commander 到达
  // 此 action，说明 argv 改写未触发（例如用户运行了
  // `limkenion ssh` 且无主机）——仅打印用法。
  if (feature('SSH_REMOTE')) {
    program.command('ssh <host> [dir]').description('通过 SSH 在远程主机上运行 Limkenion。会部署二进制文件并 ' + '将 API 认证隧道回传你的本地机器——无需任何远程配置。').option('--permission-mode <mode>', '远程会话的权限模式').option('--dangerously-skip-permissions', '跳过远程机器上的所有权限提示（危险）').option('--local', 'e2e 测试模式——在本地启动子 CLI（跳过 ssh/部署）。' + '用于在无远程主机时演练认证代理与 unix 套接字管道。').action(async () => {
      // main() 中的 argv 改写本应在 commander 运行前消费掉 `ssh <host>`。
      // 到达这里意味着主机缺失或改写谓词不匹配。
      process.stderr.write('用法: limkenion ssh <user@host | ssh-config-alias> [dir]\n\n' + "在远程 Linux 主机上运行 Limkenion。无需在远程端安装任何东西，\n" + '也无需在远程运行 `limkenion auth login`——二进制文件会通过 SSH 部署，\n' + 'API 认证会隧道回传你的本地机器。\n');
      process.exit(1);
    });
  }

  // limkenion connect ——子命令仅处理 -p（无头）模式。
  // 交互式模式（无 -p）由 main() 中的提前 argv 改写处理，
  // 它会以完整 TUI 支持重定向到主命令。

  // limkenion auth

  const auth = program.command('auth').description('管理身份认证').configureHelp(createSortedHelpConfig());
  auth.command('login').description('登录你的 Limkenion 账户').option('--email <email>', '在登录页预填邮箱地址').option('--sso', '强制走 SSO 登录流程').option('--console', '使用 Limkenion 控制台（API 用量计费）而非 Limkenion 订阅').option('--limkenionai', '使用 Limkenion 订阅（默认）').action(async ({
    email,
    sso,
    console: useConsole,
    limkenionai
  }: {
    email?: string;
    sso?: boolean;
    console?: boolean;
    limkenionai?: boolean;
  }) => {
    const {
      authLogin
    } = await import('./cli/handlers/auth.js');
    await authLogin({
      email,
      sso,
      console: useConsole,
      limkenionai
    });
  });
  auth.command('status').description('显示身份认证状态').option('--json', '以 JSON 输出（默认）').option('--text', '以易读文本输出').action(async (opts: {
    json?: boolean;
    text?: boolean;
  }) => {
    const {
      authStatus
    } = await import('./cli/handlers/auth.js');
    await authStatus(opts);
  });
  auth.command('logout').description('退出你的 Limkenion 账户').action(async () => {
    const {
      authLogout
    } = await import('./cli/handlers/auth.js');
    await authLogout();
  });

  /**
   * 一致地处理市场命令错误的辅助函数。
   * 记录错误后以状态码 1 退出进程。
   * @param error 发生的错误
   * @param action 失败操作的描述
   */
  // 面向 cowork_plugins 目录的、用于所有插件/市场子命令的隐藏标志。
  const coworkOption = () => new Option('--cowork', 'Use cowork_plugins directory').hideHelp();

  // 插件校验命令
  const pluginCmd = program.command('plugin').alias('plugins').description('管理 Limkenion 插件').configureHelp(createSortedHelpConfig());
  pluginCmd.command('validate <path>').description('校验插件或市场清单').addOption(coworkOption()).action(async (manifestPath: string, options: {
    cowork?: boolean;
  }) => {
    const {
      pluginValidateHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginValidateHandler(manifestPath, options);
  });

  // 插件列表命令
  pluginCmd.command('list').description('列出已安装的插件').option('--json', '以 JSON 输出').option('--available', '包含市场中可用的插件（需要 --json）').addOption(coworkOption()).action(async (options: {
    json?: boolean;
    available?: boolean;
    cowork?: boolean;
  }) => {
    const {
      pluginListHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginListHandler(options);
  });

  // 市场子命令
  const marketplaceCmd = pluginCmd.command('marketplace').description('管理 Limkenion 插件市场').configureHelp(createSortedHelpConfig());
  marketplaceCmd.command('add <source>').description('从 URL、路径或 GitHub 仓库添加市场').addOption(coworkOption()).option('--sparse <paths...>', '通过 git sparse-checkout 将检出限定到指定目录（用于 monorepo）。示例：--sparse .limkenion-plugin plugins').option('--scope <scope>', '在哪里声明市场：user（默认）、project 或 local').action(async (source: string, options: {
    cowork?: boolean;
    sparse?: string[];
    scope?: string;
  }) => {
    const {
      marketplaceAddHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceAddHandler(source, options);
  });
  marketplaceCmd.command('list').description('列出所有已配置的市场').option('--json', '以 JSON 输出').addOption(coworkOption()).action(async (options: {
    json?: boolean;
    cowork?: boolean;
  }) => {
    const {
      marketplaceListHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceListHandler(options);
  });
  marketplaceCmd.command('remove <name>').alias('rm').description('移除一个已配置的市场').addOption(coworkOption()).action(async (name: string, options: {
    cowork?: boolean;
  }) => {
    const {
      marketplaceRemoveHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceRemoveHandler(name, options);
  });
  marketplaceCmd.command('update [name]').description('从源更新市场——未指定名称时更新所有市场').addOption(coworkOption()).action(async (name: string | undefined, options: {
    cowork?: boolean;
  }) => {
    const {
      marketplaceUpdateHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceUpdateHandler(name, options);
  });

  // 插件安装命令
  pluginCmd.command('install <plugin>').alias('i').description('从可用市场安装插件（可针对特定市场使用 plugin@marketplace）').option('-s, --scope <scope>', '安装范围：user、project 或 local', 'user').addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginInstallHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginInstallHandler(plugin, options);
  });

  // 插件卸载命令
  pluginCmd.command('uninstall <plugin>').alias('remove').alias('rm').description('卸载一个已安装的插件').option('-s, --scope <scope>', '卸载范围：user、project 或 local', 'user').option('--keep-data', "保留插件的持久数据目录（~/.limkenion/plugins/data/{id}/）").addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
    keepData?: boolean;
  }) => {
    const {
      pluginUninstallHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginUninstallHandler(plugin, options);
  });

  // 插件启用命令
  pluginCmd.command('enable <plugin>').description('启用一个已禁用的插件').option('-s, --scope <scope>', `安装范围：${VALID_INSTALLABLE_SCOPES.join(', ')}（默认：自动检测）`).addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginEnableHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginEnableHandler(plugin, options);
  });

  // 插件禁用命令
  pluginCmd.command('disable [plugin]').description('禁用一个已启用的插件').option('-a, --all', '禁用所有已启用的插件').option('-s, --scope <scope>', `安装范围：${VALID_INSTALLABLE_SCOPES.join(', ')}（默认：自动检测）`).addOption(coworkOption()).action(async (plugin: string | undefined, options: {
    scope?: string;
    cowork?: boolean;
    all?: boolean;
  }) => {
    const {
      pluginDisableHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginDisableHandler(plugin, options);
  });

  // 插件更新命令
  pluginCmd.command('update <plugin>').description('将插件更新到最新版本（需重启才能生效）').option('-s, --scope <scope>', `安装范围：${VALID_UPDATE_SCOPES.join(', ')}（默认：user）`).addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginUpdateHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginUpdateHandler(plugin, options);
  });
  // END ANT-ONLY

  // Agents 命令 - 列出已配置的 agent
  program.command('agents').description('列出已配置的 agent').option('--setting-sources <sources>', '要加载的设置来源列表，用逗号分隔（user、project、local）。').action(async () => {
    const {
      agentsHandler
    } = await import('./cli/handlers/agents.js');
    await agentsHandler();
    process.exit(0);
  });
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 当 limkenion_auto_mode_config.enabled === 'disabled' 时跳过（熔断器）。
    // 从磁盘缓存读取——注册时 GrowthBook 尚未初始化。
    if (getAutoModeEnabledStateIfCached() !== 'disabled') {
      const autoModeCmd = program.command('auto-mode').description('查看自动模式分类器配置');
      autoModeCmd.command('defaults').description('以 JSON 打印默认的自动模式环境、允许与拒绝规则').action(async () => {
        const {
          autoModeDefaultsHandler
        } = await import('./cli/handlers/autoMode.js');
        autoModeDefaultsHandler();
        process.exit(0);
      });
      autoModeCmd.command('config').description('以 JSON 打印生效的自动模式配置：未设置的用默认值').action(async () => {
        const {
          autoModeConfigHandler
        } = await import('./cli/handlers/autoMode.js');
        autoModeConfigHandler();
        process.exit(0);
      });
      autoModeCmd.command('critique').description('获得对你自定义自动模式规则的 AI 反馈').option('--model <model>', '覆盖所使用的模型').action(async options => {
        const {
          autoModeCritiqueHandler
        } = await import('./cli/handlers/autoMode.js');
        await autoModeCritiqueHandler(options);
        process.exit();
      });
    }
  }

  if (feature('KAIROS')) {
    program.command('assistant [sessionId]').description('将 REPL 作为客户端挂接到正在运行的 bridge 会话。若未给出 sessionId 则通过 API 发现会话。').action(() => {
      // 上面的 argv 改写应在 commander 运行前就消费掉 `assistant [id]`。
      // 走到这里说明根标志在前（例如 `--debug assistant`），且第 0 位置
      // 谓词未匹配。像 ssh 存根一样打印用法。
      process.stderr.write('用法: limkenion assistant [sessionId]\n\n' + '将 REPL 作为查看客户端挂接到正在运行的 bridge 会话。\n' + '省略 sessionId 以发现并从可用会话中选择。\n');
      process.exit(1);
    });
  }

  // Doctor 命令 - 检查安装健康状况
  program.command('doctor').description('检查你的 Limkenion 自动更新器健康状况。注意：会跳过工作区信任对话框，并为做健康检查而启动 .mcp.json 中的 stdio 服务器。请仅在可信目录中使用此命令。').action(async () => {
    const [{
      doctorHandler
    }, {
      createRoot
    }] = await Promise.all([import('./cli/handlers/util.js'), import('./ink.js')]);
    const root = await createRoot(getBaseRenderOptions(false));
    await doctorHandler(root);
  });

  // limkenion update
  //
  // 对于带构建元数据的 SemVer 兼容版本（X.X.X+SHA）：
  // - 我们执行精确字符串比较（含 SHA）以检测任何变更
  // - 这确保用户始终获得最新构建，即使只更改了 SHA
  // - UI 为清晰起见显示包含构建元数据的两个版本
  program.command('update').alias('upgrade').description('检查更新并在可用时安装').action(async () => {
    const {
      update
    } = await import('src/cli/update.js');
    await update();
  });

  // limkenion up — 运行项目 LIMKENION.md 中的 "# limkenion up" 设置说明.
  

  // limkenion rollback（仅 ant）
  // 回滚到之前的版本
  

  // limkenion install
  program.command('install [target]').description('安装 Limkenion 原生构建。使用 [target] 指定版本（stable、latest 或具体版本号）').option('--force', '即使已安装也强制安装').action(async (target: string | undefined, options: {
    force?: boolean;
  }) => {
    const {
      installHandler
    } = await import('./cli/handlers/util.js');
    await installHandler(target, options);
  });

  // 仅 ant 命令
  
  profileCheckpoint('run_before_parse');
  await program.parseAsync(process.argv);
  profileCheckpoint('run_after_parse');

  // 为 total_time 计算记录最终检查点
  profileCheckpoint('main_after_run');

  // 向 Statsig 记录启动性能（采样）并在启用时输出详细报告
  profileReport();
  return program;
}
async function logLimkenionInit({
  hasInitialPrompt,
  hasStdin,
  verbose,
  debug,
  debugToStderr,
  print,
  outputFormat,
  inputFormat,
  numAllowedTools,
  numDisallowedTools,
  mcpClientCount,
  worktreeEnabled,
  skipWebFetchPreflight,
  githubActionInputs,
  dangerouslySkipPermissionsPassed,
  permissionMode,
  modeIsBypass,
  allowDangerouslySkipPermissionsPassed,
  systemPromptFlag,
  appendSystemPromptFlag,
  thinkingConfig,
  assistantActivationPath
}: {
  hasInitialPrompt: boolean;
  hasStdin: boolean;
  verbose: boolean;
  debug: boolean;
  debugToStderr: boolean;
  print: boolean;
  outputFormat: string;
  inputFormat: string;
  numAllowedTools: number;
  numDisallowedTools: number;
  mcpClientCount: number;
  worktreeEnabled: boolean;
  skipWebFetchPreflight: boolean | undefined;
  githubActionInputs: string | undefined;
  dangerouslySkipPermissionsPassed: boolean;
  permissionMode: string;
  modeIsBypass: boolean;
  allowDangerouslySkipPermissionsPassed: boolean;
  systemPromptFlag: 'file' | 'flag' | undefined;
  appendSystemPromptFlag: 'file' | 'flag' | undefined;
  thinkingConfig: ThinkingConfig;
  assistantActivationPath: string | undefined;
}): Promise<void> {
  try {
    logEvent('limkenion_init', {
      entrypoint: 'limkenion' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      hasInitialPrompt,
      hasStdin,
      verbose,
      debug,
      debugToStderr,
      print,
      outputFormat: outputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inputFormat: inputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numAllowedTools,
      numDisallowedTools,
      mcpClientCount,
      worktree: worktreeEnabled,
      skipWebFetchPreflight,
      ...(githubActionInputs && {
        githubActionInputs: githubActionInputs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      dangerouslySkipPermissionsPassed,
      permissionMode: permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      modeIsBypass,
      inProtectedNamespace: isInProtectedNamespace(),
      allowDangerouslySkipPermissionsPassed,
      thinkingType: thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(systemPromptFlag && {
        systemPromptFlag: systemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      ...(appendSystemPromptFlag && {
        appendSystemPromptFlag: appendSystemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      is_simple: isBareMode() || undefined,
      is_coordinator: feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode() ? true : undefined,
      ...(assistantActivationPath && {
        assistantActivationPath: assistantActivationPath as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      autoUpdatesChannel: (getInitialSettings().autoUpdatesChannel ?? 'latest') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(({}))
    });
  } catch (error) {
    logError(error);
  }
}
function maybeActivateProactive(options: unknown): void {
  if ((feature('PROACTIVE') || feature('KAIROS')) && ((options as {
    proactive?: boolean;
  }).proactive || isEnvTruthy(process.env.LIMKENION_PROACTIVE))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proactiveModule = require('./proactive/index.js');
    if (!proactiveModule.isProactiveActive()) {
      proactiveModule.activateProactive('command');
    }
  }
}
function maybeActivateBrief(options: unknown): void {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) return;
  const briefFlag = (options as {
    brief?: boolean;
  }).brief;
  const briefEnv = isEnvTruthy(process.env.LIMKENION_BRIEF);
  if (!briefFlag && !briefEnv) return;
  // --brief / LIMKENION_BRIEF 是显式选择加入：先通过检查 entitlement，
  // 然后设置 userMsgOptIn 以激活该工具和提示词区段。该环境
  // 变量同样授予 entitlement（isBriefEntitled() 会读取它），因此仅设置
  // LIMKENION_BRIEF=1 即可在开发/测试时强制启用——无需 GB 开关。
  // initialIsBriefOnly 直接读取 getUserMsgOptIn()。
  // 条件 require：静态 import 会把工具名串经 BriefTool.ts → prompt.ts
  // 泄漏到外部构建中。
  /* eslint-disable @typescript-eslint/no-require-imports */
  const {
    isBriefEntitled
  } = require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const entitled = isBriefEntitled();
  if (entitled) {
    setUserMsgOptIn(true);
  }
  // 一旦看到意图即无条件触发：enabled=false 捕获
  // 在 Datadog 中的“用户已尝试但被门控”的失败模式。
  logEvent('limkenion_brief_mode_enabled', {
    enabled: entitled,
    gated: !entitled,
    source: (briefEnv ? 'env' : 'flag') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
}
function resetCursor() {
  const terminal = process.stderr.isTTY ? process.stderr : process.stdout.isTTY ? process.stdout : undefined;
  terminal?.write(SHOW_CURSOR);
}
type TeammateOptions = {
  agentId?: string;
  agentName?: string;
  teamName?: string;
  agentColor?: string;
  planModeRequired?: boolean;
  parentSessionId?: string;
  teammateMode?: 'auto' | 'tmux' | 'in-process';
  agentType?: string;
};
function extractTeammateOptions(options: unknown): TeammateOptions {
  if (typeof options !== 'object' || options === null) {
    return {};
  }
  const opts = options as Record<string, unknown>;
  const teammateMode = opts.teammateMode;
  return {
    agentId: typeof opts.agentId === 'string' ? opts.agentId : undefined,
    agentName: typeof opts.agentName === 'string' ? opts.agentName : undefined,
    teamName: typeof opts.teamName === 'string' ? opts.teamName : undefined,
    agentColor: typeof opts.agentColor === 'string' ? opts.agentColor : undefined,
    planModeRequired: typeof opts.planModeRequired === 'boolean' ? opts.planModeRequired : undefined,
    parentSessionId: typeof opts.parentSessionId === 'string' ? opts.parentSessionId : undefined,
    teammateMode: teammateMode === 'auto' || teammateMode === 'tmux' || teammateMode === 'in-process' ? teammateMode : undefined,
    agentType: typeof opts.agentType === 'string' ? opts.agentType : undefined
  };
}