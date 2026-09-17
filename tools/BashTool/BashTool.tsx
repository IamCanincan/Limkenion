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
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js';
import type { SetToolJSXFn, ToolCallProgress, ToolUseContext, ValidationResult } from '../../Tool.js';
import { buildTool, type ToolDef } from '../../Tool.js';
import { backgroundExistingForegroundTask, markTaskNotified, registerForeground, spawnShellTask, unregisterForeground } from '../../tasks/LocalShellTask/LocalShellTask.js';
import type { AgentId } from '../../types/ids.js';
import type { AssistantMessage } from '../../types/message.js';
import { parseForSecurity } from '../../utils/bash/ast.js';
import { splitCommand_DEPRECATED, splitCommandWithOperators } from '../../utils/bash/commands.js';
import { extractLimkenionHints } from '../../utils/limkenionHints.js';
import { detectCodeIndexingFromCommand } from '../../utils/codeIndexing.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { isENOENT, ShellError } from '../../utils/errors.js';
import { detectFileEncoding, detectLineEndings, getFileModificationTime, writeTextContent } from '../../utils/file.js';
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js';
import { truncate } from '../../utils/format.js';
import { getFsImplementation } from '../../utils/fsOperations.js';
import { lazySchema } from '../../utils/lazySchema.js';
import { expandPath } from '../../utils/path.js';
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js';
import { maybeRecordPluginHint } from '../../utils/plugins/hintRecommendation.js';
import { exec } from '../../utils/Shell.js';
import type { ExecResult } from '../../utils/ShellCommand.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { semanticBoolean } from '../../utils/semanticBoolean.js';
import { semanticNumber } from '../../utils/semanticNumber.js';
import { EndTruncatingAccumulator } from '../../utils/stringUtils.js';
import { getTaskOutputPath } from '../../utils/task/diskOutput.js';
import { TaskOutput } from '../../utils/task/TaskOutput.js';
import { isOutputLineTruncated } from '../../utils/terminal.js';
import { buildLargeToolResultMessage, ensureToolResultsDir, generatePreview, getToolResultPath, PREVIEW_SIZE_BYTES } from '../../utils/toolResultStorage.js';
import { userFacingName as fileEditUserFacingName } from '../FileEditTool/UI.js';
import { trackGitOperations } from '../shared/gitOperationTracking.js';
import { bashToolHasPermission, commandHasAnyCd, matchWildcardPattern, permissionRuleExtractPrefix } from './bashPermissions.js';
import { interpretCommandResult } from './commandSemantics.js';
import { getDefaultTimeoutMs, getMaxTimeoutMs, getSimplePrompt } from './prompt.js';
import { checkReadOnlyConstraints } from './readOnlyValidation.js';
import { parseSedEditCommand } from './sedEditParser.js';
import { shouldUseSandbox } from './shouldUseSandbox.js';
import { BASH_TOOL_NAME } from './toolName.js';
import { BackgroundHint, renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, renderToolUseProgressMessage, renderToolUseQueuedMessage } from './UI.js';
import { buildImageToolResult, isImageOutput, resetCwdIfOutsideProject, resizeShellImageOutput, stdErrAppendShellResetMessage, stripEmptyLines } from './utils.js';
const EOL = '\n';

// 进度显示常量
const PROGRESS_THRESHOLD_MS = 2000; // 2 秒后展示进度
// 在 assistant 模式下，主 agent 中的阻塞型 bash 在这么多毫秒后自动转入后台
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;

// 用于可折叠展示的搜索命令（grep、find 等）
const BASH_SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis']);

// 用于可折叠展示的读取/查看命令（cat、head 等）
const BASH_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more',
// 分析命令
'wc', 'stat', 'file', 'strings',
// 数据处理——常用于在管道中解析/转换文件内容
'jq', 'awk', 'cut', 'sort', 'uniq', 'tr']);

// 用于可折叠展示的目录列举命令（ls、tree、du）。
// 从 BASH_READ_COMMANDS 中拆分出来，使摘要显示 "Listed N directories"
// 而不是有误导性的 "Read N files"。
const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du']);

// 在任何位置都语义中立的命令——纯输出/状态命令，
// 不改变整个管道的读取/搜索性质。
// 例如 `ls dir && echo "---" && ls dir2` 仍是只读复合命令。
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':' // bash 空操作
]);

