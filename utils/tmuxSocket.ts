/**
 * TMUX 套接字隔离
 * =====================
 * 本模块为 Limkenion 的操作管理一个隔离的 tmux 套接字。
 *
 * 为什么存在：
 * 没有隔离，Limkenion 可能会意外影响用户的 tmux 会话。
 * 例如，通过 Bash 工具运行 `tmux kill-session` 会杀死用户的
 * 当前会话（如果用户从 tmux 内启动 Limkenion）。
 *
 * 工作原理：
 * 1. Limkenion 创建自己的 tmux 套接字：`limkenion-<PID>`（如 `limkenion-12345`）
 * 2. 所有 Tmux 工具命令通过 `-L` 标志使用此套接字
 * 3. 所有 Bash 工具命令继承指向此套接字的 TMUX env 变量
 *    （在 Shell.ts 中通过 getLimkenionTmuxEnv() 设置）
 *
 * 这意味着通过 Limkenion 运行的任何 tmux 命令——无论是直接通过 Tmux 工具
 * 还是通过 Bash——都将作用于 Limkenion 的隔离套接字，而不会作用到
 * 用户的 tmux 会话。
 *
 * 重要说明：用户的原始 TMUX env 变量不会被使用。套接字初始化后，
 * getLimkenionTmuxEnv() 返回一个值，该值会覆盖 Shell.ts 派生的
 * 所有子进程中的用户 TMUX 设置。
 */

import { posix } from 'path'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { toError } from './errors.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'

// 用于 tmux 套接字管理的常量
const TMUX_COMMAND = 'tmux'
const LIMKENION_SOCKET_PREFIX = 'limkenion'

/**
 * 执行 tmux 命令，在 Windows 上通过 WSL 路由。
 * 在 Windows 上，tmux 只存在于 WSL 内部——WSL 互操作允许 tmux 会话把
 * .exe 文件作为原生 Win32 进程启动，同时 stdin/stdout 通过 WSL pty 流动。
 */
async function execTmux(
  args: string[],
  opts?: { useCwd?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (getPlatform() === 'windows') {
    // -e 无需登录 shell 即可直接执行 tmux。没有它，wsl 会把命令行交给
    // bash，而 bash 会把 `#` 当作注释吃掉：下面的 `display-message -p
    // #{socket_path},#{pid}` 会变成 `display-message -p ` → 退出码 1 →
    // 我们会静默回退到猜测的路径，永远无法得知真实的服务器 PID。
    // 与 TungstenTool/utils.ts:execTmuxCommand 的根因相同。
    const result = await execFileNoThrow('wsl', ['-e', TMUX_COMMAND, ...args], {
      env: { ...process.env, WSL_UTF8: '1' },
      ...opts,
    })
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      code: result.code || 0,
    }
  }
  const result = await execFileNoThrow(TMUX_COMMAND, args, opts)
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.code || 0,
  }
}

// 套接字状态 - 首次使用 Tmux 工具或运行 tmux 命令时惰性初始化
let socketName: string | null = null
let socketPath: string | null = null
let serverPid: number | null = null
let isInitializing = false
let initPromise: Promise<void> | null = null

// tmux 可用性 - 一次性检查
let tmuxAvailabilityChecked = false
let tmuxAvailable = false

// 跟踪 Tmux 工具是否至少使用过一次
// 用于在真正需要时才初始化套接字
let tmuxToolUsed = false

/**
 * 获取 Limkenion 隔离 tmux 会话的套接字名称。
 * 格式：limkenion-<PID>
 */
export function getLimkenionSocketName(): string {
  if (!socketName) {
    socketName = `${LIMKENION_SOCKET_PREFIX}-${process.pid}`
  }
  return socketName
}


/**
 * 初始化后设置套接字信息。
 * 在 tmux 会话创建后调用。
 */
export function setLimkenionSocketInfo(path: string, pid: number): void {
  socketPath = path
  serverPid = pid
}

/**
 * 返回套接字是否已初始化。
 */
export function isSocketInitialized(): boolean {
  return socketPath !== null && serverPid !== null
}

/**
 * 获取 Limkenion 隔离套接字的 TMUX 环境变量值。
 *
 * 关键：Shell.ts 用此值覆盖所有子进程中的 TMUX env 变量。
 * 这能确保任何通过 Bash 工具运行的 `tmux` 命令都作用于
 * Limkenion 的套接字，而不会作用到用户的会话。
 *
 * 格式："socket_path,server_pid,pane_index"（与 tmux 的 TMUX env 变量一致）
 * 示例："/tmp/tmux-501/limkenion-12345,54321,0"
 *
 * 若套接字尚未初始化则返回 null。
 * 返回 null 时，Shell.ts 不会覆盖 TMUX，从而保留用户的环境。
 */
