import { feature } from 'bun:bundle';
import type { ToolResultBlockParam } from '../../types/llm-protocol.js';
import { copyFile, stat as fsStat, truncate as fsTruncate, link } from 'fs/promises';
import * as React from 'react';
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js';
import type { AppState } from 'src/state/AppState.js';
import { z } from 'zod/v4';
import { getKairosActive } from '../../bootstrap/state.js';
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import type { SetToolJSXFn, Tool, ToolCallProgress, ValidationResult } from '../../Tool.js';
import { buildTool, type ToolDef } from '../../Tool.js';
import { backgroundExistingForegroundTask, markTaskNotified, registerForeground, spawnShellTask, unregisterForeground } from '../../tasks/LocalShellTask/LocalShellTask.js';
import type { AgentId } from '../../types/ids.js';
import type { AssistantMessage } from '../../types/message.js';
import { extractLimkenionHints } from '../../utils/limkenionHints.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { errorMessage as getErrorMessage, ShellError } from '../../utils/errors.js';
import { truncate } from '../../utils/format.js';
import { lazySchema } from '../../utils/lazySchema.js';
import { logError } from '../../utils/log.js';
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js';
import { getPlatform } from '../../utils/platform.js';
import { maybeRecordPluginHint } from '../../utils/plugins/hintRecommendation.js';
import { exec } from '../../utils/Shell.js';
import type { ExecResult } from '../../utils/ShellCommand.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { semanticBoolean } from '../../utils/semanticBoolean.js';
import { semanticNumber } from '../../utils/semanticNumber.js';
import { getCachedPowerShellPath } from '../../utils/shell/powershellDetection.js';
import { EndTruncatingAccumulator } from '../../utils/stringUtils.js';
import { getTaskOutputPath } from '../../utils/task/diskOutput.js';
import { TaskOutput } from '../../utils/task/TaskOutput.js';
import { isOutputLineTruncated } from '../../utils/terminal.js';
import { buildLargeToolResultMessage, ensureToolResultsDir, generatePreview, getToolResultPath, PREVIEW_SIZE_BYTES } from '../../utils/toolResultStorage.js';
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js';
import { BackgroundHint } from '../BashTool/UI.js';
import { buildImageToolResult, isImageOutput, resetCwdIfOutsideProject, resizeShellImageOutput, stdErrAppendShellResetMessage, stripEmptyLines } from '../BashTool/utils.js';
import { trackGitOperations } from '../shared/gitOperationTracking.js';
import { interpretCommandResult } from './commandSemantics.js';
import { powershellToolHasPermission } from './powershellPermissions.js';
import { getDefaultTimeoutMs, getMaxTimeoutMs, getPrompt } from './prompt.js';
import { hasSyncSecurityConcerns, isReadOnlyCommand, resolveToCanonical } from './readOnlyValidation.js';
import { POWERSHELL_TOOL_NAME } from './toolName.js';
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, renderToolUseProgressMessage, renderToolUseQueuedMessage } from './UI.js';

// 终端输出绝不使用 os.EOL——Windows 上的 \r\n 会破坏 Ink 渲染
const EOL = '\n';

/**
 * 用于可折叠显示的 PowerShell 搜索命令（grep 等价物）。
 * 以规范化（小写）cmdlet 名存储。
 */
const PS_SEARCH_COMMANDS = new Set(['select-string',
// grep 等价物
'get-childitem',
// find 等价物（带 -Recurse）
'findstr',
// Windows 原生搜索
'where.exe' // Windows 原生 which
]);

/**
 * 用于可折叠显示的 PowerShell 读取/查看命令。
 * 以规范化（小写）cmdlet 名存储。
 */
const PS_READ_COMMANDS = new Set(['get-content',
// cat 等价物
'get-item',
// 文件信息
'test-path',
// test -e 等价物
'resolve-path',
// realpath 等价物
'get-process',
// ps 等价物
'get-service',
// 系统信息
'get-childitem',
// ls/dir 等价物（递归时也用于搜索）
'get-location',
// pwd 等价物
'get-filehash',
// 校验和
'get-acl',
// 权限信息
'format-hex' // hexdump 等价物
]);

/**
 * 不改变搜索/读取语义的 PowerShell 语义中性命令。
 */
const PS_SEMANTIC_NEUTRAL_COMMANDS = new Set(['write-output',
// echo 等价物
'write-host']);

/**
 * 检查 PowerShell 命令是否为搜索或读取操作。
 * 用于判断该命令是否应在 UI 中折叠。
 */
function isSearchOrReadPowerShellCommand(command: string): {
  isSearch: boolean;
  isRead: boolean;
} {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      isSearch: false,
      isRead: false
    };
  }

  // 按语句分隔符和管道操作符简单切分
  // 这是同步函数，因此采用轻量做法
  const parts = trimmed.split(/\s*[;|]\s*/).filter(Boolean);
  if (parts.length === 0) {
    return {
      isSearch: false,
      isRead: false
    };
  }
  let hasSearch = false;
  let hasRead = false;
  let hasNonNeutralCommand = false;
  for (const part of parts) {
    const baseCommand = part.trim().split(/\s+/)[0];
    if (!baseCommand) {
      continue;
    }
    const canonical = resolveToCanonical(baseCommand);
    if (PS_SEMANTIC_NEUTRAL_COMMANDS.has(canonical)) {
      continue;
    }
    hasNonNeutralCommand = true;
    const isPartSearch = PS_SEARCH_COMMANDS.has(canonical);
    const isPartRead = PS_READ_COMMANDS.has(canonical);
    if (!isPartSearch && !isPartRead) {
      return {
        isSearch: false,
        isRead: false
      };
    }
    if (isPartSearch) hasSearch = true;
    if (isPartRead) hasRead = true;
  }
  if (!hasNonNeutralCommand) {
    return {
      isSearch: false,
      isRead: false
    };
  }
  return {
    isSearch: hasSearch,
    isRead: hasRead
  };
}

