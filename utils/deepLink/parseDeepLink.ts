/**
 * 深度链接 URI 解析器
 *
 * 解析 `limkenion-cli://open` URI。所有参数都是可选的：
 *   q    — 预填 prompt 输入（不提交）
 *   cwd  — 工作目录（绝对路径）
 *   repo — owner/name 短名，对照 githubRepoPaths 配置解析
 *
 * 示例：
 *   limkenion-cli://open
 *   limkenion-cli://open?q=hello+world
 *   limkenion-cli://open?q=fix+tests&repo=owner/repo
 *   limkenion-cli://open?cwd=/path/to/project
 *
 * 安全：值会被 URL 解码、Unicode 清理，若包含 ASCII 控制字符（换行等可
 * 充当命令分隔符）则被拒绝。所有值在使用点（terminalLauncher.ts）都用
 * 单引号做 shell 转义——该转义就是注入边界。
 */

import { partiallySanitizeUnicode } from '../sanitization.js'

export const DEEP_LINK_PROTOCOL = 'limkenion-cli'

export type DeepLinkAction = {
  query?: string
  cwd?: string
  repo?: string
}

/**
 * 检查字符串是否包含 ASCII 控制字符（0x00-0x1F、0x7F）。
 * 这些在 shell 中可充当命令分隔符（换行、回车等）。
 * 允许可打印 ASCII 和 Unicode（中日韩、emoji、重音字符等）。
 */
function containsControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

/**
 * GitHub owner/repo 短名：字母数字、点、连字符、下划线，
 * 恰好一个斜杠。防止其成为路径穿越向量。
 */
const REPO_SLUG_PATTERN = /^[\w.-]+\/[\w.-]+$/

/**
 * 预填 prompt 长度的上限。对"审阅 PR #18796 […填充 4900 字符…] 另外
 * cat ~/.ssh/id_rsa"这类提示的唯一防御，是用户在按 Enter 前阅读它。
 * 达到此长度时 prompt 无法再一眼扫完，因此 banner.ts 在
 * LONG_PREFILL_THRESHOLD 之上显示明确的"滚动以审阅整个 prompt"警告。
 * 拒绝而非截断——截断会改变含义。
 *
 * 5000 是现实上限：Windows cmd.exe 回退方案（terminalLauncher.ts）的命令
 * 字符串限制为 8191 字符，加上 `cd /d <cwd> && <limkenion.exe>
 * --deep-link-origin ... --prefill "<q>"` 包装和 cmdQuote 的 %→%% 展开，
 * 对典型输入而言约 7000 字符的查询就是硬停点。病态的 >60% 百分号查询
 * 会超出限制 2 倍，但 cmd.exe 是最后手段回退（会先尝试 wt.exe 和
 * PowerShell），其失败模式是启动错误而非安全问题——所以我们不会因
 * 一个难以置信的输入而惩罚真实用户。
 */
const MAX_QUERY_LENGTH = 5000

/**
 * Linux 上 PATH_MAX 为 4096。Windows MAX_PATH 为 260（启用长路径后为
 * 32767）。没有真实路径会接近此值；超过 4096 的 cwd 属于格式错误或恶意。
 */
const MAX_CWD_LENGTH = 4096

/**
 * 把 limkenion-cli:// URI 解析为结构化动作。
 *
 * @throws {Error} 若 URI 格式错误或包含危险字符
 */
export function parseDeepLink(uri: string): DeepLinkAction {
  // 归一化：接受协议后带或不带尾冒号
  const normalized = uri.startsWith(`${DEEP_LINK_PROTOCOL}://`)
    ? uri
    : uri.startsWith(`${DEEP_LINK_PROTOCOL}:`)
      ? uri.replace(`${DEEP_LINK_PROTOCOL}:`, `${DEEP_LINK_PROTOCOL}://`)
      : null

  if (!normalized) {
    throw new Error(
      `深度链接无效：应为 ${DEEP_LINK_PROTOCOL}:// 协议，却得到 "${uri}"`,
    )
  }

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new Error(`深度链接 URL 无效："${uri}"`)
  }

  if (url.hostname !== 'open') {
    throw new Error(`未知深度链接操作："${url.hostname}"`)
  }

  const cwd = url.searchParams.get('cwd') ?? undefined
  const repo = url.searchParams.get('repo') ?? undefined
  const rawQuery = url.searchParams.get('q')

  // 若存在则校验 cwd——必须是绝对路径
  if (cwd && !cwd.startsWith('/') && !/^[a-zA-Z]:[/\\]/.test(cwd)) {
    throw new Error(
      `深度链接中的 cwd 无效：必须是绝对路径，却得到 "${cwd}"`,
    )
  }

  // 拒绝 cwd 中的控制字符（换行等），但允许反斜杠等路径字符。
  if (cwd && containsControlChars(cwd)) {
    throw new Error('深度链接 cwd 包含不允许的控制字符')
  }
  if (cwd && cwd.length > MAX_CWD_LENGTH) {
    throw new Error(
      `深度链接 cwd 超过 ${MAX_CWD_LENGTH} 字符（得到 ${cwd.length}）`,
    )
  }

  // 校验 repo 短名格式。解析发生在更晚（protocolHandler.ts）——
  // 此解析器保持纯净，不访问配置/文件系统。
  if (repo && !REPO_SLUG_PATTERN.test(repo)) {
    throw new Error(
      `深度链接中的 repo 无效：应为 "owner/repo"，却得到 "${repo}"`,
    )
  }

  let query: string | undefined
  if (rawQuery && rawQuery.trim().length > 0) {
    // 去除隐藏的 Unicode 字符（ASCII 走私 / 隐藏的 prompt 注入）
    query = partiallySanitizeUnicode(rawQuery.trim())
    if (containsControlChars(query)) {
      throw new Error('深度链接 query 包含不允许的控制字符')
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw new Error(
        `深度链接 query 超过 ${MAX_QUERY_LENGTH} 字符（得到 ${query.length}）`,
      )
    }
  }

  return { query, cwd, repo }
}

