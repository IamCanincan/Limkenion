/**
 * 服务器自身出网的白名单闸门（尽力而为的"网络沙箱"）。
 *
 * - 未设置 LIMKENION_EGRESS_ALLOWLIST 时：全部放行（行为不变）。
 * - 设置后：逗号分隔的主机名列表，如 `api.deepseek.com,*.githubusercontent.com`；
 *   `*.` 前缀按后缀匹配，其余精确匹配主机名。只管**服务端进程自己**的出站请求
 *   （模型 API / MCP / OAuth）；shell 工具拉起的子进程走操作系统网络栈，
 *   Node 层面拦不住 —— 那需要 OS 级沙箱，Windows 下无轻量方案，见 README 局限说明。
 */
const allowRaw = process.env.LIMKENION_EGRESS_ALLOWLIST ?? ''

/**
 * 主机名是否命中白名单。抽出来是为了让**服务端出网**与 **shell 子进程代理**
 * 共用同一套规则语义 —— 两套判断迟早会对不上。
 * @param {string} host
 * @returns {boolean}
 */
export function hostAllowed(host) {
  if (!allowRaw) return true
  const h = String(host ?? '').trim().toLowerCase()
  if (!h) return false
  const rules = allowRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return rules.some(r => (r.startsWith('*.') ? h.endsWith(r.slice(1)) : r === h))
}

/** @param {string|URL} url */
export function egressAllowed(url) {
  if (!allowRaw) return true
  let host
  try {
    host = new URL(String(url)).hostname.toLowerCase()
  } catch {
    return false
  }
  return hostAllowed(host)
}

/** fetch 的白名单包裹：mcp / oauth / 模型 API 的出站请求一律走这里。 */
async function guardedFetch(url, opts) {
  if (!egressAllowed(url)) {
    throw new Error(`出网被拒绝：${String(url)} 不在 LIMKENION_EGRESS_ALLOWLIST 白名单内`)
  }
  return fetch(url, opts)
}

export { guardedFetch as fetch }
