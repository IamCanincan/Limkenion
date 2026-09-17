import { profileCheckpoint } from '../utils/startupProfiler.js'
import '../bootstrap/state.js'
import '../utils/config.js'
import type { Attributes, MetricOptions } from '@opentelemetry/api'
import memoize from 'lodash-es/memoize.js'
import { getIsNonInteractiveSession } from 'src/bootstrap/state.js'
import type { AttributedCounter } from '../bootstrap/state.js'
import { getSessionCounter, setMeter } from '../bootstrap/state.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import {
  initializePolicyLimitsLoadingPromise,
  isPolicyLimitsEligible,
} from '../services/policyLimits/index.js'
import {
  initializeRemoteManagedSettingsLoadingPromise,
  isEligibleForRemoteManagedSettings,
  waitForRemoteManagedSettingsToLoad,
} from '../services/remoteManagedSettings/index.js'
import { preconnectLimkenionApi } from '../utils/apiPreconnect.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { enableConfigs, recordFirstStartTime } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { detectCurrentRepository } from '../utils/detectRepository.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { initJetBrainsDetection } from '../utils/envDynamic.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { ConfigParseError, errorMessage } from '../utils/errors.js'
// showInvalidConfigDialog 在出错路径中动态导入，以避免在初始化时加载 React
import {
  gracefulShutdownSync,
  setupGracefulShutdown,
} from '../utils/gracefulShutdown.js'
import {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
} from '../utils/managedEnv.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import {
  ensureScratchpadDir,
  isScratchpadEnabled,
} from '../utils/permissions/filesystem.js'
// initializeTelemetry 通过 setMeterState() 中的 import() 惰性加载，将
// ~400KB 的 OpenTelemetry + protobuf 模块推迟到遥测真正初始化时。
// gRPC 导出器（通过 @grpc/grpc-js 约 700KB）在 instrumentation.ts 中进一步惰性加载。
import { configureGlobalAgents } from '../utils/proxy.js'
import { isBetaTracingEnabled } from '../utils/telemetry/betaSessionTracing.js'
import { getTelemetryAttributes } from '../utils/telemetryAttributes.js'
import { setShellIfWindows } from '../utils/windowsPaths.js'

// initialize1PEventLogging 通过动态导入，以推迟 OpenTelemetry sdk-logs/resources

// 跟踪遥测是否已初始化，防止重复初始化
let telemetryInitialized = false

