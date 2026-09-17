import { join, normalize, sep } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import {
  buildMemoryPrompt,
  ensureMemoryDirExists,
} from '../../memdir/memdir.js'
import { getMemoryBaseDir } from '../../memdir/paths.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { sanitizePath } from '../../utils/path.js'

// 持久化代理记忆的作用域：'user'（~/.limkenion/agent-memory/）、'project'（.limkenion/agent-memory/）或 'local'（.limkenion/agent-memory-local/）
export type AgentMemoryScope = 'user' | 'project' | 'local'

/**
 * 净化代理类型名以用作目录名。
 * 将冒号（在 Windows 上无效，用于插件命名空间的代理类型，如
 * "my-plugin:my-agent"）替换为破折号。
 */
function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-')
}

/**
 * 返回本地代理记忆目录，它随项目而异且不纳入版本控制。
 * 当设置了 LIMKENION_REMOTE_MEMORY_DIR 时，持久化到带项目命名空间的挂载点。
 * 否则，使用 <cwd>/.limkenion/agent-memory-local/<agentType>/。
 */
function getLocalAgentMemoryDir(dirName: string): string {
  if (process.env.LIMKENION_REMOTE_MEMORY_DIR) {
    return (
      join(
        process.env.LIMKENION_REMOTE_MEMORY_DIR,
        'projects',
        sanitizePath(
          findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot(),
        ),
        'agent-memory-local',
        dirName,
      ) + sep
    )
  }
  return join(getCwd(), '.limkenion', 'agent-memory-local', dirName) + sep
}

/**
 * 返回给定代理类型与作用域的代理记忆目录。
 * - 'user' 作用域：<memoryBase>/agent-memory/<agentType>/
 * - 'project' 作用域：<cwd>/.limkenion/agent-memory/<agentType>/
 * - 'local' 作用域：见 getLocalAgentMemoryDir()
 */
export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  const dirName = sanitizeAgentTypeForPath(agentType)
  switch (scope) {
    case 'project':
      return join(getCwd(), '.limkenion', 'agent-memory', dirName) + sep
    case 'local':
      return getLocalAgentMemoryDir(dirName)
    case 'user':
      return join(getMemoryBaseDir(), 'agent-memory', dirName) + sep
  }
}

// 检查文件是否位于代理记忆目录内（任意作用域）。
export function isAgentMemoryPath(absolutePath: string): boolean {
  // SECURITY: 归一化以防通过 .. 段的路径穿越绕过
  const normalizedPath = normalize(absolutePath)
  const memoryBase = getMemoryBaseDir()

  // 用户作用域：检查记忆基础目录（可能是自定义目录或配置主目录）
  if (normalizedPath.startsWith(join(memoryBase, 'agent-memory') + sep)) {
    return true
  }

  // 项目作用域：始终基于 cwd（不被重定向）
  if (
    normalizedPath.startsWith(join(getCwd(), '.limkenion', 'agent-memory') + sep)
  ) {
    return true
  }

  // 本地作用域：当设置了 LIMKENION_REMOTE_MEMORY_DIR 时持久化到挂载点，否则基于 cwd
  if (process.env.LIMKENION_REMOTE_MEMORY_DIR) {
    if (
      normalizedPath.includes(sep + 'agent-memory-local' + sep) &&
      normalizedPath.startsWith(
        join(process.env.LIMKENION_REMOTE_MEMORY_DIR, 'projects') + sep,
      )
    ) {
      return true
    }
  } else if (
    normalizedPath.startsWith(
      join(getCwd(), '.limkenion', 'agent-memory-local') + sep,
    )
  ) {
    return true
  }

  return false
}


export function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
): string {
  switch (memory) {
    case 'user':
      return `用户（${join(getMemoryBaseDir(), 'agent-memory')}/）`
    case 'project':
      return '项目（.limkenion/agent-memory/）'
    case 'local':
      return `本地（${getLocalAgentMemoryDir('...')}）`
    default:
      return '无'
  }
}

/**
 * 为启用记忆的代理加载持久化记忆。
 * 必要时创建记忆目录，并返回包含记忆内容的提示词。
 *
 * @param agentType 代理的类型名（用作目录名）
 * @param scope 'user' 对应 ~/.limkenion/agent-memory/，或 'project' 对应 .limkenion/agent-memory/
 */
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  let scopeNote: string
  switch (scope) {
    case 'user':
      scopeNote =
        '- 由于此记忆是用户作用域，记忆应保持通用，因为它们适用于所有项目'
      break
    case 'project':
      scopeNote =
        '- 由于此记忆是项目作用域且经由版本控制与团队共享，请将记忆针对此项目定制'
      break
    case 'local':
      scopeNote =
        '- 由于此记忆是本地作用域（不纳入版本控制），请将记忆针对此项目与机器定制'
      break
  }

  const memoryDir = getAgentMemoryDir(agentType, scope)

  // 即发即忘：这在代理派生时于同步的 getSystemPrompt() 回调内运行
  //（由 AgentDetail.tsx 中的 React 渲染调用，因此不能是异步的）。
  // 派生的代理直到一次完整 API 往返之后才会尝试 Write，届时 mkdir
  // 应已完成。即便尚未完成，FileWriteTool 也会自行 mkdir 父目录。
  void ensureMemoryDirExists(memoryDir)

  const coworkExtraGuidelines =
    process.env.LIMKENION_COWORK_MEMORY_EXTRA_GUIDELINES
  return buildMemoryPrompt({
    displayName: '持久化代理记忆',
    memoryDir,
    extraGuidelines:
      coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
        ? [scopeNote, coworkExtraGuidelines]
        : [scopeNote],
  })
}
