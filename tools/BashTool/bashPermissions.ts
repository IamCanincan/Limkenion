import { feature } from 'bun:bundle'
import { APIUserAbortError } from '../../types/llm-protocol.js'
import type { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { PendingClassifierCheck } from '../../types/permissions.js'
import { count } from '../../utils/array.js'
import {
  checkSemantics,
  nodeTypeId,
  type ParseForSecurityResult,
  parseForSecurityFromAst,
  type Redirect,
  type SimpleCommand,
} from '../../utils/bash/ast.js'
import {
  type CommandPrefixResult,
  extractOutputRedirections,
  getCommandSubcommandPrefix,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { parseCommandRaw } from '../../utils/bash/parser.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { AbortError } from '../../utils/errors.js'
import type {
  ClassifierBehavior,
  ClassifierResult,
} from '../../utils/permissions/bashClassifier.js'
import {
  classifyBashCommand,
  getBashPromptAllowDescriptions,
  getBashPromptAskDescriptions,
  getBashPromptDenyDescriptions,
  isClassifierPermissionsEnabled,
} from '../../utils/permissions/bashClassifier.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from '../../utils/permissions/PermissionResult.js'
import type {
  PermissionRule,
  PermissionRuleValue,
} from '../../utils/permissions/PermissionRule.js'
import { extractRules } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js'
import {
  createPermissionRequestMessage,
  getRuleByContentsForTool,
} from '../../utils/permissions/permissions.js'
import {
  parsePermissionRule,
  type ShellPermissionRule,
  matchWildcardPattern as sharedMatchWildcardPattern,
  permissionRuleExtractPrefix as sharedPermissionRuleExtractPrefix,
  suggestionForExactCommand as sharedSuggestionForExactCommand,
  suggestionForPrefix as sharedSuggestionForPrefix,
} from '../../utils/permissions/shellRuleMatching.js'
import { getPlatform } from '../../utils/platform.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import { BashTool } from './BashTool.js'
import { checkCommandOperatorPermissions } from './bashCommandHelpers.js'
import {
  bashCommandIsSafeAsync_DEPRECATED,
  stripSafeHeredocSubstitutions,
} from './bashSecurity.js'
import { checkPermissionMode } from './modeValidation.js'
import { checkPathConstraints } from './pathValidation.js'
import { checkSedConstraints } from './sedValidation.js'
import { shouldUseSandbox } from './shouldUseSandbox.js'

// DCE 悬崖：Bun 的 feature() 求值器对每个函数有复杂度预算。
// bashToolHasPermission 恰好处于临界点。import 块中的 `import { X as Y }` 别名
// 会计入该预算；当它们把预算推过阈值时，Bun 便无法再证明
// feature('BASH_CLASSIFIER') 是常量，会静默地把三元表达式求值为 `false`，
// 从而丢弃每个 pendingClassifierCheck 的展开。请把别名保持为顶层
// const 重绑定。(另见 checkSemanticsDeny 下方的注释。)
const bashCommandIsSafeAsync = bashCommandIsSafeAsync_DEPRECATED
const splitCommand = splitCommand_DEPRECATED

// 环境变量赋值前缀 (VAR=value)。由三个 while 循环共享，它们会
// 在提取命令名之前跳过安全的环境变量。
const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/

// CC-643：对于复杂复合命令，splitCommand_DEPRECATED 可能产生
// 非常大的子命令数组（可能指数级增长；#21405 的 ReDoS 修复
// 可能并未覆盖完全）。每个子命令随后运行 tree-sitter 解析 +
// 约 20 个校验器 + logEvent（bashSecurity.ts），配合记忆化元数据，
// 产生的微任务链会饿死事件循环——REPL 在 100% CPU 下冻结，
// strace 显示 /proc/self/stat 读取约 127Hz 且没有 epoll_wait。50 是
// 一个宽裕的上限：合法用户命令不会拆分到那么宽。超过上限后我们
// 回退到 'ask'（安全默认值——我们无法证明安全性，因此进行提示）。
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50

// GH#11380：限制复合命令中每个子命令的建议规则数量。
// 超过此数量后，"是，并且不再询问 X、Y、Z…"标签
// 无论如何都会退化为"相似命令"，而且从一次提示中保存 10+ 条规则
// 更可能是噪音而非意图。在单个 && 列表中串联这么多写命令的用户
// 极少见；他们总能批准一次并手动添加规则。
export const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

/**
 * [仅限 ANT]记录分类器求值结果用于分析。
 * 这有助于我们了解哪些分类器规则正在被求值，
 * 以及分类器是如何对命令做出决策的。
 */
function logClassifierResultForAnts(
  command: string,
  behavior: ClassifierBehavior,
  descriptions: string[],
  result: ClassifierResult,
): void {
  if (true) {
    return
  }

  logEvent('limkenion_internal_bash_classifier_result', {
    behavior:
      behavior as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    descriptions: jsonStringify(
      descriptions,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    matches: result.matches,
    matchedDescription: (result.matchedDescription ??
      '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    confidence:
      result.confidence as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    reason:
      result.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 注意：命令包含代码/文件路径——这仅限 ANT，因此可以
    command:
      command as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * 从原始命令字符串中提取稳定的命令前缀（命令 + 子命令）。
 * 仅当环境变量赋值位于 SAFE_ENV_VARS（或供 ant 用户使用的
 * ANT_ONLY_SAFE_ENV_VARS）中时才跳过前导环境变量赋值。如果遇到非安全
 * 环境变量则返回 null（以便回退到精确匹配），或者第二个 token 看起来
 * 不像子命令（小写字母数字，例如 "commit"、"run"）。
 *
 * 示例：
 *   'git commit -m "fix typo"' → 'git commit'
 *   'NODE_ENV=prod npm run build' → 'npm run' (NODE_ENV 是安全的)
 *   'MY_VAR=val npm run build' → null (MY_VAR 不安全)
 *   'ls -la' → null (标志，不是子命令)
 *   'cat file.txt' → null (文件名，不是子命令)
 *   'chmod 755 file' → null (数字，不是子命令)
 */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  // 跳过开头的环境变量赋值（VAR=value），但仅当它们
  // 位于 SAFE_ENV_VARS（或供 ant 用户使用的 ANT_ONLY_SAFE_ENV_VARS）中。如果遇到
  // 非安全环境变量，返回 null 以回退到精确匹配。这可以
  // 防止生成像 Bash(npm run:*) 这样永远不可能匹配的前缀规则，
  // 因为在允许规则检查时 stripSafeWrappers 只剥离安全变量。
  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      false
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }

  const remaining = tokens.slice(i)
  if (remaining.length < 2) return null
  const subcmd = remaining[1]!
  // 第二个 token 必须看起来像子命令（例如 "commit"、"run"、"compose"），
  // 而不是标志 (-rf)、文件名 (file.txt)、路径 (/tmp)、URL 或数字 (755)。
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(subcmd)) return null
  return remaining.slice(0, 2).join(' ')
}

// `bash:*` 或 `sh:*` 这类裸前缀建议会允许通过 `-c` 执行任意代码。
// `env:*` 或 `sudo:*` 这类包装器建议同样如此：
// `env` 不在 SAFE_WRAPPER_PATTERNS 中，所以 `env bash -c "evil"` 能
// 原样通过 stripSafeWrappers，并命中前缀规则匹配器中的 startsWith("env ") 检查。
// shell 列表镜像了 src/utils/shell/prefix.ts 中的 DANGEROUS_SHELL_PREFIXES，
// 后者守护了旧的 deepseek-flash 提取器。
const BARE_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  // 会将其参数作为一条命令执行的包装器
  'env',
  'xargs',
  // 安全要点：checkSemantics (ast.ts) 会剥离这些包装器以检查被包裹的命令。
  // 建议 `Bash(nice:*)` 就约等于 `Bash(*)`——用户会在提示后添加它，然后
  // `nice rm -rf /` 能通过语义检查，而 deny/cd+git 闸门只会看到 'nice'
  // （SAFE_WRAPPER_PATTERNS 直到本次修复才剥离裸的 `nice`）。阻止这些
  // 包装器被建议。
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  // 权限提升——来自 `sudo -u foo ...` 的 sudo:* 会自动批准
  // 未来任何 sudo 调用
  'sudo',
  'doas',
  'pkexec',
])

/**
 * 仅 UI 使用的回退方案：当 getSimpleCommandPrefix 拒绝时仅提取第一个单词。
 * 在外部构建中 TREE_SITTER_BASH 关闭，因此 BashPermissionRequest 中的异步
 * tree-sitter 细分永远不会触发——如果没有此函数，管道和复合命令
 * （`python3 file.py 2>&1 | tail -20`）会原样倾倒进可编辑字段。
 *
 * 有意不被 suggestionForExactCommand 使用：后端建议的 `Bash(rm:*)`
 * 过于宽泛，不适合自动生成，但作为可编辑的起点正是用户所期望的
 * (Slack C07VBSHV7EV/p1772670433193449)。
 *
 * 复用与 getSimpleCommandPrefix 相同的 SAFE_ENV_VARS 闸门——形如
 * `Bash(python3:*)` 的规则在检查时永远无法匹配 `RUN=/path python3 ...`，
 * 因为 stripSafeWrappers 不会剥离 RUN。
 */
export function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)

  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      false
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }

  const cmd = tokens[i]
  if (!cmd) return null
  // 与 getSimpleCommandPrefix 中的子命令正则形状检查相同：
  // 拒绝路径 (./script.sh, /usr/bin/python)、标志、数字、文件名。
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(cmd)) return null
  if (BARE_SHELL_PREFIXES.has(cmd)) return null
  return cmd
}

function suggestionForExactCommand(command: string): PermissionUpdate[] {
  // heredoc 命令包含每次都变化的多行内容，这使得精确匹配规则
  // 毫无用处（它们再也不会匹配）。在 heredoc 操作符之前提取一个
  // 稳定前缀，并改为建议前缀规则。
  const heredocPrefix = extractPrefixBeforeHeredoc(command)
  if (heredocPrefix) {
    return sharedSuggestionForPrefix(BashTool.name, heredocPrefix)
  }

  // 没有 heredoc 的多行命令同样不适合做精确匹配规则。
  // 保存完整多行文本可能产生中间含有 `:*` 的模式，这会通不过
  // 权限校验并破坏设置文件。改为把第一行用作前缀规则。
  if (command.includes('\n')) {
    const firstLine = command.split('\n')[0]!.trim()
    if (firstLine) {
      return sharedSuggestionForPrefix(BashTool.name, firstLine)
    }
  }

  // 单行命令：提取 2 词前缀用于可复用的规则。
  // 没有这一步，保存的精确匹配规则永远不会匹配参数不同的
  // 未来调用。
  const prefix = getSimpleCommandPrefix(command)
  if (prefix) {
    return sharedSuggestionForPrefix(BashTool.name, prefix)
  }

  return sharedSuggestionForExactCommand(BashTool.name, command)
}