export const init = memoize(async (): Promise<void> => {
  const initStartTime = Date.now()
  logForDiagnosticsNoPII('info', 'init_started')
  profileCheckpoint('init_function_start')

  // 校验配置有效并启用配置系统
  try {
    const configsStart = Date.now()
    enableConfigs()
    logForDiagnosticsNoPII('info', 'init_configs_enabled', {
      duration_ms: Date.now() - configsStart,
    })
    profileCheckpoint('init_configs_enabled')

    // 在信任对话框之前仅应用安全的环境变量
    // 完整环境变量将在建立信任后应用
    const envVarsStart = Date.now()
    applySafeConfigEnvironmentVariables()

    // 尽早将 settings.json 中的 NODE_EXTRA_CA_CERTS 应用到 process.env，
    // 在任何 TLS 连接之前。Bun 通过 BoringSSL 在启动时缓存 TLS 证书库，
    // 因此这必须在第一次 TLS 握手之前完成。
    applyExtraCACertsFromConfig()

    logForDiagnosticsNoPII('info', 'init_safe_env_vars_applied', {
      duration_ms: Date.now() - envVarsStart,
    })
    profileCheckpoint('init_safe_env_vars_applied')

    // 确保退出时刷新所有内容
    setupGracefulShutdown()
    profileCheckpoint('init_after_graceful_shutdown')

    // 初始化 1P 事件日志（无安全隐患，但推迟以避免在启动时加载
    // OpenTelemetry sdk-logs）。此时 growthbook.js 已进入模块缓存
    // （firstPartyEventLogger 会导入它），因此第二次动态导入不增加加载成本。
    void Promise.all([
      import('../services/analytics/firstPartyEventLogger.js'),
      import('../services/analytics/growthbook.js'),
    ]).then(([fp, gb]) => {
      fp.initialize1PEventLogging()
      // 若 limkenion_1p_event_batch_config 在会话中途变化则重建 logger provider。
      // 变化检测（isEqual）位于处理器内部，因此未变化的刷新是无操作。
      gb.onGrowthBookRefresh(() => {
        void fp.reinitialize1PEventLoggingIfConfigChanged()
      })
    })
    profileCheckpoint('init_after_1p_event_logging')

    // 异步初始化 JetBrains IDE 检测（填充缓存，供后续同步访问使用）
    void initJetBrainsDetection()
    profileCheckpoint('init_after_jetbrains_detection')

    // 异步检测 GitHub 仓库（填充 gitDiff PR 链接的缓存）
    void detectCurrentRepository()

    // 尽早初始化加载 promise，以便其它系统（如插件钩子）可以等待远程设置加载。
    // 该 promise 带超时，以防止在 loadRemoteManagedSettings() 从未被调用时
    // 产生死锁（例如 Agent SDK 测试）。
    if (isEligibleForRemoteManagedSettings()) {
      initializeRemoteManagedSettingsLoadingPromise()
    }
    if (isPolicyLimitsEligible()) {
      initializePolicyLimitsLoadingPromise()
    }
    profileCheckpoint('init_after_remote_settings_check')

    // 记录首次启动时间
    recordFirstStartTime()

    // 配置全局 mTLS 设置
    const mtlsStart = Date.now()
    logForDebugging('[init] configureGlobalMTLS starting')
    configureGlobalMTLS()
    logForDiagnosticsNoPII('info', 'init_mtls_configured', {
      duration_ms: Date.now() - mtlsStart,
    })
    logForDebugging('[init] configureGlobalMTLS complete')

    // 配置全局 HTTP 代理（代理和/或 mTLS）
    const proxyStart = Date.now()
    logForDebugging('[init] configureGlobalAgents starting')
    configureGlobalAgents()
    logForDiagnosticsNoPII('info', 'init_proxy_configured', {
      duration_ms: Date.now() - proxyStart,
    })
    logForDebugging('[init] configureGlobalAgents complete')
    profileCheckpoint('init_network_configured')

    // 预连接到 Limkenion API —— 在 API 请求前约 100ms 的 action 处理器工作中，
    // 重叠执行 TCP+TLS 握手（约 100-200ms）。在配置好 CA 证书 + 代理之后，
    // 这样预热后的连接会使用正确的传输层。发后即忘；对于代理/mTLS/unix/云供应商
    // 场景会跳过，因为 SDK 的分发器不会复用全局连接池。
    preconnectLimkenionApi()

    // CCR upstreamproxy：启动本地 CONNECT 中继，使 agent 子进程能够通过
    // 凭据注入访问组织配置的上游。受 LIMKENION_REMOTE + GrowthBook 门控；
    // 任何错误都 fail-open。惰性导入，因此非 CCR 启动无需支付模块加载成本。
    // getUpstreamProxyEnv 函数注册到 subprocessEnv.ts 中，子进程生成时无需
    // 静态导入 upstreamproxy 模块即可注入代理变量。
    if (isEnvTruthy(process.env.LIMKENION_REMOTE)) {
      try {
        const { initUpstreamProxy, getUpstreamProxyEnv } = await import(
          '../upstreamproxy/upstreamproxy.js'
        )
        const { registerUpstreamProxyEnvFn } = await import(
          '../utils/subprocessEnv.js'
        )
        registerUpstreamProxyEnvFn(getUpstreamProxyEnv)
        await initUpstreamProxy()
      } catch (err) {
        logForDebugging(
          `[init] upstreamproxy init failed: ${err instanceof Error ? err.message : String(err)}; continuing without proxy`,
          { level: 'warn' },
        )
      }
    }

    // 如相关，设置 git-bash
    setShellIfWindows()

    // 注册 LSP 管理器清理（初始化在 main.tsx 处理完 --plugin-dir 后进行）
    registerCleanup(shutdownLspServerManager)

    // gh-32730：由子 agent（或无显式 TeamDelete 的主 agent）创建的 teams
    // 会永远残留在磁盘上。为本次会话创建的所有 teams 注册清理。
    // 惰性导入：swarm 代码位于 feature 门控之后，多数会话从不创建 teams。
    registerCleanup(async () => {
      const { cleanupSessionTeams } = await import(
        '../utils/swarm/teamHelpers.js'
      )
      await cleanupSessionTeams()
    })

    // 若已启用 scratchpad 目录，则初始化它
    if (isScratchpadEnabled()) {
      const scratchpadStart = Date.now()
      await ensureScratchpadDir()
      logForDiagnosticsNoPII('info', 'init_scratchpad_created', {
        duration_ms: Date.now() - scratchpadStart,
      })
    }

    logForDiagnosticsNoPII('info', 'init_completed', {
      duration_ms: Date.now() - initStartTime,
    })
    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigParseError) {
      // 当无法安全渲染时跳过交互式 Ink 对话框。
      // 该对话框会破坏 JSON 消费方（例如在 VM 沙箱中运行
      // `plugin marketplace list --json` 的桌面市场插件管理器）。
      if (getIsNonInteractiveSession()) {
        process.stderr.write(
          `Configuration error in ${error.filePath}: ${error.message}\n`,
        )
        gracefulShutdownSync(1)
        return
      }

      // 使用错误对象显示无效配置对话框并等待其完成
      return import('../components/InvalidConfigDialog.js').then(m =>
        m.showInvalidConfigDialog({ error }),
      )
      // 对话框自身会处理 process.exit，因此这里无需额外清理
    } else {
      // 对于非配置类错误，重新抛出
      throw error
    }
  }
})

