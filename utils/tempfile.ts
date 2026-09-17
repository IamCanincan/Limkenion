import { createHash, randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 生成一个临时文件路径。
 *
 * @param prefix 临时文件名的可选前缀
 * @param extension 可选文件扩展名（默认为 '.md'）
 * @param options.contentHash 提供时，标识符由该字符串的 SHA-256 哈希
 *   （前 16 个十六进制字符）导出。这会生成在进程边界内稳定的路径——
 *   任何具有相同内容的进程都会得到相同的路径。当该路径会进入发送给
 *   Limkenion API 的内容（例如工具描述中的沙箱拒绝列表）时使用此项，
 *   因为随机 UUID 会在每次子进程生成时变化，并使提示缓存前缀失效。
 * @returns 临时文件路径
 */
export function generateTempFilePath(
  prefix: string = 'limkenion-prompt',
  extension: string = '.md',
  options?: { contentHash?: string },
): string {
  const id = options?.contentHash
    ? createHash('sha256')
        .update(options.contentHash)
        .digest('hex')
        .slice(0, 16)
    : randomUUID()
  return join(tmpdir(), `${prefix}-${id}${extension}`)
}
