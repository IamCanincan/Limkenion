/**
 * Computer Use：截屏 + 键鼠控制（Windows，零依赖）。
 *
 * 实现路径：系统自带的 PowerShell + .NET——
 *   - 截屏：System.Drawing CopyFromScreen（缩放到最大宽 1280 控制 token 消耗）；
 *   - 鼠标：user32 SetCursorPos / mouse_event（P/Invoke 内联）；
 *   - 键盘：SendInput KEYEVENTF_UNICODE（支持中文），修饰键组合用 VK 按住-轻点-放开。
 *
 * 安全边界（别放松）：
 *   - 总开关 LIMKENION_WEB_COMPUTER_USE=1，默认关闭；
 *   - 非 Windows 平台一律不可用；
 *   - 三个动作都在 DANGEROUS_TOOLS 里，每次走权限确认；不可信内容触达时升级确认。
 *
 * 局限（如实）：高 DPI 多屏下坐标可能有偏移；拖拽等精细操作不如人手；
 * 非交互式会话（服务）里截屏可能失败或得到黑屏——此时如实报错。
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function computerUseEnabled() {
  return process.env.LIMKENION_WEB_COMPUTER_USE === '1'
}

export function computerAvailable() {
  return computerUseEnabled() && process.platform === 'win32'
}

/** 跑一段 PowerShell（超时保护 + 输出捕获）。 */
function runPs(script, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message || err)))
        else resolve(String(stdout))
      },
    )
  })
}

/** 截取虚拟屏幕，缩放到 maxWidth，返回 data URL（PNG）。 */
export async function screenshot({ maxWidth = 1280 } = {}) {
  if (!computerAvailable()) {
    throw new Error(
      process.platform !== 'win32'
        ? 'Computer Use 仅在 Windows 上可用（当前平台：' + process.platform + '）'
        : 'Computer Use 未启用（需设置环境变量 LIMKENION_WEB_COMPUTER_USE=1）',
    )
  }
  const out = join(tmpdir(), `lk-screen-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  const outPs = out.replace(/\\/g, '\\\\')
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    "if ($vs.Width -le 0 -or $vs.Height -le 0) { throw '未检测到可用的显示会话（当前进程可能不在交互桌面上）' }",
    '$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)',
    // 注意 [Math]::Min(1, 0.39) 会选中 int 重载把 0.39 截成 0 —— 必须写 1.0 走 double 重载
    `$scale = [Math]::Min(1.0, ${maxWidth} / [double]$vs.Width)`,
    '$w = [int]($vs.Width * $scale)',
    '$h = [int]($vs.Height * $scale)',
    '$small = New-Object System.Drawing.Bitmap $w, $h',
    '$g2 = [System.Drawing.Graphics]::FromImage($small)',
    '$g2.DrawImage($bmp, 0, 0, $w, $h)',
    `$small.Save('${outPs}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    'Write-Output "$w x $h"',
  ].join('\n')
  // 临时 PNG 必须**无论如何**都删掉：原先 rm 写在 readFile 之后，一旦 runPs 或
  // readFile 抛错（无显示会话、脚本失败、文件被锁…），那行就永远执行不到，
  // 截图的临时文件会在 tmpdir 里越堆越多（Computer Use 会反复截图）。
  try {
    const sizeOut = (await runPs(ps)).trim()
    const b64 = (await readFile(out)).toString('base64')
    return { dataUrl: `data:image/png;base64,${b64}`, size: sizeOut }
  } finally {
    await rm(out, { force: true }).catch(() => {})
  }
}

/** 内联 C#：鼠标（user32）+ 键盘（SendInput UNICODE，支持中文）。 */
const INPUT_HELPERS = [
  "Add-Type -TypeDefinition @'\n" +
    'using System;\n' +
    'using System.Runtime.InteropServices;\n' +
    'public class LkIn {\n' +
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);\n' +
    '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);\n' +
    '  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int size);\n' +
    '  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }\n' +
    '  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }\n' +
    '  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }\n' +
    '  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }\n' +
    '  public const uint KEYEVENTF_UNICODE = 0x0004;\n' +
    '  public const uint KEYEVENTF_KEYUP = 0x0002;\n' +
    '  public static uint SendChar(char c, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.wScan = c; i.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0); return SendInput(1, new INPUT[]{i}, Marshal.SizeOf(typeof(INPUT))); }\n' +
    '  public static uint SendVk(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0; return SendInput(1, new INPUT[]{i}, Marshal.SizeOf(typeof(INPUT))); }\n' +
    '}',
    "'@",
  ].join('\n')

