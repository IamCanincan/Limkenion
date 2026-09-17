import { LRUCache } from 'lru-cache'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'

type CacheEntry<T> = {
  value: T
  timestamp: number
  refreshing: boolean
}

type MemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
  }
}

type LRUMemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
    size: () => number
    delete: (key: string) => boolean
    get: (key: string) => Result | undefined
    has: (key: string) => boolean
  }
}

/**
 * 创建一个返回缓存值并并行刷新的记忆化函数。
 * 实现写穿缓存模式：
 * - 若缓存是新的，立即返回
 * - 若缓存过期，返回过期值但在后台刷新
 * - 若无缓存，阻塞并计算值
 *
 * @param f 要记忆化的函数
 * @param cacheLifetimeMs 缓存值的存活时间（毫秒）
 * @returns 该函数的记忆化版本
 */
export function memoizeWithTTL<Args extends unknown[], Result>(
  f: (...args: Args) => Result,
  cacheLifetimeMs: number = 5 * 60 * 1000, // 默认 5 分钟
): MemoizedFunction<Args, Result> {
  const cache = new Map<string, CacheEntry<Result>>()

  const memoized = (...args: Args): Result => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()

    // 填充缓存
    if (!cached) {
      const value = f(...args)
      cache.set(key, {
        value,
        timestamp: now,
        refreshing: false,
      })
      return value
    }

    // 若有过期缓存且尚未在刷新
    if (
      cached &&
      now - cached.timestamp > cacheLifetimeMs &&
      !cached.refreshing
    ) {
      // 标记为刷新，防止出现多个并行刷新
      cached.refreshing = true

      // 安排异步刷新（非阻塞）。.then 和 .catch 都有身份守卫：
      // 当此微任务排队时，并发的 cache.clear() + 冷未命中会存下更新的
      // 条目。.then 用过期刷新的结果覆盖，比 .catch 删除更糟（会用
      // 错误数据持续整个 TTL，而不是在下一次调用时自我修正）。
      Promise.resolve()
        .then(() => {
          const newValue = f(...args)
          if (cache.get(key) === cached) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch(e => {
          logError(e)
          if (cache.get(key) === cached) {
            cache.delete(key)
          }
        })

      // 立即返回过期值
      return cached.value
    }

    return cache.get(key)!.value
  }

  // 添加缓存清理方法
  memoized.cache = {
    clear: () => cache.clear(),
  }

  return memoized
}

/**
 * 创建一个返回缓存值并并行刷新的记忆化异步函数。
 * 为异步函数实现写穿缓存模式：
 * - 若缓存是新的，立即返回
 * - 若缓存过期，返回过期值但在后台刷新
 * - 若无缓存，阻塞并计算值
 *
 * @param f 要记忆化的异步函数
 * @param cacheLifetimeMs 缓存值的存活时间（毫秒）
 * @returns 该异步函数的记忆化版本
 */
export function memoizeWithTTLAsync<Args extends unknown[], Result>(
  f: (...args: Args) => Promise<Result>,
  cacheLifetimeMs: number = 5 * 60 * 1000, // 默认 5 分钟
): ((...args: Args) => Promise<Result>) & { cache: { clear: () => void } } {
  const cache = new Map<string, CacheEntry<Result>>()
  // 进行中冷未命中的去重。旧的 memoizeWithTTL（同步）意外地
  // 提供了这一功能：它在首个 await 前同步地存放 Promise，因此并发的
  // 调用方共享一次 f() 调用。这个异步变体在 cache.set 前等待，
  // 因此并发的冷未命中调用方如果没有这个 map 就会各自独立地调用 f()。
  // 对 refreshAndGetAwsCredentials 而言，这意味着 N 个并发的 `aws sso login`
  // 派生。与 auth.ts:1171 的 pending401Handlers 是同一模式。
  const inFlight = new Map<string, Promise<Result>>()

  const memoized = async (...args: Args): Promise<Result> => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()

    // 填充缓存——若此操作抛出，则不会缓存任何内容
    if (!cached) {
      const pending = inFlight.get(key)
      if (pending) return pending
      const promise = f(...args)
      inFlight.set(key, promise)
      try {
        const result = await promise
        // 身份守卫：await 期间的 cache.clear() 应丢弃此结果
        // （clear 的意图就是失效）。若我们仍在进行中，
        // 就存储它。clear() 也会清空 inFlight，因此此检查能捕获该情况。
        if (inFlight.get(key) === promise) {
          cache.set(key, {
            value: result,
            timestamp: now,
            refreshing: false,
          })
        }
        return result
      } finally {
        if (inFlight.get(key) === promise) {
          inFlight.delete(key)
        }
      }
    }

    // 若有过期缓存且尚未在刷新
    if (
      cached &&
      now - cached.timestamp > cacheLifetimeMs &&
      !cached.refreshing
    ) {
      // 标记为刷新，防止出现多个并行刷新
      cached.refreshing = true

      // 安排异步刷新（非阻塞）。.then 和 .catch 都对与并发的
      // cache.clear() + 冷未命中（可能在此刷新进行中时存下更新的条目）
      // 做身份守卫。.then 用过期刷新的结果覆盖，比 .catch
      // 删除更糟——错误数据会持续整个 TTL（例如设置更改后的
      // 旧 awsAuthRefresh 命令产生的凭据）。
      const staleEntry = cached
      f(...args)
        .then(newValue => {
          if (cache.get(key) === staleEntry) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch(e => {
          logError(e)
          if (cache.get(key) === staleEntry) {
            cache.delete(key)
          }
        })

      // 立即返回过期值
      return cached.value
    }

    return cache.get(key)!.value
  }

  // 添加缓存清理方法。同时清空 inFlight：冷未命中 await 期间的 clear()
  // 不应让过期的进行中 promise 被返回给下一位调用方（那会使 clear 的
  // 目的落空）。上面的 try/finally 对 inFlight.delete 做身份守卫，
  // 使得若 finally 触发前发生 clear+ 冷未命中，过期的 promise 不会
  // 删除一个全新的 promise。
  memoized.cache = {
    clear: () => {
      cache.clear()
      inFlight.clear()
    },
  }

  return memoized as ((...args: Args) => Promise<Result>) & {
    cache: { clear: () => void }
  }
}

/**
 * 创建一个带 LRU（最近最少使用）淘汰策略的记忆化函数。
 * 当缓存达到最大体积时，通过淘汰最近最少使用的条目来防止无界的
 * 内存增长。
 *
 * 注意：记忆化消息处理函数的缓存大小
 * 选出来自防止无界内存增长（使用 lodash memoize 时曾达 300MB+），
 * 同时为典型对话保持良好的缓存命中率。
 *
 * @param f 要记忆化的函数
 * @returns 带缓存管理方法的记忆化版本
 */
export function memoizeWithLRU<
  Args extends unknown[],
  Result extends NonNullable<unknown>,
>(
  f: (...args: Args) => Result,
  cacheFn: (...args: Args) => string,
  maxCacheSize: number = 100,
): LRUMemoizedFunction<Args, Result> {
  const cache = new LRUCache<string, Result>({
    max: maxCacheSize,
  })

  const memoized = (...args: Args): Result => {
    const key = cacheFn(...args)
    const cached = cache.get(key)
    if (cached !== undefined) {
      return cached
    }

    const result = f(...args)
    cache.set(key, result)
    return result
  }

  // 添加缓存管理方法
  memoized.cache = {
    clear: () => cache.clear(),
    size: () => cache.size,
    delete: (key: string) => cache.delete(key),
    // peek() 避免更新最近使用状态——我们只想观察，不想提升
    get: (key: string) => cache.peek(key),
    has: (key: string) => cache.has(key),
  }

  return memoized
}
