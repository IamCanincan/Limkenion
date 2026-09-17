import chalk from 'chalk'
import { stat } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { ToolPermissionContext } from '../../Tool.js'
import { getErrnoCode } from '../../utils/errors.js'
import { expandPath } from '../../utils/path.js'
import {
  allWorkingDirectories,
  pathInWorkingPath,
} from '../../utils/permissions/filesystem.js'

export type AddDirectoryResult =
  | {
      resultType: 'success'
      absolutePath: string
    }
  | {
      resultType: 'emptyPath'
    }
  | {
      resultType: 'pathNotFound' | 'notADirectory'
      directoryPath: string
      absolutePath: string
    }
  | {
      resultType: 'alreadyInWorkingDirectory'
      directoryPath: string
      workingDir: string
    }

export async function validateDirectoryForWorkspace(
  directoryPath: string,
  permissionContext: ToolPermissionContext,
): Promise<AddDirectoryResult> {
  if (!directoryPath) {
    return {
      resultType: 'emptyPath',
    }
  }

  // resolve() 会去掉 expandPath 在绝对输入上可能留下的尾随斜杠，
  // 因此 /foo 与 /foo/ 映射到同一个存储键（CC-33）。
  const absolutePath = resolve(expandPath(directoryPath))

  // 检查路径是否存在且为目录（单次系统调用）
  try {
    const stats = await stat(absolutePath)
    if (!stats.isDirectory()) {
      return {
        resultType: 'notADirectory',
        directoryPath,
        absolutePath,
      }
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    // 匹配先前的 existsSync() 语义：将以下任一情况视为"未找到"
    // 而非重新抛出。特别是 EACCES/EPERM 不能在所配置的附加目录
    // 不可访问时使启动崩溃。
    if (
      code === 'ENOENT' ||
      code === 'ENOTDIR' ||
      code === 'EACCES' ||
      code === 'EPERM'
    ) {
      return {
        resultType: 'pathNotFound',
        directoryPath,
        absolutePath,
      }
    }
    throw e
  }

  // 获取当前权限上下文
  const currentWorkingDirs = allWorkingDirectories(permissionContext)

  // 检查是否已处于某个既有工作目录之内
  for (const workingDir of currentWorkingDirs) {
    if (pathInWorkingPath(absolutePath, workingDir)) {
      return {
        resultType: 'alreadyInWorkingDirectory',
        directoryPath,
        workingDir,
      }
    }
  }

  return {
    resultType: 'success',
    absolutePath,
  }
}

export function addDirHelpMessage(result: AddDirectoryResult): string {
  switch (result.resultType) {
    case 'emptyPath':
      return '请提供一个目录路径。'
    case 'pathNotFound':
      return `路径 ${chalk.bold(result.absolutePath)} 未找到。`
    case 'notADirectory': {
      const parentDir = dirname(result.absolutePath)
      return `${chalk.bold(result.directoryPath)} 不是目录。你是想添加父目录 ${chalk.bold(parentDir)} 吗？`
    }
    case 'alreadyInWorkingDirectory':
      return `${chalk.bold(result.directoryPath)} 已可在现有工作目录 ${chalk.bold(result.workingDir)} 内访问。`
    case 'success':
      return `已将 ${chalk.bold(result.absolutePath)} 添加为工作目录。`
  }
}
