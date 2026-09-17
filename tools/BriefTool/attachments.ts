/**
 * SendUserMessage 与 SendUserFile 共用的附件校验与解析逻辑。放在
 * BriefTool/ 目录下，使 feature('BRIDGE_MODE') 守卫内的动态 `./upload.js`
 * 导入保持相对路径，同时让 upload.ts（axios、crypto、认证工具）可以在
 * 非 bridge 构建中通过 tree-shaking 移除。
 */

import { feature } from 'bun:bundle'
import { stat } from 'fs/promises'

import type { ValidationResult } from '../../Tool.js'

import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { IMAGE_EXTENSION_REGEX } from '../../utils/imagePaste.js'
import { expandPath } from '../../utils/path.js'

export type ResolvedAttachment = {
  path: string
  size: number
  isImage: boolean
  file_uuid?: string
}

export async function validateAttachmentPaths(
  rawPaths: string[],
): Promise<ValidationResult> {
  const cwd = getCwd()
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    try {
      const stats = await stat(fullPath)
      if (!stats.isFile()) {
        return {
          result: false,
          message: `附件 "${rawPath}" 不是普通文件。`,
          errorCode: 1,
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return {
          result: false,
          message: `附件 "${rawPath}" 不存在。当前工作目录：${cwd}。`,
          errorCode: 1,
        }
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          result: false,
          message: `附件 "${rawPath}" 无法访问（权限被拒绝）。`,
          errorCode: 1,
        }
      }
      throw e
    }
  }
  return { result: true }
}

export async function resolveAttachments(
  rawPaths: string[],
  uploadCtx: { replBridgeEnabled: boolean; signal?: AbortSignal },
): Promise<ResolvedAttachment[]> {
  // 逐个（本地、快速）stat 以保证顺序确定，随后并行上传（网络、较慢）。
  // 上传失败会解析为 undefined——附件仍携带 {path, size, isImage} 供本地渲染。
  const stated: ResolvedAttachment[] = []
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    // 单次 stat——我们需要 size，这是实际执行的操作，而非守卫。
    // validateInput 比我们更早运行，但文件可能已被移动过（TOCTOU）；
    // 如果确实发生了移动，就让错误向上传播，使模型能看到它。
    const stats = await stat(fullPath)
    stated.push({
      path: fullPath,
      size: stats.size,
      isImage: IMAGE_EXTENSION_REGEX.test(fullPath),
    })
  }
  // 在 feature() 守卫内动态导入，使 upload.ts（axios、crypto、zod、
  // 认证工具、MIME 映射）在非 BRIDGE_MODE 构建中被彻底移除。静态导入会
  // 无视 uploadBriefAttachment 内部守卫而强制执行模块作用域求值——
  // LIMKENION.md："在函数外部定义的辅助函数即使从未被调用也仍保留在构建中"。
  if (feature('BRIDGE_MODE')) {
    // 无头/SDK 调用方从不设置 appState.replBridgeEnabled（只有 TTY REPL
    // 在 main.tsx 初始化时设置）。LIMKENION_BRIEF_UPLOAD 允许把 CLI 作为
    // 子进程运行的主机选择加入——例如 cowork 桌面 bridge，它已经传入
    // LIMKENION_OAUTH_TOKEN 用于认证。
    const shouldUpload =
      uploadCtx.replBridgeEnabled ||
      isEnvTruthy(process.env.LIMKENION_BRIEF_UPLOAD)
    const { uploadBriefAttachment } = await import('./upload.js')
    const uuids = await Promise.all(
      stated.map(a =>
        uploadBriefAttachment(a.path, a.size, {
          replBridgeEnabled: shouldUpload,
          signal: uploadCtx.signal,
        }),
      ),
    )
    return stated.map((a, i) =>
      uuids[i] === undefined ? a : { ...a, file_uuid: uuids[i] },
    )
  }
  return stated
}
