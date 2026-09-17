import type { QuerySource } from 'src/constants/querySource.js'
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  OUTPUT_STYLE_CONFIG,
} from '../constants/outputStyles.js'
import { getSettings_DEPRECATED } from './settings/settings.js'

/**
 * 确定智能体用途的提示类别。
 * 用于分析以跟踪不同的智能体模式。
 *
 * @param agentType - 智能体的类型/名称
 * @param isBuiltInAgent - 是否为内置智能体或自定义智能体
 * @returns 智能体提示类别字符串
 */
export function getQuerySourceForAgent(
  agentType: string | undefined,
  isBuiltInAgent: boolean,
): QuerySource {
  if (isBuiltInAgent) {
    // TODO: 避免此强制转换
    return agentType
      ? (`agent:builtin:${agentType}` as QuerySource)
      : 'agent:default'
  } else {
    return 'agent:custom'
  }
}

/**
 * 根据输出样式设置确定提示类别。
 * 用于分析以跟踪不同的输出样式用法。
 *
 * @returns 提示类别字符串；默认时返回 undefined
 */
export function getQuerySourceForREPL(): QuerySource {
  const settings = getSettings_DEPRECATED()
  const style = settings?.outputStyle ?? DEFAULT_OUTPUT_STYLE_NAME

  if (style === DEFAULT_OUTPUT_STYLE_NAME) {
    return 'repl_main_thread'
  }

  // OUTPUT_STYLE_CONFIG 中的所有样式都是内置的
  const isBuiltIn = style in OUTPUT_STYLE_CONFIG
  return isBuiltIn
    ? (`repl_main_thread:outputStyle:${style}` as QuerySource)
    : 'repl_main_thread:outputStyle:custom'
}