// 进度显示常量
const PROGRESS_THRESHOLD_MS = 2000;
const PROGRESS_INTERVAL_MS = 1000;
// 在 assistant 模式下，主 agent 中的阻塞命令在此毫秒数后自动转入后台
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;

// 不应自动转入后台的命令（规范化小写）。
// 'sleep' 是 Start-Sleep 的 PS 内置别名，但不在 COMMON_ALIASES 中，
// 因此两种形式都列出。
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ['start-sleep',
// Start-Sleep 应在前台运行，除非显式要求后台执行
'sleep'];

/**
 * 检查命令是否允许自动转入后台
 * @param command 要检查的命令
 * @returns 对于不应自动转入后台的命令（如 Start-Sleep）返回 false
 */
function isAutobackgroundingAllowed(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0];
  if (!firstWord) return true;
  const canonical = resolveToCanonical(firstWord);
  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(canonical);
}

/**
 * BashTool 的 detectBlockedSleepPattern 的 PS 风格移植版。
 * 捕获作为首条语句的 `Start-Sleep N`、`Start-Sleep -Seconds N`、`sleep N`（内置别名）。
 * 不拦截 `Start-Sleep -Milliseconds`（亚秒级
 * 节奏控制没问题）或浮点秒数（合法的限流）。
 */
export function detectBlockedSleepPattern(command: string): string | null {
  // 仅首条语句——按 PS 语句分隔符切分：`;`、`|`、
  // `&`/`&&`/`||`（pwsh 7+）以及换行（PS 的主要分隔符）。这里
  // 有意做得较浅——脚本块、子 shell 或后续
  // 管道阶段中的 sleep 都没问题。与 BashTool 的 splitCommandWithOperators
  // 意图一致（src/utils/bash/commands.ts），但不需要完整的 PS 解析器。
  const first = command.trim().split(/[;|&\r\n]/)[0]?.trim() ?? '';
  // 匹配：Start-Sleep N、Start-Sleep -Seconds N、Start-Sleep -s N、sleep N
  // （不区分大小写；按 PS 惯例 -Seconds 可缩写为 -s）
  const m = /^(?:start-sleep|sleep)(?:\s+-s(?:econds)?)?\s+(\d+)\s*$/i.exec(first);
  if (!m) return null;
  const secs = parseInt(m[1]!, 10);
  if (secs < 2) return null; // 2 秒以内的 sleep 没问题（限流、节奏控制）

  const rest = command.trim().slice(first.length).replace(/^[\s;|&]+/, '');
  return rest ? `Start-Sleep ${secs} followed by: ${rest}` : `standalone Start-Sleep ${secs}`;
}

/**
 * 在 Windows 原生环境下，沙箱不可用（bwrap/sandbox-exec 仅支持
 * POSIX）。若企业策略启用了 sandbox.enabled 且禁止
 * 非沙箱命令，PowerShell 无法遵从——此时拒绝执行，
 * 而不是静默绕过策略。在 Linux/macOS/WSL2 上，pwsh
 * 与 bash 一样作为原生二进制在沙箱下运行，因此该
 * 门禁不适用。
 *
 * 在 validateInput（给出干净的工具运行器错误）和 call()
 * （覆盖 promptShellExecution.ts 这类跳过
 * validateInput 的直接调用方）中都会检查。call() 中的守卫才是关键。
 */
const WINDOWS_SANDBOX_POLICY_REFUSAL = 'Enterprise policy requires sandboxing, but sandboxing is not available on native Windows. Shell command execution is blocked on this platform by policy.';
function isWindowsSandboxPolicyViolation(): boolean {
  return getPlatform() === 'windows' && SandboxManager.isSandboxEnabledInSettings() && !SandboxManager.areUnsandboxedCommandsAllowed();
}

// 在模块加载时检查后台任务是否已禁用
const isBackgroundTasksDisabled =
// eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: schema must be defined at module load
isEnvTruthy(process.env.LIMKENION_DISABLE_BACKGROUND_TASKS);
const fullInputSchema = lazySchema(() => z.strictObject({
  command: z.string().describe('要执行的 PowerShell 命令'),
  timeout: semanticNumber(z.number().optional()).describe(`可选的超时时间（毫秒，最大 ${getMaxTimeoutMs()}）`),
  description: z.string().optional().describe('用主动语态清晰、简洁地描述此命令的作用。'),
  run_in_background: semanticBoolean(z.boolean().optional()).describe(`设为 true 以在后台运行此命令。稍后可用 Read 读取其输出。`),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe('设为 true 可危险地覆盖沙箱模式，在无沙箱的情况下运行命令。')
}));