/**
 * 如果命令包含 heredoc (<<)，提取其前的命令前缀。
 * 返回 heredoc 操作符之前的第一个单词作为稳定前缀，
 * 如果命令不含 heredoc 则返回 null。
 *
 * 示例：
 *   'git commit -m "$(cat <<\'EOF\'\n...\nEOF\n)"' → 'git commit'
 *   'cat <<EOF\nhello\nEOF' → 'cat'
 *   'echo hello' → null (无 heredoc)
 */
function extractPrefixBeforeHeredoc(command: string): string | null {
  if (!command.includes('<<')) return null

  const idx = command.indexOf('<<')
  if (idx <= 0) return null

  const before = command.substring(0, idx).trim()
  if (!before) return null

  const prefix = getSimpleCommandPrefix(before)
  if (prefix) return prefix

  // 回退：跳过安全环境变量赋值并取最多 2 个 token。
  // 这保留了标志 token（例如 "python3 -c" 仍是 "python3 -c"，
  // 而不只是 "python3"），并跳过像 "NODE_ENV=test" 这样的安全环境变量前缀。
  // 如果遇到非安全环境变量，返回 null 以避免生成永远无法匹配的
  // 前缀规则（与 getSimpleCommandPrefix 的理据相同）。
  const tokens = before.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      false
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }
  if (i >= tokens.length) return null
  return tokens.slice(i, i + 2).join(' ') || null
}

function suggestionForPrefix(prefix: string): PermissionUpdate[] {
  return sharedSuggestionForPrefix(BashTool.name, prefix)
}

/**
 * 从遗留的 :* 语法中提取前缀（例如 "npm:*" -> "npm"）
 * 委托给共享实现。
 */
export const permissionRuleExtractPrefix = sharedPermissionRuleExtractPrefix

/**
 * 将命令与通配符模式进行匹配（对 Bash 区分大小写）。
 * 委托给共享实现。
 */
export function matchWildcardPattern(
  pattern: string,
  command: string,
): boolean {
  return sharedMatchWildcardPattern(pattern, command)
}

/**
 * 将权限规则解析为结构化规则对象。
 * 委托给共享实现。
 */
export const bashPermissionRule: (
  permissionRule: string,
) => ShellPermissionRule = parsePermissionRule

/**
 * 可从命令中安全剥离的环境变量白名单。
 * 这些变量不能执行代码或加载库。
 *
 * 安全要点：这些变量绝不能加入白名单：
 * - PATH、LD_PRELOAD、LD_LIBRARY_PATH、DYLD_*（执行/加载库）
 * - PYTHONPATH、NODE_PATH、CLASSPATH、RUBYLIB（模块加载）
 * - GOFLAGS、RUSTFLAGS、NODE_OPTIONS（可能包含代码执行标志）
 * - HOME、TMPDIR、SHELL、BASH_ENV（影响系统行为）
 */
const SAFE_ENV_VARS = new Set([
  // Go - 仅构建/运行时设置
  'GOEXPERIMENT', // 实验特性
  'GOOS', // 目标操作系统
  'GOARCH', // 目标架构
  'CGO_ENABLED', // 启用/禁用 CGO
  'GO111MODULE', // 模块模式

  // Rust - 仅日志/调试
  'RUST_BACKTRACE', // 回溯详细程度
  'RUST_LOG', // 日志过滤器

  // Node - 仅环境名称（不是 NODE_OPTIONS!）
  'NODE_ENV',

  // Python - 仅行为标志（不是 PYTHONPATH!）
  'PYTHONUNBUFFERED', // 禁用缓冲
  'PYTHONDONTWRITEBYTECODE', // 不生成 .pyc 文件

  // Pytest - 测试配置
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD', // 禁用插件加载
  'PYTEST_DEBUG', // 调试输出

  // API 密钥与身份认证
  'LIMKENION_API_KEY', // API 身份认证

  // 区域设置与字符编码
  'LANG', // 默认区域设置
  'LANGUAGE', // 语言偏好列表
  'LC_ALL', // 覆盖所有区域设置
  'LC_CTYPE', // 字符分类
  'LC_TIME', // 时间格式
  'CHARSET', // 字符集偏好

  // 终端与显示
  'TERM', // 终端类型
  'COLORTERM', // 彩色终端指示器
  'NO_COLOR', // 禁用颜色输出（通用标准）
  'FORCE_COLOR', // 强制彩色输出
  'TZ', // 时区

  // 各工具的配色配置
  'LS_COLORS', // ls 的颜色 (GNU)
  'LSCOLORS', // ls 的颜色 (BSD/macOS)
  'GREP_COLOR', // grep 匹配颜色（已弃用）
  'GREP_COLORS', // grep 配色方案
  'GCC_COLORS', // GCC 诊断颜色

  // 显示格式
  'TIME_STYLE', // ls 的时间显示格式
  'BLOCK_SIZE', // du/df 的块大小
  'BLOCKSIZE', // 备选块大小
])

/**
 * 可从命令中安全剥离的仅供 ANT 使用的环境变量。
 * 仅在 USER_TYPE === 'ant' 时启用。
 *
 * 安全要点：这些环境变量在权限规则匹配之前被剥离，这意味着
 * `DOCKER_HOST=tcp://evil.com docker ps` 在剥离后会匹配 `Bash(docker ps:*)`
 * 规则。这有意地仅供 ANT 使用（在第 ~380 行处门控）且绝不可
 * 提供给外部用户。DOCKER_HOST 会重定向 Docker 守护进程
 * 端点——剥离它会通过向权限检查隐藏网络端点而破坏基于前缀的
 * 权限限制。KUBECONFIG 同样控制 kubectl 与哪个集群通信。这些是
 * 为接受该风险的内部分析用户提供的便利性剥离。
 *
 * 基于对 30 天 limkenion_internal_bash_tool_use_permission_request 事件的分析。
 */
const ANT_ONLY_SAFE_ENV_VARS = new Set([
  // Kubernetes 与容器配置（配置文件指针，而非执行）
  'KUBECONFIG', // kubectl 配置文件路径——控制 kubectl 使用哪个集群
  'DOCKER_HOST', // Docker 守护进程套接字/端点——控制 docker 与哪个守护进程通信

  // 云提供商项目/配置文件选择（只是名称/标识符）
  'AWS_PROFILE', // AWS 配置文件名选择
  'CLOUDSDK_CORE_PROJECT', // GCP 项目 ID
  'CLUSTER', // 通用集群名

  // Limkenion 内部集群选择（只是名称/标识符）
  'COO_CLUSTER', // coo 集群名
  'COO_CLUSTER_NAME', // coo 集群名（备选）
  'COO_NAMESPACE', // coo 命名空间
  'COO_LAUNCH_YAML_DRY_RUN', // 试运行模式

  // 功能开关（仅布尔/字符串开关）
  'SKIP_NODE_VERSION_CHECK', // 跳过版本检查
  'EXPECTTEST_ACCEPT', // 接受测试期望
  'CI', // CI 环境指示器
  'GIT_LFS_SKIP_SMUDGE', // 跳过 LFS 下载

  // GPU/设备选择（仅设备 ID）
  'CUDA_VISIBLE_DEVICES', // GPU 设备选择
  'JAX_PLATFORMS', // JAX 平台选择

  // 显示/终端设置
  'COLUMNS', // 终端宽度
  'TMUX', // TMUX 套接字信息

  // 测试/调试配置
  'POSTGRESQL_VERSION', // postgres 版本字符串
  'FIRESTORE_EMULATOR_HOST', // emulator 主机:端口
  'HARNESS_QUIET', // 静默模式开关
  'TEST_CROSSCHECK_LISTS_MATCH_UPDATE', // 测试更新开关
  'DBT_PER_DEVELOPER_ENVIRONMENTS', // DBT 配置
  'STATSIG_FORD_DB_CHECKS', // statsig DB 检查开关

  // 构建配置
  'ANT_ENVIRONMENT', // Limkenion 环境名
  'ANT_SERVICE', // Limkenion 服务名
  'MONOREPO_ROOT_DIR', // monorepo 根路径

  // 版本选择器
  'PYENV_VERSION', // Python 版本选择

  // 凭据（已批准的子集——这些不改变数据外泄风险）
  'PGPASSWORD', // Postgres 密码
  'GH_TOKEN', // GitHub 令牌
  'GROWTHBOOK_API_KEY', // 自托管 growthbook
])

/**
 * 从命令中剥离整行注释。
 * 这处理 Limkenion 在 bash 命令中添加注释的情况，例如：
 *   "# Check the logs directory\nls /home/user/logs"
 * 应被剥离为："ls /home/user/logs"
 *
 * 只剥离整行注释（整个行都是注释的行）、
 * 而不是与命令同行的行内注释。
 */
function stripCommentLines(command: string): string {
  const lines = command.split('\n')
  const nonCommentLines = lines.filter(line => {
    const trimmed = line.trim()
    // 保留非空且不以 # 开头的行
    return trimmed !== '' && !trimmed.startsWith('#')
  })

  // 如果所有行都是注释/空行，返回原始内容
  if (nonCommentLines.length === 0) {
    return command
  }

  return nonCommentLines.join('\n')
}