const VK = {
  enter: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, delete: 0x2e,
  space: 0x20, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, win: 0x5b, ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10,
}

/** 键鼠控制。action ∈ move|click|doubleClick|rightClick|scroll|type|press。 */
export async function control(input = {}) {
  if (!computerAvailable()) {
    throw new Error(
      process.platform !== 'win32'
        ? 'Computer Use 仅在 Windows 上可用（当前平台：' + process.platform + '）'
        : 'Computer Use 未启用（需设置环境变量 LIMKENION_WEB_COMPUTER_USE=1）',
    )
  }
  const action = String(input.action ?? '')
  const typeBlock = INPUT_HELPERS
  if (action === 'move' || action === 'click' || action === 'doubleClick' || action === 'rightClick') {
    const x = Number(input.x)
    const y = Number(input.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('move/click 需要 x、y 坐标（虚拟屏幕像素）')
    const clickPart =
      action === 'move'
        ? ''
        : action === 'click'
          ? '[LkIn]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [LkIn]::mouse_event(4,0,0,0,[UIntPtr]::Zero)'
          : action === 'doubleClick'
            ? '1..2 | ForEach-Object { [LkIn]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [LkIn]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }'
            : '[LkIn]::mouse_event(8,0,0,0,[UIntPtr]::Zero); [LkIn]::mouse_event(16,0,0,0,[UIntPtr]::Zero)'
    const ps = [
      typeBlock,
      `[LkIn]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`,
      'Start-Sleep -Milliseconds 40',
      clickPart,
    ].join('\n')
    await runPs(ps)
    return `已${action === 'move' ? '移动光标' : action === 'click' ? '左键单击' : action === 'doubleClick' ? '双击' : '右键单击'}到 (${Math.round(x)}, ${Math.round(y)})`
  }
  if (action === 'scroll') {
    const amount = Number(input.amount ?? 3)
    if (!Number.isFinite(amount) || amount === 0) throw new Error('scroll 需要 amount（正数向上、负数向下）')
    const ps = [
      typeBlock,
      `[LkIn]::mouse_event(0x0800, 0, 0, ${Math.round(amount) * 120}, [UIntPtr]::Zero)`,
    ].join('\n')
    await runPs(ps)
    return `已滚动 ${amount}`
  }
  if (action === 'type') {
    const text = String(input.text ?? '')
    if (!text) throw new Error('type 需要 text')
    const inFile = join(tmpdir(), `lk-type-${Date.now()}.txt`)
    await writeFile(inFile, text, 'utf8')
    const inPs = inFile.replace(/\\/g, '\\\\')
    const ps = [
      typeBlock,
      `$text = [IO.File]::ReadAllText('${inPs}', [Text.Encoding]::UTF8)`,
      'foreach ($ch in $text.ToCharArray()) { [LkIn]::SendChar($ch, $false) | Out-Null; [LkIn]::SendChar($ch, $true) | Out-Null }',
    ].join('\n')
    try {
      await runPs(ps, 60_000)
    } finally {
      await rm(inFile, { force: true }).catch(() => {})
    }
    return `已输入 ${text.length} 个字符`
  }
  if (action === 'press') {
    const combo = String(input.key ?? '').trim().toLowerCase()
    if (!combo) throw new Error('press 需要 key，例如 {"key": "enter"} 或 {"key": "ctrl+s"}')
    const parts = combo.split('+').map(k => {
      if (VK[k]) return { vk: VK[k], mod: false }
      if (/^f([1-9]|1[0-2])$/.test(k)) return { vk: 0x70 + Number(k.slice(1)) - 1, mod: false }
      if (k.length === 1) return { vk: k.toUpperCase().charCodeAt(0), mod: false }
      throw new Error(`不支持的按键：${k}`)
    })
    const mods = parts.slice(0, -1).filter(p => p.mod)
    const last = parts[parts.length - 1]
    const ps = [
      typeBlock,
      ...mods.map(m => `[LkIn]::SendVk(${m.vk}, $false) | Out-Null`),
      `[LkIn]::SendVk(${last.vk}, $false) | Out-Null`,
      `[LkIn]::SendVk(${last.vk}, $true) | Out-Null`,
      ...mods.reverse().map(m => `[LkIn]::SendVk(${m.vk}, $true) | Out-Null`),
    ].join('\n')
    await runPs(ps)
    return `已按下 ${combo}`
  }
  throw new Error(`不支持的 action：${action}（可选 move/click/doubleClick/rightClick/scroll/type/press）`)
}
