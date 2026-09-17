/**
 * User-Agent 字符串辅助函数。
 *
 * 保持零依赖，使 SDK 打包代码（bridge、cli/transports）无需引入
 * auth.ts 及其传递依赖树即可导入。
 */

export function getLimkenionUserAgent(): string {
  return `limkenion/${MACRO.VERSION}`
}