export function stripSafeWrappers(command: string): string {
  // 安全要点：使用 [ \t]+ 而非 \s+——\s 会匹配 \n/\r，它们是 bash 中的
  // 命令分隔符。跨换行匹配会从一个行剥离包装器，却让下一行的不同
  // 命令留给 bash 执行。
  //
  // 安全要点：`(?:--[ \t]+)?` 会消费包装器自身的 `--`，这样
  // `nohup -- rm -- -/../foo` 被剥离为 `rm -- -/../foo`（而不是
  // `-- rm ...`，后者会把 `--` 当作未知 baseCmd 从而跳过路径校验）。
  const SAFE_WRAPPER_PATTERNS = [
    // timeout：枚举 GNU 长标志——无值标志（--foreground、
    // --preserve-status、--verbose）、可取值标志的 =fused 和
    // 空格分隔两种形式（--kill-after=5、--kill-after 5、--signal=TERM、
    // --signal TERM）。短标志：-v（无参）、-k/-s 与分离或融合的值。
    // 安全要点：标志值使用白名单 [A-Za-z0-9_.+-]（信号是
    // TERM/KILL/9，时长为 5/5s/10.5）。之前 [^ \t]+ 会匹配
    // $ ( ) ` | ; &——`timeout -k$(id) 10 ls` 被剥离为 `ls`，匹配了
    // Bash(ls:*)，而 bash 会在分词过程中、timeout 运行之前
    // 展开 $(id)。对比下方 ENV_VAR_PATTERN，它已经使用白名单。
    /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
    /^time[ \t]+(?:--[ \t]+)?/,
    // 安全要点：与 checkSemantics 的包装器剥离保持同步（ast.ts
    // ~:1990-2080）并兼容 stripWrappersFromArgv（pathValidation.ts ~:1260）。
    // 之前此模式要求 `-n N`；checkSemantics 已经处理了裸 `nice`
    // 和遗留 `-N`。这种不对称意味着 checkSemantics 会把被包裹的命令
    // 暴露给语义检查，但 deny 规则匹配和 cd+git 闸门只会看到包装器名。
    // `nice rm -rf /` 配合 Bash(rm:*) deny 会变成 ask 而非 deny；
    // `cd evil && nice git status` 会跳过裸仓库 RCE 闸门。PR #21503
    // 修复了 stripWrappersFromArgv；这里之前漏掉了。
    // 现在匹配：`nice cmd`、`nice -n N cmd`、`nice -N cmd`
    // （checkSemantics 会剥离的所有形式）。
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    // stdbuf：仅融合短标志（-o0、-eL）。checkSemantics 处理更多形式
    // （空格分隔、长标志 --output=MODE），但我们在上面那些形式
    // 上采取失败关闭，所以这里不过度剥离是安全的。主要需求：
    // `stdbuf -o0 cmd`。
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ] as const

  // 环境变量的模式：
  // ^([A-Za-z_][A-Za-z0-9_]*)  - 变量名（标准标识符）
  // =                           - 等号
  // ([A-Za-z0-9_./:-]+)         - 值：仅字母数字 + 安全标点
  // [ \t]+                      - 值后必需的横向空白
  //
  // 安全要点：只匹配含安全字符的未加引号值（不含 $()、反引号、$var、;|&）。
  //
  // 安全要点：尾部空白必须是 [ \t]+（仅横向），不能是 \s+。
  // \s 会匹配 \n/\r。如果 reconstructCommand 在 `TZ=UTC` 和 `echo` 之间
  // 发出未加引号的换行，\s+ 会跨过它并剥离 `TZ=UTC<NL>`，
  // 让 `echo curl evil.com` 去匹配 Bash(echo:*)。但 bash 会把
  // 换行当作命令分隔符。与 needsQuoting 修复一起构成纵深防御。
  const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/

  let stripped = command
  let previousStripped = ''

  // 阶段 1：仅剥离前导环境变量和注释。
  // 在 bash 中，命令前的环境变量赋值（VAR=val cmd）是真正的
  // shell 级赋值。为了权限匹配，剥离它们是安全的。
  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const envVarMatch = stripped.match(ENV_VAR_PATTERN)
    if (envVarMatch) {
      const varName = envVarMatch[1]!
      const isAntOnlySafe =
        false
      if (SAFE_ENV_VARS.has(varName) || isAntOnlySafe) {
        stripped = stripped.replace(ENV_VAR_PATTERN, '')
      }
    }
  }

  // 阶段 2：仅剥离包装器命令和注释。不要剥离环境变量。
  // 包装器命令（timeout、time、nice、nohup）使用 execvp 运行其
  // 参数，因此包装器之后的 VAR=val 会被当作要执行的命令，
  // 而不是环境变量赋值。在这里剥离环境变量会在解析器
  // 所见与实际执行之间造成不匹配。
  // (HackerOne #3543050)
  previousStripped = ''
  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    for (const pattern of SAFE_WRAPPER_PATTERNS) {
      stripped = stripped.replace(pattern, '')
    }
  }

  return stripped.trim()
}

// 安全：timeout 旗标取值的白名单（信号为 TERM/KILL/9，时长为 5/5s/10.5）。
// 拒绝 $ ( ) ` | ; & 以及换行符——此前会通过 [^ \t]+ 匹配，
// 而 `timeout -k$(id) 10 ls` 必须不能被剥离。
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

/**
 * 解析 timeout 的 GNU 旗标（长 + 短、合并 + 空格分隔），并返回
 * DURATION（时长）token 在 argv 中的下标；若旗标无法解析则返回 -1。
 * 枚举：--foreground/--preserve-status/--verbose（无取值），
 * --kill-after/--signal（有取值，既支持 = 合并也支持空格分隔），-v
 *（无取值），-k/-s（有取值，合并与空格分隔均可）。
 *
 * 从 stripWrappersFromArgv 中抽出，以保证 bashToolHasPermission 在 Bun
 * 的 feature() DCE 复杂度阈值之内——若内联此处，会破坏分类器测试中
 * feature('BASH_CLASSIFIER') 的求值。
 */
function skipTimeoutFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    const next = a[i + 1]
    if (
      arg === '--foreground' ||
      arg === '--preserve-status' ||
      arg === '--verbose'
    )
      i++
    else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (
      (arg === '--kill-after' || arg === '--signal') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (arg === '--') {
      i++
      break
    } // 选项结束标记
    else if (arg.startsWith('--')) return -1
    else if (arg === '-v') i++
    else if (
      (arg === '-k' || arg === '-s') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (arg.startsWith('-')) return -1
    else break
  }
  return i
}

/**
 * stripSafeWrappers 在 argv 层的对应实现。剥离相同的包装命令
 *（timeout、time、nice、nohup）对 AST 派生的 argv。环境变量已
 * 被分离到 SimpleCommand.envVars，因此无需环境变量剥离。
 *
 * 与上面的 SAFE_WRAPPER_PATTERNS 保持同步——若在那里新增
 * 包装命令，这里也要同步新增。
 */
export function stripWrappersFromArgv(argv: string[]): string[] {
  // 安全：消费包装命令选项之后的可选 `--`，与包装命令本身保持一致。
  // 否则 `['nohup','--','rm','--','-/../foo']` 会把 `--` 当作 baseCmd
  // 并跳过路径校验。见 SAFE_WRAPPER_PATTERNS 的注释。
  let a = argv
  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'timeout') {
      const i = skipTimeoutFlags(a)
      if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) return a
      a = a.slice(i + 1)
    } else if (
      a[0] === 'nice' &&
      a[1] === '-n' &&
      a[2] &&
      /^-?\d+$/.test(a[2])
    ) {
      a = a.slice(a[3] === '--' ? 4 : 3)
    } else {
      return a
    }
  }
}

/**
 * 会使“另一个二进制”被运行的环境变量（注入或解析劫持）。
 * 仅为启发式——export-&& 形式会绕过它，且 excludedCommands 本来
 * 也不是安全边界。
 */
export const BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/

/**
 * 从命令中剥离所有前导的环境变量前缀，无论变量名是否在安全列表中。
 *
 * 用于 deny/ask 规则匹配：当用户否认 `limkenion` 或 `rm` 时，即使
 * 命令被像 `FOO=bar limkenion` 这样的任意环境变量加前缀，也应保持
 * 被阻止。stripSafeWrappers 中的安全列表限制对于 allow 规则是正确的
 *（防止 `DOCKER_HOST=evil docker ps` 自动匹配 `Bash(docker ps:*)`），
 * 但 deny 规则必须更难被绕过。
 *
 * 也用于 sandbox.excludedCommands 匹配（并非安全边界——权限提示才是），
 * 并以 BINARY_HIJACK_VARS 作为黑名单。
 *
 * 安全：使用的取值模式比 stripSafeWrappers 更宽。该取值模式只排除
 * 真正的 shell 注入字符（$、反引号、;、|、&、括号、重定向、引号、
 * 反斜杠）和空白。像 =、+、@、~、, 这类字符在未加引号的环境变量
 * 赋值位置是无害的，必须能被匹配，以防止诸如 `FOO=a=b denied_command`
 * 的琐碎绕过。
 *
 * @param blocklist - 可选的正则表达式，针对每个变量名进行测试；匹配的
 *  变量不剥离（并且剥离在此停止）。deny 规则省略该参数；为
 *  excludedCommands 传入 BINARY_HIJACK_VARS。
 */
export function stripAllLeadingEnvVars(
  command: string,
  blocklist?: RegExp,
): string {
  // 用于 deny 规则剥离的更宽取值模式。处理：
  //
  // - 标准赋值 (FOO=bar)、追加 (FOO+=bar)、数组 (FOO[0]=bar)
  // - 单引号取值：'[^'\n\r]*' —— bash 会抑制所有展开
  // - 双引号取值及反斜杠转义："(?:\\.|[^"$`\\\n\r])*"
  //   在 bash 双引号中，只有 \$, \`, \", \\ 以及 \换行 是特殊的。
  //   其它 \x 序列无害，因此允许双引号内的 \.。我们仍排除（未加反斜杠的）
  //   裸 $ 和 ` 以阻止展开。
  // - 未加引号的取值：排除 shell 元字符，允许反斜杠转义
  // - 拼接片段：FOO='x'y"z" —— bash 会将相邻片段拼接起来
  //
  // 安全：尾随空白必须是 [ \t]+（仅水平空白），不能是 \s+。
  //
  // 外层的 * 每次迭代匹配一个原子单元：一个完整带引号的字符串、
  // 一对反斜杠转义、或单个未加引号的安全字符。内部的
  // double-quote 分支 (?:...|...)* 由右引号界定边界，因此不会与
  // 外层的 * 产生回溯交互。
  //
  // 注意：$ 被排除在未加引号/双引号取值类之外，以阻止危险形式
  // 如 $(cmd)、${var} 和 $((expr))。这意味着 FOO=$VAR 不被剥离——
  // 加入 $VAR 匹配会带来 ReDoS 风险（CodeQL #671），且 $VAR
  // 绕过的优先级较低。
  const ENV_VAR_PATTERN =
    /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\\\'"])*[ \t]+/

  let stripped = command
  let previousStripped = ''

  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const m = stripped.match(ENV_VAR_PATTERN)
    if (!m) continue
    if (blocklist?.test(m[1]!)) break
    stripped = stripped.slice(m[0].length)
  }

  return stripped.trim()
}

