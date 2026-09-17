import {
  type SpawnOptions,
  type SpawnSyncOptions,
  spawn,
  spawnSync,
} from 'child_process'
import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import instances from '../ink/instances.js'
import { logForDebugging } from './debug.js'
import { whichSync } from './which.js'

function isCommandAvailable(command: string): boolean {
  return !!whichSync(command)
}

// 在独立窗口打开并可分离派生的 GUI 编辑器，无需与 TUI 争夺 stdin。
// VS Code 的分支（cursor、windsurf、codium）被显式列出，因为它们都不以
// 'code' 作为子串。
const GUI_EDITORS = [
  'code',
  'cursor',
  'windsurf',
  'codium',
  'subl',
  'atom',
  'gedit',
  'notepad++',
  'notepad',
]

// 接受 +N 作为 goto-line 参数的编辑器。Windows 默认
// （'start /wait notepad'）不接受——notepad 把 +42 当作文件名。
const PLUS_N_EDITORS = /\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/

// VS Code 及其分支使用 -g file:line。subl 使用裸 file:line（不带 -g）。
const VSCODE_FAMILY = new Set(['code', 'cursor', 'windsurf', 'codium'])

/**
 * 将编辑器分类为 GUI 或非 GUI。返回匹配的 GUI 家族名称用于 goto-line
 * argv 选择，或对终端编辑器返回 undefined。
 * 注意：这只是分类——实际派生用户的真实二进制，而不是此返回值，
 * 这样 'code-insiders' / 绝对路径能被保留。
 *
 * 使用 basename，使 /home/alice/code/bin/nvim 不会经由目录组件匹配
 * 'code'。code-insiders → 仍匹配 'code'，/usr/bin/code → 'code' →
 * 匹配。
 */
export function classifyGuiEditor(editor: string): string | undefined {
  const base = basename(editor.split(' ')[0] ?? '')
  return GUI_EDITORS.find(g => base.includes(g))
}

/**
 * 为 GUI 编辑器构建 goto-line argv。VS Code 家族使用 -g file:line；
 * subl 使用裸 file:line；其他不支持 goto-line。
 */
function guiGotoArgv(
  guiFamily: string,
  filePath: string,
  line: number | undefined,
): string[] {
  if (!line) return [filePath]
  if (VSCODE_FAMILY.has(guiFamily)) return ['-g', `${filePath}:${line}`]
  if (guiFamily === 'subl') return [`${filePath}:${line}`]
  return [filePath]
}

/**
 * 在用户的外部编辑器中打开文件。
 *
 * 对 GUI 编辑器（code、subl 等）：分离派生——编辑器在独立窗口中打开，
 * Limkenion 保持交互。
 *
 * 对终端编辑器（vim、nvim、nano 等）：通过 Ink 的备用屏幕切换阻塞，
 * 直到编辑器退出。这与 editFileInEditor()（promptEditor.ts 中）的
 * 处理相同，只是不做回读。
 *
 * 编辑器已启动则返回 true，无可用编辑器则返回 false。
 */
export function openFileInExternalEditor(
  filePath: string,
  line?: number,
): boolean {
  const editor = getExternalEditor()
  if (!editor) return false

  // 派生用户的真实二进制（保留 code-insiders、绝对路径等）。
  // 拆分为二进制 + 额外参数，使多词值（如 'start /wait
  // notepad' 或 'code --wait'）把所有 token 传给 spawn。
  const parts = editor.split(' ')
  const base = parts[0] ?? editor
  const editorArgs = parts.slice(1)
  const guiFamily = classifyGuiEditor(editor)

  if (guiFamily) {
    const gotoArgv = guiGotoArgv(guiFamily, filePath, line)
    const detachedOpts: SpawnOptions = { detached: true, stdio: 'ignore' }
    let child
    if (process.platform === 'win32') {
      // win32 上使用 shell: true，使 code.cmd / cursor.cmd / windsurf.cmd
      // 能解析——CreateProcess 无法直接执行 .cmd/.bat。拼装带引号的命令
      // 字符串；cmd.exe 不会展开双引号内的 $() 或反引号。
      // 给每个参数加引号，使带空格的路径能在 shell 拼接中存活。
      const gotoStr = gotoArgv.map(a => `"${a}"`).join(' ')
      child = spawn(`${editor} ${gotoStr}`, { ...detachedOpts, shell: true })
    } else {
      // POSIX：无 shell 的 argv 数组——注入安全。shell: true 会
      // 展开双引号内的 $() / 反引号，且 filePath 来自文件系统
      // （恶意仓库文件名可能导致 RCE）。
      child = spawn(base, [...editorArgs, ...gotoArgv], detachedOpts)
    }
    // spawn() 异步地发出 ENOENT。$VISUAL/$EDITOR 上的 ENOENT 属于
    // 用户配置错误，而非内部缺陷——不要污染错误遥测。
    child.on('error', e =>
      logForDebugging(`editor spawn failed: ${e}`, { level: 'error' }),
    )
    child.unref()
    return true
  }

  // 终端编辑器——需要备用屏幕切换，因为它接管了终端。阻塞直到编辑器退出。
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) return false
  // 仅对已知支持它的编辑器前置 +N——notepad 把 +42 当作要打开的文件名。
  // 测试 basename，使 /home/vim/bin/kak 不会经由目录段匹配 'vim'。
  const useGotoLine = line && PLUS_N_EDITORS.test(basename(base))
  inkInstance.enterAlternateScreen()
  try {
    const syncOpts: SpawnSyncOptions = { stdio: 'inherit' }
    let result
    if (process.platform === 'win32') {
      // Windows 上使用 shell: true，使 `start` 等 cmd.exe 内建命令能解析。
      // shell: true 会以不带引号的方式拼接参数，因此我们自己用显式引号
      // 拼装命令字符串（与 promptEditor.ts:74 一致）。spawnSync
      // 通过 .error 而不通过抛异常返回错误。
      const lineArg = useGotoLine ? `+${line} ` : ''
      result = spawnSync(`${editor} ${lineArg}"${filePath}"`, {
        ...syncOpts,
        shell: true,
      })
    } else {
      // POSIX：直接派生（无 shell），argv 数组是引号安全的。
      const args = [
        ...editorArgs,
        ...(useGotoLine ? [`+${line}`, filePath] : [filePath]),
      ]
      result = spawnSync(base, args, syncOpts)
    }
    if (result.error) {
      logForDebugging(`editor spawn failed: ${result.error}`, {
        level: 'error',
      })
      return false
    }
    return true
  } finally {
    inkInstance.exitAlternateScreen()
  }
}

export const getExternalEditor = memoize((): string | undefined => {
  // 环境变量优先
  if (process.env.VISUAL?.trim()) {
    return process.env.VISUAL.trim()
  }

  if (process.env.EDITOR?.trim()) {
    return process.env.EDITOR.trim()
  }

  // `isCommandAvailable` 会在 Windows 上破坏 limkenion 进程的 stdin；
  // 作为权宜之计，我们跳过它
  if (process.platform === 'win32') {
    return 'start /wait notepad'
  }

  // 按偏好顺序搜索可用的编辑器
  const editors = ['code', 'vi', 'nano']
  return editors.find(command => isCommandAvailable(command))
})
