import { spawnSync } from 'child_process'
import { getIsInteractive } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'

let loggedTmuxCcDisable = false
let checkedTmuxMouseHint = false

/**
 * 来自 `tmux display-message -p '#{client_control_mode}'` 的缓存结果。
 * undefined = 尚未查询（或探测失败）——环境变量启发式仍然可靠。
 */
let tmuxControlModeProbed: boolean | undefined

/**
 * 用于 iTerm2 的 tmux 集成模式（`tmux -CC` / `tmux -2CC`）的环境变量启发式。
 *
 * 在 `-CC` 模式下，iTerm2 把 tmux 窗格渲染为原生分屏——tmux 作为服务器
 * 运行（设置了 TMUX），但每个窗格的实际终端模拟器是 iTerm2，因此
 * TERM_PROGRAM 保持为 `iTerm.app` 且 TERM 是 iTerm2 的默认值（xterm-*）。
 * 与此相对，常规的 iTerm2 内 tmux 会把 TERM_PROGRAM 覆盖为 `tmux` 并把
 * TERM 设为 screen-* 或 tmux-*。
 *
 * 此启发式有已知盲区（SSH 通常不传播 TERM_PROGRAM；.tmux.conf 可覆盖
 * TERM）——probeTmuxControlModeSync() 是权威的后卫。此处作为零子进程的
 * 快速路径保留。
 */
function isTmuxControlModeEnvHeuristic(): boolean {
  if (!process.env.TMUX) return false
  if (process.env.TERM_PROGRAM !== 'iTerm.app') return false
  // 双保险：在常规 tmux 中 TERM 是 screen-* 或 tmux-*；
  // 在 -CC 模式下 iTerm2 设置自己的 TERM（xterm-*）。
  const term = process.env.TERM ?? ''
  return !term.startsWith('screen') && !term.startsWith('tmux')
}

/**
 * 同步一次性探测：通过 `#{client_control_mode}` 直接询问 tmux 该客户端
 * 是否处于控制模式。在环境变量启发式无法判断时于首次 isTmuxControlMode()
 * 调用运行；结果被缓存。
 *
 * 用同步（spawnSync）是因为答案决定是否进入全屏——异步探测与 React 渲染
 * 竞争并失败：coder-tmux（ssh → 远程的 tmux -CC）不传播 TERM_PROGRAM，
 * 环境变量启发式错过；等异步探测解析时，我们已进入启用了鼠标追踪的
 * 备用屏幕。在 iTerm2 的 -CC 集成中鼠标滚轮是死的，用户完全无法滚动。
 *
 * 代价：约 5ms 子进程，仅当设置了 $TMUX 且未设置 $TERM_PROGRAM 时
 * （SSH 进入 tmux 的情况）。本地的 iTerm2 -CC 和非 tmux 路径跳过派生。
 *
 * TMUX 环境变量检查必须在前——否则 display-message 会去查询碰巧运行
 * 的任何 tmux 服务器，而不是我们的客户端。
 */
function probeTmuxControlModeSync(): void {
  // 用启发式结果预填缓存，使下面的提前返回不会让它保持 undefined——
  // isTmuxControlMode() 每次渲染被调用 15+ 次，undefined 缓存会在每次
  // 调用时重新进入此函数（在失败情况下重新派生 tmux）。
  tmuxControlModeProbed = isTmuxControlModeEnvHeuristic()
  if (tmuxControlModeProbed) return
  if (!process.env.TMUX) return
  // 仅在可能涉及 iTerm 时探测：TERM_PROGRAM 是 iTerm.app（上面已覆盖）
  // 或未设置（SSH 通常不传播它）。当 TERM_PROGRAM 明确是某个非 iTerm
  // 终端时，跳过——tmux -CC 是 iTerm 独有功能，派生子进程会浪费。
  if (process.env.TERM_PROGRAM) return
  let result
  try {
    result = spawnSync(
      'tmux',
      ['display-message', '-p', '#{client_control_mode}'],
      { encoding: 'utf8', timeout: 2000 },
    )
  } catch {
    // spawnSync 在某些平台上可能抛出（例如 Windows 上 tmux 不存在且运行时
    // 以异常而非 result.error 呈现）。按非零退出处理。
    return
  }
  // 非零退出 / 派生错误：tmux 太旧（格式变量于 2.4 加入）或不可用。
  // 保持启发式结果缓存。
  if (result.status !== 0) return
  tmuxControlModeProbed = result.stdout.trim() === '1'
}

/**
 * 在 `tmux -CC`（iTerm2 集成模式）下运行时为 true。
 *
 * 在 -CC 模式中，全屏模式的备用屏幕 / 鼠标追踪路径不可恢复
 * （双击破坏终端状态；鼠标滚轮是死的），因此调用方自动禁用全屏。
 *
 * 当环境变量启发式无法判断时，在首次调用上惰性探测 tmux。
 */
export function isTmuxControlMode(): boolean {
  if (tmuxControlModeProbed === undefined) probeTmuxControlModeSync()
  return tmuxControlModeProbed ?? false
}

