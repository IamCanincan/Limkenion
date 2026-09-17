/**
 * 系统提示词数组的品牌类型。
 *
 * 该模块刻意保持零依赖，以便可从任何地方导入，而不会产生循环初始化问题。
 */

export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}
