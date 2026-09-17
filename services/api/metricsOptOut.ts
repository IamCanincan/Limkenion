import axios from 'axios'
import { hasProfileScope, isLimkenionAISubscriber } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getAuthHeaders, withOAuth401Retry } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { memoizeWithTTLAsync } from '../../utils/memoize.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getLimkenionUserAgent } from '../../utils/userAgent.js'

type MetricsEnabledResponse = {
  metrics_logging_enabled: boolean
}

type MetricsStatus = {
  enabled: boolean
  hasError: boolean
}

// 内存 TTL——在单个进程内对调用去重
const CACHE_TTL_MS = 60 * 60 * 1000

// 磁盘 TTL——组织设置极少变动。当磁盘缓存比这更新鲜时，
// 完全跳过网络请求（不做后台刷新）。这能把 N 次 `limkenion -p`
// 调用压缩为每天约 1 次 API 调用。
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 内部函数，调用 API 检查指标是否启用。
 * 由 memoizeWithTTLAsync 包装以增加缓存行为。
 */
async function _fetchMetricsEnabled(): Promise<MetricsEnabledResponse> {
  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`认证错误：${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getLimkenionUserAgent(),
    ...authResult.headers,
  }

  const endpoint = ``
  const response = await axios.get<MetricsEnabledResponse>(endpoint, {
    headers,
    timeout: 5000,
  })
  return response.data
}

async function _checkMetricsEnabledAPI(): Promise<MetricsStatus> {
  // 事故开关：当非关键流量被禁用时，跳过网络调用。
  // 返回 enabled:false 可在消费端减压（bigqueryExporter 跳过
  // 导出）。与下方非订阅用户的提前返回形式保持一致。
  if (isEssentialTrafficOnly()) {
    return { enabled: false, hasError: false }
  }

  try {
    const data = await withOAuth401Retry(_fetchMetricsEnabled, {
      also403Revoked: true,
    })

    logForDebugging(
      `指标退出 API 响应：enabled=${data.metrics_logging_enabled}`,
    )

    return {
      enabled: data.metrics_logging_enabled,
      hasError: false,
    }
  } catch (error) {
    logForDebugging(
      `检查指标退出状态失败：${errorMessage(error)}`,
    )
    logError(error)
    return { enabled: false, hasError: true }
  }
}

// 创建带自定义错误处理的记忆化版本
const memoizedCheckMetrics = memoizeWithTTLAsync(
  _checkMetricsEnabledAPI,
  CACHE_TTL_MS,
)

/**
 * 获取（内存记忆化的）结果，并在发生变化时持久化到磁盘。
 * 错误不会被持久化——一次瞬时失败不应覆盖
 * 已知良好的磁盘值。
 */
async function refreshMetricsStatus(): Promise<MetricsStatus> {
  const result = await memoizedCheckMetrics()
  if (result.hasError) {
    return result
  }

  const cached = getGlobalConfig().metricsStatusCache
  const unchanged = cached !== undefined && cached.enabled === result.enabled
  // 当未变化且时间戳仍新鲜时跳过写盘——避免并发调用方
  // 越过过期的磁盘条目后争相写入造成配置抖动。
  if (unchanged && Date.now() - cached.timestamp < DISK_CACHE_TTL_MS) {
    return result
  }

  saveGlobalConfig(current => ({
    ...current,
    metricsStatusCache: {
      enabled: result.enabled,
      timestamp: Date.now(),
    },
  }))
  return result
}

/**
 * 检查当前组织是否启用了指标。
 *
 * 两层缓存：
 * - 磁盘（24h TTL）：进程重启后仍保留。磁盘缓存新 → 零网络请求。
 * - 内存（1h TTL）：在进程内对后台刷新去重。
 *
 * 调用方（bigqueryExporter）容忍过期读取——在 24 小时窗口内
 * 漏掉一次导出或额外多一次都在可接受范围内。
 */
export async function checkMetricsEnabled(): Promise<MetricsStatus> {
  // 服务密钥 OAuth 会话缺少 user:profile 权限 → 会 403。
  // API 密钥用户（非订阅者）则回退使用 x-api-key 认证。
  // 此检查在读取磁盘之前运行，确保我们绝不持久化源自认证状态的
  // 判断结果——只有真实的 API 响应才写入磁盘。否则服务密钥
  // 会话会污染缓存，影响后续完整的 OAuth 会话。
  if (isLimkenionAISubscriber() && !hasProfileScope()) {
    return { enabled: false, hasError: false }
  }

  const cached = getGlobalConfig().metricsStatusCache
  if (cached) {
    if (Date.now() - cached.timestamp > DISK_CACHE_TTL_MS) {
      // saveGlobalConfig 的回退路径（config.ts:731）在锁与回退写入
      // 均失败时可能抛错——在此捕获，避免 fire-and-forget
      // 变成未处理的拒绝。
      void refreshMetricsStatus().catch(logError)
    }
    return {
      enabled: cached.enabled,
      hasError: false,
    }
  }

  // 本机首次运行：阻塞于网络以填充磁盘。
  return refreshMetricsStatus()
}

