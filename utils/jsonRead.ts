/**
 * 叶子模块 stripBOM —— 从 json.ts 中拆出，以打破 settings → json → log →
 * types/logs → … → settings 的依赖环。json.ts 导入它以用于其带记忆化和日志
 * 的 safeParseJSON；无法导入 json.ts 的叶子调用方则内联使用 stripBOM +
 * jsonParse（syncCacheState 就是这样做的）。
 *
 * UTF-8 BOM（U+FEFF）：PowerShell 5.x 默认以带 BOM 的 UTF-8 写入
 * （Out-File、Set-Content）。我们无法控制用户环境，因此在读取时剥离。
 * 否则 JSON.parse 会报 "Unexpected token（意外标记）"。
 */

const UTF8_BOM = '\uFEFF'

export function stripBOM(content: string): string {
  return content.startsWith(UTF8_BOM) ? content.slice(1) : content
}
