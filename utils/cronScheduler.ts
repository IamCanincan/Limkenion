// .limkenion/scheduled_tasks.json 的非 React 调度器核心。
// 由 REPL（通过 useScheduledTasks）和 SDK/-p 模式（print.ts）共享。
//
// 生命周期：轮询 getScheduledTasksEnabled() 直到为 true（当 CronCreate
// 运行或某个技能 on: 触发时标志翻转）→ 加载任务 + 监视文件 + 启动一个
// 1 秒检查定时器 → 触发时调用 onFire(prompt)。stop() 拆除所有东西。

import type { FSWatcher } from 'chokidar'
import {
  getScheduledTasksEnabled,
  getSessionCronTasks,
  removeSessionCronTasks,
  setScheduledTasksEnabled,
} from '../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { cronToHuman } from './cron.js'
import {
  type CronJitterConfig,
  type CronTask,
  DEFAULT_CRON_JITTER_CONFIG,
  findMissedTasks,
  getCronFilePath,
  hasCronTasksSync,
  jitteredNextCronRunMs,
  markCronTasksFired,
  oneShotJitteredNextCronRunMs,
  readCronTasks,
  removeCronTasks,
} from './cronTasks.js'
import {
  releaseSchedulerLock,
  tryAcquireSchedulerLock,
} from './cronTasksLock.js'
import { logForDebugging } from './debug.js'

const CHECK_INTERVAL_MS = 1000
const FILE_STABILITY_MS = 300
// 非持有会话多久重新探测一次调度器锁。粗略即可，因为接管只在意
// 持有会话是否已崩溃。
const LOCK_PROBE_INTERVAL_MS = 5000
/**
 * 当循环任务创建超过 `maxAgeMs` 且应在其下次触发时被删除时为 true。
 * 永久任务永不过期。`maxAgeMs === 0` 表示无限（永不过期）。在调用时取自
 * {@link CronJitterConfig.recurringMaxAgeMs}。
 * 为可测试性而提取——调度器的 check() 深埋在 setInterval/chokidar/锁
 * 机制之下。
 */
export function isRecurringTaskAged(
  t: CronTask,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (maxAgeMs === 0) return false
  return Boolean(t.recurring && !t.permanent && nowMs - t.createdAt >= maxAgeMs)
}

type CronSchedulerOptions = {
  /** 任务触发时调用（常规或启动时错过的）。 */
  onFire: (prompt: string) => void
  /** 为 true 时，触发被推迟到下一个 tick。 */
  isLoading: () => boolean
  /**
   * 为 true 时，绕过 check() 中的 isLoading 门控，并在不等待
   * setScheduledTasksEnabled() 的情况下自动启用调度器。自动启用是
   * 承载关键行为的部分——助手模式在安装时就已把任务写在
   * scheduled_tasks.json 中，不应等待某个加载器技能来翻转标志。
   * 在 #20425 之后 isLoading 绕过是次要的（助手模式现在像普通 REPL
   * 一样在轮次之间空闲）。
   */
  assistantMode?: boolean
  /**
   * 提供时，接收常规触发时的完整 CronTask（且该次触发不调用 onFire）。
   * 让守护进程调用方看到任务 id/cron 等，而不只是 prompt 字符串。
   */
  onFireTask?: (task: CronTask) => void
  /**
   * 提供时，在初始加载时接收错过的一次性任务（且不调用带预格式化
   * 通知的 onFire）。由守护进程决定如何呈现它们。
   */
  onMissed?: (tasks: CronTask[]) => void
  /**
   * 包含 .limkenion/scheduled_tasks.json 的目录。提供时，调度器
   * 绝不会触及 bootstrap 状态：不读取 getProjectRoot/getSessionId，
   * 并跳过 getScheduledTasksEnabled() 轮询（enable() 在启动时立即
   * 运行）。Agent SDK 守护进程调用方必需。
   */
  dir?: string
  /**
   * 写入锁文件的所有者键。默认取 getSessionId()。
   * 守护进程调用方必须传入稳定的每进程 UUID，因为它们没有会话。
   * PID 无论如何仍是存活性探针。
   */
  lockIdentity?: string
  /**
   * 返回本次 tick 要用的 cron 抖动配置。每个 check() 周期调用一次。
   * REPL 调用方传入 GrowthBook 支持的实现（见 cronJitterConfig.ts）
   * 以进行实时调优——运维可在 :00 负载尖峰期间于会话中加宽抖动窗口，
   * 而无需重启客户端。Agent SDK 守护进程调用方省略此参数并获得
   * DEFAULT_CRON_JITTER_CONFIG，这对它们是安全的，因为守护进程反正
   * 会在配置变化时重启，且 growthbook.ts → config.ts → commands.ts →
   * REPL 链保持在 sdk.mjs 之外。
   */
  getJitterConfig?: () => CronJitterConfig
  /**
   * 总开关：每个 check() tick 轮询一次。为 true 时，check() 在任何
   * 触发前退出——已有 cron 在会话中途停摆。CLI 调用方注入
   * `() => !isKairosCronEnabled()`，这样关闭 limkenion_kairos_cron 门
   * 会停止已运行的调度器（而不只是新建的）。守护进程调用方省略此参数，
   * 理由与 getJitterConfig 相同。
   */
  isKilled?: () => boolean
  /**
   * 在任何副作用之前应用的每任务门控。返回 false 的任务对本调度器
   * 不可见：从不触发、从不盖上 `lastFiredAt`、从不删除、从不呈现为
   * 错过、不出现于 `getNextFireTime()`。守护进程 cron worker 使用
   * `t => t.permanent`，因此同一 scheduled_tasks.json 中的非永久任务
   * 不会被触及。
   */
  filter?: (t: CronTask) => boolean
}

