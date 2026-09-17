import { createHash, randomUUID, type UUID } from 'crypto'
import { stat } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type {
  AttributionSnapshotMessage,
  FileAttributionState,
} from '../types/logs.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { isGeneratedFile } from './generatedFiles.js'
import { getRemoteUrlForDir, resolveGitDir } from './git/gitFilesystem.js'
import { findGitRoot, gitExe } from './git.js'
import { logError } from './log.js'
import { getCanonicalName, type ModelName } from './model/model.js'
import { sequential } from './sequential.js'

/**
 * List of repos where internal model names are allowed in trailers.
 * Includes both SSH and HTTPS URL formats.
 *
 * NOTE: This is intentionally a repo allowlist, not an org-wide check.
 * The limkenions and limkenion-experimental orgs contain PUBLIC repos
 * (e.g. limkenions/limkenion, limkenion-experimental/sandbox-runtime).
 * Undercover mode must stay ON in those to prevent codename leaks.
 * Only add repos here that are confirmed PRIVATE.
 */
const INTERNAL_MODEL_REPOS = [
  'github.com:limkenions/limkenion-cli-internal',
  'github.com/limkenions/limkenion-cli-internal',
  'github.com:limkenions/limkenion',
  'github.com/limkenions/limkenion',
  'github.com:limkenions/apps',
  'github.com/limkenions/apps',
  'github.com:limkenions/casino',
  'github.com/limkenions/casino',
  'github.com:limkenions/dbt',
  'github.com/limkenions/dbt',
  'github.com:limkenions/dotfiles',
  'github.com/limkenions/dotfiles',
  'github.com:limkenions/terraform-config',
  'github.com/limkenions/terraform-config',
  'github.com:limkenions/hex-export',
  'github.com/limkenions/hex-export',
  'github.com:limkenions/feedback-v2',
  'github.com/limkenions/feedback-v2',
  'github.com:limkenions/labs',
  'github.com/limkenions/labs',
  'github.com:limkenions/argo-rollouts',
  'github.com/limkenions/argo-rollouts',
  'github.com:limkenions/starling-configs',
  'github.com/limkenions/starling-configs',
  'github.com:limkenions/ts-tools',
  'github.com/limkenions/ts-tools',
  'github.com:limkenions/ts-capsules',
  'github.com/limkenions/ts-capsules',
  'github.com:limkenions/feldspar-testing',
  'github.com/limkenions/feldspar-testing',
  'github.com:limkenions/trellis',
  'github.com/limkenions/trellis',
  'github.com:limkenions/limkenion-for-hiring',
  'github.com/limkenions/limkenion-for-hiring',
  'github.com:limkenions/forge-web',
  'github.com/limkenions/forge-web',
  'github.com:limkenions/infra-manifests',
  'github.com/limkenions/infra-manifests',
  'github.com:limkenions/mycro_manifests',
  'github.com/limkenions/mycro_manifests',
  'github.com:limkenions/mycro_configs',
  'github.com/limkenions/mycro_configs',
  'github.com:limkenions/mobile-apps',
  'github.com/limkenions/mobile-apps',
]

/**
 * Get the repo root for attribution operations.
 * Uses getCwd() which respects agent worktree overrides (AsyncLocalStorage),
 * then resolves to git root to handle `cd subdir` case.
 * Falls back to getOriginalCwd() if git root can't be determined.
 */
export function getAttributionRepoRoot(): string {
  const cwd = getCwd()
  return findGitRoot(cwd) ?? getOriginalCwd()
}

// Cache for repo classification result. Primed once per process.
// 'internal' = remote matches INTERNAL_MODEL_REPOS allowlist
// 'external' = has a remote, not on allowlist (public/open-source repo)
// 'none'     = no remote URL (not a git repo, or no remote configured)
let repoClassCache: 'internal' | 'external' | 'none' | null = null

/**
 * Synchronously return the cached repo classification.
 * Returns null if the async check hasn't run yet.
 */
export function getRepoClassCached(): 'internal' | 'external' | 'none' | null {
  return repoClassCache
}


/**
 * Check if the current repo is in the allowlist for internal model names.
 * Memoized - only checks once per process.
 */
export const isInternalModelRepo = sequential(async (): Promise<boolean> => {
  if (repoClassCache !== null) {
    return repoClassCache === 'internal'
  }

  const cwd = getAttributionRepoRoot()
  const remoteUrl = await getRemoteUrlForDir(cwd)

  if (!remoteUrl) {
    repoClassCache = 'none'
    return false
  }
  const isInternal = INTERNAL_MODEL_REPOS.some(repo => remoteUrl.includes(repo))
  repoClassCache = isInternal ? 'internal' : 'external'
  return isInternal
})


