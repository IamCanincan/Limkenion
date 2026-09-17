import { DEEPSEEK_FLASH_CONFIG } from '../model/configs.js'

// @[MODEL LAUNCH]: 新增模型时更新这里的兜底模型。
// 用户从未在 /config 里设置过 teammateDefaultModel 时，新队友用默认模型。
// 原本是 Opus 4.6 且按 provider 取 ID —— 上游那套多 provider 配置表已移除。
export function getHardcodedTeammateModelFallback(): string {
  return DEEPSEEK_FLASH_CONFIG.firstParty
}
