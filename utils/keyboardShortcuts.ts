// macOS 上 Option+键产生的特殊字符，映射到对应的快捷键等价物。
// 用于检测在未启用「Option 作为 Meta」的 macOS 终端上的 Option+键快捷键。
export const MACOS_OPTION_SPECIAL_CHARS = {
  '†': 'alt+t', // Option+T -> 切换思考模式
  π: 'alt+p', // Option+P -> 模型选择器
  ø: 'alt+o', // Option+O -> 快速模式
} as const satisfies Record<string, string>

export function isMacosOptionChar(
  char: string,
): char is keyof typeof MACOS_OPTION_SPECIAL_CHARS {
  return char in MACOS_OPTION_SPECIAL_CHARS
}
