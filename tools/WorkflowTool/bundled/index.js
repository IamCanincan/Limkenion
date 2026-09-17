/**
 * 桩实现 —— 内置工作流。
 * 上游 upstream-ref-impl 也没有提供该文件；它在真实构建中是代码生成产物
 * （内置工作流定义会被编译进二进制）。
 * 安全的空操作：注册零个内置工作流。
 */
export function initBundledWorkflows() {
  return []
}

export const BUNDLED_WORKFLOWS = []
export default { initBundledWorkflows, BUNDLED_WORKFLOWS }
