import { logForDebugging } from './debug.js'
import { which } from './which.js'

// 会话缓存，避免重复检查
const binaryCache = new Map<string, boolean>()

/**
 * 检查某个二进制/命令是否已安装且可用。
 * 在 Unix 系统（macOS、Linux、WSL）上使用 'which'，在 Windows 上使用 'where'。
 *
 * @param command - 要检查的命令名（例如 'gopls'、'rust-analyzer'）
 * @returns Promise<boolean> - 命令存在返回 true，否则返回 false
 */
export async function isBinaryInstalled(command: string): Promise<boolean> {
  // 边界情况：空命令或仅空白字符的命令
  if (!command || !command.trim()) {
    logForDebugging('[binaryCheck] 提供了空命令，返回 false')
    return false
  }

  // 修剪命令以处理空白字符
  const trimmedCommand = command.trim()

  // 先检查缓存
  const cached = binaryCache.get(trimmedCommand)
  if (cached !== undefined) {
    logForDebugging(
      `[binaryCheck] 缓存命中 '${trimmedCommand}': ${cached}`,
    )
    return cached
  }

  let exists = false
  if (await which(trimmedCommand).catch(() => null)) {
    exists = true
  }

  // 缓存结果
  binaryCache.set(trimmedCommand, exists)

  logForDebugging(
    `[binaryCheck] 二进制 '${trimmedCommand}' ${exists ? '已找到' : '未找到'}`,
  )

  return exists
}

