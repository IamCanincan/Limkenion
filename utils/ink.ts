import type { TextProps } from '../ink.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  type AgentColorName,
} from '../tools/AgentTool/agentColorManager.js'

const DEFAULT_AGENT_THEME_COLOR = 'cyan_FOR_SUBAGENTS_ONLY'

/**
 * 将颜色字符串转换为 Ink 的 TextProps['color'] 格式。
 * 颜色通常是 AgentColorName 值，如 'blue'、'green' 等。
 * 这会将它们转换为主题键，使其遵循当前主题。
 * 若不是已知的智能体颜色，则回退到原始 ANSI 颜色。
 */
export function toInkColor(color: string | undefined): TextProps['color'] {
  if (!color) {
    return DEFAULT_AGENT_THEME_COLOR
  }
  // 若是已知的智能体颜色，则尝试映射为主题颜色
  const themeColor = AGENT_COLOR_TO_THEME_COLOR[color as AgentColorName]
  if (themeColor) {
    return themeColor
  }
  // 未知颜色回退到原始 ANSI 颜色
  return `ansi:${color}` as TextProps['color']
}
