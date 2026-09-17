// 定时提示，存储在 <project>/.limkenion/scheduled_tasks.json。
//
// 任务有两种形式：
//   - 一次性（recurring: false/undefined）——触发一次，然后自动删除。
//   - 循环（recurring: true）——按计划触发，从现在起重新调度，
//     直到通过 CronDelete 显式删除，或超过可配置的限制
//     （DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs）后自动过期。
//
// 文件格式：
//   { "tasks": [{ id, cron, prompt, createdAt, recurring?, permanent? }] }

import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  addSessionCronTask,
  getProjectRoot,
  getSessionCronTasks,
  removeSessionCronTasks,
} from '../bootstrap/state.js'
import { computeNextCronRun, parseCronExpression } from './cron.js'
import { logForDebugging } from './debug.js'
import { isFsInaccessible } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { safeParseJSON } from './json.js'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'

export type CronTask = {
  id: string
  /** 5 字段 cron 字符串（本地时间）——写入时校验，读取时重新校验。 */
  cron: string
  /** 任务触发时入队的提示。 */
  prompt: string
  /** 任务创建时的 Epoch 毫秒。用于错过任务的检测锚点。 */
  createdAt: number
  /**
   * 最近一次触发的 Epoch 毫秒。调度器在每次循环触发后写回，
   * 使下次触发计算能在进程重启后存活。
   * 调度器用 `lastFiredAt ?? createdAt` 作为首次所见锚点——从未触发的
   * 任务用 createdAt（这对固定 cron 如 `30 14 27 2 *` 正确，其从现在
   * 起的下次触发在明年）；之前触发过的任务则重建先前进程在内存中的
   * 同一个 `nextFireAt`。一次性任务从不设置（触发即删除）。
   */
  lastFiredAt?: number
  /** 为 true 时，任务触发后重新调度而不是被删除。 */
  recurring?: boolean
  /**
   * 为 true 时，任务豁免 recurringMaxAgeMs 自动过期。
   * 系统逃生通道，用于助手模式的內建任务（catch-up/
   * morning-checkin/dream）——安装程序的 writeIfMissing() 会跳过已存在
   * 的文件，因此重新安装无法重建它们。无法通过 CronCreateTool 设置；
   * 仅由 src/assistant/install.ts 直接写入 scheduled_tasks.json。
   */
  permanent?: boolean
  /**
   * 仅运行时标志。false → 会话作用域（从不写入磁盘）。
   * 文件后备任务保持 undefined；writeCronTasks 剥离它，使磁盘上的
   * 形状保持 { id, cron, prompt, createdAt, lastFiredAt?, recurring?, permanent? }。
   */
  durable?: boolean
  /**
   * 仅运行时。设置后，表示该任务由进程内队友创建。
   * 调度器将触发路由到该队友的队列，而不是主 REPL 的。
   * 从不写入磁盘（队友 cron 始终是会话级的）。
   */
  agentId?: string
}

type CronFile = { tasks: CronTask[] }

const CRON_FILE_REL = join('.limkenion', 'scheduled_tasks.json')

/**
 * cron 文件路径。`dir` 默认取 getProjectRoot()——在不经过 main.tsx
 * 的上下文中显式传入它（例如没有 bootstrap 状态的 Agent SDK 守护进程）。
 */
export function getCronFilePath(dir?: string): string {
  return join(dir ?? getProjectRoot(), CRON_FILE_REL)
}

/**
 * 读取并解析 .limkenion/scheduled_tasks.json。若文件缺失、为空或格式错误
 * 则返回空任务列表。cron 字符串无效的任务会被静默丢弃（在调试级别记录），
 * 这样单个坏条目永远不会阻塞整个文件。
 */
export async function readCronTasks(dir?: string): Promise<CronTask[]> {
  const fs = getFsImplementation()
  let raw: string
  try {
    raw = await fs.readFile(getCronFilePath(dir), { encoding: 'utf-8' })
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return []
    logError(e)
    return []
  }

  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') return []
  const file = parsed as Partial<CronFile>
  if (!Array.isArray(file.tasks)) return []

  const out: CronTask[] = []
  for (const t of file.tasks) {
    if (
      !t ||
      typeof t.id !== 'string' ||
      typeof t.cron !== 'string' ||
      typeof t.prompt !== 'string' ||
      typeof t.createdAt !== 'number'
    ) {
      logForDebugging(
        `[ScheduledTasks] 跳过格式错误的任务：${jsonStringify(t)}`,
      )
      continue
    }
    if (!parseCronExpression(t.cron)) {
      logForDebugging(
        `[ScheduledTasks] 跳过 cron 无效的任务 ${t.id}：'${t.cron}'`,
      )
      continue
    }
    out.push({
      id: t.id,
      cron: t.cron,
      prompt: t.prompt,
      createdAt: t.createdAt,
      ...(typeof t.lastFiredAt === 'number'
        ? { lastFiredAt: t.lastFiredAt }
        : {}),
      ...(t.recurring ? { recurring: true } : {}),
      ...(t.permanent ? { permanent: true } : {}),
    })
  }
  return out
}