// 当后台任务被禁用时，条件性地从 schema 中移除 run_in_background
const inputSchema = lazySchema(() => isBackgroundTasksDisabled ? fullInputSchema().omit({
  run_in_background: true
}) : fullInputSchema());
type InputSchema = ReturnType<typeof inputSchema>;

// 使用 fullInputSchema 来做类型，以始终包含 run_in_background
// （即使它已从 schema 中剥离，代码仍需处理它）
export type PowerShellToolInput = z.infer<ReturnType<typeof fullInputSchema>>;
const outputSchema = lazySchema(() => z.object({
  stdout: z.string().describe('命令的标准输出'),
  stderr: z.string().describe('命令的标准错误输出'),
  interrupted: z.boolean().describe('命令是否被中断'),
  returnCodeInterpretation: z.string().optional().describe('对具有特殊含义的非错误退出码的语义解释'),
  isImage: z.boolean().optional().describe('指示 stdout 是否包含图像数据的标志'),
  persistedOutputPath: z.string().optional().describe('输出过大无法内联时持久化完整输出的路径'),
  persistedOutputSize: z.number().optional().describe('持久化时输出的总字节大小'),
  backgroundTaskId: z.string().optional().describe('命令在后台运行时后台任务的 ID'),
  backgroundedByUser: z.boolean().optional().describe('用户是否用 Ctrl+B 手动将命令放入后台'),
  assistantAutoBackgrounded: z.boolean().optional().describe('命令是否因助理模式的阻塞预算被自动放入后台')
}));
type OutputSchema = ReturnType<typeof outputSchema>;
export type Out = z.infer<OutputSchema>;
import type { PowerShellProgress } from '../../types/tools.js';
export type { PowerShellProgress } from '../../types/tools.js';
const COMMON_BACKGROUND_COMMANDS = ['npm', 'yarn', 'pnpm', 'node', 'python', 'python3', 'go', 'cargo', 'make', 'docker', 'terraform', 'webpack', 'vite', 'jest', 'pytest', 'curl', 'Invoke-WebRequest', 'build', 'test', 'serve', 'watch', 'dev'] as const;
function getCommandTypeForLogging(command: string): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  const trimmed = command.trim();
  const firstWord = trimmed.split(/\s+/)[0] || '';
  for (const cmd of COMMON_BACKGROUND_COMMANDS) {
    if (firstWord.toLowerCase() === cmd.toLowerCase()) {
      return cmd as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    }
  }
  return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
}
export const PowerShellTool = buildTool({
  name: POWERSHELL_TOOL_NAME,
  searchHint: 'execute Windows PowerShell commands',
  maxResultSizeChars: 30_000,
  strict: true,
  async description({
    description
  }: Partial<PowerShellToolInput>): Promise<string> {
    return description || 'Run PowerShell command';
  },
  async prompt(): Promise<string> {
    return getPrompt();
  },
  isConcurrencySafe(input: PowerShellToolInput): boolean {
    return this.isReadOnly?.(input) ?? false;
  },
  isSearchOrReadCommand(input: Partial<PowerShellToolInput>): {
    isSearch: boolean;
    isRead: boolean;
  } {
    if (!input.command) {
      return {
        isSearch: false,
        isRead: false
      };
    }
    return isSearchOrReadPowerShellCommand(input.command);
  },
  isReadOnly(input: PowerShellToolInput): boolean {
    // 在判定为只读之前先做同步安全检查（启发式）。
    // 完整的 AST 解析是异步的，此处不可用，因此我们使用
    // 基于正则的检测来发现子表达式、展开（splatting）、成员
    // 调用和赋值——与 BashTool 在 cmdlet 允许列表评估之前
    // 先检查安全问题的模式一致。
    if (hasSyncSecurityConcerns(input.command)) {
      return false;
    }
    // 注意：此处调用 isReadOnlyCommand 时未传入解析后的 AST。没有
    // AST，isReadOnlyCommand 无法切分管道/语句，除最简单的单 token
    // 命令外都会返回 false。这是同步 Tool.isReadOnly() 接口的
    // 已知局限——真正的只读自动放行发生在
    // powershellToolHasPermission（步骤 4.5）的异步流程中，
    // 那里有解析后的 AST 可用。
    return isReadOnlyCommand(input.command);
  },
  toAutoClassifierInput(input) {
    return input.command;
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName(): string {
    return 'PowerShell';
  },
  getToolUseSummary(input: Partial<PowerShellToolInput> | undefined): string | null {
    if (!input?.command) {
      return null;
    }
    const {
      command,
      description
    } = input;
    if (description) {
      return description;
    }
    return truncate(command, TOOL_SUMMARY_MAX_LENGTH);
  },
  getActivityDescription(input: Partial<PowerShellToolInput> | undefined): string {
    if (!input?.command) {
      return 'Running command';
    }
    const desc = input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH);
    return `Running ${desc}`;
  },
  isEnabled(): boolean {
    return true;
  },
  async validateInput(input: PowerShellToolInput): Promise<ValidationResult> {
    // 纵深防御：在 call() 中也为直接调用方做了守卫。
    if (isWindowsSandboxPolicyViolation()) {
      return {
        result: false,
        message: WINDOWS_SANDBOX_POLICY_REFUSAL,
        errorCode: 11
      };
    }
    if (feature('MONITOR_TOOL') && !isBackgroundTasksDisabled && !input.run_in_background) {
      const sleepPattern = detectBlockedSleepPattern(input.command);
      if (sleepPattern !== null) {
        return {
          result: false,
          message: `Blocked: ${sleepPattern}. Run blocking commands in the background with run_in_background: true — you'll get a completion notification when done. For streaming events (watching logs, polling APIs), use the Monitor tool. If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.`,
          errorCode: 10
        };
      }
    }
    return {
      result: true
    };
  },
  async checkPermissions(input: PowerShellToolInput, context: Parameters<Tool['checkPermissions']>[1]): Promise<PermissionResult> {
    return await powershellToolHasPermission(input, context);
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  mapToolResultToToolResultBlockParam({
    interrupted,
    stdout,
    stderr,
    isImage,
    persistedOutputPath,
    persistedOutputSize,
    backgroundTaskId,
    backgroundedByUser,
    assistantAutoBackgrounded
  }: Out, toolUseID: string): ToolResultBlockParam {
    // 对于图像数据，格式化为给 Limkenion 的图像内容块
    if (isImage) {
      const block = buildImageToolResult(stdout, toolUseID);
      if (block) return block;
    }
    let processedStdout = stdout;
    if (persistedOutputPath) {
      const trimmed = stdout ? stdout.replace(/^(\s*\n)+/, '').trimEnd() : '';
      const preview = generatePreview(trimmed, PREVIEW_SIZE_BYTES);
      processedStdout = buildLargeToolResultMessage({
        filepath: persistedOutputPath,
        originalSize: persistedOutputSize ?? 0,
        isJson: false,
        preview: preview.preview,
        hasMore: preview.hasMore
      });
    } else if (stdout) {
      processedStdout = stdout.replace(/^(\s*\n)+/, '');
      processedStdout = processedStdout.trimEnd();
    }
    let errorMessage = stderr.trim();
    if (interrupted) {
      if (stderr) errorMessage += EOL;
      errorMessage += '<error>Command was aborted before completion</error>';
    }
    let backgroundInfo = '';
    if (backgroundTaskId) {
      const outputPath = getTaskOutputPath(backgroundTaskId);
      if (assistantAutoBackgrounded) {
        backgroundInfo = `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${backgroundTaskId}. It is still running — you will be notified when it completes. Output is being written to: ${outputPath}. In assistant mode, delegate long-running work to a subagent or use run_in_background to keep this conversation responsive.`;
      } else if (backgroundedByUser) {
        backgroundInfo = `Command was manually backgrounded by user with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}`;
      } else {
        backgroundInfo = `Command running in background with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}`;
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [processedStdout, errorMessage, backgroundInfo].filter(Boolean).join('\n'),
      is_error: interrupted
    };
  },
  async call(input: PowerShellToolInput, toolUseContext: Parameters<Tool['call']>[1], _canUseTool?: CanUseToolFn, _parentMessage?: AssistantMessage, onProgress?: ToolCallProgress<PowerShellProgress>): Promise<{
    data: Out;
  }> {
    // 关键守卫：promptShellExecution.ts 和 processBashCommand.tsx
    // 会直接调用 PowerShellTool.call()，绕过 validateInput。这里是
    // 覆盖所有调用方的检查。策略依据见 isWindowsSandboxPolicyViolation
    // 的注释。
    if (isWindowsSandboxPolicyViolation()) {
      throw new Error(WINDOWS_SANDBOX_POLICY_REFUSAL);
    }
    const {
      abortController,
      setAppState,
      setToolJSX
    } = toolUseContext;
    const isMainThread = !toolUseContext.agentId;
    let progressCounter = 0;
    try {
      const commandGenerator = runPowerShellCommand({
        input,
        abortController,
        // 使用始终共享的任务通道，使异步 agent 的后台
        // shell 任务真正被注册（并可在 agent 退出时终止）。
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
        setToolJSX,
        preventCwdChanges: !isMainThread,
        isMainThread,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId
      });
      let generatorResult;
      do {
        generatorResult = await commandGenerator.next();
        if (!generatorResult.done && onProgress) {
          const progress = generatorResult.value;
          onProgress({
            toolUseID: `ps-progress-${progressCounter++}`,
            data: {
              type: 'powershell_progress',
              output: progress.output,
              fullOutput: progress.fullOutput,
              elapsedTimeSeconds: progress.elapsedTimeSeconds,
              totalLines: progress.totalLines,
              totalBytes: progress.totalBytes,
              timeoutMs: progress.timeoutMs,
              taskId: progress.taskId
            }
          });
        }
      } while (!generatorResult.done);
      const result = generatorResult.value;

      // 上报 git/PR 使用指标（与 BashTool 相同的计数器）。PS 会以外部
      // 二进制方式调用 git/gh/glab/curl，语法完全相同，因此
      // trackGitOperations 中与 shell 无关的正则检测可直接使用。
      // 在 backgroundTaskId 提前返回之前调用，使转入后台的
      // 命令也被统计（与 BashTool.tsx:912 一致）。
      //
      // 预检哨兵值守卫：PS 的两条预检路径（pwsh-not-found、
      // exec-spawn-catch）返回 code: 0 + 空 stdout + stderr，以便 call()
      // 优雅地暴露 stderr 而不是抛出 ShellError。但
      // gitOperationTracking.ts:48 将 code 0 视为成功，会
      // 对该命令做正则匹配，从而错误统计一条从未运行的命令。
      // BashTool 是安全的——其预检走 createFailedCommand
      // （code: 1），因此跟踪会提前返回。遇到此哨兵值时跳过跟踪。
      const isPreFlightSentinel = result.code === 0 && !result.stdout && result.stderr && !result.backgroundTaskId;
      if (!isPreFlightSentinel) {
        trackGitOperations(input.command, result.code, result.stdout);
      }

      // 区分用户主动中断（提交了新消息）与其他
      // 中断状态。只有用户中断才应抑制 ShellError——
      // 超时终止或带 isError 的进程终止仍应抛出。
      // 与 BashTool 的 isInterrupt 一致。
      const isInterrupt = result.interrupted && abortController.signal.reason === 'interrupt';

      // 只有主线程会跟踪/重置 cwd；agent 有自己的 cwd
      // 隔离。与 BashTool 的 !preventCwdChanges 守卫一致。
      // 在 backgroundTaskId 提前返回之前运行：命令可能在转入后台前
      // 改变 CWD（例如 `Set-Location C:\temp;
      // Start-Sleep 60`），而 BashTool 没有这样的提前返回——其
      // 后台结果会经过 :945 处的 resetCwdIfOutsideProject。
      let stderrForShellReset = '';
      if (isMainThread) {
        const appState = toolUseContext.getAppState();
        if (resetCwdIfOutsideProject(appState.toolPermissionContext)) {
          stderrForShellReset = stdErrAppendShellResetMessage('');
        }
      }

      // 若已转入后台，立即带着任务 ID 返回。先剥离提示，
      // 使因中断而转入后台的 fullOutput 不会把该标签泄露给
      // 模型（BashTool 没有提前返回，因此所有路径都经过其
      // 单一提取点）。
      if (result.backgroundTaskId) {
        const bgExtracted = extractLimkenionHints(result.stdout || '', input.command);
        if (isMainThread && bgExtracted.hints.length > 0) {
          for (const hint of bgExtracted.hints) maybeRecordPluginHint(hint);
        }
        return {
          data: {
            stdout: bgExtracted.stripped,
            stderr: [result.stderr || '', stderrForShellReset].filter(Boolean).join('\n'),
            interrupted: false,
            backgroundTaskId: result.backgroundTaskId,
            backgroundedByUser: result.backgroundedByUser,
            assistantAutoBackgrounded: result.assistantAutoBackgrounded
          }
        };
      }
      const stdoutAccumulator = new EndTruncatingAccumulator();
      const processedStdout = (result.stdout || '').trimEnd();
      stdoutAccumulator.append(processedStdout + EOL);

      // 按语义规则解释退出码。PS 原生 cmdlet（Select-String、
      // Compare-Object、Test-Path）在无匹配时退出码为 0，因此总会走到这里的默认分支。
      // 这里主要处理外部 .exe（grep、rg、findstr、fc、robocopy），
      // 它们的非零退出码可能表示“无匹配”/“文件已复制”而非失败。
      const interpretation = interpretCommandResult(input.command, result.code, processedStdout, result.stderr || '');

      // toolErrors.ts 中的 getErrorParts() 在构建 ShellError 消息时
      // 已根据 error.code 在前面加上 'Exit code N'。不要在此处
      // 重复写入 stdout（BashTool 在 :939 的追加是死代码——
      // 它在读取 stdoutAccumulator.toString() 之前就抛出了）。

      let stdout = stripEmptyLines(stdoutAccumulator.toString());

      // Limkenion 提示协议：以 LIMKENIONCODE=1 为条件的 CLI/SDK 会向
      // stderr 发出 `<limkenion-hint />` 标签（在此处合并进 stdout）。扫描、
      // 记录以供 useLimkenionHintRecommendation 呈现，然后剥离，
      // 使模型永远看不到该标签——一条零 token 的旁路通道。
      // 剥离无条件执行（子代理的输出也必须保持干净）；
      // 仅对话框记录是主线程专属的。
      const extracted = extractLimkenionHints(stdout, input.command);
      stdout = extracted.stripped;
      if (isMainThread && extracted.hints.length > 0) {
        for (const hint of extracted.hints) maybeRecordPluginHint(hint);
      }

      // preSpawnError 表示 exec() 成功，但内层 shell 在
      // 命令运行之前失败（例如 CWD 被删除）。createFailedCommand 设置 code=1，
      // interpretCommandResult 可能将其误判为 grep 无匹配 / findstr
      // 未找到字符串。直接抛出。与 BashTool.tsx:957 一致。
      if (result.preSpawnError) {
        throw new Error(result.preSpawnError);
      }
      if (interpretation.isError && !isInterrupt) {
        throw new ShellError(stdout, result.stderr || '', result.code, result.interrupted);
      }

      // 大输出：磁盘上的文件超过 getMaxOutputLength() 字节。
      // stdout 已包含第一块内容。将输出文件复制到
      // tool-results 目录，以便模型通过 FileRead 读取。若超过 64 MB，
      // 则在复制后截断。与 BashTool.tsx:983-1005 一致。
      //
      // 放在 preSpawnError/ShellError 抛出之后（与 BashTool 的顺序一致，
      // 其持久化位于 try/finally 之后）：否则一条失败但同样产生了
      // >maxOutputLength 字节的命令会执行 3-4 次磁盘系统调用、
      // 存储到 tool-results/，然后抛出——留下孤立文件。
      const MAX_PERSISTED_SIZE = 64 * 1024 * 1024;
      let persistedOutputPath: string | undefined;
      let persistedOutputSize: number | undefined;
      if (result.outputFilePath && result.outputTaskId) {
        try {
          const fileStat = await fsStat(result.outputFilePath);
          persistedOutputSize = fileStat.size;
          await ensureToolResultsDir();
          const dest = getToolResultPath(result.outputTaskId, false);
          if (fileStat.size > MAX_PERSISTED_SIZE) {
            await fsTruncate(result.outputFilePath, MAX_PERSISTED_SIZE);
          }
          try {
            await link(result.outputFilePath, dest);
          } catch {
            await copyFile(result.outputFilePath, dest);
          }
          persistedOutputPath = dest;
        } catch {
          // 文件可能已经不存在——stdout 预览已足够
        }
      }

      // 若存在图像，则限制其尺寸和大小（CC-304——见
      // resizeShellImageOutput）。把解码后的缓冲区限定在作用域内，使其能在
      // 我们构建输出对象之前被回收。
      let isImage = isImageOutput(stdout);
      let compressedStdout = stdout;
      if (isImage) {
        const resized = await resizeShellImageOutput(stdout, result.outputFilePath, persistedOutputSize);
        if (resized) {
          compressedStdout = resized;
        } else {
          // 解析失败（例如 data URL 之后的多行 stdout）。让
          // isImage 与实际发送的内容保持一致，以保证 UI 标签
          // 准确——mapToolResultToToolResultBlockParam 的防御性
          // 兜底会发送文本，而非图像块。
          isImage = false;
        }
      }
      const finalStderr = [result.stderr || '', stderrForShellReset].filter(Boolean).join('\n');
      logEvent('limkenion_powershell_tool_command_executed', {
        command_type: getCommandTypeForLogging(input.command),
        stdout_length: compressedStdout.length,
        stderr_length: finalStderr.length,
        exit_code: result.code,
        interrupted: result.interrupted
      });
      return {
        data: {
          stdout: compressedStdout,
          stderr: finalStderr,
          interrupted: result.interrupted,
          returnCodeInterpretation: interpretation.message,
          isImage,
          persistedOutputPath,
          persistedOutputSize
        }
      };
    } finally {
      if (setToolJSX) setToolJSX(null);
    }
  },
  isResultTruncated(output: Out): boolean {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr);
  }
} satisfies ToolDef<InputSchema, Out>);
async function* runPowerShellCommand({
  input,
  abortController,
  setAppState,
  setToolJSX,
  preventCwdChanges,
  isMainThread,
  toolUseId,
  agentId
}: {
  input: PowerShellToolInput;
  abortController: AbortController;
  setAppState: (f: (prev: AppState) => AppState) => void;
  setToolJSX?: SetToolJSXFn;
  preventCwdChanges?: boolean;
  isMainThread?: boolean;
  toolUseId?: string;
  agentId?: AgentId;
}): AsyncGenerator<{
  type: 'progress';
  output: string;
  fullOutput: string;
  elapsedTimeSeconds: number;
  totalLines: number;
  totalBytes: number;
  taskId?: string;
  timeoutMs?: number;
}, ExecResult, void> {
  const {
    command,
    description,
    timeout,
    run_in_background,
    dangerouslyDisableSandbox
  } = input;
  const timeoutMs = Math.min(timeout || getDefaultTimeoutMs(), getMaxTimeoutMs());
  let fullOutput = '';
  let lastProgressOutput = '';
  let lastTotalLines = 0;
  let lastTotalBytes = 0;
  let backgroundShellId: string | undefined = undefined;
  let interruptBackgroundingStarted = false;
  let assistantAutoBackgrounded = false;

  // 进度信号：当异步 .then() 路径中设置了 backgroundShellId 时兑现，
  // 立即唤醒生成器的 Promise.race，而不用
  // 等待下一次 setTimeout 触发（与 BashTool 的模式一致）。
  let resolveProgress: (() => void) | null = null;
  function createProgressSignal(): Promise<null> {
    return new Promise<null>(resolve => {
      resolveProgress = () => resolve(null);
    });
  }
  const shouldAutoBackground = !isBackgroundTasksDisabled && isAutobackgroundingAllowed(command);
  const powershellPath = await getCachedPowerShellPath();
  if (!powershellPath) {
    // 预检失败：pwsh 未安装。返回 code 0，使 call() 将其
    // 作为优雅的 stderr 消息呈现，而不是抛出 ShellError——
    // 命令从未运行，因此没有有意义的非零退出码可报告。
    return {
      stdout: '',
      stderr: 'PowerShell is not available on this system.',
      code: 0,
      interrupted: false
    };
  }
  let shellCommand: Awaited<ReturnType<typeof exec>>;
  try {
    shellCommand = await exec(command, abortController.signal, 'powershell', {
      timeout: timeoutMs,
      onProgress(lastLines, allLines, totalLines, totalBytes, isIncomplete) {
        lastProgressOutput = lastLines;
        fullOutput = allLines;
        lastTotalLines = totalLines;
        lastTotalBytes = isIncomplete ? totalBytes : 0;
      },
      preventCwdChanges,
      // 沙箱在 Linux/macOS/WSL2 上可用——那里的 pwsh 是原生二进制，
      // SandboxManager.wrapWithSandbox 会像包装 bash 一样包装它（Shell.ts 用
      // /bin/sh 做外层 spawn，以解析 POSIX 引号形式的 bwrap/sandbox-exec
      // 字符串）。在 Windows 原生环境下不支持沙箱；shouldUseSandbox()
      // 经 isSandboxingEnabled() → isSupportedPlatform() → false 返回 false。
      // 显式的平台检查是冗余但直观的。
      shouldUseSandbox: getPlatform() === 'windows' ? false : shouldUseSandbox({
        command,
        dangerouslyDisableSandbox
      }),
      shouldAutoBackground
    });
  } catch (e) {
    logError(e);
    // 预检失败：命令运行之前 spawn/exec 被拒绝。使用
    // code 0，使 call() 优雅地返回 stderr，而不是抛出 ShellError。
    return {
      stdout: '',
      stderr: `Failed to execute PowerShell command: ${getErrorMessage(e)}`,
      code: 0,
      interrupted: false
    };
  }
  const resultPromise = shellCommand.result;

  // 用于启动后台任务并返回其 ID 的辅助函数
  async function spawnBackgroundTask(): Promise<string> {
    const handle = await spawnShellTask({
      command,
      description: description || command,
      shellCommand,
      toolUseId,
      agentId
    }, {
      abortController,
      getAppState: () => {
        throw new Error('getAppState not available in runPowerShellCommand context');
      },
      setAppState
    });
    return handle.taskId;
  }

  // 用于带日志地开始后台执行的辅助函数
  function startBackgrounding(eventName: string, backgroundFn?: (shellId: string) => void): void {
    // 若已注册前台任务（通过进度循环中的 registerForeground），
    // 则原地将其转入后台，而不是重新启动。重新启动
    // 会覆盖 tasks[taskId]、重复发出 task_started SDK 事件，
    // 并泄漏第一个清理回调。
    if (foregroundTaskId) {
      if (!backgroundExistingForegroundTask(foregroundTaskId, shellCommand, description || command, setAppState, toolUseId)) {
        return;
      }
      backgroundShellId = foregroundTaskId;
      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command)
      });
      backgroundFn?.(foregroundTaskId);
      return;
    }

    // 未注册前台任务——启动新的后台任务
    // 注意：spawn 虽然标记为 async，但实质上是同步的
    void spawnBackgroundTask().then(shellId => {
      backgroundShellId = shellId;

      // 唤醒生成器的 Promise.race，使其看到 backgroundShellId。
      // 若不这样做，生成器要等当前 setTimeout 触发
      // （最多约 1 秒）才会察觉到已转入后台。与 BashTool 一致。
      const resolve = resolveProgress;
      if (resolve) {
        resolveProgress = null;
        resolve();
      }
      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command)
      });
      if (backgroundFn) {
        backgroundFn(shellId);
      }
    });
  }

  // 若已启用，则设置超时后自动转入后台
  if (shellCommand.onTimeout && shouldAutoBackground) {
    shellCommand.onTimeout(backgroundFn => {
      startBackgrounding('limkenion_powershell_command_timeout_backgrounded', backgroundFn);
    });
  }

  // 在 assistant 模式下，主 agent 应保持响应。阻塞命令超过
  // ASSISTANT_BLOCKING_BUDGET_MS 后自动转入后台，使 agent 能继续
  // 协调而不是干等。命令仍在运行——不丢失状态。
  if (feature('KAIROS') && getKairosActive() && isMainThread && !isBackgroundTasksDisabled && run_in_background !== true) {
    setTimeout(() => {
      if (shellCommand.status === 'running' && backgroundShellId === undefined) {
        assistantAutoBackgrounded = true;
        startBackgrounding('limkenion_powershell_command_assistant_auto_backgrounded');
      }
    }, ASSISTANT_BLOCKING_BUDGET_MS).unref();
  }

  // 处理 Limkenion 显式要求将其在后台运行的情况
  // 通过 run_in_background 显式请求时，无论命令类型如何都一律遵从
  // （isAutobackgroundingAllowed 仅适用于自动转入后台）
  if (run_in_background === true && !isBackgroundTasksDisabled) {
    const shellId = await spawnBackgroundTask();
    logEvent('limkenion_powershell_command_explicitly_backgrounded', {
      command_type: getCommandTypeForLogging(command)
    });
    return {
      stdout: '',
      stderr: '',
      code: 0,
      interrupted: false,
      backgroundTaskId: shellId
    };
  }

  // 开始轮询输出文件以获取进度
  TaskOutput.startPolling(shellCommand.taskOutput.taskId);

  // 设置带周期性检查的进度产出
  const startTime = Date.now();
  let nextProgressTime = startTime + PROGRESS_THRESHOLD_MS;
  let foregroundTaskId: string | undefined = undefined;

  // 进度循环：用 try/finally 包裹，使每条退出路径都会调用 stopPolling
  // ——正常完成、超时/中断转入后台，以及 Ctrl+B
  // （与 BashTool 的模式一致；见 :560 处 PR #18887 的评审讨论）
  try {
    while (true) {
      const now = Date.now();
      const timeUntilNextProgress = Math.max(0, nextProgressTime - now);
      const progressSignal = createProgressSignal();
      const result = await Promise.race([resultPromise, new Promise<null>(resolve => setTimeout(r => r(null), timeUntilNextProgress, resolve).unref()), progressSignal]);
      if (result !== null) {
        // 竞态：后台化已触发（15 秒定时器 / onTimeout / Ctrl+B），但
        // 命令在下一次轮询前就已完成。#handleExit 会设置
        // backgroundTaskId，但跳过 outputFilePath（它假定后台
        // 消息或 <task_notification> 会带上该路径）。剥离
        // backgroundTaskId，使模型看到一条干净已完成的命令，
        // 为大输出重建 outputFilePath，并抑制 .then() 处理器中
        // 冗余的 <task_notification>。
        // 检查 result.backgroundTaskId（而非闭包变量），以同时覆盖
        // Ctrl+B——它直接调用 shellCommand.background()。
        if (result.backgroundTaskId !== undefined) {
          markTaskNotified(result.backgroundTaskId, setAppState);
          const fixedResult: ExecResult = {
            ...result,
            backgroundTaskId: undefined
          };
          // 复刻 ShellCommand.#handleExit 中因设置了 #backgroundTaskId
          // 而被跳过的大输出分支。
          const {
            taskOutput
          } = shellCommand;
          if (taskOutput.stdoutToFile && !taskOutput.outputFileRedundant) {
            fixedResult.outputFilePath = taskOutput.path;
            fixedResult.outputFileSize = taskOutput.outputFileSize;
            fixedResult.outputTaskId = taskOutput.taskId;
          }
          // 命令已完成——在此清理流监听器。finally
          // 块的守卫（!backgroundShellId && status !== 'backgrounded'）
          // 对*正在运行的*后台任务正确地跳过清理，但
          // 在此竞态中进程已结束。与 BashTool.tsx:1399 一致。
          shellCommand.cleanup();
          return fixedResult;
        }
        // 命令已完成
        return result;
      }

      // 检查命令是否已转入后台（因超时或中断）
      if (backgroundShellId) {
        return {
          stdout: interruptBackgroundingStarted ? fullOutput : '',
          stderr: '',
          code: 0,
          interrupted: false,
          backgroundTaskId: backgroundShellId,
          assistantAutoBackgrounded
        };
      }

      // 用户提交了新消息——转入后台而不是杀掉
      if (abortController.signal.aborted && abortController.signal.reason === 'interrupt' && !interruptBackgroundingStarted) {
        interruptBackgroundingStarted = true;
        if (!isBackgroundTasksDisabled) {
          startBackgrounding('limkenion_powershell_command_interrupt_backgrounded');
          // 重新循环，使（上面的）backgroundShellId 检查能捕获同步的
          // foregroundTaskId→后台 路径。否则会落到
          // 下面的 Ctrl+B 检查，而它匹配 status==='backgrounded'
          // 并错误地返回 backgroundedByUser:true。（bug 020/021）
          continue;
        }
        shellCommand.kill();
      }

      // 检查该前台任务是否通过 backgroundAll() 转入后台（ctrl+b）
      if (foregroundTaskId) {
        if (shellCommand.status === 'backgrounded') {
          return {
            stdout: '',
            stderr: '',
            code: 0,
            interrupted: false,
            backgroundTaskId: foregroundTaskId,
            backgroundedByUser: true
          };
        }
      }

      // 该更新进度了
      const elapsed = Date.now() - startTime;
      const elapsedSeconds = Math.floor(elapsed / 1000);

      // 超过阈值后显示转入后台的 UI 提示
      if (!isBackgroundTasksDisabled && backgroundShellId === undefined && elapsedSeconds >= PROGRESS_THRESHOLD_MS / 1000 && setToolJSX) {
        if (!foregroundTaskId) {
          foregroundTaskId = registerForeground({
            command,
            description: description || command,
            shellCommand,
            agentId
          }, setAppState, toolUseId);
        }
        setToolJSX({
          jsx: <BackgroundHint />,
          shouldHidePromptInput: false,
          shouldContinueAnimation: true,
          showSpinner: true
        });
      }
      yield {
        type: 'progress',
        fullOutput,
        output: lastProgressOutput,
        elapsedTimeSeconds: elapsedSeconds,
        totalLines: lastTotalLines,
        totalBytes: lastTotalBytes,
        taskId: shellCommand.taskOutput.taskId,
        ...(timeout ? {
          timeoutMs
        } : undefined)
      };
      nextProgressTime = Date.now() + PROGRESS_INTERVAL_MS;
    }
  } finally {
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId);
    // 确保每条退出路径都会执行清理（成功、拒绝、中止）。
    // 转入后台时跳过——那些任务的清理由 LocalShellTask 负责。
    // 与 main 的 #21105 一致。
    if (!backgroundShellId && shellCommand.status !== 'backgrounded') {
      if (foregroundTaskId) {
        unregisterForeground(foregroundTaskId, setAppState);
      }
      shellCommand.cleanup();
    }
  }
}