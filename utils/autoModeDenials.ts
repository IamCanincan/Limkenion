/**
 * 跟踪最近被自动模式分类器拒绝的命令。
 * 由 useCanUseTool.ts 填充，由 /permissions 中的 RecentDenialsTab.tsx 读取。
 */

import { feature } from 'bun:bundle'

export type AutoModeDenial = {
  toolName: string
  /** 被拒绝命令的人类可读描述（例如 bash 命令字符串） */
  display: string
  reason: string
  timestamp: number
}

let DENIALS: readonly AutoModeDenial[] = []
const MAX_DENIALS = 20

export function recordAutoModeDenial(denial: AutoModeDenial): void {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return
  DENIALS = [denial, ...DENIALS.slice(0, MAX_DENIALS - 1)]
}

export function getAutoModeDenials(): readonly AutoModeDenial[] {
  return DENIALS
}
