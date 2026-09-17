import type { LocalCommandCall } from '../../types/command.js'
import {
  getCronFilePath,
  listAllCronTasks,
  nextCronRunMs,
  removeCronTasks,
  type CronTask,
} from '../../utils/cronTasks.js'

/** 把 epoch 毫秒格式化成本地时间，附带相对时长。 */
function formatWhen(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const abs =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const diff = ms - Date.now()
  const mins = Math.round(diff / 60_000)
  const rel =
    mins < 60
      ? `${mins} 分钟后`
      : mins < 60 * 24
        ? `${Math.round(mins / 60)} 小时后`
        : `${Math.round(mins / (60 * 24))} 天后`
  return `${abs}（${rel}）`
}

function describe(t: CronTask): string {
  const next = nextCronRunMs(t.cron, Date.now())
  const when = next === null ? '（无法解析的 cron 表达式）' : formatWhen(next)
  const kind = t.recurring ? '循环' : '一次性'
  const scope = t.durable === false ? '仅本会话' : '已落盘'
  const prompt = t.prompt.length > 60 ? t.prompt.slice(0, 60) + '…' : t.prompt
  return [
    `  ${t.id}`,
    `    计划  ${t.cron}   ${kind} · ${scope}`,
    `    下次  ${when}`,
    `    内容  ${prompt}`,
  ].join('\n')
}

export const call: LocalCommandCall = async args => {
  const trimmed = (args ?? '').trim()

  // /schedule remove <id>
  if (trimmed.startsWith('remove ')) {
    const id = trimmed.slice('remove '.length).trim()
    if (!id) {
      return { type: 'text', value: '用法：/schedule remove <任务 id>' }
    }
    try {
      await removeCronTasks([id])
      return { type: 'text', value: `已删除定时任务 ${id}` }
    } catch (err) {
      return {
        type: 'text',
        value: `删除失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  if (trimmed && trimmed !== 'list') {
    return {
      type: 'text',
      value: '用法：/schedule              列出全部定时任务\n     /schedule remove <id>  删除某个任务',
    }
  }

  let tasks: CronTask[]
  try {
    tasks = await listAllCronTasks()
  } catch (err) {
    return {
      type: 'text',
      value: `读取定时任务失败：${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (tasks.length === 0) {
    return {
      type: 'text',
      value: [
        '当前没有定时任务。',
        '',
        '创建方式：直接让模型帮你建，例如',
        '  「每天早上 9 点跑一次测试」',
        '模型会调用 CronCreate 工具写入本地任务表。',
        '',
        `存储位置：${getCronFilePath()}`,
      ].join('\n'),
    }
  }

  return {
    type: 'text',
    value: [
      `定时任务（${tasks.length} 个）：`,
      '',
      ...tasks.map(describe),
      '',
      `存储位置：${getCronFilePath()}`,
      '删除：/schedule remove <id>',
    ].join('\n'),
  }
}
