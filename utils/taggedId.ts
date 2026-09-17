/**
 * 与 API 的 tagged_id.py 格式兼容的带标签 ID 编码。
 *
 * 从 UUID 字符串生成形如 "user_01PaGUP2rbg1XDh7Z9W1CEpd" 的 ID。
 * 格式为：{tag}_{version}{base58(uuid_as_128bit_int)}
 *
 * 必须与 api/api/common/utils/tagged_id.py 保持同步。
 */

const BASE_58_CHARS =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const VERSION = '01'
// ceil(128 / log2(58)) = 22
const ENCODED_LENGTH = 22

/**
 * 把 128 位无符号整数编码为定长 base58 字符串。
 */
function base58Encode(n: bigint): string {
  const base = BigInt(BASE_58_CHARS.length)
  const result = new Array<string>(ENCODED_LENGTH).fill(BASE_58_CHARS[0]!)
  let i = ENCODED_LENGTH - 1
  let value = n
  while (value > 0n) {
    const rem = Number(value % base)
    result[i] = BASE_58_CHARS[rem]!
    value = value / base
    i--
  }
  return result.join('')
}

/**
 * 把 UUID 字符串（带或不带连字符）解析为 128 位 bigint。
 */
function uuidToBigInt(uuid: string): bigint {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32) {
    throw new Error(`无效的 UUID 十六进制长度：${hex.length}`)
  }
  return BigInt('0x' + hex)
}

/**
 * 将账户 UUID 转换为 API 格式的带标签 ID。
 *
 * @param tag - 标签前缀（例如 "user"、"org"）
 * @param uuid - UUID 字符串（带或不带连字符）
 * @returns 形如 "user_01PaGUP2rbg1XDh7Z9W1CEpd" 的带标签 ID 字符串
 */
export function toTaggedId(tag: string, uuid: string): string {
  const n = uuidToBigInt(uuid)
  return `${tag}_${VERSION}${base58Encode(n)}`
}