export function getLimkenionTmuxEnv(): string | null {
  if (!socketPath || serverPid === null) {
    return null
  }
  return `${socketPath},${serverPid},0`
}

/**
 * 检查系统上是否安装了 tmux。
 * 此检查只做一次并在进程生命周期内缓存。
 *
 * 当 tmux 不可用：
 * - TungstenTool（Tmux）将无法工作
 * - TeammateTool 将无法工作（它用 tmux 进行窗格管理）
 * - Bash 命令将在没有 tmux 隔离的情况下运行
 */
export async function checkTmuxAvailable(): Promise<boolean> {
  if (!tmuxAvailabilityChecked) {
    const result =
      getPlatform() === 'windows'
        ? await execFileNoThrow('wsl', ['-e', TMUX_COMMAND, '-V'], {
            env: { ...process.env, WSL_UTF8: '1' },
            useCwd: false,
          })
        : await execFileNoThrow('which', [TMUX_COMMAND], {
            useCwd: false,
          })
    tmuxAvailable = result.code === 0
    if (!tmuxAvailable) {
      logForDebugging(
        `[Socket] 未安装 tmux。Tmux 工具和 Teammate 工具将不可用。`,
      )
    }
    tmuxAvailabilityChecked = true
  }
  return tmuxAvailable
}

/**
 * 返回缓存的 tmux 可用性状态。
 * 若尚未检查则返回 false。
 * 需执行检查时使用 checkTmuxAvailable()。
 */
export function isTmuxAvailable(): boolean {
  return tmuxAvailabilityChecked && tmuxAvailable
}


/**
 * 返回 Tmux 工具是否至少被使用过一次。
 * Shell.ts 用它来决定是否初始化套接字。
 */
export function hasTmuxToolBeenUsed(): boolean {
  return tmuxToolUsed
}

/**
 * 确保套接字已用 tmux 会话初始化。
 * 当 Tmux 工具被使用或命令包含 "tmux" 时由 Shell.ts 调用。
 * 可安全重复调用；只会初始化一次。
 *
 * 若未安装 tmux，此函数会优雅返回而不初始化套接字。
 * getLimkenionTmuxEnv() 将返回 null，Bash 命令将在没有
 * tmux 隔离的情况下运行。
 */
export async function ensureSocketInitialized(): Promise<void> {
  // 已初始化
  if (isSocketInitialized()) {
    return
  }

  // 在使用前检查 tmux 是否可用
  const available = await checkTmuxAvailable()
  if (!available) {
    return
  }

  // 已有另一个调用正在初始化 - 等待它但不传播错误
  // 原始调用方会处理错误并设置优雅降级
  if (isInitializing && initPromise) {
    try {
      await initPromise
    } catch {
      // 忽略 - 原始调用方会记录错误
    }
    return
  }

  isInitializing = true
  initPromise = doInitialize()

  try {
    await initPromise
  } catch (error) {
    // 记录错误但不抛出 - 优雅降级
    const err = toError(error)
    logError(err)
    logForDebugging(
      `[Socket] 初始化 tmux 套接字失败：${err.message}。Tmux 隔离将被禁用。`,
    )
  } finally {
    isInitializing = false
  }
}

/**
 * 终止 Limkenion 隔离套接字的 tmux 服务器。
 * 在优雅关闭时调用以清理资源。
 */
async function killTmuxServer(): Promise<void> {
  const socket = getLimkenionSocketName()
  logForDebugging(`[Socket] 正在终止套接字 ${socket} 的 tmux 服务器`)

  const result = await execTmux(['-L', socket, 'kill-server'])

  if (result.code === 0) {
    logForDebugging(`[Socket] 已成功终止 tmux 服务器`)
  } else {
    // 服务器可能已经停止，这没问题
    logForDebugging(
      `[Socket] 终止 tmux 服务器失败（退出码 ${result.code}）：${result.stderr}`,
    )
  }
}

