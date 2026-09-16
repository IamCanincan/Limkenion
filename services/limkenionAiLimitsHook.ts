import { useEffect, useState } from 'react'
import {
  type LimkenionAILimits,
  currentLimits,
  statusListeners,
} from './limkenionAiLimits.js'

export function useLimkenionAiLimits(): LimkenionAILimits {
  const [limits, setLimits] = useState<LimkenionAILimits>({ ...currentLimits })

  useEffect(() => {
    const listener = (newLimits: LimkenionAILimits) => {
      setLimits({ ...newLimits })
    }
    statusListeners.add(listener)

    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return limits
}