/**
 * 同步检查 cron 文件是否有任何有效任务。由 cronScheduler.start() 用来
 * 决定是否自动启用。只读一次文件。
 */
export function hasCronTasksSync(dir?: string): boolean {
  let raw: string
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- called once from cronScheduler.start()
    raw = readFileSync(getCronFilePath(dir), 'utf-8')
  } catch {
    return false
  }
  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') return false
  const tasks = (parsed as Partial<CronFile>).tasks
  return Array.isArray(tasks) && tasks.length > 0
}

/**
 * 用给定任务覆盖 .limkenion/scheduled_tasks.json。若 .limkenion/ 缺失则创建。
 * 空任务列表写入空文件（而非删除），使文件监视器在最后一个任务被移除时
 * 能看到变更事件。
 */
export async function writeCronTasks(
  tasks: CronTask[],
  dir?: string,
): Promise<void> {
  const root = dir ?? getProjectRoot()
  await mkdir(join(root, '.limkenion'), { recursive: true })
  // 剥离仅运行时的 `durable` 标志——磁盘上的一切本就默认是持久的，
  // 不保留该标志意味着 readCronTasks() 自然而然地得出 durable: undefined，
  // 无需显式设置。
  const body: CronFile = {
    tasks: tasks.map(({ durable: _durable, ...rest }) => rest),
  }
  await writeFile(
    getCronFilePath(root),
    jsonStringify(body, null, 2) + '\n',
    'utf-8',
  )
}

/**
 * 追加一个任务。返回生成的 id。调用方需已校验过 cron 字符串
 * （工具通过 validateInput 处理）。
 *
 * 当 `durable` 为 false 时，任务只保存在进程内存中
 * （bootstrap/state.ts）——它会在本会话按计划触发，但从不写入
 * .limkenion/scheduled_tasks.json，并随进程结束而消失。
 * 调度器直接把会话任务合并进其 tick 循环，因此无需文件变更事件。
 */
export async function addCronTask(
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
  agentId?: string,
): Promise<string> {
  // 短 ID——8 个十六进制字符对 MAX_JOBS=50 绰绰有余，避免了
  // 工具层（显示短 ID）与磁盘之间的 slice/prefix 转换。
  const id = randomUUID().slice(0, 8)
  const task = {
    id,
    cron,
    prompt,
    createdAt: Date.now(),
    ...(recurring ? { recurring: true } : {}),
  }
  if (!durable) {
    addSessionCronTask({ ...task, ...(agentId ? { agentId } : {}) })
    return id
  }
  const tasks = await readCronTasks()
  tasks.push(task)
  await writeCronTasks(tasks)
  return id
}

/**
 * 按 id 移除任务。若无匹配则为空操作（例如另一个会话抢先了）。
 * 既用于触发一次后的清理，也用于显式 CronDelete。
 *
 * 当以未定义的 `dir` 调用时（REPL 路径），也会清扫内存中的会话存储——
 * 调用方不知道一个 id 存在于哪个存储中。
 * 守护进程调用方显式传入 `dir`；它们没有会话，`dir !== undefined`
 * 守卫使此函数在该路径上不会触及 bootstrap 状态（测试强制执行此点）。
 */
export async function removeCronTasks(
  ids: string[],
  dir?: string,
): Promise<void> {
  if (ids.length === 0) return
  // 先清扫会话存储。若所有 id 都在那里被找到，则完成——完全跳过文件读取。
  // removeSessionCronTasks 在未命中时是空操作（返回 0），因此已有的
  // 持久删除路径会在不分配的情况下继续走。
  if (dir === undefined && removeSessionCronTasks(ids) === ids.length) {
    return
  }
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  const remaining = tasks.filter(t => !idSet.has(t.id))
  if (remaining.length === tasks.length) return
  await writeCronTasks(remaining, dir)
}