function filterRulesByContentsMatchingInput(
  input: z.infer<typeof BashTool.inputSchema>,
  rules: Map<string, PermissionRule>,
  matchMode: 'exact' | 'prefix',
  {
    stripAllEnvVars = false,
    skipCompoundCheck = false,
  }: { stripAllEnvVars?: boolean; skipCompoundCheck?: boolean } = {},
): PermissionRule[] {
  const command = input.command.trim()

  // 为权限匹配剥离输出重定向
  // 这使得 Bash(python:*) 之类的规则可以匹配 "python script.py > output.txt"
  // 重定向目标的安全校验在 checkPathConstraints 中另行处理
  const commandWithoutRedirections =
    extractOutputRedirections(command).commandWithoutRedirections

  // 对于精确匹配，同时尝试原始命令（保留引号）
  // 以及去掉重定向后的命令（让没有重定向的规则也能匹配）
  // 对于前缀匹配，只使用去掉重定向后的命令
  const commandsForMatching =
    matchMode === 'exact'
      ? [command, commandWithoutRedirections]
      : [commandWithoutRedirections]

  // 剥离安全包装命令（timeout、time、nice、nohup）和环境变量以便匹配
  // 这使得 Bash(npm install:*) 之类的规则可以匹配 "timeout 10 npm install foo"
  // 或 "GOOS=linux go build"
  const commandsToTry = commandsForMatching.flatMap(cmd => {
    const strippedCommand = stripSafeWrappers(cmd)
    return strippedCommand !== cmd ? [cmd, strippedCommand] : [cmd]
  })

  // 安全：对于 deny/ask 规则，同时也尝试剥离全部前导环境变量前缀后
  // 再匹配。这防止通过 `FOO=bar denied_command` 绕过——其中 FOO
  // 不在安全列表中。stripSafeWrappers 中的安全列表限制对于 allow
  // 规则是有意为之（见 HackerOne #3543050），但 deny 规则必须更难
  // 被绕过——被拒绝的命令无论是否带环境变量前缀都应保持被拒绝。
  //
  // 我们对所有候选反复同时应用两种剥离操作，直到不再产生新的候选
  //（不动点）。这处理诸如 `nohup FOO=bar timeout 5 limkenion` 的交错
  // 模式，其中：
  //   1. stripSafeWrappers 剥离 `nohup` → `FOO=bar timeout 5 limkenion`
  //   2. stripAllLeadingEnvVars 剥离 `FOO=bar` → `timeout 5 limkenion`
  //   3. stripSafeWrappers 剥离 `timeout 5` → `limkenion`（deny 匹配）
  //
  // 若不迭代，单次组合会漏掉多层的交错。
  if (stripAllEnvVars) {
    const seen = new Set(commandsToTry)
    let startIdx = 0

    // 迭代直到不再产生新的候选（不动点）
    while (startIdx < commandsToTry.length) {
      const endIdx = commandsToTry.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = commandsToTry[i]
        if (!cmd) {
          continue
        }
        // 尝试剥离环境变量
        const envStripped = stripAllLeadingEnvVars(cmd)
        if (!seen.has(envStripped)) {
          commandsToTry.push(envStripped)
          seen.add(envStripped)
        }
        // 尝试剥离安全包装命令
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          commandsToTry.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }
  }

  // 预先为每个候选计算复合命令状态，以避免在规则过滤循环内重复解析
  //（否则会把 splitCommand 调用规模放大到 rules.length × commandsToTry.length）。
  // 该复合检查只对 'prefix' 模式下的前缀/通配匹配适用，且仅针对 allow
  // 规则。
  // 安全：deny/ask 规则必须能匹配复合命令，以免通过把被拒绝的命令
  // 包裹进复合表达式中来绕过。
  const isCompoundCommand = new Map<string, boolean>()
  if (matchMode === 'prefix' && !skipCompoundCheck) {
    for (const cmd of commandsToTry) {
      if (!isCompoundCommand.has(cmd)) {
        isCompoundCommand.set(cmd, splitCommand(cmd).length > 1)
      }
    }
  }

  return Array.from(rules.entries())
    .filter(([ruleContent]) => {
      const bashRule = bashPermissionRule(ruleContent)

      return commandsToTry.some(cmdToMatch => {
        switch (bashRule.type) {
          case 'exact':
            return bashRule.command === cmdToMatch
          case 'prefix':
            switch (matchMode) {
              // 在 'exact' 模式下，仅当命令与前缀规则完全匹配时才返回 true
              case 'exact':
                return bashRule.prefix === cmdToMatch
              case 'prefix': {
                // 安全：不允许前缀规则匹配复合命令。
                // 例如 Bash(cd:*) 一定不能匹配 "cd /path && python3 evil.py"。
                // 在正常流程里命令会在到达此处之前被拆分，但 shell 转义
                // 可能使第一遍 splitCommand 失效——例如，
                //   cd src\&\& python3 hello.py  →  splitCommand  →  ["cd src&& python3 hello.py"]
                // 之后它看起来就像一个以 "cd " 开头的单命令。
                // 在此处重新拆分候选命令可以捕获这些情况。
                if (isCompoundCommand.get(cmdToMatch)) {
                  return false
                }
                // 确保词边界：前缀后必须是空格或字符串结尾
                // 防止 "ls:*" 匹配 "lsof" 或 "lsattr"
                if (cmdToMatch === bashRule.prefix) {
                  return true
                }
                if (cmdToMatch.startsWith(bashRule.prefix + ' ')) {
                  return true
                }
                // 对于不带旗标的裸 xargs，也匹配 "xargs <prefix>"。
                // 这样 Bash(grep:*) 可以匹配 "xargs grep pattern"，
                // 而 deny 规则如 Bash(rm:*) 可以阻止 "xargs rm file"。
                // 天然词边界："xargs -n1 grep" 不以 "xargs grep " 开头，
                // 因此带旗标的 xargs 调用不会被匹配。
                const xargsPrefix = 'xargs ' + bashRule.prefix
                if (cmdToMatch === xargsPrefix) {
                  return true
                }
                return cmdToMatch.startsWith(xargsPrefix + ' ')
              }
            }
            break
          case 'wildcard':
            // 安全修复：在精确匹配模式下，通配符绝不能匹配，因为我们
            // 检查的是未解析的完整命令。对未解析命令进行通配匹配会
            // 允许 "foo *" 匹配 "foo arg && curl evil.com"，因为 .* 可以
            // 匹配运算符。
            // 通配符只应在拆分出各个子命令后进行匹配。
            if (matchMode === 'exact') {
              return false
            }
            // 安全：与前缀规则相同，不允许通配符规则在 prefix 模式下
            // 匹配复合命令。例如 Bash(cd *) 一定不能匹配
            // "cd /path && python3 evil.py"，尽管 "cd *" 模式本可以匹配它。
            if (isCompoundCommand.get(cmdToMatch)) {
              return false
            }
            // 在 prefix 模式（拆分后）下，通配符可以安全地匹配子命令
            return matchWildcardPattern(bashRule.pattern, cmdToMatch)
        }
      })
    })
    .map(([, rule]) => rule)
}

function matchingRulesForInput(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  matchMode: 'exact' | 'prefix',
  { skipCompoundCheck = false }: { skipCompoundCheck?: boolean } = {},
) {
  const denyRuleByContents = getRuleByContentsForTool(
    toolPermissionContext,
    BashTool,
    'deny',
  )
  // 安全：deny/ask 规则采用激进的环境变量剥离，使
  // `FOO=bar denied_command` 仍能匹配 denied_command 的 deny 规则。
  const matchingDenyRules = filterRulesByContentsMatchingInput(
    input,
    denyRuleByContents,
    matchMode,
    { stripAllEnvVars: true, skipCompoundCheck: true },
  )

  const askRuleByContents = getRuleByContentsForTool(
    toolPermissionContext,
    BashTool,
    'ask',
  )
  const matchingAskRules = filterRulesByContentsMatchingInput(
    input,
    askRuleByContents,
    matchMode,
    { stripAllEnvVars: true, skipCompoundCheck: true },
  )

  const allowRuleByContents = getRuleByContentsForTool(
    toolPermissionContext,
    BashTool,
    'allow',
  )
  const matchingAllowRules = filterRulesByContentsMatchingInput(
    input,
    allowRuleByContents,
    matchMode,
    { skipCompoundCheck },
  )

  return {
    matchingDenyRules,
    matchingAskRules,
    matchingAllowRules,
  }
}

/**
 * 检查子命令是否与某条权限规则精确匹配
 */
export const bashToolCheckExactMatchPermission = (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult => {
  const command = input.command.trim()
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'exact')

  // 1. 精确命令被 deny 则拒绝
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2. 精确命令在 ask 规则中则询问
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. 精确命令在 allow 规则中则允许
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 4. 否则，直通（passthrough）
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    // 向用户建议精确匹配规则
    // 在 `checkCommandAndSuggestRules()` 中可能被前缀建议覆盖
    suggestions: suggestionForExactCommand(command),
  }
}

export const bashToolCheckPermission = (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astCommand?: SimpleCommand,
): PermissionResult => {
  const command = input.command.trim()

  // 1. 先检查精确匹配
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )

  // 1a. 精确命令有规则时拒绝/询问
  if (
    exactMatchResult.behavior === 'deny' ||
    exactMatchResult.behavior === 'ask'
  ) {
    return exactMatchResult
  }

  // 2. 查找所有匹配规则（前缀或精确）
  // 安全修复：在路径约束之前检查 Bash deny/ask 规则，防止通过项目目录之外
  // 的绝对路径绕过（HackerOne 报告）
  // 当采用 AST 解析时，子命令已是原子的——跳过会将词中 # 误判为
  // 复合命令的 legacy splitCommand 重新检查。
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'prefix', {
      skipCompoundCheck: astCommand !== undefined,
    })

  // 2a. 命令有 deny 规则则拒绝
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2b. 命令有 ask 规则则询问
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. 检查路径约束
  // 该检查放在 deny/ask 规则之后，使显式规则优先。
  // 安全：当此子命令的 AST 派生 argv 可用时，将其传入，使
  // checkPathConstraints 直接使用它，而不是用 shell-quote 重新解析
  //（shell-quote 存在单引号反斜杠缺陷，会导致 parseCommandArguments
  // 返回 [] 并静默跳过路径校验）。
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    toolPermissionContext,
    compoundCommandHasCd,
    astCommand?.redirects,
    astCommand ? [astCommand] : undefined,
  )
  if (pathResult.behavior !== 'passthrough') {
    return pathResult
  }

  // 4. 精确命令是 allow 则允许
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 5. 命令有 allow 规则则允许
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 5b. 检查 sed 约束（在模式自动允许之前阻止危险的 sed 操作）
  const sedConstraintResult = checkSedConstraints(input, toolPermissionContext)
  if (sedConstraintResult.behavior !== 'passthrough') {
    return sedConstraintResult
  }

  // 6. 检查模式相关的权限处理
  const modeResult = checkPermissionMode(input, toolPermissionContext)
  if (modeResult.behavior !== 'passthrough') {
    return modeResult
  }

  // 7. 检查只读规则
  if (BashTool.isReadOnly(input)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Read-only command is allowed',
      },
    }
  }

  // 8. 无规则匹配则直通，将触发权限提示
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    // 向用户建议精确匹配规则
    // 在 `checkCommandAndSuggestRules()` 中可能被前缀建议覆盖
    suggestions: suggestionForExactCommand(command),
  }
}

/**
 * 处理单个子命令，并应用前缀检查与建议
 */
export async function checkCommandAndSuggestRules(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  commandPrefixResult: CommandPrefixResult | null | undefined,
  compoundCommandHasCd?: boolean,
  astParseSucceeded?: boolean,
): Promise<PermissionResult> {
  // 1. 先检查精确匹配
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )
  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }

  // 2. 检查命令前缀
  const permissionResult = bashToolCheckPermission(
    input,
    toolPermissionContext,
    compoundCommandHasCd,
  )
  // 2a. 命令被显式 deny/ask 时拒绝/询问
  if (
    permissionResult.behavior === 'deny' ||
    permissionResult.behavior === 'ask'
  ) {
    return permissionResult
  }

  // 3. 若检测到命令注入则询问权限。当
  // AST 解析已成功时跳过——tree-sitter 已确认没有
  // 隐藏的替换或结构技巧，因此 legacy 基于正则的
  // 校验器（反斜杠转义运算符等）只会引入误报。
  if (
    !astParseSucceeded &&
    !isEnvTruthy(process.env.LIMKENION_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    const safetyResult = await bashCommandIsSafeAsync(input.command)

    if (safetyResult.behavior !== 'passthrough') {
      const decisionReason: PermissionDecisionReason = {
        type: 'other' as const,
        reason:
          safetyResult.behavior === 'ask' && safetyResult.message
            ? safetyResult.message
            : 'This command contains patterns that could pose security risks and requires approval',
      }

      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
        decisionReason,
        suggestions: [], // 不要建议保存可能危险的命令
      }
    }
  }

  // 4. 命令被允许则放行
  if (permissionResult.behavior === 'allow') {
    return permissionResult
  }

  // 5. 可用前缀则建议前缀，否则建议精确命令
  const suggestedUpdates = commandPrefixResult?.commandPrefix
    ? suggestionForPrefix(commandPrefixResult.commandPrefix)
    : suggestionForExactCommand(input.command)

  return {
    ...permissionResult,
    suggestions: suggestedUpdates,
  }
}