/**
 * 在信任已获授予后初始化遥测。
 * 对于符合远程设置条件的用户，等待设置加载（非阻塞），
 * 随后在初始化遥测前重新应用环境变量（以纳入远程设置）。
 * 对于不符合条件的用户，立即初始化遥测。
 * 此函数只应被调用一次，即在信任对话框被接受之后。
 */
export function initializeTelemetryAfterTrust(): void {
  if (isEligibleForRemoteManagedSettings()) {
    // 对于启用 beta tracing 的 SDK/无头模式，先立即初始化，
    // 确保 tracer 在首次查询之前就绪。
    // 下面的异步路径仍会运行，但 doInitializeTelemetry() 会防止双重初始化。
    if (getIsNonInteractiveSession() && isBetaTracingEnabled()) {
      void doInitializeTelemetry().catch(error => {
        logForDebugging(
          `[3P telemetry] Eager telemetry init failed (beta tracing): ${errorMessage(error)}`,
          { level: 'error' },
        )
      })
    }
    logForDebugging(
      '[3P telemetry] Waiting for remote managed settings before telemetry init',
    )
    void waitForRemoteManagedSettingsToLoad()
      .then(async () => {
        logForDebugging(
          '[3P telemetry] Remote managed settings loaded, initializing telemetry',
        )
        // 在初始化遥测前重新应用环境变量，以纳入远程设置。
        applyConfigEnvironmentVariables()
        await doInitializeTelemetry()
      })
      .catch(error => {
        logForDebugging(
          `[3P telemetry] Telemetry init failed (remote settings path): ${errorMessage(error)}`,
          { level: 'error' },
        )
      })
  } else {
    void doInitializeTelemetry().catch(error => {
      logForDebugging(
        `[3P telemetry] Telemetry init failed: ${errorMessage(error)}`,
        { level: 'error' },
      )
    })
  }
}

async function doInitializeTelemetry(): Promise<void> {
  if (telemetryInitialized) {
    // 已完成初始化，无需再做任何事
    return
  }

  // 在初始化前设置标识，防止双重初始化
  telemetryInitialized = true
  try {
    await setMeterState()
  } catch (error) {
    // 失败时重置标识，以便后续调用可以重试
    telemetryInitialized = false
    throw error
  }
}

async function setMeterState(): Promise<void> {
  // 惰性加载插桩代码，推迟约 400KB 的 OpenTelemetry + protobuf
  const { initializeTelemetry } = await import(
    '../utils/telemetry/instrumentation.js'
  )
  // 初始化客户的 OTLP 遥测（指标、日志、追踪）
  const meter = await initializeTelemetry()
  if (meter) {
    // 为带属性的计数器创建工厂函数
    const createAttributedCounter = (
      name: string,
      options: MetricOptions,
    ): AttributedCounter => {
      const counter = meter?.createCounter(name, options)

      return {
        add(value: number, additionalAttributes: Attributes = {}) {
          // 始终获取最新的遥测属性，确保它们是最新的
          const currentAttributes = getTelemetryAttributes()
          const mergedAttributes = {
            ...currentAttributes,
            ...additionalAttributes,
          }
          counter?.add(value, mergedAttributes)
        },
      }
    }

    setMeter(meter, createAttributedCounter)

    // 在此递增会话计数器，因为启动遥测路径会在此异步初始化完成之前
    // 运行，届时计数器会为 null。
    getSessionCounter()?.add(1)
  }
}
