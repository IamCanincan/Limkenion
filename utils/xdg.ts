/**
 * 用于 Limkenion CLI 原生安装器的 XDG 基础目录工具
 *
 * 实现 XDG Base Directory 规范，将原生安装器组件组织到合适的系统目录中。
 *
 * @see https://specifications.freedesktop.org/basedir-spec/latest/
 */

import { homedir as osHomedir } from 'os'
import { join } from 'path'

type EnvLike = Record<string, string | undefined>

type XDGOptions = {
  env?: EnvLike
  homedir?: string
}

function resolveOptions(options?: XDGOptions): { env: EnvLike; home: string } {
  return {
    env: options?.env ?? process.env,
    home: options?.homedir ?? process.env.HOME ?? osHomedir(),
  }
}

/**
 * 获取 XDG state home 目录
 * 默认：~/.local/state
 * @param options 用于测试的可选 env 和 homedir 覆盖
 */
export function getXDGStateHome(options?: XDGOptions): string {
  const { env, home } = resolveOptions(options)
  return env.XDG_STATE_HOME ?? join(home, '.local', 'state')
}

/**
 * 获取 XDG cache home 目录
 * 默认：~/.cache
 * @param options 用于测试的可选 env 和 homedir 覆盖
 */
export function getXDGCacheHome(options?: XDGOptions): string {
  const { env, home } = resolveOptions(options)
  return env.XDG_CACHE_HOME ?? join(home, '.cache')
}

/**
 * 获取 XDG data home 目录
 * 默认：~/.local/share
 * @param options 用于测试的可选 env 和 homedir 覆盖
 */
export function getXDGDataHome(options?: XDGOptions): string {
  const { env, home } = resolveOptions(options)
  return env.XDG_DATA_HOME ?? join(home, '.local', 'share')
}

/**
 * 获取用户 bin 目录（严格说不是 XDG，但遵循相同约定）
 * 默认：~/.local/bin
 * @param options 用于测试的可选 homedir 覆盖
 */
export function getUserBinDir(options?: XDGOptions): string {
  const { home } = resolveOptions(options)
  return join(home, '.local', 'bin')
}