// 成功时通常不产生 stdout 的命令
const BASH_SILENT_COMMANDS = new Set(['mv', 'cp', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp', 'touch', 'ln', 'cd', 'export', 'unset', 'wait']);

/**
 * 检查 bash 命令是否为搜索或读取操作。
 * 用于判断该命令在 UI 中是否应折叠。
 * 返回一个对象，表明它是搜索还是读取操作。
 *
 * 对于管道（例如 `cat file | bq`），所有部分都必须是搜索/读取命令，
 * 整个命令才被视为可折叠。
 *
 * 语义中立命令（echo、printf、true、false、:）在任何位置都被跳过，
 * 因为它们是纯输出/状态命令，不影响管道的读取/搜索
 * 性质（例如 `ls dir && echo "---" && ls dir2` 仍是读取）。
 */
export function isSearchOrReadBashCommand(command: string): {
  isSearch: boolean;
  isRead: boolean;
  isList: boolean;
} {
  let partsWithOperators: string[];
  try {
    partsWithOperators = splitCommandWithOperators(command);
  } catch {
    // 如果因语法格式错误而无法解析该命令，
    // 它就不是搜索/读取命令
    return {
      isSearch: false,
      isRead: false,
      isList: false
    };
  }
  if (partsWithOperators.length === 0) {
    return {
      isSearch: false,
      isRead: false,
      isList: false
    };
  }
  let hasSearch = false;
  let hasRead = false;
  let hasList = false;
  let hasNonNeutralCommand = false;
  let skipNextAsRedirectTarget = false;
  for (const part of partsWithOperators) {
    if (skipNextAsRedirectTarget) {
      skipNextAsRedirectTarget = false;
      continue;
    }
    if (part === '>' || part === '>>' || part === '>&') {
      skipNextAsRedirectTarget = true;
      continue;
    }
    if (part === '||' || part === '&&' || part === '|' || part === ';') {
      continue;
    }
    const baseCommand = part.trim().split(/\s+/)[0];
    if (!baseCommand) {
      continue;
    }
    if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(baseCommand)) {
      continue;
    }
    hasNonNeutralCommand = true;
    const isPartSearch = BASH_SEARCH_COMMANDS.has(baseCommand);
    const isPartRead = BASH_READ_COMMANDS.has(baseCommand);
    const isPartList = BASH_LIST_COMMANDS.has(baseCommand);
    if (!isPartSearch && !isPartRead && !isPartList) {
      return {
        isSearch: false,
        isRead: false,
        isList: false
      };
    }
    if (isPartSearch) hasSearch = true;
    if (isPartRead) hasRead = true;
    if (isPartList) hasList = true;
  }

  // 只有中立命令（例如仅 "echo foo"）——不可折叠
  if (!hasNonNeutralCommand) {
    return {
      isSearch: false,
      isRead: false,
      isList: false
    };
  }
  return {
    isSearch: hasSearch,
    isRead: hasRead,
    isList: hasList
  };
}

/**
 * 检查 bash 命令在成功时是否预期不产生 stdout。
 * 用于在 UI 中显示 "Done" 而不是 "(No output)"。
 */
function isSilentBashCommand(command: string): boolean {
  let partsWithOperators: string[];
  try {
    partsWithOperators = splitCommandWithOperators(command);
  } catch {
    return false;
  }
  if (partsWithOperators.length === 0) {
    return false;
  }
  let hasNonFallbackCommand = false;
  let lastOperator: string | null = null;
  let skipNextAsRedirectTarget = false;
  for (const part of partsWithOperators) {
    if (skipNextAsRedirectTarget) {
      skipNextAsRedirectTarget = false;
      continue;
    }
    if (part === '>' || part === '>>' || part === '>&') {
      skipNextAsRedirectTarget = true;
      continue;
    }
    if (part === '||' || part === '&&' || part === '|' || part === ';') {
      lastOperator = part;
      continue;
    }
    const baseCommand = part.trim().split(/\s+/)[0];
    if (!baseCommand) {
      continue;
    }
    if (lastOperator === '||' && BASH_SEMANTIC_NEUTRAL_COMMANDS.has(baseCommand)) {
      continue;
    }
    hasNonFallbackCommand = true;
    if (!BASH_SILENT_COMMANDS.has(baseCommand)) {
      return false;
    }
  }
  return hasNonFallbackCommand;
}

// 不应自动转入后台的命令
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ['sleep' // 除非用户显式转入后台，sleep 应在前台运行
];

// 在模块加载时检查后台任务是否被禁用
const isBackgroundTasksDisabled =
// eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: schema must be defined at module load
isEnvTruthy(process.env.LIMKENION_DISABLE_BACKGROUND_TASKS);
const fullInputSchema = lazySchema(() => z.strictObject({
  command: z.string().describe('要执行的命令'),
  timeout: semanticNumber(z.number().optional()).describe(`可选的超时时间（毫秒，最大 ${getMaxTimeoutMs()}）`),
  description: z.string().optional().describe(`用主动语态清晰、简洁地描述此命令的作用。不要在描述中使用"complex"或"risk"之类的词——只需描述它做了什么。

对于简单命令（git、npm、标准 CLI 工具），保持简短（5-10 个词）：
- ls → "列出当前目录中的文件"
- git status → "显示工作树状态"
- npm install → "安装包依赖"

对于难以一眼看懂的复杂命令（管道命令、晦涩的标志等），补充足够上下文说明其作用：
- find . -name "*.tmp" -exec rm {} \\; → "递归查找并删除所有 .tmp 文件"
- git reset --hard origin/main → "丢弃所有本地更改并与远程 main 保持一致"
- curl -s url | jq '.data[]' → "从 URL 获取 JSON 并提取 data 数组元素"`),
  run_in_background: semanticBoolean(z.boolean().optional()).describe(`设为 true 以在后台运行此命令。稍后可用 Read 读取其输出。`),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe('设为 true 可危险地覆盖沙箱模式，在无沙箱的情况下运行命令。'),
  _simulatedSedEdit: z.object({
    filePath: z.string(),
    newContent: z.string()
  }).optional().describe('内部：来自预览的预计算 sed 编辑结果')
}));

// 始终从模型可见的 schema 中剔除 _simulatedSedEdit。这是仅供内部使用的
// 字段，由 SedEditPermissionRequest 在用户批准 sed 编辑预览后设置。
// 将其暴露在 schema 中会允许模型通过把无害命令与任意文件写入配对，
// 从而绕过权限检查与沙箱。
// 当后台任务被禁用时，还会条件性地移除 run_in_background。
const inputSchema = lazySchema(() => isBackgroundTasksDisabled ? fullInputSchema().omit({
  run_in_background: true,
  _simulatedSedEdit: true
}) : fullInputSchema().omit({
  _simulatedSedEdit: true
}));
type InputSchema = ReturnType<typeof inputSchema>;

// 使用 fullInputSchema 来做类型，以始终包含 run_in_background
// （即使它已从 schema 中剥离，代码仍需处理它）
export type BashToolInput = z.infer<ReturnType<typeof fullInputSchema>>;
const COMMON_BACKGROUND_COMMANDS = ['npm', 'yarn', 'pnpm', 'node', 'python', 'python3', 'go', 'cargo', 'make', 'docker', 'terraform', 'webpack', 'vite', 'jest', 'pytest', 'curl', 'wget', 'build', 'test', 'serve', 'watch', 'dev'] as const;
function getCommandTypeForLogging(command: string): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  const parts = splitCommand_DEPRECATED(command);
  if (parts.length === 0) return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;

  // 检查命令的每个部分，看是否有匹配常见后台命令
  for (const part of parts) {
    const baseCommand = part.split(' ')[0] || '';
    if (COMMON_BACKGROUND_COMMANDS.includes(baseCommand as (typeof COMMON_BACKGROUND_COMMANDS)[number])) {
      return baseCommand as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    }
  }
  return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
}
const outputSchema = lazySchema(() => z.object({
  stdout: z.string().describe('命令的标准输出'),
  stderr: z.string().describe('命令的标准错误输出'),
  rawOutputPath: z.string().optional().describe('大型 MCP 工具输出的原始输出文件路径'),
  interrupted: z.boolean().describe('命令是否被中断'),
  isImage: z.boolean().optional().describe('指示 stdout 是否包含图像数据的标志'),
  backgroundTaskId: z.string().optional().describe('命令在后台运行时后台任务的 ID'),
  backgroundedByUser: z.boolean().optional().describe('用户是否用 Ctrl+B 手动将命令放入后台'),
  assistantAutoBackgrounded: z.boolean().optional().describe('助理模式是否将长时间运行的阻塞命令自动放入后台'),
  dangerouslyDisableSandbox: z.boolean().optional().describe('指示沙箱模式是否被覆盖的标志'),
  returnCodeInterpretation: z.string().optional().describe('对具有特殊含义的非错误退出码的语义解释'),
  noOutputExpected: z.boolean().optional().describe('命令是否预期在成功时不产生任何输出'),
  structuredContent: z.array(z.any()).optional().describe('结构化内容块'),
  persistedOutputPath: z.string().optional().describe('tool-results 目录中持久化的完整输出路径（当输出过大无法内联时设置）'),
  persistedOutputSize: z.number().optional().describe('输出的总字节大小（当输出过大无法内联时设置）')
}));
type OutputSchema = ReturnType<typeof outputSchema>;
export type Out = z.infer<OutputSchema>;

