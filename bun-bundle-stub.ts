/**
 * Stub for `bun:bundle` when running outside Bun.
 * In real Bun builds, this module is replaced by the runtime
 * and `feature()` is evaluated at compile-time for dead-code elimination.
 *
 * 默认返回 `true` 以保留所有代码路径。但对于上游专属、本地 DeepSeek 构建
 * 不支持的实验功能，必须返回 `false`：
 * - 它们的门控逻辑依赖 feature() 在编译期求值为常量才能做 DCE；
 * esbuild 无法对函数调用求值，若这里强制 true，这些被删空的死代码
 * 路径会在运行时被激活，进而抛 "X is not a function"。
 * 对这些功能返回 false 即可在运行时短路门控、跳过净空模块，恢复对话主路径。
 * （当前禁用名单见下方 UNSUPPORTED_UPSTREAM_FEATURES。）
 */
const UNSUPPORTED_UPSTREAM_FEATURES = new Set([
  'HISTORY_SNIP',
  'UDS_INBOX',
  'CONTEXT_COLLAPSE',
  'REACTIVE_COMPACT',
  'CACHED_MICROCOMPACT',
  // 上游专属、被删空成 Proxy-stub 的实验功能，必须关掉，否则 REPL 会渲染
  // 一个 undefined 的子组件并崩溃：
  // - WEB_BROWSER_TOOL → tools/WebBrowserTool/WebBrowserPanel.ts 是 stub，
  //   命名空间上没有 WebBrowserPanel 导出，`<WebBrowserPanelModule.WebBrowserPanel/>`
  //   求值为 `<undefined/>`（Element type is invalid ... got: undefined）。
  // - PROACTIVE / KAIROS → proactive/* 均为 stub，关闭以免激活无实现路径。
  'WEB_BROWSER_TOOL',
  'PROACTIVE',
  'KAIROS',
])

export function feature(name: string): boolean {
  if (UNSUPPORTED_UPSTREAM_FEATURES.has(name)) {
    return false
  }
  return true
}