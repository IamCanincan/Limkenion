/**
 * Pure utility functions for MCP name normalization.
 * This file has no dependencies to avoid circular imports.
 */

/**
 * 把 MCP 服务器名规范化成符合 API 模式 ^[a-zA-Z0-9_-]{1,64}$ 的形式：
 * 把非法字符（含点和空格）替换成下划线。
 *
 * 原本这里还有一条"Limkenion 托管服务器"的特殊分支（按名字前缀识别，
 * 额外折叠连续下划线）—— 本构建没有云端托管服务，那种服务器不会出现，
 * 分支已移除。
 */
export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}