// @[MODEL LAUNCH]: 新增模型时在这里补一条映射，让 git 提交 trailer 显示公开模型名。
/**
 * 把内部模型名净化成公开名。
 * 本构建只有 DeepSeek 两个模型；原本那一长串上游模型名映射已移除。
 */
export function sanitizeModelName(shortName: string): string {
  if (shortName.includes('deepseek-v4-pro')) return 'deepseek-v4-pro'
  if (shortName.includes('deepseek-flash')) return 'deepseek-flash'
  // 未知模型给一个通用名，避免泄露内部代号
  return 'limkenion'
}

/**
 * Attribution state for tracking Limkenion's contributions to files.
 */
export type AttributionState = {
  // File states keyed by relative path (from cwd)
  fileStates: Map<string, FileAttributionState>
  // Session baseline states for net change calculation
  sessionBaselines: Map<string, { contentHash: string; mtime: number }>
  // Surface from which edits were made
  surface: string
  // HEAD SHA at session start (for detecting external commits)
  startingHeadSha: string | null
  // Total prompts in session (for steer count calculation)
  promptCount: number
  // Prompts at last commit (to calculate steers for current commit)
  promptCountAtLastCommit: number
  // Permission prompt tracking
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  // ESC press tracking (user cancelled permission prompt)
  escapeCount: number
  escapeCountAtLastCommit: number
}

/**
 * Summary of Limkenion's contribution for a commit.
 */
export type AttributionSummary = {
  limkenionPercent: number
  limkenionChars: number
  humanChars: number
  surfaces: string[]
}

/**
 * Per-file attribution details for git notes.
 */
export type FileAttribution = {
  limkenionChars: number
  humanChars: number
  percent: number
  surface: string
}

/**
 * Full attribution data for git notes JSON.
 */
export type AttributionData = {
  version: 1
  summary: AttributionSummary
  files: Record<string, FileAttribution>
  surfaceBreakdown: Record<string, { limkenionChars: number; percent: number }>
  excludedGenerated: string[]
  sessions: string[]
}

/**
 * Get the current client surface from environment.
 */
export function getClientSurface(): string {
  return process.env.LIMKENION_ENTRYPOINT ?? 'cli'
}


/**
 * Compute SHA-256 hash of content.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Normalize file path to relative path from cwd for consistent tracking.
 * Resolves symlinks to handle /tmp vs /private/tmp on macOS.
 */
export function normalizeFilePath(filePath: string): string {
  const fs = getFsImplementation()
  const cwd = getAttributionRepoRoot()

  if (!isAbsolute(filePath)) {
    return filePath
  }

  // Resolve symlinks in both paths for consistent comparison
  // (e.g., /tmp -> /private/tmp on macOS)
  let resolvedPath = filePath
  let resolvedCwd = cwd

  try {
    resolvedPath = fs.realpathSync(filePath)
  } catch {
    // File may not exist yet, use original path
  }

  try {
    resolvedCwd = fs.realpathSync(cwd)
  } catch {
    // Keep original cwd
  }

  if (
    resolvedPath.startsWith(resolvedCwd + sep) ||
    resolvedPath === resolvedCwd
  ) {
    // Normalize to forward slashes so keys match git diff output on Windows
    return relative(resolvedCwd, resolvedPath).replaceAll(sep, '/')
  }

  // Fallback: try original comparison
  if (filePath.startsWith(cwd + sep) || filePath === cwd) {
    return relative(cwd, filePath).replaceAll(sep, '/')
  }

  return filePath
}

/**
 * Expand a relative path to absolute path.
 */
export function expandFilePath(filePath: string): string {
  if (isAbsolute(filePath)) {
    return filePath
  }
  return join(getAttributionRepoRoot(), filePath)
}

/**
 * Create an empty attribution state for a new session.
 */
export function createEmptyAttributionState(): AttributionState {
  return {
    fileStates: new Map(),
    sessionBaselines: new Map(),
    surface: getClientSurface(),
    startingHeadSha: null,
    promptCount: 0,
    promptCountAtLastCommit: 0,
    permissionPromptCount: 0,
    permissionPromptCountAtLastCommit: 0,
    escapeCount: 0,
    escapeCountAtLastCommit: 0,
  }
}

/**
 * Compute the character contribution for a file modification.
 * Returns the FileAttributionState to store, or null if tracking failed.
 */
