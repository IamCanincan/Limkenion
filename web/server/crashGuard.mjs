/**
 * 进程级崩溃兜底。
 *
 * 服务里大量「发了不管」的异步调用（`void runEventHooks(...)`、`void runTurn(...)`、
 * 各处 `.then()` 没接 `.catch()` 等）。Node 15+ 默认对「未处理的 Promise 拒绝」
 * 直接终止进程 —— 一条畸形消息、一个钩子脚本崩、一个 MCP 连接断开，都可能让
 * 整个本地服务下线（这正是 protocol.mjs 同类崩溃的根因：一条畸形 WS 帧打挂服务）。
 *
 * 这里把两类未捕获异常就地接住并记日志，服务继续运行。这是**最后一道防线**，
 * 不是替代调用点的 `.catch()`：能就地给客户端回错的，仍然应该在调用点处理。
 *
 * 取舍：默认 `uncaughtException` 在 Node 文档里建议「做完同步清理就退出」，
 * 但本服务是单用户本地进程，比起「任何一个 bug 就让服务消失」，保活并留下
 * 可见的日志更可取。兜底日志带 `[crash-guard]` 前缀，方便从输出里一眼看到。
 *
 * @returns {void}
 */
export function installCrashGuard() {
  process.on('unhandledRejection', reason => {
    console.error('[crash-guard] 未捕获的 Promise 拒绝（已拦截，服务继续运行）：', reason)
  })
  process.on('uncaughtException', err => {
    console.error('[crash-guard] 未捕获的异常（已拦截，服务继续运行）：', err)
  })
}