/**
 * 检查命令在沙箱环境下是否应被自动允许。
 * 若存在应被遵守的显式 deny/ask 规则则提前返回。
 *
 * 注意：仅当同时启用了沙箱与自动允许时才应调用此函数。
 *
 * @param input - bash 工具输入
 * @param toolPermissionContext - 权限上下文
 * @returns PermissionResult：
 *   - deny/ask（若存在显式规则（精确或前缀））
 *   - allow（若无显式规则（沙箱自动允许生效））
 *   - passthrough 不应出现，因为我们处于自动允许模式
 */
function checkSandboxAutoAllow(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const command = input.command.trim()

  // 在完整命令上检查显式 deny/ask 规则（精确 + 前缀）
  const { matchingDenyRules, matchingAskRules } = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  )

  // 完整命令存在显式 deny 规则则立即返回
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 安全：对于复合命令，针对 deny/ask 规则逐一检查每个子命令。
  // 诸如 Bash(rm:*) 的前缀规则不会匹配整个复合命令
  //（例如 "echo hello && rm -rf /" 不以 "rm" 开头），因此我们必须
  // 单独检查每个子命令。
  // 重要：子命令的 deny 检查必须在完整命令的 ask 返回之前运行。
  // 否则匹配完整命令的通配 ask 规则（例如 Bash(*echo*)）
  // 会先于子命令上的前缀 deny 规则（例如 Bash(rm:*)）返回 'ask'，
  // 把 deny 降级为 ask。
  const subcommands = splitCommand(command)
  if (subcommands.length > 1) {
    let firstAskRule: PermissionRule | undefined
    for (const sub of subcommands) {
      const subResult = matchingRulesForInput(
        { command: sub },
        toolPermissionContext,
        'prefix',
      )
      // deny 拥有最高优先级——立即返回
      if (subResult.matchingDenyRules[0] !== undefined) {
        return {
          behavior: 'deny',
          message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
          decisionReason: {
            type: 'rule',
            rule: subResult.matchingDenyRules[0],
          },
        }
      }
      // 暂存首个 ask 匹配；先不返回（跨所有子命令的 deny 优先）
      firstAskRule ??= subResult.matchingAskRules[0]
    }
    if (firstAskRule) {
      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(BashTool.name),
        decisionReason: {
          type: 'rule',
          rule: firstAskRule,
        },
      }
    }
  }

  // 完整命令 ask 检查（在所有 deny 来源耗尽之后）
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }
  // 无显式规则，因此在沙箱中自动允许

  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: {
      type: 'other',
      reason: 'Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)',
    },
  }
}

/**
 * 过滤掉 `cd ${cwd}` 形式的前缀子命令，同时保持 astCommands 对齐。
 * 抽出此逻辑以让 bashToolHasPermission 处于 Bun 的 feature() DCE
 * 复杂度阈值之内——若内联此处，会破坏约 10 个分类器测试中的
 * pendingClassifierCheck 附加行为。
 */
function filterCdCwdSubcommands(
  rawSubcommands: string[],
  astCommands: SimpleCommand[] | undefined,
  cwd: string,
  cwdMingw: string,
): { subcommands: string[]; astCommandsByIdx: (SimpleCommand | undefined)[] } {
  const subcommands: string[] = []
  const astCommandsByIdx: (SimpleCommand | undefined)[] = []
  for (let i = 0; i < rawSubcommands.length; i++) {
    const cmd = rawSubcommands[i]!
    if (cmd === `cd ${cwd}` || cmd === `cd ${cwdMingw}`) continue
    subcommands.push(cmd)
    astCommandsByIdx.push(astCommands?.[i])
  }
  return { subcommands, astCommandsByIdx }
}

/**
 * AST 过复杂与 checkSemantics 路径的提前退出 deny 强制。
 * 若非直通，返回精确匹配结果（deny/ask/allow），然后检查
 * 前缀/通配 deny 规则。若两者都未匹配，返回 null，表示
 * 调用方应回退到 ask。为保证 bashToolHasPermission 处于 Bun 的
 * feature() DCE 复杂度阈值之内而抽出。
 */
function checkEarlyExitDeny(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult | null {
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )
  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }
  const denyMatch = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  ).matchingDenyRules[0]
  if (denyMatch !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
      decisionReason: { type: 'rule', rule: denyMatch },
    }
  }
  return null
}

/**
 * checkSemantics 路径的 deny 强制。先调用 checkEarlyExitDeny
 *（精确匹配 + 完整命令前缀 deny），然后针对每个 SimpleCommand 的
 * .text 片段检查前缀 deny 规则。逐一子命令检查是必需的，因为
 * filterRulesByContentsMatchingInput 有复合命令守卫
 *（splitCommand().length > 1 → 前缀规则返回 false），会阻止
 * `Bash(eval:*)` 匹配像 `echo foo | eval rm` 这样的完整管道。
 * 每个 SimpleCommand 片段都是单个命令，因此该守卫不会触发。
 *
 * 单独的辅助函数（未并入 checkEarlyExitDeny 也未在调用处内联），
 * 因为 bashToolHasPermission 在 Bun 的 feature() DCE 复杂度阈值上
 * 非常紧张——在那里即使再增加约 5 行也会破坏
 * feature('BASH_CLASSIFIER') 求值并丢弃 pendingClassifierCheck。
 */
function checkSemanticsDeny(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  commands: readonly { text: string }[],
): PermissionResult | null {
  const fullCmd = checkEarlyExitDeny(input, toolPermissionContext)
  if (fullCmd !== null) return fullCmd
  for (const cmd of commands) {
    const subDeny = matchingRulesForInput(
      { ...input, command: cmd.text },
      toolPermissionContext,
      'prefix',
    ).matchingDenyRules[0]
    if (subDeny !== undefined) {
      return {
        behavior: 'deny',
        message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
        decisionReason: { type: 'rule', rule: subDeny },
      }
    }
  }
  return null
}

/**
 * 若分类器已启用且有 allow 描述，则构建待处理的分类器检查元数据。
 * 若分类器被禁用、处于自动模式，或无 allow 描述，则返回 undefined。
 */
function buildPendingClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
): { command: string; cwd: string; descriptions: string[] } | undefined {
  if (!isClassifierPermissionsEnabled()) {
    return undefined
  }
  // 自动模式跳过——自动模式分类器处理所有权限决策
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto')
    return undefined
  if (toolPermissionContext.mode === 'bypassPermissions') return undefined

  const allowDescriptions = getBashPromptAllowDescriptions(
    toolPermissionContext,
  )
  if (allowDescriptions.length === 0) return undefined

  return {
    command,
    cwd: getCwd(),
    descriptions: allowDescriptions,
  }
}

const speculativeChecks = new Map<string, Promise<ClassifierResult>>()

/**
 * 尽早发起一次试探性的 bash allow 分类器检查，使其与预处理钩子、
 * deny/ask 分类器以及权限对话框搭建并行运行。
 * 其结果之后可被 executeAsyncClassifierCheck 通过
 * consumeSpeculativeClassifierCheck 消费。
 */
export function peekSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined {
  return speculativeChecks.get(command)
}

export function startSpeculativeClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): boolean {
  // 与 buildPendingClassifierCheck 相同的守卫
  if (!isClassifierPermissionsEnabled()) return false
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto')
    return false
  if (toolPermissionContext.mode === 'bypassPermissions') return false
  const allowDescriptions = getBashPromptAllowDescriptions(
    toolPermissionContext,
  )
  if (allowDescriptions.length === 0) return false

  const cwd = getCwd()
  const promise = classifyBashCommand(
    command,
    cwd,
    allowDescriptions,
    'allow',
    signal,
    isNonInteractiveSession,
  )
  // 若在消费该 promise 之前信号中止，则防止出现未处理的拒绝。
  // 原始 promise（可能 reject）仍保存在 Map 中供消费者 await。
  promise.catch(() => {})
  speculativeChecks.set(command, promise)
  return true
}

/**
 * 消费指定命令的试探性分类器检查结果。
 * 若有则返回该 promise（并将其从 Map 中移除），否则返回 undefined。
 */
export function consumeSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined {
  const promise = speculativeChecks.get(command)
  if (promise) {
    speculativeChecks.delete(command)
  }
  return promise
}

export function clearSpeculativeChecks(): void {
  speculativeChecks.clear()
}

/**
 * 等待一次待处理的分类器检查；若为高置信度 allow 则返回
 * PermissionDecisionReason，否则返回 undefined。
 *
 * 由 swarm 代理（tmux 与进程内）用于把关权限转发：先运行
 * 分类器，仅当分类器未自动批准时才升级给 leader。
 */