export type CronScheduler = {
  start: () => void
  stop: () => void
  /**
   * 所有已加载任务中最近一次计划触发的 Epoch 毫秒，或若无可计划触发
   * （无任务，或所有任务都已进行中）则为 null。守护进程调用方用它来
   * 决定是拆除空闲的 agent 子进程，还是为即刻触发保持其活跃。
   */
  getNextFireTime: () => number | null
}

export function createCronScheduler(
  options: CronSchedulerOptions,
): CronScheduler {
  const {
    onFire,
    isLoading,
    assistantMode = false,
    onFireTask,
    onMissed,
    dir,
    lockIdentity,
    getJitterConfig,
    isKilled,
    filter,
  } = options
  const lockOpts = dir || lockIdentity ? { dir, lockIdentity } : undefined

  // 仅文件后备任务。会话任务（durable: false）不在这里加载——它们可在
  // 会话中随时添加/移除而无文件事件，因此 check() 在每个 tick 直接从
  // bootstrap 状态读取。
  let tasks: CronTask[] = []
  // 每个任务的下次触发时间（Epoch 毫秒）。
  const nextFireAt = new Map<string, number>()
  // 我们已经为其入队"错过任务"提示的 id——防止在用户作答前每次文件
  // 变更都重新询问。
  const missedAsked = new Set<string>()
  // 当前已入队但从文件移除前仍存在的任务。防止间隔在 removeCronTasks
  // 落地前再次滴答时双重触发。
  const inFlight = new Set<string>()

  let enablePoll: ReturnType<typeof setInterval> | null = null
  let checkTimer: ReturnType<typeof setInterval> | null = null
  let lockProbeTimer: ReturnType<typeof setInterval> | null = null
  let watcher: FSWatcher | null = null
  let stopped = false
  let isOwner = false

  async function load(initial: boolean) {
    const next = await readCronTasks(dir)
    if (stopped) return
    tasks = next

    // 仅在初始加载时呈现错过任务。Chokidar 触发的重载把逾期任务留给
    // check()（它从 createdAt 锚定并立即触发）。这避免了在会话中途
    // 才逾期的任务产生误导性的"Limkenion 未运行时错过"提示。
    //
    // 循环任务不呈现也不删除——check() 会正确处理它们（在首个 tick
    // 触发，向前重新调度）。只有一次性错过任务需要用户输入
    // （现在运行一次，或永久丢弃）。
    if (!initial) return

    const now = Date.now()
    const missed = findMissedTasks(next, now).filter(
      t => !t.recurring && !missedAsked.has(t.id) && (!filter || filter(t)),
    )
    if (missed.length > 0) {
      for (const t of missed) {
        missedAsked.add(t.id)
        // 防止 check() 在异步的 removeCronTasks + chokidar 重载链进行中
        // 重新触发原始提示。
        nextFireAt.set(t.id, Infinity)
      }
      logEvent('limkenion_scheduled_task_missed', {
        count: missed.length,
        taskIds: missed
          .map(t => t.id)
          .join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      if (onMissed) {
        onMissed(missed)
      } else {
        onFire(buildMissedTaskNotification(missed))
      }
      void removeCronTasks(
        missed.map(t => t.id),
        dir,
      ).catch(e =>
        logForDebugging(`[ScheduledTasks] 移除错过任务失败：${e}`),
      )
      logForDebugging(
        `[ScheduledTasks] 已呈现 ${missed.length} 个错过的一次性任务`,
      )
    }
  }

  function check() {
    if (isKilled?.()) return
    if (isLoading() && !assistantMode) return
    const now = Date.now()
    const seen = new Set<string>()
    // 本 tick 触发过的文件后备循环任务。在循环后合并成一次
    // markCronTasksFired 调用，使 N 次触发 = 一次写入。会话任务
    // 排除——它们随进程结束而消失，无需持久化。
    const firedFileRecurring: string[] = []
    // 每个 tick 读一次。REPL 调用方传入由 GrowthBook 支持的
    // getJitterConfig，使配置推送无需重启即生效。守护进程和 SDK
    // 调用方省略它并获得 DEFAULT_CRON_JITTER_CONFIG（安全——抖动是
    // REPL 集群负载削峰的运维杠杆，而非守护进程所关心）。
    const jitterCfg = getJitterConfig?.() ?? DEFAULT_CRON_JITTER_CONFIG

    // 共享的循环主体。`isSession` 路由一次性清理路径：
    // 会话任务从内存同步移除，文件任务走异步的 removeCronTasks +
    // chokidar 重载。
    function process(t: CronTask, isSession: boolean) {
      if (filter && !filter(t)) return
      seen.add(t.id)
      if (inFlight.has(t.id)) return

      let next = nextFireAt.get(t.id)
      if (next === undefined) {
        // 首次所见——从 lastFiredAt（循环）或 createdAt 锚定。
        // 从未触发的循环任务用 createdAt：若 isLoading 把本 tick 延迟
        // 到触发时间之后，用 `now` 锚定会把固定 cron（`30 14 27 2 *`）
        // 计算成明年。之前触发过的任务用 lastFiredAt：下面的重新调度
        // 会把 `now` 写回磁盘，因此下次进程生成时的首次所见会算出一个
        // 与这里设置的内存中 newNext 相同的值。没有它，守护进程子进程
        // 在空闲时撤出会丢失 nextFireAt，下次生成会从 10 天前的
        // createdAt 重新锚定 → 每个周期触发每个任务。
        next = t.recurring
          ? (jitteredNextCronRunMs(
              t.cron,
              t.lastFiredAt ?? t.createdAt,
              t.id,
              jitterCfg,
            ) ?? Infinity)
          : (oneShotJitteredNextCronRunMs(
              t.cron,
              t.createdAt,
              t.id,
              jitterCfg,
            ) ?? Infinity)
        nextFireAt.set(t.id, next)
        logForDebugging(
          `[ScheduledTasks] 计划 ${t.id} 于 ${next === Infinity ? 'never' : new Date(next).toISOString()}`,
        )
      }

      if (now < next) return

      logForDebugging(
        `[ScheduledTasks] 触发 ${t.id}${t.recurring ? '（循环）' : ''}`,
      )
      logEvent('limkenion_scheduled_task_fire', {
        recurring: t.recurring ?? false,
        taskId:
          t.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      if (onFireTask) {
        onFireTask(t)
      } else {
        onFire(t.prompt)
      }

      // 老化过期的循环任务落到下面的一次性删除路径
      // （会话任务同步移除；文件任务走异步的 inFlight/chokidar 路径）。
      // 最后一次触发，然后被移除。
      const aged = isRecurringTaskAged(t, now, jitterCfg.recurringMaxAgeMs)
      if (aged) {
        const ageHours = Math.floor((now - t.createdAt) / 1000 / 60 / 60)
        logForDebugging(
          `[ScheduledTasks] 循环任务 ${t.id} 已过期（创建 ${ageHours} 小时），最终触发后删除`,
        )
        logEvent('limkenion_scheduled_task_expired', {
          taskId:
            t.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ageHours,
        })
      }

      if (t.recurring && !aged) {
        // 循环：从现在（而非从 next）重新调度，避免会话被阻塞时快速追赶。
        // 抖动让我们每个周期都避开精确的 :00 墙钟边界。
        const newNext =
          jitteredNextCronRunMs(t.cron, now, t.id, jitterCfg) ?? Infinity
        nextFireAt.set(t.id, newNext)
        // 持久化 lastFiredAt=now，使下次进程生成在首次所见时重建
        // 这个相同的 newNext。会话任务跳过——进程本地。
        if (!isSession) firedFileRecurring.push(t.id)
      } else if (isSession) {
        // 一次性（或老化过期）会话任务：同步内存移除。无 inFlight
        // 窗口——下一个 tick 将读取不含此 id 的会话存储。
        removeSessionCronTasks([t.id])
        nextFireAt.delete(t.id)
      } else {
        // 一次性（或老化过期）文件任务：从磁盘删除。
        // inFlight 在异步的 removeCronTasks + chokidar 重载期间
        // 防止双重触发。
        inFlight.add(t.id)
        void removeCronTasks([t.id], dir)
          .catch(e =>
            logForDebugging(
              `[ScheduledTasks] 移除任务 ${t.id} 失败：${e}`,
            ),
          )
          .finally(() => inFlight.delete(t.id))
        nextFireAt.delete(t.id)
      }
    }

    // 文件后备任务：仅当我们拥有调度器锁时才处理。锁的存在是为了
    // 阻止同一 cwd 下的两个 Limkenion 会话双重触发同一个磁盘任务。
    if (isOwner) {
      for (const t of tasks) process(t, false)
      // 合并的 lastFiredAt 写入。inFlight 在 chokidar 触发重载期间
      // 防止双重触发（与下面的 removeCronTasks 相同的模式）——重载
      // 会用刚写出的 lastFiredAt 重新播种 `tasks`，而对其首次所见
      // 产生与我们已在内存中设置的相同的 newNext，因此即使没有
      // inFlight 也是幂等的。不过仍加防护以保持语义清晰。
      if (firedFileRecurring.length > 0) {
        for (const id of firedFileRecurring) inFlight.add(id)
        void markCronTasksFired(firedFileRecurring, now, dir)
          .catch(e =>
            logForDebugging(
              `[ScheduledTasks] 持久化 lastFiredAt 失败：${e}`,
            ),
          )
          .finally(() => {
            for (const id of firedFileRecurring) inFlight.delete(id)
          })
      }
    }
    // 会话任务：进程私有，锁不适用——另一会话看不到它们，也没有
    // 双重触发风险。每个 tick 从 bootstrap 状态读取
    // （无 chokidar、无 load()）。在守护进程路径（`dir !== undefined`）
    // 上跳过，该路径绝不触及 bootstrap 状态。
    if (dir === undefined) {
      for (const t of getSessionCronTasks()) process(t, true)
    }

    if (seen.size === 0) {
      // 本 tick 无活动任务——清空整个计划，使 getNextFireTime() 返回
      // null。下面的逐出循环在此不可达（seen 为空），否则过时条目
      // 会无限期存留并使守护进程 agent 保持活跃。
      nextFireAt.clear()
      return
    }
    // 逐出不再出现的任务的计划条目。当 !isOwner 时，文件任务的 id
    // 不在 `seen` 中并被逐出——无害：它们在首个拥有 tick 上会从
    // createdAt 重新锚定。
    for (const id of nextFireAt.keys()) {
      if (!seen.has(id)) nextFireAt.delete(id)
    }
  }

  async function enable() {
    if (stopped) return
    if (enablePoll) {
      clearInterval(enablePoll)
      enablePoll = null
    }

    const { default: chokidar } = await import('chokidar')
    if (stopped) return

    // 获取项目级调度器锁。只有持有会话运行 check()。其他会话定期
    // 探测，在持有者死亡时接管。当多个 Limkenion 共享同一 cwd 时
    // 防止双重触发。
    isOwner = await tryAcquireSchedulerLock(lockOpts).catch(() => false)
    if (stopped) {
      if (isOwner) {
        isOwner = false
        void releaseSchedulerLock(lockOpts)
      }
      return
    }
    if (!isOwner) {
      lockProbeTimer = setInterval(() => {
        void tryAcquireSchedulerLock(lockOpts)
          .then(owned => {
            if (stopped) {
              if (owned) void releaseSchedulerLock(lockOpts)
              return
            }
            if (owned) {
              isOwner = true
              if (lockProbeTimer) {
                clearInterval(lockProbeTimer)
                lockProbeTimer = null
              }
            }
          })
          .catch(e => logForDebugging(String(e), { level: 'error' }))
      }, LOCK_PROBE_INTERVAL_MS)
      lockProbeTimer.unref?.()
    }

    void load(true)

    const path = getCronFilePath(dir)
    watcher = chokidar.watch(path, {
      persistent: false,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: FILE_STABILITY_MS },
      ignorePermissionErrors: true,
    })
    watcher.on('add', () => void load(false))
    watcher.on('change', () => void load(false))
    watcher.on('unlink', () => {
      if (!stopped) {
        tasks = []
        nextFireAt.clear()
      }
    })

    checkTimer = setInterval(check, CHECK_INTERVAL_MS)
    // 不要仅为调度器而保持进程存活——在 -p 文本模式下，即使创建了
    // cron，进程也应在单次轮次后退出。
    checkTimer.unref?.()
  }

  return {
    start() {
      stopped = false
      // 守护进程路径（显式给出 dir）：不要触及 bootstrap 状态——
      // getScheduledTasksEnabled() 会读取一个从未初始化的标志。
      // 守护进程是在请求调度；直接启用。
      if (dir !== undefined) {
        logForDebugging(
          `[ScheduledTasks] 调度器 start() — dir=${dir}, hasTasks=${hasCronTasksSync(dir)}`,
        )
        void enable()
        return
      }
      logForDebugging(
        `[ScheduledTasks] 调度器 start() — enabled=${getScheduledTasksEnabled()}, hasTasks=${hasCronTasksSync()}`,
      )
      // 当 scheduled_tasks.json 有条目时自动启用。CronCreateTool
      // 也在会话中创建任务时设置它。
      if (
        !getScheduledTasksEnabled() &&
        (assistantMode || hasCronTasksSync())
      ) {
        setScheduledTasksEnabled(true)
      }
      if (getScheduledTasksEnabled()) {
        void enable()
        return
      }
      enablePoll = setInterval(
        en => {
          if (getScheduledTasksEnabled()) void en()
        },
        CHECK_INTERVAL_MS,
        enable,
      )
      enablePoll.unref?.()
    },
    stop() {
      stopped = true
      if (enablePoll) {
        clearInterval(enablePoll)
        enablePoll = null
      }
      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      if (lockProbeTimer) {
        clearInterval(lockProbeTimer)
        lockProbeTimer = null
      }
      void watcher?.close()
      watcher = null
      if (isOwner) {
        isOwner = false
        void releaseSchedulerLock(lockOpts)
      }
    },
    getNextFireTime() {
      // nextFireAt 用 Infinity 表示"永不"（进行中的一次性任务、坏 cron
      // 字符串）。过滤掉它们，使调用方能区分"即将"和"无可计划"。
      let min = Infinity
      for (const t of nextFireAt.values()) {
        if (t < min) min = t
      }
      return min === Infinity ? null : min
    },
  }
}

/**
 * 构建错过任务的通知文本。引导语位于任务列表之前，列表被包裹在代码
 * 围栏中，使多行祈使式提示不会被解释为即时指令，以避免自我引发的
 * prompt 注入。完整的 prompt 主体被保留——此路径确实需要模型在用户
 * 确认后执行该提示，且在模型看到此通知前，任务已从 JSON 删除。
 */
export function buildMissedTaskNotification(missed: CronTask[]): string {
  const plural = missed.length > 1
  const header =
    `当 Limkenion 未在运行时，以下一次性计划任务被错过。` +
    `${plural ? '它们' : '它'}已从 .limkenion/scheduled_tasks.json 中移除。\n\n` +
    `${plural ? '这些提示' : '此提示'}暂时不要执行。` +
    `请先使用 AskUserQuestion 工具询问是否现在${plural ? '逐一' : ''}运行。` +
    `仅在用户确认后才执行。`

  const blocks = missed.map(t => {
    const meta = `[${cronToHuman(t.cron)}, created ${new Date(t.createdAt).toLocaleString()}]`
    // 使用比提示中任何反引号序列都长一位的围栏，这样包含 ``` 的提示
    // 无法提前闭合围栏并解开尾部文本（CommonMark 围栏匹配规则）。
    const longestRun = (t.prompt.match(/`+/g) ?? []).reduce(
      (max, run) => Math.max(max, run.length),
      0,
    )
    const fence = '`'.repeat(Math.max(3, longestRun + 1))
    return `${meta}\n${fence}\n${t.prompt}\n${fence}`
  })

  return `${header}\n\n${blocks.join('\n\n')}`
}
