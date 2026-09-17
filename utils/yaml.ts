/**
 * YAML 解析封装。
 *
 * 在 Bun 下使用内置的 Bun.YAML（零成本），否则回退到 `yaml` npm 包。
 * 该包在非 Bun 分支内延迟 require，这样原生 Bun 构建永远不会加载
 * 约 270KB 的 yaml 解析器。
 */

export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    return Bun.YAML.parse(input)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('yaml') as typeof import('yaml')).parse(input)
}