export async function awaitClassifierAutoApproval(
  pendingCheck: PendingClassifierCheck,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<PermissionDecisionReason | undefined> {
  const { command, cwd, descriptions } = pendingCheck
  const speculativeResult = consumeSpeculativeClassifierCheck(command)
  const classifierResult = speculativeResult
    ? await speculativeResult
    : await classifyBashCommand(
        command,
        cwd,
        descriptions,
        'allow',
        signal,
        isNonInteractiveSession,
      )

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  if (
    feature('BASH_CLASSIFIER') &&
    classifierResult.matches &&
    classifierResult.confidence === 'high'
  ) {
    return {
      type: 'classifier',
      classifier: 'bash_allow',
      reason: `Allowed by prompt rule: "${classifierResult.matchedDescription}"`,
    }
  }
  return undefined
}

type AsyncClassifierCheckCallbacks = {
  shouldContinue: () => boolean
  onAllow: (decisionReason: PermissionDecisionReason) => void
  onComplete?: () => void
}

/**
 * 异步执行 bash allow 分类器检查。
 * 权限提示显示期间在后台运行。
 * 若分类器以高置信度允许，且用户尚未交互，则自动批准。
 *
 * @param pendingCheck - 来自 bashToolHasPermission 的分类器检查元数据
 * @param signal - 中止信号
 * @param isNonInteractiveSession - 是否为非交互式会话
 * @param callbacks - 用于检查是否应继续以及处理批准的回调
 */
export async function executeAsyncClassifierCheck(
  pendingCheck: { command: string; cwd: string; descriptions: string[] },
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  callbacks: AsyncClassifierCheckCallbacks,
): Promise<void> {
  const { command, cwd, descriptions } = pendingCheck
  const speculativeResult = consumeSpeculativeClassifierCheck(command)

  let classifierResult: ClassifierResult
  try {
    classifierResult = speculativeResult
      ? await speculativeResult
      : await classifyBashCommand(
          command,
          cwd,
          descriptions,
          'allow',
          signal,
          isNonInteractiveSession,
        )
  } catch (error: unknown) {
    // 当协调者会话被取消时，中止信号触发，分类器 API 调用以
    // APIUserAbortError 拒绝。这是预期行为，
    // 不应作为未处理的 promise 拒绝暴露出来。
    if (error instanceof APIUserAbortError || error instanceof AbortError) {
      callbacks.onComplete?.()
      return
    }
    callbacks.onComplete?.()
    throw error
  }

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  // 若用户已做出决定，或已与权限对话框交互
  //（例如方向键、Tab、输入），则不要自动批准
  if (!callbacks.shouldContinue()) return

  if (
    feature('BASH_CLASSIFIER') &&
    classifierResult.matches &&
    classifierResult.confidence === 'high'
  ) {
    callbacks.onAllow({
      type: 'classifier',
      classifier: 'bash_allow',
      reason: `Allowed by prompt rule: "${classifierResult.matchedDescription}"`,
    })
  } else {
    // 无匹配——通知以便清除检查指示器
    callbacks.onComplete?.()
  }
}

/**
 * 检查在给定输入下是否需要请求用户授权调用 BashTool 的主实现
 */
export async function bashToolHasPermission(
  input: z.infer<typeof BashTool.inputSchema>,
  context: ToolUseContext,
  getCommandSubcommandPrefixFn = getCommandSubcommandPrefix,
): Promise<PermissionResult> {
  let appState = context.getAppState()

  // 0. 基于 AST 的安全解析。这取代了 tryParseShellCommand
  //（shell-quote 预处理）以及 bashCommandIsSafe 误解析门控。
  // tree-sitter 要么产出一个干净的 SimpleCommand[]（引号已解析，
  // 无隐藏替换），要么输出 'too-complex'——这正是我们需要的信号，
  // 用于决定 splitCommand 的输出是否可信。
  //
  // 当 tree-sitter WASM 不可用，或通过环境变量禁用了注入检查时，
  // 我们回退到旧路径（约 1370 行的 legacy 门控执行）。
  const injectionCheckDisabled = isEnvTruthy(
    process.env.LIMKENION_DISABLE_COMMAND_INJECTION_CHECK,
  )
  // GrowthBook 用于 shadow 模式的 killswitch——关闭时完全跳过原生解析。
  // 只计算一次；feature() 必须保持内联在下面的三元表达式中。
  const shadowEnabled = feature('TREE_SITTER_BASH_SHADOW')
    ? getFeatureValue_CACHED_MAY_BE_STALE('limkenion_birch_trellis', true)
    : false
  // 在此解析一次；产生的 AST 同时供 parseForSecurityFromAst
  // 和 bashToolCheckCommandOperatorPermissions 使用。
  let astRoot = injectionCheckDisabled
    ? null
    : feature('TREE_SITTER_BASH_SHADOW') && !shadowEnabled
      ? null
      : await parseCommandRaw(input.command)
  let astResult: ParseForSecurityResult = astRoot
    ? parseForSecurityFromAst(input.command, astRoot)
    : { kind: 'parse-unavailable' }
  let astSubcommands: string[] | null = null
  let astRedirects: Redirect[] | undefined
  let astCommands: SimpleCommand[] | undefined
  let shadowLegacySubs: string[] | undefined

  // Shadow 测试 tree-sitter：记录其判定，然后强制 parse-unavailable，
  // 使 legacy 路径保持权威。parseCommand 仍由 TREE_SITTER_BASH
  //（而非 SHADOW）门控，因此 legacy 内部保持纯正则。
  // 每次 bash 调用记录一个事件，同时覆盖偏差与不可用
  // 原因；模块加载失败由 session 作用域的
  // limkenion_tree_sitter_load 事件单独覆盖。
  if (feature('TREE_SITTER_BASH_SHADOW')) {
    const available = astResult.kind !== 'parse-unavailable'
    let tooComplex = false
    let semanticFail = false
    let subsDiffer = false
    if (available) {
      tooComplex = astResult.kind === 'too-complex'
      semanticFail =
        astResult.kind === 'simple' && !checkSemantics(astResult.commands).ok
      const tsSubs =
        astResult.kind === 'simple'
          ? astResult.commands.map(c => c.text)
          : undefined
      const legacySubs = splitCommand(input.command)
      shadowLegacySubs = legacySubs
      subsDiffer =
        tsSubs !== undefined &&
        (tsSubs.length !== legacySubs.length ||
          tsSubs.some((s, i) => s !== legacySubs[i]))
    }
    logEvent('limkenion_tree_sitter_shadow', {
      available,
      astTooComplex: tooComplex,
      astSemanticFail: semanticFail,
      subsDiffer,
      injectionCheckDisabled,
      killswitchOff: !shadowEnabled,
      cmdOverLength: input.command.length > 10000,
    })
    // 始终强制 legacy——shadow 模式仅作观测。
    astResult = { kind: 'parse-unavailable' }
    astRoot = null
  }

  if (astResult.kind === 'too-complex') {
    // 解析成功但发现了无法静态分析的结构
    //（命令替换、展开、控制流、解析器差异）。
    // 先遵守精确匹配的 deny/ask/allow，再进行前缀/通配 deny。只有当
    // 没有 deny 匹配时才回退到 ask——不要把 deny 降级为 ask。
    const earlyExit = checkEarlyExitDeny(input, appState.toolPermissionContext)
    if (earlyExit !== null) return earlyExit
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason: astResult.reason,
    }
    logEvent('limkenion_bash_ast_too_complex', {
      nodeTypeId: nodeTypeId(astResult.nodeType),
    })
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      suggestions: [],
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  if (astResult.kind === 'simple') {
    // 干净解析：检查语义层面的关注点（zsh 内建、eval 等），
    // 这些能正常分词但按名称是危险的。
    const sem = checkSemantics(astResult.commands)
    if (!sem.ok) {
      // 与 too-complex 路径相同的 deny 规则强制：拥有
      // `Bash(eval:*)` deny 的用户期望 `eval "rm"` 被阻止，而不是降级。
      const earlyExit = checkSemanticsDeny(
        input,
        appState.toolPermissionContext,
        astResult.commands,
      )
      if (earlyExit !== null) return earlyExit
      const decisionReason: PermissionDecisionReason = {
        type: 'other' as const,
        reason: sem.reason,
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
        suggestions: [],
      }
    }
    // 暂存分词后的子命令供后续使用。下游代码（规则
    // 匹配、路径提取、cd 检测）仍对字符串操作，因此我们传入每个
    // SimpleCommand 的原始源码片段。下游
    // 处理（stripSafeWrappers、parseCommandArguments）会对这些片段
    // 重新分词——该重新分词有已知缺陷（stripCommentLines
    // 会误处理引号内的换行），但 checkSemantics 已捕获任何包含
    // 换行的 argv 元素，因此这些缺陷在此不会生效。
    // 将下游迁移为直接操作 argv 是后续提交。
    astSubcommands = astResult.commands.map(c => c.text)
    astRedirects = astResult.commands.flatMap(c => c.redirects)
    astCommands = astResult.commands
  }

  // Legacy shell-quote 预处理。仅在 'parse-unavailable' 时到达
  //（tree-sitter 未加载，或 TREE_SITTER_BASH 特性被关闭）。会
  // 落入下方完整的 legacy 路径。
  if (astResult.kind === 'parse-unavailable') {
    logForDebugging(
      'bashToolHasPermission: tree-sitter unavailable, using legacy shell-quote path',
    )
    const parseResult = tryParseShellCommand(input.command)
    if (!parseResult.success) {
      const decisionReason = {
        type: 'other' as const,
        reason: `Command contains malformed syntax that cannot be parsed: ${parseResult.error}`,
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  // 检查沙箱自动允许（遵守显式 deny/ask 规则）
  // 仅当同时启用了沙箱与自动允许时才调用
  if (
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)
  ) {
    const sandboxAutoAllowResult = checkSandboxAutoAllow(
      input,
      appState.toolPermissionContext,
    )
    if (sandboxAutoAllowResult.behavior !== 'passthrough') {
      return sandboxAutoAllowResult
    }
  }

  // 先检查精确匹配
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    appState.toolPermissionContext,
  )

  // 精确命令被拒绝
  if (exactMatchResult.behavior === 'deny') {
    return exactMatchResult
  }

  // 并行检查 Bash 提示 deny 与 ask 规则（两者都使用 deepseek-flash）。
  // deny 优先于 ask，两者都优先于 allow 规则。
  // 自动模式跳过——自动模式分类器处理所有权限决策
  if (
    isClassifierPermissionsEnabled() &&
    !(
      feature('TRANSCRIPT_CLASSIFIER') &&
      appState.toolPermissionContext.mode === 'auto'
    )
  ) {
    const denyDescriptions = getBashPromptDenyDescriptions(
      appState.toolPermissionContext,
    )
    const askDescriptions = getBashPromptAskDescriptions(
      appState.toolPermissionContext,
    )
    const hasDeny = denyDescriptions.length > 0
    const hasAsk = askDescriptions.length > 0

    if (hasDeny || hasAsk) {
      const [denyResult, askResult] = await Promise.all([
        hasDeny
          ? classifyBashCommand(
              input.command,
              getCwd(),
              denyDescriptions,
              'deny',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
        hasAsk
          ? classifyBashCommand(
              input.command,
              getCwd(),
              askDescriptions,
              'ask',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
      ])

      if (context.abortController.signal.aborted) {
        throw new AbortError()
      }

      if (denyResult) {
        logClassifierResultForAnts(
          input.command,
          'deny',
          denyDescriptions,
          denyResult,
        )
      }
      if (askResult) {
        logClassifierResultForAnts(
          input.command,
          'ask',
          askDescriptions,
          askResult,
        )
      }

      // deny 优先
      if (denyResult?.matches && denyResult.confidence === 'high') {
        return {
          behavior: 'deny',
          message: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          decisionReason: {
            type: 'other',
            reason: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          },
        }
      }

      if (askResult?.matches && askResult.confidence === 'high') {
        // 跳过 deepseek-flash 调用——UI 在本地计算前缀
        // 并允许用户编辑它。当测试覆写它时仍调用注入的函数。
        let suggestions: PermissionUpdate[]
        if (getCommandSubcommandPrefixFn === getCommandSubcommandPrefix) {
          suggestions = suggestionForExactCommand(input.command)
        } else {
          const commandPrefixResult = await getCommandSubcommandPrefixFn(
            input.command,
            context.abortController.signal,
            context.options.isNonInteractiveSession,
          )
          if (context.abortController.signal.aborted) {
            throw new AbortError()
          }
          suggestions = commandPrefixResult?.commandPrefix
            ? suggestionForPrefix(commandPrefixResult.commandPrefix)
            : suggestionForExactCommand(input.command)
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name),
          decisionReason: {
            type: 'other',
            reason: `Required by Bash prompt rule: "${askResult.matchedDescription}"`,
          },
          suggestions,
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // 检查非子命令的 Bash 运算符，如 `>`、`|` 等。
  // 这必须先于危险的路径检查，以便带管道的命令
  // 由运算符逻辑处理（其会生成“多个操作”消息）。
  const commandOperatorResult = await checkCommandOperatorPermissions(
    input,
    (i: z.infer<typeof BashTool.inputSchema>) =>
      bashToolHasPermission(i, context, getCommandSubcommandPrefixFn),
    { isNormalizedCdCommand, isNormalizedGitCommand },
    astRoot,
  )
  if (commandOperatorResult.behavior !== 'passthrough') {
    // 安全修复：当管道段处理返回 'allow' 时，仍必须校验
    // 原始命令。管道段处理在检查每个段之前会剥离重定向，
    // 因此像：
    //   echo 'x' | xargs printf '%s' >> /tmp/file
    // 的命令两段都会被允许（echo 和 xargs printf），但 >> 重定向
    // 会绕过校验。我们必须检查：
    // 1. 输出重定向的路径约束
    // 2. 重定向目标中危险模式（反引号等）的命令安全性
    if (commandOperatorResult.behavior === 'allow') {
      // 在原始命令中检查危险模式（反引号、$() 等）
      // 捕获诸如：echo x | xargs echo > `pwd`/evil.txt
      // 其中反引号位于重定向目标中（已从段上剥离）
      // 由 AST 门控：当 astSubcommands 非空时，tree-sitter 已
      // 校验结构（重定向目标中的反引号/$() 会返回 too-complex）。
      // 与约 1481、约 1706、约 1755 处的门控一致。
      // 避免误报：`find -exec {} \; | grep x` 因反斜杠-; 触发。
      // bashCommandIsSafe 运行完整的 legacy 正则组合（约 20 个模式）——
      // 仅在确实会使用其结果时才调用。
      const safetyResult =
        astSubcommands === null
          ? await bashCommandIsSafeAsync(input.command)
          : null
      if (
        safetyResult !== null &&
        safetyResult.behavior !== 'passthrough' &&
        safetyResult.behavior !== 'allow'
      ) {
        // 附加待处理的分类器检查——可能在用户响应前自动批准
        appState = context.getAppState()
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name, {
            type: 'other',
            reason:
              safetyResult.message ??
              'Command contains patterns that require approval',
          }),
          decisionReason: {
            type: 'other',
            reason:
              safetyResult.message ??
              'Command contains patterns that require approval',
          },
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }

      appState = context.getAppState()
      // 安全：根据完整命令计算 compoundCommandHasCd，而不要
      // 硬编码 false。管道处理路径此前在这里传入 `false`，
      // 禁用了 pathValidation.ts:821 处的 cd+redirect 检查。在
      // `cd .limkenion && echo x > settings.json` 之后追加
      // `| echo done` 会以 compoundCommandHasCd=false 路由经过
      // 此路径，使重定向写入 .limkenion/settings.json 而不触发
      // cd+redirect 检查。
      const pathResult = checkPathConstraints(
        input,
        getCwd(),
        appState.toolPermissionContext,
        commandHasAnyCd(input.command),
        astRedirects,
        astCommands,
      )
      if (pathResult.behavior !== 'passthrough') {
        return pathResult
      }
    }

    // 当管道段返回 'ask'（各段未被规则允许）时，
    // 附加待处理的分类器检查——可能在用户响应前自动批准。
    if (commandOperatorResult.behavior === 'ask') {
      appState = context.getAppState()
      return {
        ...commandOperatorResult,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }

    return commandOperatorResult
  }

  // 安全：legacy 误解析门控。仅在 tree-sitter 模块
  // 未加载时运行。超时/中止通过 too-complex 故障关闭
  //（在上面提前返回），不会路由到这里。当 AST 解析成功时，
  // astSubcommands 非空且我们已校验结构；此块被完全跳过。
  // AST 的 'too-complex' 结果涵盖 isBashSecurityCheckForMisparsing
  // 覆盖的一切——两者都回答同一个问题：
  // “对这份输入，splitCommand 是否能被信任？”
  if (
    astSubcommands === null &&
    !isEnvTruthy(process.env.LIMKENION_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    const originalCommandSafetyResult = await bashCommandIsSafeAsync(
      input.command,
    )
    if (
      originalCommandSafetyResult.behavior === 'ask' &&
      originalCommandSafetyResult.isBashSecurityCheckForMisparsing
    ) {
      // 带安全 heredoc 模式的复合命令（$(cat <<'EOF'...EOF)）
      // 会在未拆分的命令上触发 $() 检查。剥离安全 heredoc
      // 并重新检查剩余部分——若存在其它误解析模式
      //（例如反斜杠转义运算符），它们仍必须被阻止。
      const remainder = stripSafeHeredocSubstitutions(input.command)
      const remainderResult =
        remainder !== null ? await bashCommandIsSafeAsync(remainder) : null
      if (
        remainder === null ||
        (remainderResult?.behavior === 'ask' &&
          remainderResult.isBashSecurityCheckForMisparsing)
      ) {
        // 若精确命令有显式 allow 权限则允许——用户
        // 已作出明确的决定，允许这条特定命令。
        appState = context.getAppState()
        const exactMatchResult = bashToolCheckExactMatchPermission(
          input,
          appState.toolPermissionContext,
        )
        if (exactMatchResult.behavior === 'allow') {
          return exactMatchResult
        }
        // 附加待处理的分类器检查——可能在用户响应前自动批准
        const decisionReason: PermissionDecisionReason = {
          type: 'other' as const,
          reason: originalCommandSafetyResult.message,
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(
            BashTool.name,
            decisionReason,
          ),
          decisionReason,
          suggestions: [], // 不要建议保存可能危险的命令
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // 拆分为子命令。优先使用 AST 抽取的片段；仅当 tree-sitter
  // 不可用时回退到 splitCommand。cd-cwd 过滤器会剥离
  // 模型喜欢追加的 `cd ${cwd}` 前缀。
  const cwd = getCwd()
  const cwdMingw =
    getPlatform() === 'windows' ? windowsPathToPosixPath(cwd) : cwd
  const rawSubcommands =
    astSubcommands ?? shadowLegacySubs ?? splitCommand(input.command)
  const { subcommands, astCommandsByIdx } = filterCdCwdSubcommands(
    rawSubcommands,
    astCommands,
    cwd,
    cwdMingw,
  )

  // CC-643：对子命令扇出设上限。只有 legacy splitCommand 路径会
  // 爆炸——AST 路径要么返回有界的列表（astSubcommands !== null），
  // 要么对无法表示的结构短路为 'too-complex'。
  if (
    astSubcommands === null &&
    subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK
  ) {
    logForDebugging(
      `bashPermissions: ${subcommands.length} subcommands exceeds cap (${MAX_SUBCOMMANDS_FOR_SECURITY_CHECK}) — returning ask`,
      { level: 'debug' },
    )
    const decisionReason = {
      type: 'other' as const,
      reason: `Command splits into ${subcommands.length} subcommands, too many to safety-check individually`,
    }
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      decisionReason,
    }
  }

  // 存在多个 `cd` 命令时询问
  const cdCommands = subcommands.filter(subCommand =>
    isNormalizedCdCommand(subCommand),
  )
  if (cdCommands.length > 1) {
    const decisionReason = {
      type: 'other' as const,
      reason:
        'Multiple directory changes in one command require approval for clarity',
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
    }
  }

  // 跟踪复合命令是否包含 cd，用于安全校验
  // 这防止通过以下方式绕过路径检查：cd .limkenion/ && mv test.txt settings.json
  const compoundCommandHasCd = cdCommands.length > 0

  // 安全：阻止同时包含 cd 与 git 的复合命令
  // 这防止通过以下方式逃逸沙箱：cd /malicious/dir && git status
  // 其中恶意目录包含带有 core.fsmonitor 的裸 git 仓库。
  // 此检查必须在此处（子命令级权限检查之前）进行
  // 因为 bashToolCheckPermission 会独立检查每个子命令，通过
  // BashTool.isReadOnly()，它会仅根据“git status”
  // 重新推导 compoundCommandHasCd=false，绕过 readOnlyValidation.ts 检查。
  if (compoundCommandHasCd) {
    const hasGitCommand = subcommands.some(cmd =>
      isNormalizedGitCommand(cmd.trim()),
    )
    if (hasGitCommand) {
      const decisionReason = {
        type: 'other' as const,
        reason:
          'Compound commands with cd and git require approval to prevent bare repository attacks',
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  appState = context.getAppState() // 重新计算最新状态，以防用户按下 shift+tab

  // 安全修复：在路径约束之前检查 Bash deny/ask 规则
  // 确保像 Bash(ls:*) 这样的显式 deny 规则优先于
  // 对项目外路径返回 'ask' 的路径约束检查。
  // 没有此顺序，项目外的绝对路径（例如 ls /home）会
  // 因为 checkPathConstraints 优先返回 'ask' 而绕过 deny 规则。
  //
  // 注意：bashToolCheckPermission 内部会调用 checkPathConstraints，处理
  // 每个子命令上的输出重定向校验。但由于 splitCommand 会在到达此处前
  // 剥离重定向，我们必须在检查 deny 规则之后、返回结果之前
  // 校验原始命令上的输出重定向。
  const subcommandPermissionDecisions = subcommands.map((command, i) =>
    bashToolCheckPermission(
      { command },
      appState.toolPermissionContext,
      compoundCommandHasCd,
      astCommandsByIdx[i],
    ),
  )

  // 任一子命令被拒绝则拒绝
  const deniedSubresult = subcommandPermissionDecisions.find(
    _ => _.behavior === 'deny',
  )
  if (deniedSubresult !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [
            subcommands[i]!,
            result,
          ]),
        ),
      },
    }
  }

  // 在原始命令上校验输出重定向（在 splitCommand 剥离它们之前）
  // 这必须在检查 deny 规则之后、返回结果之前进行。
  // 输出重定向如 "> /etc/passwd" 会被 splitCommand 剥离，因此逐子命令
  // 的 checkPathConstraints 调用看不到它们。我们在此于原始输入上校验它们。
  // 安全：当 AST 数据可用时，传入 AST 派生的重定向，使
  // checkPathConstraints 直接使用它们，而不是用 shell-quote 重新解析
  //（shell-quote 有已知的单引号反斜杠误解析缺陷，
  // 可能静默隐藏重定向运算符）。
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    appState.toolPermissionContext,
    compoundCommandHasCd,
    astRedirects,
    astCommands,
  )
  if (pathResult.behavior === 'deny') {
    return pathResult
  }

  const askSubresult = subcommandPermissionDecisions.find(
    _ => _.behavior === 'ask',
  )
  const nonAllowCount = count(
    subcommandPermissionDecisions,
    _ => _.behavior !== 'allow',
  )

  // 安全（GH#28784）：仅当没有子命令独立产生 'ask' 时，
  // 才在路径约束 'ask' 上短路。checkPathConstraints 会在完整输入上
  // 重新运行路径命令循环，因此 `cd <项目外> && python3 foo.py`
  // 会产生只带 Read(<dir>/**) 建议的 ask——UI 将其渲染为
  // “是，允许从 <dir>/ 读取”，选择该选项会静默批准
  // python3。当子命令有自己的 ask（例如 cd 子命令自身的
  // 路径约束 ask）时，则跳过：要么下面的 askSubresult 短路
  // 触发（单个非 allow 子命令），要么合并流程为每个非 allow
  // 子命令收集 Bash 规则建议。bashToolCheckPermission 内部的
  // 逐子命令 checkPathConstraints 调用已在该路径中捕获
  // 那部分 cd 目标的 Read 规则。
  //
  // 当没有子命令询问（全部 allow，或全部 passthrough 如 `printf > file`）时，
  // pathResult 就是唯一的 ask——返回它以便重定向检查显现。
  if (pathResult.behavior === 'ask' && askSubresult === undefined) {
    return pathResult
  }

  // 若任一子命令需要批准则询问（例如越界的 ls/cd）。
  // 仅当恰好一个子命令需要批准时才短路——若多个
  // 需要（例如 cd-出项目 ask + python3 passthrough），则转入
  // 合并流程，使提示为它们全部呈现 Bash 规则建议
  //，而不是只呈现首个 ask 的 Read 规则（GH#28784）。
  if (askSubresult !== undefined && nonAllowCount === 1) {
    return {
      ...askSubresult,
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  // 精确命令是 allow 则允许
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 若所有子命令通过精确或前缀匹配都被允许，则允许该
  // 命令——但前提是没有任何命令注入可能。当 AST
  // 解析成功时，每个子命令都已知安全（无隐藏替换、
  // 无结构技巧）；逐子命令重新检查是
  // 多余的。当处于 legacy 路径时，对每个子命令重新运行
  // bashCommandIsSafeAsync。
  let hasPossibleCommandInjection = false
  if (
    astSubcommands === null &&
    !isEnvTruthy(process.env.LIMKENION_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    // CC-643：将偏差遥测批量合并为单个 logEvent。逐子命令
    // logEvent 曾是热路径 syscall 瓶颈（每次调用都经由
    // process.memoryUsage() 触发 /proc/self/stat）。聚合计数则
    // 保留信号。
    let divergenceCount = 0
    const onDivergence = () => {
      divergenceCount++
    }
    const results = await Promise.all(
      subcommands.map(c => bashCommandIsSafeAsync(c, onDivergence)),
    )
    hasPossibleCommandInjection = results.some(
      r => r.behavior !== 'passthrough',
    )
    if (divergenceCount > 0) {
      logEvent('limkenion_tree_sitter_security_divergence', {
        quoteContextDivergence: true,
        count: divergenceCount,
      })
    }
  }
  if (
    subcommandPermissionDecisions.every(_ => _.behavior === 'allow') &&
    !hasPossibleCommandInjection
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [
            subcommands[i]!,
            result,
          ]),
        ),
      },
    }
  }

  // 为命令前缀查询 deepseek-flash
  // 跳过 deepseek-flash 调用——UI 在本地计算前缀并
  // 允许用户编辑它。当注入了自定义 fn 时仍调用（测试）。
  let commandSubcommandPrefix: Awaited<
    ReturnType<typeof getCommandSubcommandPrefixFn>
  > = null
  if (getCommandSubcommandPrefixFn !== getCommandSubcommandPrefix) {
    commandSubcommandPrefix = await getCommandSubcommandPrefixFn(
      input.command,
      context.abortController.signal,
      context.options.isNonInteractiveSession,
    )
    if (context.abortController.signal.aborted) {
      throw new AbortError()
    }
  }

  // 若只有一个命令，无需处理子命令
  appState = context.getAppState() // 重新计算最新状态，以防用户按下 shift+tab
  if (subcommands.length === 1) {
    const result = await checkCommandAndSuggestRules(
      { command: subcommands[0]! },
      appState.toolPermissionContext,
      commandSubcommandPrefix,
      compoundCommandHasCd,
      astSubcommands !== null,
    )
    // 若命令未被允许，附加待处理的分类器检查。
    // 在此时刻，'ask' 只能来自 bashCommandIsSafe（checkCommandAndSuggestRules
    // 内部的安全检查），而非显式 ask 规则——那些已在
    // 第 13 步（askSubresult 检查）被过滤掉。分类器可以绕过安全检查。
    if (result.behavior === 'ask' || result.behavior === 'passthrough') {
      return {
        ...result,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }
    return result
  }

  // 检查子命令权限结果
  const subcommandResults: Map<string, PermissionResult> = new Map()
  for (const subcommand of subcommands) {
    subcommandResults.set(
      subcommand,
      await checkCommandAndSuggestRules(
        {
          // 传入类似 `sandbox` 的输入参数
          ...input,
          command: subcommand,
        },
        appState.toolPermissionContext,
        commandSubcommandPrefix?.subcommandPrefixes.get(subcommand),
        compoundCommandHasCd,
        astSubcommands !== null,
      ),
    )
  }

  // 所有子命令都被允许则放行
  // 注意：这与 6b 不同，因为我们在检查命令注入结果。
  if (
    subcommands.every(subcommand => {
      const permissionResult = subcommandResults.get(subcommand)
      return permissionResult?.behavior === 'allow'
    })
  ) {
    // 将 subcommandResults 保留为 PermissionResult 用于 decisionReason
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: subcommandResults,
      },
    }
  }

  // 否则，请求权限
  const collectedRules: Map<string, PermissionRuleValue> = new Map()

  for (const [subcommand, permissionResult] of subcommandResults) {
    if (
      permissionResult.behavior === 'ask' ||
      permissionResult.behavior === 'passthrough'
    ) {
      const updates =
        'suggestions' in permissionResult
          ? permissionResult.suggestions
          : undefined

      const rules = extractRules(updates)
      for (const rule of rules) {
        // 使用字符串表示作为键去重
        const ruleKey = permissionRuleValueToString(rule)
        collectedRules.set(ruleKey, rule)
      }

      // GH#28784 后续：安全检查的 ask（复合 cd+写、进程
      // 替换等）不带建议。在像 `cd ~/out && rm -rf x` 这样的
      // 复合命令中，这意味着只会收集到 cd 的 Read 规则，
      // UI 将提示标注为“是，允许从 <dir>/ 读取”——从未
      // 提及 rm。合成一个 Bash(exact) 规则，使 UI 显示
      // 链式命令。跳过显式 ask 规则（decisionReason.type 'rule'），
      // 因为用户希望每次都人工复核。
      if (
        permissionResult.behavior === 'ask' &&
        rules.length === 0 &&
        permissionResult.decisionReason?.type !== 'rule'
      ) {
        for (const rule of extractRules(
          suggestionForExactCommand(subcommand),
        )) {
          const ruleKey = permissionRuleValueToString(rule)
          collectedRules.set(ruleKey, rule)
        }
      }
      // 注意：我们只收集规则，而非模式更改等其它更新类型。
      // 这对主要需要规则建议的 bash 子命令是合适的。
    }
  }

  const decisionReason = {
    type: 'subcommandResults' as const,
    reasons: subcommandResults,
  }

  // GH#11380：以 MAX_SUGGESTED_RULES_FOR_COMPOUND 为上限。Map 保留插入
  // 顺序（子命令顺序），因此切片会保留最左侧的 N 个。
  const cappedRules = Array.from(collectedRules.values()).slice(
    0,
    MAX_SUGGESTED_RULES_FOR_COMPOUND,
  )
  const suggestedUpdates: PermissionUpdate[] | undefined =
    cappedRules.length > 0
      ? [
          {
            type: 'addRules',
            rules: cappedRules,
            behavior: 'allow',
            destination: 'localSettings',
          },
        ]
      : undefined

  // 附加待处理的分类器检查——可能在用户响应前自动批准。
  // 若任一子命令为 'ask'（例如路径约束或 ask 规则），则行为为 'ask'
  //——在 GH#28784 修复之前，ask 子结果总会
  // 在上面短路，因此此路径只见到 'passthrough' 子命令并把行为硬编码为直通。
  return {
    behavior: askSubresult !== undefined ? 'ask' : 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    suggestions: suggestedUpdates,
    ...(feature('BASH_CLASSIFIER')
      ? {
          pendingClassifierCheck: buildPendingClassifierCheck(
            input.command,
            appState.toolPermissionContext,
          ),
        }
      : {}),
  }
}

/**
 * 在归一化掉安全包装（环境变量、timeout 等）与 shell 引号后，
 * 检查子命令是否为 git 命令。
 *
 * 安全：匹配前必须先归一化，以防止以下绕过：
 *   'git' status    —— shell 引号对朴素正则隐藏命令
 *   NO_COLOR=1 git status —— 环境变量前缀隐藏命令
 */
export function isNormalizedGitCommand(command: string): boolean {
  // 快路径：在任何解析之前捕获最常见的情况
  if (command.startsWith('git ') || command === 'git') {
    return true
  }
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    // 直接 git 命令
    if (parsed.tokens[0] === 'git') {
      return true
    }
    // "xargs git ..." —— xargs 在当前目录运行 git，
    // 因此必须将其视为 git 命令，用于 cd+git 安全检查。
    // 这与 filterRulesByContentsMatchingInput 中的 xargs 前缀处理一致。
    if (parsed.tokens[0] === 'xargs' && parsed.tokens.includes('git')) {
      return true
    }
    return false
  }
  return /^git(?:\s|$)/.test(stripped)
}

/**
 * 在归一化掉安全包装（环境变量、timeout 等）与 shell 引号后，
 * 检查子命令是否为 cd 命令。
 *
 * 安全：匹配前必须先归一化，以防止以下绕过：
 *   FORCE_COLOR=1 cd sub —— 环境变量前缀对朴素 /^cd / 正则隐藏 cd
 *   这与 isNormalizedGitCommand 保持对称归一化。
 *
 * 同时匹配 pushd/popd——它们与 cd 一样改变 cwd，因此
 *   pushd /tmp/bare-repo && git status
 * 必须触发相同的 cd+git 守卫。镜像 PowerShell 的
 * DIRECTORY_CHANGE_ALIASES（src/utils/powershell/parser.ts）。
 */
export function isNormalizedCdCommand(command: string): boolean {
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    const cmd = parsed.tokens[0]
    return cmd === 'cd' || cmd === 'pushd' || cmd === 'popd'
  }
  return /^(?:cd|pushd|popd)(?:\s|$)/.test(stripped)
}

/**
 * 检查复合命令是否包含任何 cd 命令，
 * 使用可处理环境变量前缀与 shell 引号的归一化检测。
 */
export function commandHasAnyCd(command: string): boolean {
  return splitCommand(command).some(subcmd =>
    isNormalizedCdCommand(subcmd.trim()),
  )
}
