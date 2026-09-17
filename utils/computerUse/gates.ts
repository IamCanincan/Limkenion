import type { CoordinateMode, CuSubGates } from '@ant/computer-use-mcp/types'

import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getSubscriptionType } from '../auth.js'
import { isEnvTruthy } from '../envUtils.js'

type ChicagoConfig = CuSubGates & {
  enabled: boolean
  coordinateMode: CoordinateMode
}

const DEFAULTS: ChicagoConfig = {
  enabled: false,
  pixelValidation: false,
  clipboardPasteMultiline: true,
  mouseAnimation: true,
  hideBeforeAction: true,
  autoTargetDisplay: true,
  clipboardGuard: true,
  coordinateMode: 'pixels',
}

// 展开在默认值之上，使部分 JSON（单独 {"enabled": true}）继承其余部分。
// getDynamicConfig 上的泛型是类型断言，而非验证器——
// GB 返回部分对象，否则会呈现未定义字段。
function readConfig(): ChicagoConfig {
  return {
    ...DEFAULTS,
    ...getDynamicConfig_CACHED_MAY_BE_STALE<Partial<ChicagoConfig>>(
      'limkenion_malort_pedway',
      DEFAULTS,
    ),
  }
}

// 外部发布仅限 Max/Pro。Ant 绕过以便继续自食其犬粮——
// 并非所有 ant 都是 max/pro，且根据 LIMKENION.md:281，
// USER_TYPE !== 'ant' 的分支不会获得任何 antfooding。
function hasRequiredSubscription(): boolean {
  
  const tier = getSubscriptionType()
  return tier === 'max' || tier === 'pro'
}

export function getChicagoEnabled(): boolean {
  // 为继承了 monorepo 开发配置的 ant 禁用。
  // MONOREPO_ROOT_DIR 由 config/local/zsh/zshrc 导出，laptop-setup.sh
  // 将其接入 ~/.zshrc——它的存在是"有 monorepo 访问权限"的廉价代理。
  // 覆盖：ALLOW_ANT_COMPUTER_USE_MCP=1。
  
  return hasRequiredSubscription() && readConfig().enabled
}

export function getChicagoSubGates(): CuSubGates {
  const { enabled: _e, coordinateMode: _c, ...subGates } = readConfig()
  return subGates
}

// 首次读取时冻结——setup.ts 构建工具描述，executor.ts 也基于同一值
// 缩放坐标。这里的实时读取会让会话中期的 GB 翻转告诉模型 "pixels"，
// 同时却把点击转换为归一化值。
let frozenCoordinateMode: CoordinateMode | undefined
export function getChicagoCoordinateMode(): CoordinateMode {
  frozenCoordinateMode ??= readConfig().coordinateMode
  return frozenCoordinateMode
}
