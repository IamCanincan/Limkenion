import { feature } from 'bun:bundle';
import { appendFileSync } from 'fs';
import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import { type ChannelEntry, getAllowedChannels, setAllowedChannels, setHasDevChannels, setSessionTrustAccepted, setStatsStore } from './bootstrap/state.js';
import type { Command } from './commands.js';
import { createStatsStore, type StatsStore } from './context/stats.js';
import { getSystemContext } from './context.js';
import { initializeTelemetryAfterTrust } from './entrypoints/init.js';
import { isSynchronizedOutputSupported } from './ink/terminal.js';
import type { RenderOptions, Root, TextProps } from './ink.js';
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js';
import { startDeferredPrefetches } from './main.js';
import { checkGate_CACHED_OR_BLOCKING, initializeGrowthBook, resetGrowthBook } from './services/analytics/growthbook.js';
import { isQualifiedForGrove } from './services/api/grove.js';
import { handleMcpjsonServerApprovals } from './services/mcpServerApproval.js';
import { AppStateProvider } from './state/AppState.js';
import { onChangeAppState } from './state/onChangeAppState.js';
import { normalizeApiKeyForConfig } from './utils/authPortable.js';
import { getExternalLimkenionMdIncludes, getMemoryFiles, shouldShowLimkenionMdExternalIncludesWarning } from './utils/limkenionmd.js';
import { checkHasTrustDialogAccepted, getCustomApiKeyStatus, getGlobalConfig, saveGlobalConfig } from './utils/config.js';
import { updateDeepLinkTerminalPreference } from './utils/deepLink/terminalPreference.js';
import { isEnvTruthy, isRunningOnHomespace } from './utils/envUtils.js';
import { type FpsMetrics, FpsTracker } from './utils/fpsTracker.js';
import { updateGithubRepoPathMapping } from './utils/githubRepoPathMapping.js';
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js';
import type { PermissionMode } from './utils/permissions/PermissionMode.js';
import { getBaseRenderOptions } from './utils/renderOptions.js';
import { getSettingsWithAllErrors } from './utils/settings/allErrors.js';
import { hasAutoModeOptIn, hasSkipDangerousModePermissionPrompt } from './utils/settings/settings.js';
export function completeOnboarding(): void {
  saveGlobalConfig(current => ({
    ...current,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: MACRO.VERSION
  }));
}
export function showDialog<T = void>(root: Root, renderer: (done: (result: T) => void) => React.ReactNode): Promise<T> {
  return new Promise<T>(resolve => {
    const done = (result: T): void => void resolve(result);
    root.render(renderer(done));
  });
}

/**
 * 通过 Ink 渲染一条错误消息，然后卸载并退出。
 * 用于 Ink root 创建之后发生的致命错误 ——
 * console.error 会被 Ink 的 patchConsole 吞掉，所以改为
 * 通过 React 树渲染。
 */
export async function exitWithError(root: Root, message: string, beforeExit?: () => Promise<void>): Promise<never> {
  return exitWithMessage(root, message, {
    color: 'error',
    beforeExit
  });
}

/**
 * 通过 Ink 渲染一条消息，然后卸载并退出。
 * 用于 Ink root 创建之后的消息输出 ——
 * console 输出会被 Ink 的 patchConsole 吞掉，所以改为
 * 通过 React 树渲染。
 */
export async function exitWithMessage(root: Root, message: string, options?: {
  color?: TextProps['color'];
  exitCode?: number;
  beforeExit?: () => Promise<void>;
}): Promise<never> {
  const {
    Text
  } = await import('./ink.js');
  const color = options?.color;
  const exitCode = options?.exitCode ?? 1;
  root.render(color ? <Text color={color}>{message}</Text> : <Text>{message}</Text>);
  root.unmount();
  await options?.beforeExit?.();
  // eslint-disable-next-line custom-rules/no-process-exit -- exit after Ink unmount
  process.exit(exitCode);
}

/**
 * 展示一个包在 AppStateProvider + KeybindingSetup 中的设置对话框。
 * 减少 showSetupScreens() 里的样板代码 —— 那里每个对话框都需要这两层包装。
 */
export function showSetupDialog<T = void>(root: Root, renderer: (done: (result: T) => void) => React.ReactNode, options?: {
  onChangeAppState?: typeof onChangeAppState;
}): Promise<T> {
  return showDialog<T>(root, done => <AppStateProvider onChangeAppState={options?.onChangeAppState}>
      <KeybindingSetup>{renderer(done)}</KeybindingSetup>
    </AppStateProvider>);
}

