/**
 * 路径解析与沙箱校验（被 tools / config / workspace 共用，因此单独成模块避免循环依赖）。
 */

import { isAbsolute, join, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * 定位 CLI 源码根，按优先级取第一个含 commands/ 的候选：
 *   1. LIMKENION_CLI_ROOT —— 显式指定
 *   2. 包内相对位置 —— web/ 位于 CLI 仓库内（源码模式）
 *   3. 进程工作目录 —— 全局安装后在任意项目里启动
 * 全局安装时包内相对位置会落在 node_modules/ 下，因此必须回退到工作目录。
 */
function detectCliRoot() {
  const fallback = process.cwd()
  const candidates = [
    process.env.LIMKENION_CLI_ROOT,
    join(import.meta.dirname, '..', '..'),
    fallback,
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (existsSync(join(c, 'commands'))) return resolve(c)
    } catch { /* 候选目录不可访问则跳过 */ }
  }
  return resolve(fallback)
}

/** CLI 源码根：命令注册表扫描、/agents 等镜像功能的来源目录。 */
export const CLI_ROOT = detectCliRoot()

/** 文件工具沙箱根：显式环境变量 > CLI 源码根。 */
export const WORKSPACE_ROOT = resolve(process.env.LIMKENION_WEB_WORKSPACE ?? CLI_ROOT)

/** POSIX 风格路径（前端与工具输出统一用正斜杠）。 */
export function toPosix(p) {
  return p.split('\\').join('/')
}

/** 相对工作区的 POSIX 路径。 */
export function relToWorkspace(p) {
  return toPosix(relative(WORKSPACE_ROOT, p))
}

/** 判断绝对路径是否落在沙箱内。 */
export function isInsideWorkspace(abs) {
  const rel = relative(WORKSPACE_ROOT, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 解析并校验路径必须在沙箱内；返回绝对路径。
 *
 * 除常规越界外，额外拦两类 Windows 陷阱：
 *   - 盘符相对路径（`C:foo`）—— `isAbsolute` 为 false，但 `resolve` 会跳到该盘根；
 *   - 设备名（CON/NUL/COM1…）与备用数据流（`file.txt:stream`）。
 */
export function safePath(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw new Error('路径不能为空')
  }
  const raw = inputPath.trim()

  if (/^[a-zA-Z]:[^\\/]/.test(raw)) {
    throw new Error(`盘符相对路径不被允许（会跳出沙箱）：${inputPath}`)
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) && !isAbsolute(raw)) {
    throw new Error(`无法解析的盘符路径：${inputPath}`)
  }

  const abs = isAbsolute(raw) ? resolve(raw) : resolve(WORKSPACE_ROOT, raw)
  if (!isInsideWorkspace(abs)) {
    throw new Error(`路径越界（沙箱：${WORKSPACE_ROOT}）：${inputPath}`)
  }

  // Windows 保留设备名
  const base = abs.split(/[\\/]/).pop() ?? ''
  const stem = base.split('.')[0].toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new Error(`路径指向 Windows 保留设备名：${inputPath}`)
  }
  // NTFS 备用数据流
  if (/^[^\\/]*:[^\\/]+$/.test(base) && !/^[a-zA-Z]:$/.test(base)) {
    throw new Error(`不允许访问备用数据流（ADS）：${inputPath}`)
  }

  return abs
}