function computeFileModificationState(
  existingFileStates: Map<string, FileAttributionState>,
  filePath: string,
  oldContent: string,
  newContent: string,
  mtime: number,
): FileAttributionState | null {
  const normalizedPath = normalizeFilePath(filePath)

  try {
    // Calculate Limkenion's character contribution
    let limkenionContribution: number

    if (oldContent === '' || newContent === '') {
      // New file or full deletion - contribution is the content length
      limkenionContribution =
        oldContent === '' ? newContent.length : oldContent.length
    } else {
      // Find actual changed region via common prefix/suffix matching.
      // This correctly handles same-length replacements (e.g., "Esc" → "esc")
      // where Math.abs(newLen - oldLen) would be 0.
      const minLen = Math.min(oldContent.length, newContent.length)
      let prefixEnd = 0
      while (
        prefixEnd < minLen &&
        oldContent[prefixEnd] === newContent[prefixEnd]
      ) {
        prefixEnd++
      }
      let suffixLen = 0
      while (
        suffixLen < minLen - prefixEnd &&
        oldContent[oldContent.length - 1 - suffixLen] ===
          newContent[newContent.length - 1 - suffixLen]
      ) {
        suffixLen++
      }
      const oldChangedLen = oldContent.length - prefixEnd - suffixLen
      const newChangedLen = newContent.length - prefixEnd - suffixLen
      limkenionContribution = Math.max(oldChangedLen, newChangedLen)
    }

    // Get current file state if it exists
    const existingState = existingFileStates.get(normalizedPath)
    const existingContribution = existingState?.limkenionContribution ?? 0

    return {
      contentHash: computeContentHash(newContent),
      limkenionContribution: existingContribution + limkenionContribution,
      mtime,
    }
  } catch (error) {
    logError(error as Error)
    return null
  }
}


/**
 * Track a file modification by Limkenion.
 * Called after Edit/Write tool completes.
 */
export function trackFileModification(
  state: AttributionState,
  filePath: string,
  oldContent: string,
  newContent: string,
  _userModified: boolean,
  mtime: number = Date.now(),
): AttributionState {
  const normalizedPath = normalizeFilePath(filePath)
  const newFileState = computeFileModificationState(
    state.fileStates,
    filePath,
    oldContent,
    newContent,
    mtime,
  )
  if (!newFileState) {
    return state
  }

  const newFileStates = new Map(state.fileStates)
  newFileStates.set(normalizedPath, newFileState)

  logForDebugging(
    `Attribution: Tracked ${newFileState.limkenionContribution} chars for ${normalizedPath}`,
  )

  return {
    ...state,
    fileStates: newFileStates,
  }
}



// --


/**
 * Calculate final attribution for staged files.
 * Compares session baseline to committed state.
 */
