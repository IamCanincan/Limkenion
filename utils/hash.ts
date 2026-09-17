/**
 * djb2 字符串哈希——快速非加密哈希，返回有符号 32 位整数。
 * 跨运行时确定（不同于使用 wyhash 的 Bun.hash）。当 Bun.hash 不可用，
 * 或需要磁盘上稳定的输出（例如必须跨运行时升级存活的缓存目录名）时，
 * 作为后备方案使用。
 */
export function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

/**
 * 为变更检测哈希任意内容。Bun.hash 比 sha256 快约 100 倍，并且对于差异检测
 * 来说碰撞抵抗力足够（非密码安全）。
 */
export function hashContent(content: string): string {
  if (typeof Bun !== 'undefined') {
    return Bun.hash(content).toString()
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto')
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * 哈希两个字符串而不分配串联的临时字符串。Bun 路径用种子链式 wyhash
 * （hash(a) 作为种子喂给 hash(b)）；Node 路径用增量 SHA-256 update。
 * 种子链式天然区分 ("ts","code") 与 ("tsc","ode")，因此在 Bun 下无需分隔符。
 */
export function hashPair(a: string, b: string): string {
  if (typeof Bun !== 'undefined') {
    return Bun.hash(b, Bun.hash(a)).toString()
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto')
  return crypto
    .createHash('sha256')
    .update(a)
    .update('\0')
    .update(b)
    .digest('hex')
}
