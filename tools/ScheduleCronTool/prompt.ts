import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../../services/analytics/growthbook.js'
import { DEFAULT_CRON_JITTER_CONFIG } from '../../utils/cronTasks.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const KAIROS_CRON_REFRESH_MS = 5 * 60 * 1000

export const DEFAULT_MAX_AGE_DAYS =
  DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs / (24 * 60 * 60 * 1000)

/**
 * cron 调度系统的统一门控。将构建期的
 * `feature('AGENT_TRIGGERS')` 标志（死代码消除）与运行时的
 * `limkenion_kairos_cron` GrowthBook 门控相结合，刷新窗口为 5 分钟。
 *
 * AGENT_TRIGGERS 可独立于 KAIROS 发布 —— cron 模块
 * 图（cronScheduler/cronTasks/cronTasksLock/cron.ts + 三个工具 +
 * /loop 技能）对 src/assistant/ 的导入为零，也没有 feature('KAIROS')
 * 调用。REPL.tsx 中读取 kairosEnabled 是安全的：
 * kairosEnabled 无条件存在于 AppStateStore 中且默认为 false，因此
 * 当 KAIROS 关闭时，调度器只会拿到 assistantMode: false。
 *
 * 从 Tool.isEnabled()（惰性、初始化后）以及 useEffect /
 * 命令式 setup 中调用，绝不在模块作用域调用 —— 这样磁盘缓存才有
 * 机会完成填充。
 *
 * 默认值为 `true` —— /loop 已 GA（在 changelog 中公布）。对于
 * Bedrock/Vertex/Foundry 以及设置了 DISABLE_TELEMETRY /
 * LIMKENION_DISABLE_NONESSENTIAL_TRAFFIC 的情况，GrowthBook 会被禁用；若默认值为 `false`
 * 会破坏这些用户的 /loop（GH #31759）。GB 门控现在纯粹作为
 * 面向全量实例的熔断开关 —— 将其翻转为 `false` 会在下一次 isKilled 轮询 tick 时停止已在运行的
 * 调度器，而不只是新调度器。
 *
 * `LIMKENION_DISABLE_CRON` 是优先级高于 GB 的本地覆盖项。
 */
export function isKairosCronEnabled(): boolean {
  return feature('AGENT_TRIGGERS')
    ? !isEnvTruthy(process.env.LIMKENION_DISABLE_CRON) &&
        getFeatureValue_CACHED_WITH_REFRESH(
          'limkenion_kairos_cron',
          true,
          KAIROS_CRON_REFRESH_MS,
        )
    : false
}

/**
 * 磁盘持久化（durable）cron 任务的熔断开关。范围比
 * {@link isKairosCronEnabled} 更窄 —— 将其关闭会在
 * call() 处强制 `durable: false`，而不影响仅限会话的 cron（内存中，GA）。
 *
 * 默认为 `true`，以便 Bedrock/Vertex/Foundry 和 DISABLE_TELEMETRY 用户获得
 * 持久化 cron。它不读取 LIMKENION_DISABLE_CRON（那会通过
 * isKairosCronEnabled 关闭整个调度器）。
 */
export function isDurableCronEnabled(): boolean {
  return getFeatureValue_CACHED_WITH_REFRESH(
    'limkenion_kairos_cron_durable',
    true,
    KAIROS_CRON_REFRESH_MS,
  )
}

export const CRON_CREATE_TOOL_NAME = 'CronCreate'
export const CRON_DELETE_TOOL_NAME = 'CronDelete'
export const CRON_LIST_TOOL_NAME = 'CronList'

export function buildCronCreateDescription(durableEnabled: boolean): string {
  return durableEnabled
    ? 'Schedule a prompt to run at a future time — either recurring on a cron schedule, or once at a specific time. Pass durable: true to persist to .limkenion/scheduled_tasks.json; otherwise session-only.'
    : 'Schedule a prompt to run at a future time within this Limkenion session — either recurring on a cron schedule, or once at a specific time.'
}

export function buildCronCreatePrompt(durableEnabled: boolean): string {
  const durabilitySection = durableEnabled
    ? `## Durability

By default (durable: false) the job lives only in this Limkenion session — nothing is written to disk, and the job is gone when Limkenion exits. Pass durable: true to write to .limkenion/scheduled_tasks.json so the job survives restarts. Only use durable: true when the user explicitly asks for the task to persist ("keep doing this every day", "set this up permanently"). Most "remind me in 5 minutes" / "check back in an hour" requests should stay session-only.`
    : `## Session-only

Jobs live only in this Limkenion session — nothing is written to disk, and the job is gone when Limkenion exits.`

  const durableRuntimeNote = durableEnabled
    ? 'Durable jobs persist to .limkenion/scheduled_tasks.json and survive session restarts — on next launch they resume automatically. One-shot durable tasks that were missed while the REPL was closed are surfaced for catch-up. Session-only jobs die with the process. '
    : ''

  return `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets \`0 9\`, and every user who asks for "hourly" gets \`0 *\` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.

${durabilitySection}

## Runtime behavior

Jobs only fire while the REPL is idle (not mid-query). ${durableRuntimeNote}The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.

Recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the ${DEFAULT_MAX_AGE_DAYS}-day limit when scheduling recurring jobs.

Returns a job ID you can pass to ${CRON_DELETE_TOOL_NAME}.`
}

export const CRON_DELETE_DESCRIPTION = 'Cancel a scheduled cron job by ID'
export function buildCronDeletePrompt(durableEnabled: boolean): string {
  return durableEnabled
    ? `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from .limkenion/scheduled_tasks.json (durable jobs) or the in-memory session store (session-only jobs).`
    : `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from the in-memory session store.`
}

export const CRON_LIST_DESCRIPTION = 'List scheduled cron jobs'
export function buildCronListPrompt(durableEnabled: boolean): string {
  return durableEnabled
    ? `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME}, both durable (.limkenion/scheduled_tasks.json) and session-only.`
    : `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME} in this session.`
}