/**
 * 在给定循环任务上盖上 `lastFiredAt` 并写回。批量处理，因此一次调度器
 * tick 中的 N 次触发 = 一次读改写，而不是 N 次。只触及文件后备任务——
 * 会话任务随进程结束而消失，无需持久化其触发时间。若没有任何 id 匹配
 * 则为空操作（任务在触发与写入之间被删除——例如用户在 tick 中途
 * 运行了 CronDelete）。
 *
 * 调度器锁意味着最多一个进程调用此函数；chokidar 会拾取这次写入并触发
 * 重载，用刚写入的 `lastFiredAt` 重新播种 `nextFireAt`——幂等
 * （相同计算，相同结果）。
 */
export async function markCronTasksFired(
  ids: string[],
  firedAt: number,
  dir?: string,
): Promise<void> {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  let changed = false
  for (const t of tasks) {
    if (idSet.has(t.id)) {
      t.lastFiredAt = firedAt
      changed = true
    }
  }
  if (!changed) return
  await writeCronTasks(tasks, dir)
}

/**
 * File-backed tasks + session-only tasks, merged. Session tasks get
 * `durable: false` so callers can distinguish them. File tasks are
 * returned as-is (durable undefined → truthy).
 *
 * Only merges when `dir` is undefined — daemon callers (explicit `dir`)
 * have no session store to merge with.
 */
export async function listAllCronTasks(dir?: string): Promise<CronTask[]> {
  const fileTasks = await readCronTasks(dir)
  if (dir !== undefined) return fileTasks
  const sessionTasks = getSessionCronTasks().map(t => ({
    ...t,
    durable: false as const,
  }))
  return [...fileTasks, ...sessionTasks]
}

/**
 * Next fire time in epoch ms for a cron string, strictly after `fromMs`.
 * Returns null if invalid or no match in the next 366 days.
 */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron)
  if (!fields) return null
  const next = computeNextCronRun(fields, new Date(fromMs))
  return next ? next.getTime() : null
}

/**
 * Cron 调度器调优旋钮。运行时取自
 * `limkenion_kairos_cron_config` GrowthBook JSON 配置（见 cronJitterConfig.ts），
 * 以便运维无需发布客户端构建即可在全局调整行为。
 * 这里的默认值精确地保持了配置前行为。
 */
export type CronJitterConfig = {
  /** 循环任务前向延迟，为两次触发之间间隔的比例。 */
  recurringFrac: number
  /** 循环前向延迟的上限，无论间隔多长。 */
  recurringCapMs: number
  /** 一次性任务的后向提前量：任务最多可提前触发的毫秒数。 */
  oneShotMaxMs: number
  /**
   * 一次性任务的后向提前量：当分钟取模门匹配时任务可提前触发的最少毫秒数。
   * 0 = taskIds 哈希接近零的任务在精确时刻触发。提高此值可保证没人落在
   * 墙钟边界上。
   */
  oneShotFloorMs: number
  /**
   * 抖动触发落在满足 `minute % N === 0` 的分钟上。30 → :00/:30
   * （人类取整的热点）。15 → :00/:15/:30/:45。1 → 每分钟。
   */
  oneShotMinuteMod: number
  /**
   * 循环任务在创建后这么多毫秒自动过期（除非标记为 `permanent`）。
   * Cron 是多日会话的主要驱动因素（p99 正常运行时间在 #19931 后从
   * 61min → 53h），且无界的循环会让 Tier-1 堆泄漏无限累积。
   * 默认值（7 天）覆盖"本周每小时检查我的 PR"这类工作流，同时限制最坏
   * 情况的会话寿命。永久任务（助手模式的 catch-up/morning-checkin/dream）
   * 永不老化——因安装程序 install.ts 的 writeIfMissing() 会跳过已存在文件，
   * 它们一旦被删除就无法重建。
   *
   * `0` = 无限（任务永不过期）。
   */
  recurringMaxAgeMs: number
}

export const DEFAULT_CRON_JITTER_CONFIG: CronJitterConfig = {
  recurringFrac: 0.1,
  recurringCapMs: 15 * 60 * 1000,
  oneShotMaxMs: 90 * 1000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
}

