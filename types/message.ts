// @generated stub from scan-missing-imports
// 该文件自动生成，对应 ant-internal 的 feature() gated 模块。
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

// --- auto-added by scripts/fix-stub-exports.mjs ---
export const Message = stub
export const AssistantMessage = stub
export const NormalizedUserMessage = stub
export const AttachmentMessage = stub
export const CollapsedReadSearchGroup = stub
export const GroupedToolUseMessage = stub
export const ProgressMessage = stub
export const SystemMessage = stub
export const RenderableMessage = stub
export const NormalizedMessage = stub
export const NormalizedAssistantMessage = stub
export const SystemStopHookSummaryMessage = stub
export const SystemBridgeStatusMessage = stub
export const SystemTurnDurationMessage = stub
export const SystemThinkingMessage = stub
export const SystemMemorySavedMessage = stub
export const PartialCompactDirection = stub
export const UserMessage = stub
export const SystemInformationalMessage = stub
export const HookResultMessage = stub
export const RequestStartEvent = stub
export const StopHookInfo = stub
export const StreamEvent = stub
export const TombstoneMessage = stub
export const ToolUseSummaryMessage = stub
export const SystemAPIErrorMessage = stub
export const SystemCompactBoundaryMessage = stub
export const SystemLocalCommandMessage = stub
export const MessageOrigin = stub
export const CollapsibleMessage = stub
export const SystemAgentsKilledMessage = stub
export const SystemApiMetricsMessage = stub
export const SystemAwaySummaryMessage = stub
export const SystemMessageLevel = stub
export const SystemMicrocompactBoundaryMessage = stub
export const SystemPermissionRetryMessage = stub
export const SystemScheduledTaskFireMessage = stub
