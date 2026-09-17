/**
 * 用于 CCR v2 兼容层的会话 ID 标签转换辅助函数。
 *
 * 放在独立文件中（而非 workSecret.ts），使 sessionHandle.ts 和
 * replBridgeTransport.ts（bridge.mjs 入口点）可以从 workSecret.ts 导入，
 * 而不拉入这些重新打标签的函数。
 *
 * isCseShimEnabled 杀开关通过 setCseShimGate() 注入，以避免静态导入
 * bridgeEnabled.ts → growthbook.ts → config.ts——这些都被禁止进入 sdk.mjs
 * 打包（scripts/build-agent-sdk.sh）。已经导入 bridgeEnabled.ts 的调用方会
 * 注册该门控；SDK 路径从不注册，因此垫片默认为启用（与 isCseShimEnabled()
 * 自身的默认一致）。
 */

let _isCseShimEnabled: (() => boolean) | undefined

/**
 * 为 cse_ 垫片注册 GrowthBook 门控。由已经导入 bridgeEnabled.ts 的
 * bridge 初始化代码调用。
 */
export function setCseShimGate(gate: () => boolean): void {
  _isCseShimEnabled = gate
}

/**
 * 把 `cse_*` 会话 ID 重新打标签为 `session_*`，用于 v1 兼容 API。
 *
 * 工作端端点（/v1/code/sessions/{id}/worker/*）需要 `cse_*`；这就是任务轮询
 * 交付的内容。面向客户端的兼容端点（/v1/sessions/{id}、
 * /v1/sessions/{id}/archive、/v1/sessions/{id}/events）需要 `session_*`——
 * compat/convert.go:27 会校验 TagSession。同样的 UUID，不同的马甲。对非
 * `cse_*` 的 ID 为无操作。
 *
 * bridgeMain 对 worker 注册和会话管理调用持有一个 sessionId 变量。在兼容
 * 门控下它从任务轮询中以 `cse_*` 到达，因此 archiveSession/
 * fetchSessionTitle 需要这种重新打标签。
 */
export function toCompatSessionId(id: string): string {
  if (!id.startsWith('cse_')) return id
  if (_isCseShimEnabled && !_isCseShimEnabled()) return id
  return 'session_' + id.slice('cse_'.length)
}

/**
 * 把 `session_*` 会话 ID 重新打标签为 `cse_*`，用于基础设施层调用。
 *
 * 是 toCompatSessionId 的逆操作。POST /v1/environments/{id}/bridge/reconnect
 * 位于兼容层之下：一旦服务端开启 ccr_v2_compat_enabled，它便按基础设施标签
 * （`cse_*`）查会话。createBridgeSession 仍返回 `session_*`
 * （compat/convert.go:41），而 bridge-pointer 存储的正是它——所以持久重连
 * 会传入错误的马甲并收到「Session not found（会话未找到）」。同样的 UUID，
 * 错误的标签。对非 `session_*` 的 ID 为无操作。
 */
export function toInfraSessionId(id: string): string {
  if (!id.startsWith('session_')) return id
  return 'cse_' + id.slice('session_'.length)
}