/**
 * taskId 是一个 8 十六进制字符的 UUID 切片（见 {@link addCronTask}）→ 解析为
 * u32 → [0, 1)。跨重启稳定，在集群中均匀分布。非十六进制 id
 * （手工编辑的 JSON）回退到 0 = 无抖动。
 */
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000
  return Number.isFinite(frac) ? frac : 0
}

/**
 * 与 {@link nextCronRunMs} 相同，另加对每个任务的确定性延迟，以避免
 * 许多会话调度同一 cron 字符串时的惊群效应（如 `0 * * * *` → 所有人
 * 都在 :00 命中推理）。
 *
 * 延迟与当前两次触发之间的间隔成正比
 * （{@link CronJitterConfig.recurringFrac}，被
 * {@link CronJitterConfig.recurringCapMs} 封顶），因此在默认设置下，
 * 每小时任务散布在 [:00, :06)，而每分钟任务只散布几秒。
 *
 * 仅用于循环任务。一次性任务使用
 * {@link oneShotJitteredNextCronRunMs}（后向抖动，分钟门控）。
 */
export function jitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  if (t1 === null) return null
  const t2 = nextCronRunMs(cron, t1)
  // 明年内没有第二次匹配（如固定日期）→ 没有可比对的比例基准，也几乎
  // 不构成惊群风险。在 t1 触发。
  if (t2 === null) return t1
  const jitter = Math.min(
    jitterFrac(taskId) * cfg.recurringFrac * (t2 - t1),
    cfg.recurringCapMs,
  )
  return t1 + jitter
}

/**
 * 与 {@link nextCronRunMs} 相同，当触发时间落在满足
 * {@link CronJitterConfig.oneShotMinuteMod} 的分钟边界上时，减去对每个
 * 任务的确定性提前量。
 *
 * 一次性任务是用户固定的（"下午 3 点提醒我"），因此延迟它们会破坏约定——
 * 但略微提前触发是隐形的，且能分散所有人选择同一整点墙钟时间的推理峰值。
 * 在默认设置（mod 30、最大 90 秒、floor 0）下只有 :00 和 :30 会抖动，
 * 因为人类会取整到半点。
 *
 * 事件期间，运维可以推送 `limkenion_kairos_cron_config`，例如
 * `{oneShotMinuteMod: 15, oneShotMaxMs: 300000, oneShotFloorMs: 30000}`
 * 以把 :00/:15/:30/:45 的触发分散到 [t-5min, t-30s] 窗口——每个任务
 * 至少获得 30 秒提前量，因此没人落在精确时刻。
 *
 * 检查的是计算出的触发时间而非 cron 字符串，因此
 * `0 15 * * *`、步进表达式和 `0,30 9 * * *` 落在匹配分钟上时都会抖动。
 * 被 `fromMs` 截住，使在自身抖动窗口内创建的任务不会在创建之前触发。
 */
export function oneShotJitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  if (t1 === null) return null
  // Cron 分辨率为 1 分钟 → 计算出的时间始终有 :00 秒，
  // 因此检查分钟字段就足以识别热点标记。
  // 用 getMinutes()（本地），而非 getUTCMinutes()：cron 在本地时间求值，
  // 而"用户选了整点时间"意味着在他们*自己的*时区是整点。在半时区偏移的
  // 区域（印度 UTC+5:30），本地 :00 是 UTC :30——UTC 检查会抖动错误的
  // 标记。
  if (new Date(t1).getMinutes() % cfg.oneShotMinuteMod !== 0) return t1
  // floor + frac * (max - floor) → 在 [floor, max) 上均匀分布。当 floor=0
  // 时这退化为原始 frac * max。当 floor>0 时，即使 taskId 哈希为 0 也会
  // 获得 `floor` 毫秒的提前量——没人会在精确时刻触发。
  const lead =
    cfg.oneShotFloorMs +
    jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs)
  // nextCronRunMs 保证 t1 > fromMs（严格之后），因此 max() 只在任务创建
  // 于自身提前量窗口内时才起作用。
  return Math.max(t1 - lead, fromMs)
}

/**
 * 当任务的计划下次运行（从 createdAt 计算）在过去时，该任务即"错过"。
 * 在启动时向用户提示。对一次性任务和循环任务都有效——当 Limkenion
 * 关闭时窗口已过的循环任务仍然"错过"。
 */
export function findMissedTasks(tasks: CronTask[], nowMs: number): CronTask[] {
  return tasks.filter(t => {
    const next = nextCronRunMs(t.cron, t.createdAt)
    return next !== null && next < nowMs
  })
}