// 从集中式类型重新导出 BashProgress 以打破导入循环
export type { BashProgress } from '../../types/tools.js';
import type { BashProgress } from '../../types/tools.js';

/**
 * 检查命令是否允许被自动转入后台
 * @param command 要检查的命令
 * @returns 对于不应自动转入后台的命令（如 sleep）返回 false
 */
function isAutobackgroundingAllowed(command: string): boolean {
  const parts = splitCommand_DEPRECATED(command);
  if (parts.length === 0) return true;

  // 获取第一部分，即基础命令
  const baseCommand = parts[0]?.trim();
  if (!baseCommand) return true;
  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(baseCommand);
}

/**
 * 检测应改用 Monitor 的独立或前置 `sleep N` 模式。
 * 可捕获 `sleep 5`、`sleep 5 && check`、`sleep 5; check`——但
 * 不捕获管道、子 shell 或脚本中的 sleep（那些没问题）。
 */
export function detectBlockedSleepPattern(command: string): string | null {
  const parts = splitCommand_DEPRECATED(command);
  if (parts.length === 0) return null;
  const first = parts[0]?.trim() ?? '';
  // 作为第一个子命令的裸 `sleep N` 或 `sleep N.N`。
  // 浮点时长（sleep 0.5）是允许的——那是合理的节奏控制，而非轮询。
  const m = /^sleep\s+(\d+)\s*$/.exec(first);
  if (!m) return null;
  const secs = parseInt(m[1]!, 10);
  if (secs < 2) return null; // 低于 2 秒的 sleep 没问题（限流、节奏控制）

  // 单独 `sleep N` → "what are you waiting for?"
  // `sleep N && check` → "use Monitor { command: check }"
  const rest = parts.slice(1).join(' ').trim();
  return rest ? `sleep ${secs} followed by: ${rest}` : `standalone sleep ${secs}`;
}

