/**
 * 用于查询生命周期的同步状态机，兼容 React 的 `useSyncExternalStore`。
 *
 * 三种状态：
 *   idle        → 无查询，可安全出队并处理
 *   dispatching → 已出队一个条目，异步链尚未到达 onQuery
 *   running     → onQuery 调用了 tryStart()，查询正在执行
 *
 * 转换：
 *   idle → dispatching  (reserve)
 *   dispatching → running  (tryStart)
 *   idle → running  (tryStart，用于直接提交)
 *   running → idle  (end / forceEnd)
 *   dispatching → idle  (cancelReservation，当 processQueueIfReady 失败时)
 *
 * `isActive` 对 dispatching 和 running 均返回 true，可在异步间隙
 * 中阻止队列处理器重入。
 *
 * 与 React 一起使用：
 *   const queryGuard = useRef(new QueryGuard()).current
 *   const isQueryActive = useSyncExternalStore(
 *     queryGuard.subscribe,
 *     queryGuard.getSnapshot,
 *   )
 */
import { createSignal } from './signal.js'

export class QueryGuard {
  private _status: 'idle' | 'dispatching' | 'running' = 'idle'
  private _generation = 0
  private _changed = createSignal()

  /**
   * 为队列处理保留守卫。转换 idle → dispatching。
   * 如果非 idle（有查询或分派进行中）则返回 false。
   */
  reserve(): boolean {
    if (this._status !== 'idle') return false
    this._status = 'dispatching'
    this._notify()
    return true
  }

  /**
   * 当 processQueueIfReady 没有可处理内容时取消保留。
   * 转换 dispatching → idle。
   */
  cancelReservation(): void {
    if (this._status !== 'dispatching') return
    this._status = 'idle'
    this._notify()
  }

  /**
   * 启动一个查询。成功时返回代号（generation），
   * 若已有查询在运行（并发守卫）则返回 null。
   * 接受来自 idle（直接提交）和 dispatching（队列处理器路径）的转换。
   */
  tryStart(): number | null {
    if (this._status === 'running') return null
    this._status = 'running'
    ++this._generation
    this._notify()
    return this._generation
  }

  /**
   * 结束一个查询。若该代号仍是当前的则返回 true
   * （意味着调用方应执行清理）。若已有更新的查询启动
   * （来自被取消查询的过期 finally 块）则返回 false。
   */
  end(generation: number): boolean {
    if (this._generation !== generation) return false
    if (this._status !== 'running') return false
    this._status = 'idle'
    this._notify()
    return true
  }

  /**
   * 无论代号如何强制结束当前查询。
   * 由 onCancel 使用，任何进行中的查询都应被终止。
   * 递增代号，使被取消查询的 promise 拒绝产生的过期
   * finally 块会看到不匹配而跳过清理。
   */
  forceEnd(): void {
    if (this._status === 'idle') return
    this._status = 'idle'
    ++this._generation
    this._notify()
  }

  /**
   * 守卫是否处于活动状态（dispatching 或 running）？
   * 始终为同步——不受 React 状态批处理延迟影响。
   */
  get isActive(): boolean {
    return this._status !== 'idle'
  }

  get generation(): number {
    return this._generation
  }

  // --
  // useSyncExternalStore 接口

  /** 订阅状态变化。引用稳定——可安全用作 useEffect 依赖。 */
  subscribe = this._changed.subscribe

  /** 供 useSyncExternalStore 使用的快照。返回 `isActive`。 */
  getSnapshot = (): boolean => {
    return this._status !== 'idle'
  }

  private _notify(): void {
    this._changed.emit()
  }
}