async function doInitialize(): Promise<void> {
  const socket = getLimkenionSocketName()

  // 用我们的自定义套接字创建一个新会话
  // 通过 -e 传入 LIMKENION_SKIP_PROMPT_HISTORY，使其在初始 shell 环境中生效
  //
  // 在 Windows 上，tmux 服务器从生成它的短暂存活的 wsl.exe 继承 WSL_INTEROP；
  // 一旦 `new-session -d` 分离且 wsl.exe 退出，该套接字就停止服务请求。
  // 之后在窗格内启动的任何 cli.exe 都会遇到 `UtilAcceptVsock: accept4 failed
  // 110`（ETIMEDOUT）。2026-03-25 观察到：服务器 PID 386（在 WSL 启动时随
  // /init 一起启动）继承了 /run/WSL/383_interop——即 init 自己的套接字，
  // 它监听但并不处理互操作。/run/WSL/1_interop 是 WSL 维护的指向真正
  // 处理器的稳定符号链接；将服务器固定到它上面，使互操作穿过生成它的
  // wsl.exe 依然存活。
  const result = await execTmux([
    '-L',
    socket,
    'new-session',
    '-d',
    '-s',
    'base',
    '-e',
    'LIMKENION_SKIP_PROMPT_HISTORY=true',
    ...(getPlatform() === 'windows'
      ? ['-e', 'WSL_INTEROP=/run/WSL/1_interop']
      : []),
  ])

  if (result.code !== 0) {
    // 会话可能已存在（同一 PID 的先前运行——不太可能但有可能）
    // 检查会话是否存在
    const checkResult = await execTmux([
      '-L',
      socket,
      'has-session',
      '-t',
      'base',
    ])
    if (checkResult.code !== 0) {
      throw new Error(
        `Failed to create tmux session on socket ${socket}: ${result.stderr}`,
      )
    }
  }

  // 注册清理，在退出时终止 tmux 服务器
  registerCleanup(killTmuxServer)

  // 在 tmux GLOBAL 环境（-g）中设置 LIMKENION_SKIP_PROMPT_HISTORY。
  // 没有 -g 它只会作用于 'base' 会话，而 TungstenTool 创建的
  // 新会话（如 'test'、'verify'）不会继承它。
  // 在此套接字上生成的任何 Limkenion 实例都会继承该 env 变量，
  // 防止测试/验证会话污染用户的真实命令历史和 --resume 会话列表。
  await execTmux([
    '-L',
    socket,
    'set-environment',
    '-g',
    'LIMKENION_SKIP_PROMPT_HISTORY',
    'true',
  ])

  // 与上面 new-session 的 -e 相同的 WSL_INTEROP 固定，但放在 GLOBAL 环境，
  // 使 TungstenTool 创建的会话也继承它。new-session 上的 -e 只覆盖
  // base 会话的初始 shell；之后的 `new-session -s cc` 会继承 SERVER
  // 的环境，而该环境仍持有生成它的 wsl.exe 中的过时套接字。
  if (getPlatform() === 'windows') {
    await execTmux([
      '-L',
      socket,
      'set-environment',
      '-g',
      'WSL_INTEROP',
      '/run/WSL/1_interop',
    ])
  }

  // 获取套接字路径和服务器 PID
  const infoResult = await execTmux([
    '-L',
    socket,
    'display-message',
    '-p',
    '#{socket_path},#{pid}',
  ])

  if (infoResult.code === 0) {
    const [path, pidStr] = infoResult.stdout.trim().split(',')
    if (path && pidStr) {
      const pid = parseInt(pidStr, 10)
      if (!isNaN(pid)) {
        setLimkenionSocketInfo(path, pid)
        return
      }
    }
    // 解析失败 - 记录并回退到备用路径
    logForDebugging(
      `[Socket] 无法从 tmux 输出解析套接字信息："${infoResult.stdout.trim()}"。使用备用路径。`,
    )
  } else {
    // 命令失败 - 记录并回退到备用路径
    logForDebugging(
      `[Socket] 通过 display-message 获取套接字信息失败（退出码 ${infoResult.code}）：${infoResult.stderr}。使用备用路径。`,
    )
  }

  // 备用方案：从标准 tmux 位置构造套接字路径
  // tmux 套接字通常在 $TMPDIR/tmux-<UID>/<socket_name>（若未设置 TMPDIR 则在 /tmp/tmux-<UID>/）
  // 在 Windows 上该路径位于 WSL 内部，因此始终使用 POSIX 分隔符。
  // process.getuid() 在 Windows 上未定义；CI 中 WSL 默认用户是 root（uid 0）。
  const uid = process.getuid?.() ?? 0
  const baseTmpDir = process.env.TMPDIR || '/tmp'
  const fallbackPath = posix.join(baseTmpDir, `tmux-${uid}`, socket)

  // 单独获取服务器 PID
  const pidResult = await execTmux([
    '-L',
    socket,
    'display-message',
    '-p',
    '#{pid}',
  ])

  if (pidResult.code === 0) {
    const pid = parseInt(pidResult.stdout.trim(), 10)
    if (!isNaN(pid)) {
      logForDebugging(
        `[Socket] 使用备用套接字路径：${fallbackPath}（服务器 PID：${pid}）`,
      )
      setLimkenionSocketInfo(fallbackPath, pid)
      return
    }
    // PID 解析失败
    logForDebugging(
      `[Socket] 无法从 tmux 输出解析服务器 PID："${pidResult.stdout.trim()}"`,
    )
  } else {
    logForDebugging(
      `[Socket] 无法获取服务器 PID（退出码 ${pidResult.code}）：${pidResult.stderr}`,
    )
  }

  throw new Error(
    `Failed to get socket info for ${socket}: primary="${infoResult.stderr}", fallback="${pidResult.stderr}"`,
  )
}

