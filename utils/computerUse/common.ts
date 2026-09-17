import { normalizeNameForMCP } from '../../services/mcp/normalization.js'
import { env } from '../env.js'

export const COMPUTER_USE_MCP_SERVER_NAME = 'computer-use'

/**
 * 前台门的哨兵 bundle ID。Limkenion 是终端——它没有窗口。此值永远不会
 * 匹配真实的 `NSWorkspace.frontmostApplication`，因此包中的"宿主为前台"
 * 分支（鼠标点击穿透豁免、键盘安全网）对我们而言是死代码。
 * `prepareForAction` 的"豁免我们自己的窗口"同样是空操作——没有窗口
 * 可供豁免。
 */
export const CLI_HOST_BUNDLE_ID = 'com.limkenion.limkenion.cli-no-window'

/**
 * 当 `__CFBundleIdentifier` 未设置时，`env.terminal` → bundleId 的回退映射。
 * 覆盖我们可区分的 macOS 终端——Linux 条目（konsole、gnome-terminal、
 * xterm）被刻意省略，因为 `createCliExecutor` 受 darwin 保护。
 */
const TERMINAL_BUNDLE_ID_FALLBACK: Readonly<Record<string, string>> = {
  'iTerm.app': 'com.googlecode.iterm2',
  Apple_Terminal: 'com.apple.Terminal',
  ghostty: 'com.mitchellh.ghostty',
  kitty: 'net.kovidgoyal.kitty',
  WarpTerminal: 'dev.warp.Warp-Stable',
  vscode: 'com.microsoft.VSCode',
}

/**
 * 我们运行于其内部的终端模拟器的 bundle ID，使 `prepareDisplay` 能豁免它
 * 不被隐藏，`captureExcluding` 能把它排除在截图外。无法检测时返回 null
 * （ssh、清空的环境、未知终端）——调用方必须处理 null 情况。
 *
 * `__CFBundleIdentifier` 由 LaunchServices 在 .app bundle 派生进程时设置，
 * 并被子进程继承。它就是精确的 bundleId，无需查询——可处理回退表
 * 不知道的终端。在 tmux/screen 下，它反映启动 SERVER 的那个终端，可能与
 * 连接的客户端不同。这里无害：我们豁免 A 终端窗口，而截图无论如何都会
 * 排除它。
 */
export function getTerminalBundleId(): string | null {
  const cfBundleId = process.env.__CFBundleIdentifier
  if (cfBundleId) return cfBundleId
  return TERMINAL_BUNDLE_ID_FALLBACK[env.terminal ?? ''] ?? null
}

/**
 * macOS CLI 的静态能力。`hostBundleId` 不在这里——它由 `executor.ts`
 * 按 `ComputerExecutor.capabilities` 添加。`buildComputerUseTools`
 * 接受此形状（无 `hostBundleId`，无 `teachMode`）。
 */
export const CLI_CU_CAPABILITIES = {
  screenshotFiltering: 'native' as const,
  platform: 'darwin' as const,
}

export function isComputerUseMCPServer(name: string): boolean {
  return normalizeNameForMCP(name) === COMPUTER_USE_MCP_SERVER_NAME
}