/**
 * 把主 UI 渲染到 root 中并等待其退出。
 * 处理共同的收尾流程：启动延迟预取、等待退出、优雅关闭。
 */
export async function renderAndRun(root: Root, element: React.ReactNode): Promise<void> {
  root.render(element);
  startDeferredPrefetches();
  await root.waitUntilExit();
  await gracefulShutdown(0);
}
export async function showSetupScreens(root: Root, permissionMode: PermissionMode, allowDangerouslySkipPermissions: boolean, commands?: Command[], limkenionInChrome?: boolean, devChannels?: ChannelEntry[]): Promise<boolean> {
  if ("production" === 'test' || isEnvTruthy(false) || process.env.IS_DEMO // demo 模式下跳过引导流程
  ) {
    return false;
  }
  const config = getGlobalConfig();

  // 当已经配置了 API key 时跳过引导向导。
  // 该向导会让你选择登录方式（订阅 / console / 第三方）和主题 ——
  // 对使用 DeepSeek 或其他 OpenAI 兼容端点的 API key 用户来说，两者都没有意义。
  // 注意这里只跳过 Onboarding；下面的 TrustDialog 是安全边界，仍会执行。
  const hasApiKey = Boolean(
    process.env.LIMKENION_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY,
  )

  let onboardingShown = false;
  if (!hasApiKey && (!config.theme || !config.hasCompletedOnboarding) // 至少始终显示一次引导流程
  ) {
    onboardingShown = true;
    const {
      Onboarding
    } = await import('./components/Onboarding.js');
    await showSetupDialog(root, done => <Onboarding onDone={() => {
      completeOnboarding();
      void done();
    }} />, {
      onChangeAppState
    });
  }

  // 交互式会话中始终显示信任对话框，与权限模式无关。
  // 信任对话框是工作区信任边界 —— 它会对不受信任的仓库发出警告，
  // 并检查 LIMKENION.md 的外部 include。bypassPermissions 模式
  // 只影响工具执行权限，不影响工作区信任。
  // 注意：非交互式会话（带 -p 的 CI/CD）根本不会走到 showSetupScreens。
  // 在 claubbit 中跳过权限检查
  if (!isEnvTruthy(process.env.CLAUBBIT)) {
    // 快速路径：当 CWD 已被信任时，跳过 TrustDialog 的导入与渲染。
    // 因为此时 TrustDialog 无论安全特性如何都会自动通过，
    // 所以可以跳过这一次动态导入与渲染流程。
    if (!checkHasTrustDialogAccepted()) {
      const {
        TrustDialog
      } = await import('./components/TrustDialog/TrustDialog.js');
      await showSetupDialog(root, done => <TrustDialog commands={commands} onDone={done} />);
    }

    // 标记本会话的信任已通过校验。
    // GrowthBook 会检查该标记以决定是否附带认证头。
    setSessionTrustAccepted(true);

    // 在信任建立之后重置并重新初始化 GrowthBook。
    // 针对登录/登出的防御措施：清掉之前的 client，好让下次初始化
    // 拿到全新的认证头。
    resetGrowthBook();
    void initializeGrowthBook();

    // 信任已建立，此时若尚未预取系统上下文则进行预取
    void getSystemContext();

    // 若设置有效，检查是否有需要批准的 mcp.json server
    const {
      errors: allErrors
    } = getSettingsWithAllErrors();
    if (allErrors.length === 0) {
      await handleMcpjsonServerApprovals(root);
    }

    // 检查是否有需要批准的 limkenion.md include
    if (await shouldShowLimkenionMdExternalIncludesWarning()) {
      const externalIncludes = getExternalLimkenionMdIncludes(await getMemoryFiles(true));
      const {
        LimkenionMdExternalIncludesDialog
      } = await import('./components/LimkenionMdExternalIncludesDialog.js');
      await showSetupDialog(root, done => <LimkenionMdExternalIncludesDialog onDone={done} isStandaloneDialog externalIncludes={externalIncludes} />);
    }
  }

  // 记录当前仓库路径，用于 teleport 目录切换（发后不管）
  // 必须在信任校验之后执行，以防不受信任的目录污染该映射
  void updateGithubRepoPathMapping();
  if (feature('LODESTONE')) {
    updateDeepLinkTerminalPreference();
  }

  // 在信任对话框被接受之后、或处于 bypass 模式时，应用完整环境变量
  // 在 bypass 模式（CI/CD、自动化）下我们信任该环境，因此应用全部变量
  // 在正常模式下，这一步发生在信任对话框被接受之后
  // 其中包含来自不受信任来源的、可能具有危险性的环境变量
  applyConfigEnvironmentVariables();

  // 在环境变量应用完成之后初始化遥测，这样 OTEL 端点环境变量与
  // otelHeadersHelper（执行它需要信任）才可用。
  // 推迟到下一个 tick，让 OTel 的动态导入在首次渲染之后完成解析，
  // 而不是在预渲染的微任务队列中解析。
  setImmediate(() => initializeTelemetryAfterTrust());
  if (await isQualifiedForGrove()) {
    const {
      GroveDialog
    } = await import('src/components/grove/Grove.js');
    const decision = await showSetupDialog<string>(root, done => <GroveDialog showIfAlreadyViewed={false} location={onboardingShown ? 'onboarding' : 'policy_update_modal'} onDone={done} />);
    if (decision === 'escape') {
      logEvent('limkenion_grove_policy_exited', {});
      gracefulShutdownSync(0);
      return false;
    }
  }

  // 检查自定义 API key
  // 在 homespace 上，LIMKENION_API_KEY 会保留在 process.env 中供子进程使用，
  // 但 Limkenion 自身会忽略它（见 auth.ts）。
  if (process.env.LIMKENION_API_KEY && !isRunningOnHomespace()) {
    const customApiKeyTruncated = normalizeApiKeyForConfig(process.env.LIMKENION_API_KEY);
    const keyStatus = getCustomApiKeyStatus(customApiKeyTruncated);
    if (keyStatus === 'new') {
      const {
        ApproveApiKey
      } = await import('./components/ApproveApiKey.js');
      await showSetupDialog<boolean>(root, done => <ApproveApiKey customApiKeyTruncated={customApiKeyTruncated} onDone={done} />, {
        onChangeAppState
      });
    }
  }
  if ((permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) && !hasSkipDangerousModePermissionPrompt()) {
    const {
      BypassPermissionsModeDialog
    } = await import('./components/BypassPermissionsModeDialog.js');
    await showSetupDialog(root, done => <BypassPermissionsModeDialog onAccept={done} />);
  }
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 只有当 auto 模式真正解析成功时才显示该选择加入对话框 —— 如果
    // 门禁拒绝了它（组织不在白名单、设置已禁用），为一项不可用的功能
    // 征求同意毫无意义。此时改由 verifyAutoModeGateAccess 通知
    // 来解释原因。
    if (permissionMode === 'auto' && !hasAutoModeOptIn()) {
      const {
        AutoModeOptInDialog
      } = await import('./components/AutoModeOptInDialog.js');
      await showSetupDialog(root, done => <AutoModeOptInDialog onAccept={done} onDecline={() => gracefulShutdownSync(1)} declineExits />);
    }
  }

  // --dangerously-load-development-channels 的确认。接受后，把 dev channel
  // 追加到 main.tsx 中已设置的 --channels 列表上。组织策略不会被绕过 ——
  // gateChannelServer() 仍会执行；这个开关的存在只是为了绕开
  // --channels 的已批准 server 白名单。
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    // gateChannelServer 与 ChannelsNotice 会在本函数返回之后读取
    // limkenion_harbor。冷磁盘缓存（全新安装，或该开关刚在服务端上线后的
    // 首次运行）会默认为 false，并静默丢弃整个会话的 channel 通知 ——
    // 见 gh#37026。
    // checkGate_CACHED_OR_BLOCKING 在磁盘缓存已是 true 时立即返回；
    // 只有缓存为冷/陈旧 false 时才阻塞（等待此前已触发的同一个
    // 记忆化的 initializeGrowthBook promise）。同时预热下面
    // dev-channels 对话框里的 isChannelsEnabled() 检查。
    if (getAllowedChannels().length > 0 || (devChannels?.length ?? 0) > 0) {
      await checkGate_CACHED_OR_BLOCKING('limkenion_harbor');
    }
    if (devChannels && devChannels.length > 0) {
      const [{
        isChannelsEnabled
      }, {
        getLimkenionAIOAuthTokens
      }] = await Promise.all([import('./services/mcp/channelAllowlist.js'), import('./utils/auth.js')]);
      // 当 channel 被阻断时（limkenion_harbor 关闭或没有 OAuth）跳过该对话框 ——
      // 先接受、紧接着又在 ChannelsNotice 里看到「不可用」，比干脆不弹更糟。
      // 仍然追加条目，这样 ChannelsNotice 会渲染阻断分支并把 dev 条目的
      // 名字显示出来。这里的 dev:true 是给 ChannelsNotice 里的开关标签用的
      // （hasNonDev 检查）；它同时带来的白名单绕过在此已无意义，
      // 因为上游门禁已经拦住了。
      if (!isChannelsEnabled() || !getLimkenionAIOAuthTokens()?.accessToken) {
        setAllowedChannels([...getAllowedChannels(), ...devChannels.map(c => ({
          ...c,
          dev: true
        }))]);
        setHasDevChannels(true);
      } else {
        const {
          DevChannelsDialog
        } = await import('./components/DevChannelsDialog.js');
        await showSetupDialog(root, done => <DevChannelsDialog channels={devChannels} onAccept={() => {
          // 逐条标记 dev 条目，这样在两个开关同时传入时，
          // 白名单绕过不会泄漏到 --channels 的条目上。
          setAllowedChannels([...getAllowedChannels(), ...devChannels.map(c => ({
            ...c,
            dev: true
          }))]);
          setHasDevChannels(true);
          void done();
        }} />);
      }
    }
  }

  // 为首次使用 Limkenion in Chrome 的用户展示 Chrome 引导流程
  if (limkenionInChrome && !getGlobalConfig().hasCompletedLimkenionInChromeOnboarding) {
    const {
      LimkenionInChromeOnboarding
    } = await import('./components/LimkenionInChromeOnboarding.js');
    await showSetupDialog(root, done => <LimkenionInChromeOnboarding onDone={done} />);
  }
  return onboardingShown;
}
export function getRenderContext(exitOnCtrlC: boolean): {
  renderOptions: RenderOptions;
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore;
} {
  let lastFlickerTime = 0;
  const baseOptions = getBaseRenderOptions(exitOnCtrlC);

  // 当 stdin 覆盖生效时记录遥测事件
  if (baseOptions.stdin) {
    logEvent('limkenion_stdin_interactive', {});
  }
  const fpsTracker = new FpsTracker();
  const stats = createStatsStore();
  setStatsStore(stats);

  // Bench 模式：设置后，把每帧各阶段的耗时以 JSONL 追加写入，供
  // bench/repl-scroll.ts 做离线分析。覆盖完整的 TUI 渲染管线
  // （yoga → 屏幕缓冲区 → diff → optimize → stdout），
  // 这样针对任一阶段的性能工作都能基于真实用户流程来验证。
  const frameTimingLogPath = process.env.LIMKENION_FRAME_TIMING_LOG;
  return {
    getFpsMetrics: () => fpsTracker.getMetrics(),
    stats,
    renderOptions: {
      ...baseOptions,
      onFrame: event => {
        fpsTracker.record(event.durationMs);
        stats.observe('frame_duration_ms', event.durationMs);
        if (frameTimingLogPath && event.phases) {
          // 仅 bench 场景、由环境变量控制的路径：同步写入，以免
          // abrupt 退出时丢帧。≤60fps 下每帧约 100 字节，开销可忽略。
          // rss/cpu 各是一次系统调用；cpu 是累计值 —— 由 bench 侧计算差值。
          const line =
          // eslint-disable-next-line custom-rules/no-direct-json-operations -- tiny object, hot bench path
          JSON.stringify({
            total: event.durationMs,
            ...event.phases,
            rss: process.memoryUsage.rss(),
            cpu: process.cpuUsage()
          }) + '\n';
          // eslint-disable-next-line custom-rules/no-sync-fs -- bench-only, sync so no frames dropped on exit
          appendFileSync(frameTimingLogPath, line);
        }
        // 对支持同步输出的终端跳过闪烁上报 ——
        // DEC 2026 在 BSU/ESU 之间做缓冲，因此 clear+redraw 是原子的。
        if (isSynchronizedOutputSupported()) {
          return;
        }
        for (const flicker of event.flickers) {
          if (flicker.reason === 'resize') {
            continue;
          }
          const now = Date.now();
          if (now - lastFlickerTime < 1000) {
            logEvent('limkenion_flicker', {
              desiredHeight: flicker.desiredHeight,
              actualHeight: flicker.availableHeight,
              reason: flicker.reason
            } as unknown as Record<string, boolean | number | undefined>);
          }
          lastFlickerTime = now;
        }
      }
    }
  };
}