/**
 * 检查命令是否包含不应在沙箱中运行的工具
 * 包括：
 * - 基于动态配置的禁用命令和子串（limkenion_sandbox_disabled_commands）
 * - 来自 settings.json 的用户配置命令（sandbox.excludedCommands）
 *
 * 用户配置的命令支持与权限规则相同的模式语法：
 * - 精确匹配："npm run lint"
 * - 前缀模式："npm run test:*"
 */

type SimulatedSedEditResult = {
  data: Out;
};
type SimulatedSedEditContext = Pick<ToolUseContext, 'readFileState' | 'updateFileHistoryState'>;

/**
 * 直接应用模拟的 sed 编辑，而不运行 sed。
 * 权限对话框用它来确保用户预览的内容
 * 与实际写入文件的内容完全一致。
 */
async function applySedEdit(simulatedEdit: {
  filePath: string;
  newContent: string;
}, toolUseContext: SimulatedSedEditContext, parentMessage?: AssistantMessage): Promise<SimulatedSedEditResult> {
  const {
    filePath,
    newContent
  } = simulatedEdit;
  const absoluteFilePath = expandPath(filePath);
  const fs = getFsImplementation();

  // 读取原始内容以用于 VS Code 通知
  const encoding = detectFileEncoding(absoluteFilePath);
  let originalContent: string;
  try {
    originalContent = await fs.readFile(absoluteFilePath, {
      encoding
    });
  } catch (e) {
    if (isENOENT(e)) {
      return {
        data: {
          stdout: '',
          stderr: `sed: ${filePath}: No such file or directory\nExit code 1`,
          interrupted: false
        }
      };
    }
    throw e;
  }

  // 在修改前跟踪文件历史（以支持撤销）
  if (fileHistoryEnabled() && parentMessage) {
    await fileHistoryTrackEdit(toolUseContext.updateFileHistoryState, absoluteFilePath, parentMessage.uuid);
  }

  // 检测行尾并写入新内容
  const endings = detectLineEndings(absoluteFilePath);
  writeTextContent(absoluteFilePath, newContent, encoding, endings);

  // 就文件变更通知 VS Code
  notifyVscodeFileUpdated(absoluteFilePath, originalContent, newContent);

  // 更新读取时间戳，以阻止过期写入
  toolUseContext.readFileState.set(absoluteFilePath, {
    content: newContent,
    timestamp: getFileModificationTime(absoluteFilePath),
    offset: undefined,
    limit: undefined
  });

  // 返回匹配 sed 输出格式的成功结果（sed 成功时不产生输出）
  return {
    data: {
      stdout: '',
      stderr: '',
      interrupted: false
    }
  };
}
export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  searchHint: 'execute shell commands',
  // 30K 字符——工具结果持久化阈值
  maxResultSizeChars: 30_000,
  strict: true,
  async description({
    description
  }) {
    return description || 'Run shell command';
  },
  async prompt() {
    return getSimplePrompt();
  },
  isConcurrencySafe(input) {
    return this.isReadOnly?.(input) ?? false;
  },
  isReadOnly(input) {
    const compoundCommandHasCd = commandHasAnyCd(input.command);
    const result = checkReadOnlyConstraints(input, compoundCommandHasCd);
    return result.behavior === 'allow';
  },
  toAutoClassifierInput(input) {
    return input.command;
  },
  async preparePermissionMatcher({
    command
  }) {
    // 钩子的 `if` 过滤是“不匹配 → 跳过钩子”（类拒绝语义），因此
    // 只要有任一子命令匹配，复合命令就必须触发钩子。若不
    // 拆分，`ls && git push` 会绕过 `Bash(git *)` 安全钩子。
    const parsed = await parseForSecurity(command);
    if (parsed.kind !== 'simple') {
      // 无法解析/过于复杂：通过运行钩子来安全失败。
      return () => true;
    }
    // 基于 argv 匹配（剥离前导 VAR=val），因此 `FOO=bar git push` 仍能
    // 匹配 `Bash(git *)`。
    const subcommands = parsed.commands.map(c => c.argv.join(' '));
    return pattern => {
      const prefix = permissionRuleExtractPrefix(pattern);
      return subcommands.some(cmd => {
        if (prefix !== null) {
          return cmd === prefix || cmd.startsWith(`${prefix} `);
        }
        return matchWildcardPattern(pattern, cmd);
      });
    };
  },
  isSearchOrReadCommand(input) {
    const parsed = inputSchema().safeParse(input);
    if (!parsed.success) return {
      isSearch: false,
      isRead: false,
      isList: false
    };
    return isSearchOrReadBashCommand(parsed.data.command);
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName(input) {
    if (!input) {
      return 'Bash';
    }
    // 将 sed 原地编辑渲染为文件编辑
    if (input.command) {
      const sedInfo = parseSedEditCommand(input.command);
      if (sedInfo) {
        return fileEditUserFacingName({
          file_path: sedInfo.filePath,
          old_string: 'x'
        });
      }
    }
    // 先检查环境变量：shouldUseSandbox → splitCommand_DEPRECATED → shell-quote 的
    // 每次调用 `new RegExp`。userFacingName 会为历史中每条 bash
    // 消息逐次渲染运行；约 50 条消息加上一个难以分词的命令就会
    // 超过 shimmer tick → 过渡中止 → 无限重试（#21605）。
    return isEnvTruthy(process.env.LIMKENION_BASH_SANDBOX_SHOW_INDICATOR) && shouldUseSandbox(input) ? 'SandboxedBash' : 'Bash';
  },
  getToolUseSummary(input) {
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
  getActivityDescription(input) {
    if (!input?.command) {
      return 'Running command';
    }
    const desc = input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH);
    return `Running ${desc}`;
  },
  async validateInput(input: BashToolInput): Promise<ValidationResult> {
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
  async checkPermissions(input, context): Promise<PermissionResult> {
    return bashToolHasPermission(input, context);
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  // BashToolResultMessage 展示 <OutputLine content={stdout}> + stderr。
  // UI 从不展示 persistedOutputPath 包装、backgroundInfo——那些是
  // 面向模型的（下方的 mapToolResult...）。
  extractSearchText({
    stdout,
    stderr
  }) {
    return stderr ? `${stdout}\n${stderr}` : stdout;
  },
  mapToolResultToToolResultBlockParam({
    interrupted,
    stdout,
    stderr,
    isImage,
    backgroundTaskId,
    backgroundedByUser,
    assistantAutoBackgrounded,
    structuredContent,
    persistedOutputPath,
    persistedOutputSize
  }, toolUseID): ToolResultBlockParam {
    // 处理结构化内容
    if (structuredContent && structuredContent.length > 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: structuredContent
      };
    }

    // 对于图像数据，格式化为 Limkenion 的图像内容块
    if (isImage) {
      const block = buildImageToolResult(stdout, toolUseID);
      if (block) return block;
    }
    let processedStdout = stdout;
    if (stdout) {
      // 替换任何前导换行或仅含空白的行
      processedStdout = stdout.replace(/^(\s*\n)+/, '');
      // 仍像以前一样裁剪末尾
      processedStdout = processedStdout.trimEnd();
    }

    // 对于已持久化到磁盘的大量输出，为模型构建 <persisted-output>
    // 消息。UI 从不见到它——UI 使用 data.stdout。
    if (persistedOutputPath) {
      const preview = generatePreview(processedStdout, PREVIEW_SIZE_BYTES);
      processedStdout = buildLargeToolResultMessage({
        filepath: persistedOutputPath,
        originalSize: persistedOutputSize ?? 0,
        isJson: false,
        preview: preview.preview,
        hasMore: preview.hasMore
      });
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
      type: 'tool_result',
      content: [processedStdout, errorMessage, backgroundInfo].filter(Boolean).join('\n'),
      is_error: interrupted
    };
  },
  async call(input: BashToolInput, toolUseContext, _canUseTool?: CanUseToolFn, parentMessage?: AssistantMessage, onProgress?: ToolCallProgress<BashProgress>) {
    // 处理模拟的 sed 编辑——直接应用而不运行 sed
    // 这确保用户预览的内容与实际写入的内容完全一致
    if (input._simulatedSedEdit) {
      return applySedEdit(input._simulatedSedEdit, toolUseContext, parentMessage);
    }
    const {
      abortController,
      getAppState,
      setAppState,
      setToolJSX
    } = toolUseContext;
    const stdoutAccumulator = new EndTruncatingAccumulator();
    let stderrForShellReset = '';
    let interpretationResult: ReturnType<typeof interpretCommandResult> | undefined;
    let progressCounter = 0;
    let wasInterrupted = false;
    let result: ExecResult;
    const isMainThread = !toolUseContext.agentId;
    const preventCwdChanges = !isMainThread;
    try {
      // 使用 runShellCommand 的新的异步生成器版本
      const commandGenerator = runShellCommand({
        input,
        abortController,
        // 使用始终共享的任务通道，使异步 agent 的后台
        // bash 任务真正被注册（并可在 agent 退出时终止）。
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
        setToolJSX,
        preventCwdChanges,
        isMainThread,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId
      });

      // 消费生成器并捕获返回值
      let generatorResult;
      do {
        generatorResult = await commandGenerator.next();
        if (!generatorResult.done && onProgress) {
          const progress = generatorResult.value;
          onProgress({
            toolUseID: `bash-progress-${progressCounter++}`,
            data: {
              type: 'bash_progress',
              output: progress.output,
              fullOutput: progress.fullOutput,
              elapsedTimeSeconds: progress.elapsedTimeSeconds,
              totalLines: progress.totalLines,
              totalBytes: progress.totalBytes,
              taskId: progress.taskId,
              timeoutMs: progress.timeoutMs
            }
          });
        }
      } while (!generatorResult.done);

      // 从生成器的返回值获取最终结果
      result = generatorResult.value;
      trackGitOperations(input.command, result.code, result.stdout);
      const isInterrupt = result.interrupted && abortController.signal.reason === 'interrupt';

      // stderr 交错在 stdout 中（已合并 fd）——result.stdout 包含两者
      stdoutAccumulator.append((result.stdout || '').trimEnd() + EOL);

      // 使用语义规则解读命令结果
      interpretationResult = interpretCommandResult(input.command, result.code, result.stdout || '', '');

      // 检查 git index.lock 错误（stderr 现在在 stdout 中）
      if (result.stdout && result.stdout.includes(".git/index.lock': File exists")) {
        logEvent('limkenion_git_index_lock_error', {});
      }
      if (interpretationResult.isError && !isInterrupt) {
        // 仅在确实是错误时才添加退出码
        if (result.code !== 0) {
          stdoutAccumulator.append(`Exit code ${result.code}`);
        }
      }
      if (!preventCwdChanges) {
        const appState = getAppState();
        if (resetCwdIfOutsideProject(appState.toolPermissionContext)) {
          stderrForShellReset = stdErrAppendShellResetMessage('');
        }
      }

      // 如有沙箱违规则标注到输出中（stderr 在 stdout 中）
      const outputWithSbFailures = SandboxManager.annotateStderrWithSandboxFailures(input.command, result.stdout || '');
      if (result.preSpawnError) {
        throw new Error(result.preSpawnError);
      }
      if (interpretationResult.isError && !isInterrupt) {
        // stderr 已合并到 stdout（合并 fd）；outputWithSbFailures
        // 已包含完整输出。为 stdout 传 '' 以避免
        // 在 getErrorParts() 和 processBashCommand 中重复。
        throw new ShellError('', outputWithSbFailures, result.code, result.interrupted);
      }
      wasInterrupted = result.interrupted;
    } finally {
      if (setToolJSX) setToolJSX(null);
    }

    // 从累加器获取最终字符串
    const stdout = stdoutAccumulator.toString();

    // 大量输出：磁盘上的文件超过 getMaxOutputLength() 字节。
    // stdout 已包含第一块（来自 getStdout()）。将输出文件
    // 复制到 tool-results 目录，以便模型通过 FileRead
    // 读取。如果超过 64 MB，则在复制后截断。
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
        // 文件可能已不存在——stdout 预览已足够
      }
    }
    const commandType = input.command.split(' ')[0];
    logEvent('limkenion_bash_tool_command_executed', {
      command_type: commandType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      stdout_length: stdout.length,
      stderr_length: 0,
      exit_code: result.code,
      interrupted: wasInterrupted
    });

    // 记录代码索引工具的使用
    const codeIndexingTool = detectCodeIndexingFromCommand(input.command);
    if (codeIndexingTool) {
      logEvent('limkenion_code_indexing_tool_used', {
        tool: codeIndexingTool as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        source: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: result.code === 0
      });
    }
    let strippedStdout = stripEmptyLines(stdout);

    // Limkenion 提示协议：以 LIMKENIONCODE=1 为开关的 CLI/SDK 会向
    // stderr（此处已合并到 stdout）发出 `<limkenion-hint />` 标签。扫描、
    // 记录以供 useLimkenionHintRecommendation 展示，然后剥离，
    // 使模型永远看不到该标签——一条零 token 的旁路通道。
    // 剥离无条件执行（子代理的输出也必须保持干净）；
    // 只有对话框记录是主线程专属的。
    const extracted = extractLimkenionHints(strippedStdout, input.command);
    strippedStdout = extracted.stripped;
    if (isMainThread && extracted.hints.length > 0) {
      for (const hint of extracted.hints) maybeRecordPluginHint(hint);
    }
    let isImage = isImageOutput(strippedStdout);

    // 如果存在图像则限制其尺寸 + 大小（CC-304——见
    // resizeShellImageOutput）。限定解码缓冲区的作用域，使其能在
    // 我们构建输出 Out 对象之前被回收。
    let compressedStdout = strippedStdout;
    if (isImage) {
      const resized = await resizeShellImageOutput(strippedStdout, result.outputFilePath, persistedOutputSize);
      if (resized) {
        compressedStdout = resized;
      } else {
        // 解析失败或文件过大（例如超过 MAX_IMAGE_FILE_SIZE）。
        // 让 isImage 与我们实际发送的内容保持同步，使 UI 标签保持
        // 准确——mapToolResultToToolResultBlockParam 的防御性
        // 兜底会发送文本，而不是图像块。
        isImage = false;
      }
    }
    const data: Out = {
      stdout: compressedStdout,
      stderr: stderrForShellReset,
      interrupted: wasInterrupted,
      isImage,
      returnCodeInterpretation: interpretationResult?.message,
      noOutputExpected: isSilentBashCommand(input.command),
      backgroundTaskId: result.backgroundTaskId,
      backgroundedByUser: result.backgroundedByUser,
      assistantAutoBackgrounded: result.assistantAutoBackgrounded,
      dangerouslyDisableSandbox: 'dangerouslyDisableSandbox' in input ? input.dangerouslyDisableSandbox as boolean | undefined : undefined,
      persistedOutputPath,
      persistedOutputSize
    };
    return {
      data
    };
  },
  renderToolUseErrorMessage,
  isResultTruncated(output: Out): boolean {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr);
  }
} satisfies ToolDef<InputSchema, Out, BashProgress>);
async function* runShellCommand({
  input,
  abortController,
  setAppState,
  setToolJSX,
  preventCwdChanges,
  isMainThread,
  toolUseId,
  agentId
}: {
  input: BashToolInput;
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
  totalBytes?: number;
  taskId?: string;
  timeoutMs?: number;
}, ExecResult, void> {
  const {
    command,
    description,
    timeout,
    run_in_background
  } = input;
  const timeoutMs = timeout || getDefaultTimeoutMs();
  let fullOutput = '';
  let lastProgressOutput = '';
  let lastTotalLines = 0;
  let lastTotalBytes = 0;
  let backgroundShellId: string | undefined = undefined;
  let assistantAutoBackgrounded = false;

  // 进度信号：由共享轮询器的 onProgress 回调兑现，
  // 唤醒生成器以产出一条进度更新。
  let resolveProgress: (() => void) | null = null;
  function createProgressSignal(): Promise<null> {
    return new Promise<null>(resolve => {
      resolveProgress = () => resolve(null);
    });
  }

  // 判断是否应启用自动转后台
  // 仅对允许自动转后台的命令启用，
  // 且后台任务未被禁用时启用
  const shouldAutoBackground = !isBackgroundTasksDisabled && isAutobackgroundingAllowed(command);
  const shellCommand = await exec(command, abortController.signal, 'bash', {
    timeout: timeoutMs,
    onProgress(lastLines, allLines, totalLines, totalBytes, isIncomplete) {
      lastProgressOutput = lastLines;
      fullOutput = allLines;
      lastTotalLines = totalLines;
      lastTotalBytes = isIncomplete ? totalBytes : 0;
      // 唤醒生成器以产出新的进度数据
      const resolve = resolveProgress;
      if (resolve) {
        resolveProgress = null;
        resolve();
      }
    },
    preventCwdChanges,
    shouldUseSandbox: shouldUseSandbox(input),
    shouldAutoBackground
  });

  // 开始执行命令
  const resultPromise = shellCommand.result;

  // 派生后台任务并返回其 ID 的辅助函数
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
        // 这里无法直接访问 getAppState，但 spawn
        // 在派生过程中实际并不使用它
        throw new Error('getAppState not available in runShellCommand context');
      },
      setAppState
    });
    return handle.taskId;
  }

  // 启动转后台并可选记录的辅助函数
  function startBackgrounding(eventName: string, backgroundFn?: (shellId: string) => void): void {
    // 如果已注册前台任务（通过进度循环中的 registerForeground），
    // 则原地将其转入后台，而不是重新派生。重新派生
    // 会覆盖 tasks[taskId]、发出重复的 task_started SDK 事件，
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

    // 未注册前台任务——派生新的后台任务
    // 注意：spawn 虽为异步，但本质上是同步的
    void spawnBackgroundTask().then(shellId => {
      backgroundShellId = shellId;

      // 唤醒生成器的 Promise.race，使其看到 backgroundShellId。
      // 否则，如果轮询器已停止为该任务计时
      // （无输出 + 共享轮询器与相邻 stopPolling 调用的竞态）
      // 且进程卡在 I/O 上，第 ~1357 行的竞态将永远
      // 无法解决，生成器即使已转入后台也会死锁。
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

  // 如启用则在超时时设置自动转后台
  // 仅将允许自动转后台的命令转入后台（不包括 sleep 等）
  if (shellCommand.onTimeout && shouldAutoBackground) {
    shellCommand.onTimeout(backgroundFn => {
      startBackgrounding('limkenion_bash_command_timeout_backgrounded', backgroundFn);
    });
  }

  // 在 assistant 模式下，主 agent 应保持响应。阻塞型命令在
  // ASSISTANT_BLOCKING_BUDGET_MS 后自动转入后台，使 agent 能继续
  // 协调而不是等待。命令继续运行——无状态丢失。
  if (feature('KAIROS') && getKairosActive() && isMainThread && !isBackgroundTasksDisabled && run_in_background !== true) {
    setTimeout(() => {
      if (shellCommand.status === 'running' && backgroundShellId === undefined) {
        assistantAutoBackgrounded = true;
        startBackgrounding('limkenion_bash_command_assistant_auto_backgrounded');
      }
    }, ASSISTANT_BLOCKING_BUDGET_MS).unref();
  }

  // 处理 Limkenion 明确要求后台运行的情况
  // 当通过 run_in_background 显式请求时，始终遵从该请求，
  // 无论命令类型如何（isAutobackgroundingAllowed 仅适用于自动转后台）
  // 如果后台任务被禁用则跳过——改为在前台运行
  if (run_in_background === true && !isBackgroundTasksDisabled) {
    const shellId = await spawnBackgroundTask();
    logEvent('limkenion_bash_command_explicitly_backgrounded', {
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

  // 等待初始阈值后再展示进度
  const startTime = Date.now();
  let foregroundTaskId: string | undefined = undefined;
  {
    const initialResult = await Promise.race([resultPromise, new Promise<null>(resolve => {
      const t = setTimeout((r: (v: null) => void) => r(null), PROGRESS_THRESHOLD_MS, resolve);
      t.unref();
    })]);
    if (initialResult !== null) {
      shellCommand.cleanup();
      return initialResult;
    }
    if (backgroundShellId) {
      return {
        stdout: '',
        stderr: '',
        code: 0,
        interrupted: false,
        backgroundTaskId: backgroundShellId,
        assistantAutoBackgrounded
      };
    }
  }

  // 开始轮询输出文件以获取进度。轮询器的 #tick 每秒
  // 调用 onProgress，从而兑现下方的 progressSignal。
  TaskOutput.startPolling(shellCommand.taskOutput.taskId);

  // 进度循环：唤醒由共享轮询器调用 onProgress 驱动，
  // 后者兑现 progressSignal。
  try {
    while (true) {
      const progressSignal = createProgressSignal();
      const result = await Promise.race([resultPromise, progressSignal]);
      if (result !== null) {
        // 竞态：转后台已触发（15 秒定时器 / onTimeout / Ctrl+B），但命令
        // 在下一次轮询计时前就完成了。#handleExit 会设置
        // backgroundTaskId 但跳过 outputFilePath（它假定后台
        // 消息或 <task_notification> 会携带该路径）。剥离
        // backgroundTaskId，使模型看到一条干净的已完成命令，
        // 为大量输出重建 outputFilePath，并抑制来自 .then() 处理器的
        // 冗余 <task_notification>。
        // 检查 result.backgroundTaskId（而非闭包变量），以同时覆盖
        // 直接调用 shellCommand.background() 的 Ctrl+B。
        if (result.backgroundTaskId !== undefined) {
          markTaskNotified(result.backgroundTaskId, setAppState);
          const fixedResult: ExecResult = {
            ...result,
            backgroundTaskId: undefined
          };
          // 复刻 ShellCommand.#handleExit 中因设置了 #backgroundTaskId
          // 而被跳过的大量输出分支。
          const {
            taskOutput
          } = shellCommand;
          if (taskOutput.stdoutToFile && !taskOutput.outputFileRedundant) {
            fixedResult.outputFilePath = taskOutput.path;
            fixedResult.outputFileSize = taskOutput.outputFileSize;
            fixedResult.outputTaskId = taskOutput.taskId;
          }
          shellCommand.cleanup();
          return fixedResult;
        }
        // 命令已完成——返回实际结果
        // 如果我们注册为前台任务，则注销它
        if (foregroundTaskId) {
          unregisterForeground(foregroundTaskId, setAppState);
        }
        // 清理前台命令的流资源
        // （后台化命令由 LocalShellTask 清理）
        shellCommand.cleanup();
        return result;
      }

      // 检查命令是否已转入后台（通过旧机制或新的 backgroundAll）
      if (backgroundShellId) {
        return {
          stdout: '',
          stderr: '',
          code: 0,
          interrupted: false,
          backgroundTaskId: backgroundShellId,
          assistantAutoBackgrounded
        };
      }

      // 检查该前台任务是否通过 backgroundAll() 转入后台
      if (foregroundTaskId) {
        // 调用 background() 时 shellCommand.status 变为 'backgrounded'
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

      // 如可用则展示最简的转后台 UI
      // 如果后台任务被禁用则跳过
      if (!isBackgroundTasksDisabled && backgroundShellId === undefined && elapsedSeconds >= PROGRESS_THRESHOLD_MS / 1000 && setToolJSX) {
        // 将该命令注册为前台任务，以便可通过 Ctrl+B 转入后台
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
    }
  } finally {
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId);
  }
}