export async function calculateCommitAttribution(
  states: AttributionState[],
  stagedFiles: string[],
): Promise<AttributionData> {
  const cwd = getAttributionRepoRoot()
  const sessionId = getSessionId()

  const files: Record<string, FileAttribution> = {}
  const excludedGenerated: string[] = []
  const surfaces = new Set<string>()
  const surfaceCounts: Record<string, number> = {}

  let totalLimkenionChars = 0
  let totalHumanChars = 0

  // Merge file states from all sessions
  const mergedFileStates = new Map<string, FileAttributionState>()
  const mergedBaselines = new Map<
    string,
    { contentHash: string; mtime: number }
  >()

  for (const state of states) {
    surfaces.add(state.surface)

    // Merge baselines (earliest baseline wins)
    // Handle both Map and plain object (in case of serialization)
    const baselines =
      state.sessionBaselines instanceof Map
        ? state.sessionBaselines
        : new Map(
            Object.entries(
              (state.sessionBaselines ?? {}) as Record<
                string,
                { contentHash: string; mtime: number }
              >,
            ),
          )
    for (const [path, baseline] of baselines) {
      if (!mergedBaselines.has(path)) {
        mergedBaselines.set(path, baseline)
      }
    }

    // Merge file states (accumulate contributions)
    // Handle both Map and plain object (in case of serialization)
    const fileStates =
      state.fileStates instanceof Map
        ? state.fileStates
        : new Map(
            Object.entries(
              (state.fileStates ?? {}) as Record<string, FileAttributionState>,
            ),
          )
    for (const [path, fileState] of fileStates) {
      const existing = mergedFileStates.get(path)
      if (existing) {
        mergedFileStates.set(path, {
          ...fileState,
          limkenionContribution:
            existing.limkenionContribution + fileState.limkenionContribution,
        })
      } else {
        mergedFileStates.set(path, fileState)
      }
    }
  }

  // Process files in parallel
  const fileResults = await Promise.all(
    stagedFiles.map(async file => {
      // Skip generated files
      if (isGeneratedFile(file)) {
        return { type: 'generated' as const, file }
      }

      const absPath = join(cwd, file)
      const fileState = mergedFileStates.get(file)
      const baseline = mergedBaselines.get(file)

      // Get the surface for this file
      const fileSurface = states[0]!.surface

      let limkenionChars = 0
      let humanChars = 0

      // Check if file was deleted
      const deleted = await isFileDeleted(file)

      if (deleted) {
        // File was deleted
        if (fileState) {
          // Limkenion deleted this file (tracked deletion)
          limkenionChars = fileState.limkenionContribution
          humanChars = 0
        } else {
          // Human deleted this file (untracked deletion)
          // Use diff size to get the actual change size
          const diffSize = await getGitDiffSize(file)
          humanChars = diffSize > 0 ? diffSize : 100 // Minimum attribution for a deletion
        }
      } else {
        try {
          // Only need file size, not content - stat() avoids loading GB-scale
          // build artifacts into memory when they appear in the working tree.
          // stats.size (bytes) is an adequate proxy for char count here.
          const stats = await stat(absPath)

          if (fileState) {
            // We have tracked modifications for this file
            limkenionChars = fileState.limkenionContribution
            humanChars = 0
          } else if (baseline) {
            // File was modified but not tracked - human modification
            const diffSize = await getGitDiffSize(file)
            humanChars = diffSize > 0 ? diffSize : stats.size
          } else {
            // New file not created by Limkenion
            humanChars = stats.size
          }
        } catch {
          // File doesn't exist or stat failed - skip it
          return null
        }
      }

      // Ensure non-negative values
      limkenionChars = Math.max(0, limkenionChars)
      humanChars = Math.max(0, humanChars)

      const total = limkenionChars + humanChars
      const percent = total > 0 ? Math.round((limkenionChars / total) * 100) : 0

      return {
        type: 'file' as const,
        file,
        limkenionChars,
        humanChars,
        percent,
        surface: fileSurface,
      }
    }),
  )

  // Aggregate results
  for (const result of fileResults) {
    if (!result) continue

    if (result.type === 'generated') {
      excludedGenerated.push(result.file)
      continue
    }

    files[result.file] = {
      limkenionChars: result.limkenionChars,
      humanChars: result.humanChars,
      percent: result.percent,
      surface: result.surface,
    }

    totalLimkenionChars += result.limkenionChars
    totalHumanChars += result.humanChars

    surfaceCounts[result.surface] =
      (surfaceCounts[result.surface] ?? 0) + result.limkenionChars
  }

  const totalChars = totalLimkenionChars + totalHumanChars
  const limkenionPercent =
    totalChars > 0 ? Math.round((totalLimkenionChars / totalChars) * 100) : 0

  // Calculate surface breakdown (percentage of total content per surface)
  const surfaceBreakdown: Record<
    string,
    { limkenionChars: number; percent: number }
  > = {}
  for (const [surface, chars] of Object.entries(surfaceCounts)) {
    // Calculate what percentage of TOTAL content this surface contributed
    const percent = totalChars > 0 ? Math.round((chars / totalChars) * 100) : 0
    surfaceBreakdown[surface] = { limkenionChars: chars, percent }
  }

  return {
    version: 1,
    summary: {
      limkenionPercent,
      limkenionChars: totalLimkenionChars,
      humanChars: totalHumanChars,
      surfaces: Array.from(surfaces),
    },
    files,
    surfaceBreakdown,
    excludedGenerated,
    sessions: [sessionId],
  }
}

/**
 * Get the size of changes for a file from git diff.
 * Returns the number of characters added/removed (absolute difference).
 * For new files, returns the total file size.
 * For deleted files, returns the size of the deleted content.
 */
export async function getGitDiffSize(filePath: string): Promise<number> {
  const cwd = getAttributionRepoRoot()

  try {
    // Use git diff --stat to get a summary of changes
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['diff', '--cached', '--stat', '--', filePath],
      { cwd, timeout: 5000 },
    )

    if (result.code !== 0 || !result.stdout) {
      return 0
    }

    // Parse the stat output to extract additions and deletions
    // Format: " file | 5 ++---" or " file | 10 +"
    const lines = result.stdout.split('\n').filter(Boolean)
    let totalChanges = 0

    for (const line of lines) {
      // Skip the summary line (e.g., "1 file changed, 3 insertions(+), 2 deletions(-)")
      if (line.includes('file changed') || line.includes('files changed')) {
        const insertMatch = line.match(/(\d+) insertions?/)
        const deleteMatch = line.match(/(\d+) deletions?/)

        // Use line-based changes and approximate chars per line (~40 chars average)
        const insertions = insertMatch ? parseInt(insertMatch[1]!, 10) : 0
        const deletions = deleteMatch ? parseInt(deleteMatch[1]!, 10) : 0
        totalChanges += (insertions + deletions) * 40
      }
    }

    return totalChanges
  } catch {
    return 0
  }
}

