import { runExtraUsage } from './extra-usage-core.js'

export async function call(): Promise<{ type: 'text'; value: string }> {
  const result = await runExtraUsage()

  if (result.type === 'message') {
    return { type: 'text', value: result.value }
  }

  return {
    type: 'text',
    value: result.opened
      ? `浏览器已打开用于管理超量使用。若未打开，请访问：${result.url}`
      : `请访问 ${result.url} 来管理超量使用额度。`,
  }
}
