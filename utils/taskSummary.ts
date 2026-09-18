// @generated stub from scan-missing-imports
// 该文件自动生成，对应 内部构建 的 feature() gated 模块。
// 所有外部 build 的代码路径在 DCE 后都不会真的执行这里的代码，这只是
// bun build resolver 的占位符。
const __target = function noop() {}
const __handler: ProxyHandler<any> = {
  get(_t, prop) {
    if (prop === '__esModule') return true
    if (prop === 'default') return new Proxy(__target, __handler)
    if (prop === Symbol.toPrimitive) return () => undefined
    if (prop === Symbol.iterator) return function* () {}
    if (prop === Symbol.asyncIterator) return async function* () {}
    if (prop === 'then') return undefined
    return new Proxy(__target, __handler)
  },
  apply() {
    return new Proxy(__target, __handler)
  },
  construct() {
    return new Proxy(__target, __handler)
  },
}
const stub: any = new Proxy(__target, __handler)
export default stub
export const __stubMissing = true
// 兼容常见的命名导出 —— 没列在这里的也会通过 default Proxy 兜底
export const createCachedMCState = stub
export const isCachedMicrocompactEnabled = stub
export const isModelSupportedForCacheEditing = stub
export const getCachedMCConfig = stub
export const markToolsSentToAPI = stub
export const resetCachedMCState = stub
export const checkProtectedNamespace = stub
export const getCoordinatorUserContext = stub

// query.ts 在 BG_SESSIONS 门控下每次工具结果后调用（`limkenion ps` 的任务摘要）。
// 注意：require() 拿到的是模块命名空间，Proxy default 兜底救不了命名导出——
// 少了这两个导出，print 模式一走到工具调用就抛
// "shouldGenerateTaskSummary is not a function"（2026-09-18 实测踩中）。
// stub 语义：不生成摘要（返回 false），生成器为空操作。
export const shouldGenerateTaskSummary = () => false
export const maybeGenerateTaskSummary = (_args: unknown) => undefined
