// 极简 cron 表达式解析与下次运行计算。
//
// 支持标准的 5 字段 cron 子集：
//   minute hour day-of-month month day-of-week
//
// 字段语法：通配符、N、步进（斜杠 N）、范围（N-M）、列表（N,M,...）。
// 不支持 L、W、? 或名称别名。所有时间都在进程的本地时区解释——
// "0 9 * * *" 表示 CLI 运行处的上午 9 点。

export type CronFields = {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

type FieldRange = { min: number; max: number }

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // 分钟
  { min: 0, max: 23 }, // 小时
  { min: 1, max: 31 }, // 月内日期
  { min: 1, max: 12 }, // 月份
  { min: 0, max: 6 }, // 星期几（0=周日至6；7 作为周日别名接受）
]

// 把单个 cron 字段解析为排序后的匹配值数组。
// 支持：通配符、N、斜杠 N（步进）、N-M（范围）和逗号列表。
// 无效时返回 null。
function expandField(field: string, range: FieldRange): number[] | null {
  const { min, max } = range
  const out = new Set<number>()

  for (const part of field.split(',')) {
    // 通配符或斜杠 N
    const stepMatch = part.match(/^\*(?:\/(\d+))?$/)
    if (stepMatch) {
      const step = stepMatch[1] ? parseInt(stepMatch[1], 10) : 1
      if (step < 1) return null
      for (let i = min; i <= max; i += step) out.add(i)
      continue
    }

    // N-M 或 N-M/S
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1]!, 10)
      const hi = parseInt(rangeMatch[2]!, 10)
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1
      // 星期几：在范围内接受 7 作为周日别名（例如 5-7 = 周五、周六、周日 → [5,6,0]）
      const isDow = min === 0 && max === 6
      const effMax = isDow ? 7 : max
      if (lo > hi || step < 1 || lo < min || hi > effMax) return null
      for (let i = lo; i <= hi; i += step) {
        out.add(isDow && i === 7 ? 0 : i)
      }
      continue
    }

    // 纯 N
    const singleMatch = part.match(/^\d+$/)
    if (singleMatch) {
      let n = parseInt(part, 10)
      // 星期几：接受 7 作为周日别名 → 0
      if (min === 0 && max === 6 && n === 7) n = 0
      if (n < min || n > max) return null
      out.add(n)
      continue
    }

    return null
  }

  if (out.size === 0) return null
  return Array.from(out).sort((a, b) => a - b)
}

/**
 * 把 5 字段 cron 表达式解析为已展开的数字数组。
 * 无效或不受支持的语法时返回 null。
 */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const expanded: number[][] = []
  for (let i = 0; i < 5; i++) {
    const result = expandField(parts[i]!, FIELD_RANGES[i]!)
    if (!result) return null
    expanded.push(result)
  }

  return {
    minute: expanded[0]!,
    hour: expanded[1]!,
    dayOfMonth: expanded[2]!,
    month: expanded[3]!,
    dayOfWeek: expanded[4]!,
  }
}

/**
 * 计算严格晚于 `from`、与 cron 字段匹配的下一个 Date，
 * 使用进程的本地时区。逐分钟前进。上限为 366 天；
 * 无匹配时返回 null（对有效 cron 而言不可能，但满足类型）。
 *
 * 标准 cron 语义：当 dayOfMonth 和 dayOfWeek 均被约束（都不是全范围）
 * 时，只要其中任意一个匹配即算匹配。
 *
 * DST：针对春季前调空隙的固定小时 cron（例如美国时区的 `30 2 * * *`）
 * 会跳过转换日——空隙小时在本地时间中从不出现，因此小时集合检查失败，
 * 循环继续。通配符小时间的 cron（`30 * * * *`）在空隙之后的首个有效
 * 分钟触发。回拨（fall-back）重复只触发一次（前进逻辑跳过第二次出现）。
 * 这与 vixie-cron 的行为一致。
 */
