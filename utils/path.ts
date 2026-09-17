import { homedir } from 'os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'path'
import { getCwd } from './cwd.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { posixPathToWindowsPath } from './windowsPaths.js'

/**
 * 把可能包含波浪号（~）记法的路径展开为绝对路径。
 *
 * 在 Windows 上，POSIX 风格路径（例如 `/c/Users/...`）会被自动转换
 * 为 Windows 格式（例如 `C:\Users\...`）。该函数始终返回当前平台
 * 的原生格式路径。
 *
 * @param path - 要展开的路径，可能包含：
 *   - `~` - 展开为用户主目录
 *   - `~/path` - 展开为用户主目录下的路径
 *   - 绝对路径 - 返回归一化后的结果
 *   - 相对路径 - 相对 baseDir 解析
 *   - Windows 上的 POSIX 路径 - 转换为 Windows 格式
 * @param baseDir - 用于解析相对路径的基准目录（默认为当前工作目录）
 * @returns 当前平台原生格式下的展开绝对路径
 *
 * @throws {Error} 若路径无效
 *
 * @example
 * expandPath('~') // '/home/user'
 * expandPath('~/Documents') // '/home/user/Documents'
 * expandPath('./src', '/project') // '/project/src'
 * expandPath('/absolute/path') // '/absolute/path'
 */
export function expandPath(path: string, baseDir?: string): string {
  // 若未提供 baseDir，则默认用 getCwd()
  const actualBaseDir = baseDir ?? getCwd() ?? getFsImplementation().cwd()

  // 输入校验
  if (typeof path !== 'string') {
    throw new TypeError(`路径必须是字符串，却收到 ${typeof path}`)
  }

  if (typeof actualBaseDir !== 'string') {
    throw new TypeError(
      `基准目录必须是字符串，却收到 ${typeof actualBaseDir}`,
    )
  }

  // 安全：检查空字节
  if (path.includes('\0') || actualBaseDir.includes('\0')) {
    throw new Error('路径包含空字节')
  }

  // 处理空路径或纯空白路径
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return normalize(actualBaseDir).normalize('NFC')
  }

  // 处理主目录记法
  if (trimmedPath === '~') {
    return homedir().normalize('NFC')
  }

  if (trimmedPath.startsWith('~/')) {
    return join(homedir(), trimmedPath.slice(2)).normalize('NFC')
  }

  // 在 Windows 上，把 POSIX 风格路径（例如 /c/Users/...）转换为 Windows 格式
  let processedPath = trimmedPath
  if (getPlatform() === 'windows' && trimmedPath.match(/^\/[a-z]\//i)) {
    try {
      processedPath = posixPathToWindowsPath(trimmedPath)
    } catch {
      // 若转换失败，使用原始路径
      processedPath = trimmedPath
    }
  }

  // 处理绝对路径
  if (isAbsolute(processedPath)) {
    return normalize(processedPath).normalize('NFC')
  }

  // 处理相对路径
  return resolve(actualBaseDir, processedPath).normalize('NFC')
}

/**
 * 把绝对路径转换为相对 cwd 的路径，以节省工具输出中的 token。
 * 若路径在 cwd 之外（相对路径会以 .. 开头），
 * 则原样返回绝对路径，使其保持不含歧义。
 *
 * @param absolutePath - 要相对化的绝对路径
 * @returns 若在 cwd 之内则返回相对路径，否则返回原绝对路径
 */
export function toRelativePath(absolutePath: string): string {
  const relativePath = relative(getCwd(), absolutePath)
  // 若相对路径会跑到 cwd 之外（以 .. 开头），保持绝对
  return relativePath.startsWith('..') ? absolutePath : relativePath
}

/**
 * 获取给定文件或目录路径的目录路径。
 * 若路径是目录，返回其本身。
 * 若路径是文件或不存在，返回其父目录。
 *
 * @param path - 文件或目录路径
 * @returns 目录路径
 */
export function getDirectoryForPath(path: string): string {
  const absolutePath = expandPath(path)
  // 安全：对 UNC 路径跳过文件系统操作，防止 NTLM 凭据泄漏。
  if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
    return dirname(absolutePath)
  }
  try {
    const stats = getFsImplementation().statSync(absolutePath)
    if (stats.isDirectory()) {
      return absolutePath
    }
  } catch {
    // 路径不存在或无法访问
  }
  // 若它不是目录或不存在，返回父目录
  return dirname(absolutePath)
}

/**
 * 检查路径是否包含导航到父目录的目录穿越模式。
 *
 * @param path - 要检查穿越模式的路径
 * @returns 若路径包含穿越（例如 '../'、'..\' 或以 '..' 结尾）则返回 true
 */
export function containsPathTraversal(path: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)
}

// 从共享的零依赖源重新导出。
export { sanitizePath } from './sessionStoragePortable.js'

/**
 * 归一化路径以用作 JSON 配置键。
 * 在 Windows 上，路径可能带不一致的分隔符（C:\path vs C:/path），
 * 取决于它们来自 git、Node.js API 还是用户输入。
 * 这里归一化为正斜杠，以获得一致的 JSON 序列化。
 *
 * @param path - 要归一化的路径
 * @returns 带一致正斜杠的归一化路径
 */
export function normalizePathForConfigKey(path: string): string {
  // 先用 Node 的 normalize 解析 . 和 .. 段
  const normalized = normalize(path)
  // 然后把所有反斜杠转换为正斜杠，以获得一致的 JSON 键
  // 这很安全，因为正斜杠在 Windows 路径中对大多数操作都可工作
  return normalized.replace(/\\/g, '/')
}