/**
 * Check if a file was deleted in the staged changes.
 */
export async function isFileDeleted(filePath: string): Promise<boolean> {
  const cwd = getAttributionRepoRoot()

  try {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['diff', '--cached', '--name-status', '--', filePath],
      { cwd, timeout: 5000 },
    )

    if (result.code === 0 && result.stdout) {
      // Format: "D\tfilename" for deleted files
      return result.stdout.trim().startsWith('D\t')
    }
  } catch {
    // Ignore errors
  }

  return false
}


// formatAttributionTrailer moved to attributionTrailer.ts for tree-shaking
// (contains excluded strings that should not be in external builds)


/**
 * Convert attribution state to snapshot message for persistence.
 */
export function stateToSnapshotMessage(
  state: AttributionState,
  messageId: UUID,
): AttributionSnapshotMessage {
  const fileStates: Record<string, FileAttributionState> = {}

  for (const [path, fileState] of state.fileStates) {
    fileStates[path] = fileState
  }

  return {
    type: 'attribution-snapshot',
    messageId,
    surface: state.surface,
    fileStates,
    promptCount: state.promptCount,
    promptCountAtLastCommit: state.promptCountAtLastCommit,
    permissionPromptCount: state.permissionPromptCount,
    permissionPromptCountAtLastCommit: state.permissionPromptCountAtLastCommit,
    escapeCount: state.escapeCount,
    escapeCountAtLastCommit: state.escapeCountAtLastCommit,
  }
}

/**
 * Restore attribution state from snapshot messages.
 */
export function restoreAttributionStateFromSnapshots(
  snapshots: AttributionSnapshotMessage[],
): AttributionState {
  const state = createEmptyAttributionState()

  // Snapshots are full-state dumps (see stateToSnapshotMessage), not deltas.
  // The last snapshot has the most recent count for every path — fileStates
  // never shrinks. Iterating and SUMMING counts across snapshots causes
  // quadratic growth on restore (837 snapshots × 280 files → 1.15 quadrillion
  // "chars" tracked for a 5KB file over a 5-day session).
  const lastSnapshot = snapshots[snapshots.length - 1]
  if (!lastSnapshot) {
    return state
  }

  state.surface = lastSnapshot.surface
  for (const [path, fileState] of Object.entries(lastSnapshot.fileStates)) {
    state.fileStates.set(path, fileState)
  }

  // Restore prompt counts from the last snapshot (most recent state)
  state.promptCount = lastSnapshot.promptCount ?? 0
  state.promptCountAtLastCommit = lastSnapshot.promptCountAtLastCommit ?? 0
  state.permissionPromptCount = lastSnapshot.permissionPromptCount ?? 0
  state.permissionPromptCountAtLastCommit =
    lastSnapshot.permissionPromptCountAtLastCommit ?? 0
  state.escapeCount = lastSnapshot.escapeCount ?? 0
  state.escapeCountAtLastCommit = lastSnapshot.escapeCountAtLastCommit ?? 0

  return state
}

/**
 * Restore attribution state from log snapshots on session resume.
 */
export function attributionRestoreStateFromLog(
  attributionSnapshots: AttributionSnapshotMessage[],
  onUpdateState: (newState: AttributionState) => void,
): void {
  const state = restoreAttributionStateFromSnapshots(attributionSnapshots)
  onUpdateState(state)
}

/**
 * Increment promptCount and save an attribution snapshot.
 * Used to persist the prompt count across compaction.
 *
 * @param attribution - Current attribution state
 * @param saveSnapshot - Function to save the snapshot (allows async handling by caller)
 * @returns New attribution state with incremented promptCount
 */
export function incrementPromptCount(
  attribution: AttributionState,
  saveSnapshot: (snapshot: AttributionSnapshotMessage) => void,
): AttributionState {
  const newAttribution = {
    ...attribution,
    promptCount: attribution.promptCount + 1,
  }
  const snapshot = stateToSnapshotMessage(newAttribution, randomUUID())
  saveSnapshot(snapshot)
  return newAttribution
}