export function computeNextCronRun(
  fields: CronFields,
  from: Date,
): Date | null {
  const minuteSet = new Set(fields.minute)
  const hourSet = new Set(fields.hour)
  const domSet = new Set(fields.dayOfMonth)
  const monthSet = new Set(fields.month)
  const dowSet = new Set(fields.dayOfWeek)

  // 该字段是否通配（全范围）？
  const domWild = fields.dayOfMonth.length === 31
  const dowWild = fields.dayOfWeek.length === 7

  // 向上取整到下一个整分钟（严格晚于 `from`）
  const t = new Date(from.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)

  const maxIter = 366 * 24 * 60
  for (let i = 0; i < maxIter; i++) {
    const month = t.getMonth() + 1
    if (!monthSet.has(month)) {
      // 跳到下个月初
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    const dom = t.getDate()
    const dow = t.getDay()
    // 当 dom/dow 均被约束时，任一匹配即可（OR 语义）
    const dayMatches =
      domWild && dowWild
        ? true
        : domWild
          ? dowSet.has(dow)
          : dowWild
            ? domSet.has(dom)
            : domSet.has(dom) || dowSet.has(dow)

    if (!dayMatches) {
      // 跳到下一天
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    if (!hourSet.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
      continue
    }

    if (!minuteSet.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1)
      continue
    }

    return t
  }

  return null
}

// --- cronToHuman ------------------------------------------------------------
// 刻意受限：仅覆盖常见的模式；其他情况则回退到原始 cron 字符串。
// `utc` 选项专为 CCR 远程触发器（agents-platform.tsx）存在，这些触发器
// 在服务器上运行并始终使用 UTC cron 字符串——该路径把 UTC→本地
// 用于显示，并且需要跨午夜的逻辑处理星期几的情况。本地定时任务
// （默认）两者都不需要。

const DAY_NAMES = [
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
]

function formatLocalTime(minute: number, hour: number): string {
  // 1 月 1 日——任何地方都没有 DST 空隙。如果使用 `new Date()`（今天），
  // 会在一年中唯一的春季前调日把凌晨 2 点滚动成凌晨 3 点。
  const d = new Date(2000, 0, 1, hour, minute)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function formatUtcTimeAsLocal(minute: number, hour: number): string {
  // 创建一个 UTC 日期并用用户的本地时区格式化
  const d = new Date()
  d.setUTCHours(hour, minute, 0, 0)
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

export function cronToHuman(cron: string, opts?: { utc?: boolean }): string {
  const utc = opts?.utc ?? false
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]

  // 每 N 分钟：step/N * * * *
  const everyMinMatch = minute.match(/^\*\/(\d+)$/)
  if (
    everyMinMatch &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyMinMatch[1]!, 10)
    return n === 1 ? '每分钟' : `每 ${n} 分钟`
  }

  // 每小时：0 * * * *
  if (
    minute.match(/^\d+$/) &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const m = parseInt(minute, 10)
    if (m === 0) return '每小时'
    return `每小时的 :${m.toString().padStart(2, '0')} 分`
  }

  // 每 N 小时：0 step/N * * *
  const everyHourMatch = hour.match(/^\*\/(\d+)$/)
  if (
    minute.match(/^\d+$/) &&
    everyHourMatch &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyHourMatch[1]!, 10)
    const m = parseInt(minute, 10)
    const suffix = m === 0 ? '' : ` 的 :${m.toString().padStart(2, '0')} 分`
    return n === 1 ? `每小时${suffix}` : `每 ${n} 小时${suffix}`
  }

  // --- 其余情况都引用小时+分钟：按 utc 分叉 ----------------

  if (!minute.match(/^\d+$/) || !hour.match(/^\d+$/)) return cron
  const m = parseInt(minute, 10)
  const h = parseInt(hour, 10)
  const fmtTime = utc ? formatUtcTimeAsLocal : formatLocalTime

  // 每天特定时间：M H * * *
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每天 ${fmtTime(m, h)}`
  }

  // 特定星期几：M H * * D
  if (dayOfMonth === '*' && month === '*' && dayOfWeek.match(/^\d$/)) {
    const dayIndex = parseInt(dayOfWeek, 10) % 7 // 归一化 7（周日别名）-> 0
    let dayName: string | undefined
    if (utc) {
      // UTC 的日期+时间可能落在不同的本地日（跨午夜）。
      // 通过构造 UTC 时刻来计算实际的本地星期几。
      const ref = new Date()
      const daysToAdd = (dayIndex - ref.getUTCDay() + 7) % 7
      ref.setUTCDate(ref.getUTCDate() + daysToAdd)
      ref.setUTCHours(h, m, 0, 0)
      dayName = DAY_NAMES[ref.getDay()]
    } else {
      dayName = DAY_NAMES[dayIndex]
    }
    if (dayName) return `每${dayName} ${fmtTime(m, h)}`
  }

  // 工作日：M H * * 1-5
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return `工作日 ${fmtTime(m, h)}`
  }

  return cron
}
