/**
 * 用于 classifierApprovals store 的 React hook。
 * 从 classifierApprovals.ts 拆出，使纯状态导入方（permissions.ts、
 * toolExecution.ts、postCompactCleanup.ts）不把 React 拉进 print.ts。
 */

import { useSyncExternalStore } from 'react'
import {
  isClassifierChecking,
  subscribeClassifierChecking,
} from './classifierApprovals.js'

export function useIsClassifierChecking(toolUseID: string): boolean {
  return useSyncExternalStore(subscribeClassifierChecking, () =>
    isClassifierChecking(toolUseID),
  )
}