export function _resetTmuxControlModeProbeForTesting(): void {
  tmuxControlModeProbed = undefined
  loggedTmuxCcDisable = false
}

/**
 * 仅运行时环境变量检查。Ant 默认开启（设 LIMKENION_NO_FLICKER=0 可退出）；
 * 外部用户默认关闭（设 LIMKENION_NO_FLICKER=1 可加入）。
 */
export function isFullscreenEnvEnabled(): boolean {
  // 显式的用户退出选项始终优先。
  if (isEnvDefinedFalsy(process.env.LIMKENION_NO_FLICKER)) return false
  // 显式加入覆盖自动检测（逃生通道）。
  if (isEnvTruthy(process.env.LIMKENION_NO_FLICKER)) return true
  // 在 tmux -CC 下自动禁用：备用屏幕 + 鼠标追踪会在双击时破坏终端
  // 状态，且鼠标滚轮是死的。
  if (isTmuxControlMode()) {
    if (!loggedTmuxCcDisable) {
      loggedTmuxCcDisable = true
      logForDebugging(
        '检测到 tmux -CC（iTerm2 集成模式）故禁用全屏 · 设 LIMKENION_NO_FLICKER=1 可覆盖',
      )
    }
    return false
  }
  return false
}

/**
 * 全屏模式是否应启用 SGR 鼠标追踪（DEC 1000/1002/1006）。
 * 设 LIMKENION_DISABLE_MOUSE=1 可保留备用屏幕 + 虚拟化滚动
 * （键盘 PgUp/PgDn/Ctrl+Home/End 仍可用）但跳过鼠标捕获，
 * 使 tmux/kitty/终端原生的复制时选中继续可用。
 *
 * 与 LIMKENION_NO_FLICKER=0 的全有或全无不同——后者还会禁用备用屏幕
 * 和虚拟化回滚。
 */
export function isMouseTrackingEnabled(): boolean {
  return !isEnvTruthy(process.env.LIMKENION_DISABLE_MOUSE)
}

/**
 * 鼠标点击处理是否被禁用（点击/拖拽被忽略，滚轮仍可用）。
 * 设 LIMKENION_DISABLE_MOUSE_CLICKS=1 可防止意外点击触发光标定位、
 * 文本选择或消息展开。
 *
 * 仅全屏专用——仅当 LIMKENION_NO_FLICKER 生效时才可达。
 */
export function isMouseClicksDisabled(): boolean {
  return isEnvTruthy(process.env.LIMKENION_DISABLE_MOUSE_CLICKS)
}

/**
 * 全屏备用屏幕布局是否实际渲染时为 true——
 * 需要交互式 REPL 会话，且环境变量未被显式设为 falsy。无头路径
 * （--print、SDK、进程内队友）从不进入全屏，因此依赖备用屏幕重渲染的
 * 功能应以此门控。
 */
export function isFullscreenActive(): boolean {
  return getIsInteractive() && isFullscreenEnvEnabled()
}

/**
 * 面向 tmux 且 `mouse off` 的全屏用户的一次性提示。
 *
 * tmux 的 `mouse` 选项按设计是会话作用域的——没有窗格级的对应物。
 * 过去我们进入备用屏幕时执行 `tmux set mouse on` 让滚轮滚动可用，但那会
 * 改变每个兄弟窗格（vim、less、shell）的鼠标行为，并在 kill-pane 或
 * 多个 CC 实例在恢复时竞争时泄漏。现在我们保持 tmux 状态原样——与
 * vim/less/htop 相同——只告诉用户他们的选项。
 *
 * 从 REPL 启动处一次性触发。若设置了 TMUX、全屏激活且 tmux 当前的
 * `mouse` 选项为 off，则每会话返回一次提示文本；否则返回 null。
 */
export async function maybeGetTmuxMouseHint(): Promise<string | null> {
  if (!process.env.TMUX) return null
  // tmux -CC 上面会自动禁用全屏，但这里仍双保险。
  if (!isFullscreenActive() || isTmuxControlMode()) return null
  if (checkedTmuxMouseHint) return null
  checkedTmuxMouseHint = true
  // -A 包含继承值：当选项全局设置（.tmux.conf 中的 `set -g mouse on`）
  // 但未在会话级设置时，`show -v mouse` 返回空——而这是常见情况。
  // -A 给出有效值。
  const { stdout, code } = await execFileNoThrow(
    'tmux',
    ['show', '-Av', 'mouse'],
    { useCwd: false, timeout: 2000 },
  )
  if (code !== 0 || stdout.trim() === 'on') return null
  return "检测到 tmux · 用 PgUp/PgDn 滚动 · 或在 ~/.tmux.conf 中加入 'set -g mouse on' 以启用滚轮滚动"
}

/** 仅测试：重置模块级每会话一次的标志。 */
export function _resetForTesting(): void {
  loggedTmuxCcDisable = false
  checkedTmuxMouseHint = false
}
