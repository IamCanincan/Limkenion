import { isEnvTruthy } from '../../utils/envUtils.js'
import { getMaxOutputLength } from '../../utils/shell/outputLimits.js'
import {
  getPowerShellEdition,
  type PowerShellEdition,
} from '../../utils/shell/powershellDetection.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { POWERSHELL_TOOL_NAME } from './toolName.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

function getBackgroundUsageNote(): string | null {
  if (isEnvTruthy(process.env.LIMKENION_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return `  - 你可以使用 \`run_in_background\` 参数在后台运行该命令。仅当你不需要立即获取结果、且愿意在该命令稍后完成时收到通知时才使用它。你无需立刻查看输出——完成时你会被通知。`
}

function getSleepGuidance(): string | null {
  if (isEnvTruthy(process.env.LIMKENION_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return `  - 避免不必要的 \`Start-Sleep\` 命令：
    - 不要在可以立即执行的命令之间 sleep——直接执行即可。
    - 如果你的命令会长时间运行，并且希望在完成时收到通知——直接用 \`run_in_background\` 运行该命令即可，这种情况下无需 sleep。
    - 不要在 sleep 循环中重试失败的命令——请诊断根本原因或考虑其他方案。
    - 如果是在等待你用 \`run_in_background\` 启动的后台任务，完成时你会被通知——不要轮询。
    - 如果必须轮询外部进程，请先使用检查命令，而不是 sleep。
    - 如果必须 sleep，请保持短时长（1-5 秒）以避免阻塞用户。`
}

/**
 * 版本相关的语法指引。模型训练数据覆盖两个版本，但它无法判断自己面向的是哪个版本，
 * 于是在 5.1 上输出 pwsh-7 语法（解析报错 → 退出码 1），或在 7 上无谓地避免使用 &&。
 */
function getEditionSection(edition: PowerShellEdition | null): string {
  if (edition === 'desktop') {
    return `PowerShell 版本：Windows PowerShell 5.1 (powershell.exe)
   - 管道链运算符 \`&&\` 和 \`||\` 不可用——会导致解析错误。仅当 A 成功才运行 B：\`A; if ($?) { B }\`。无条件串联：\`A; B\`。
   - 三元（\`?:\`）、空值合并（\`??\`）和空值条件（\`?.\`）运算符不可用。请改用 \`if/else\` 和显式的 \`$null -eq\` 检查。
   - 避免对原生可执行文件使用 \`2>&1\`。在 5.1 中，在 PowerShell 内重定向原生命令的 stderr，会用 ErrorRecord（NativeCommandError）包裹每一行，且即使可执行文件返回退出码 0 也会把 \`$?\` 置为 \`$false\`。stderr 已替你捕获——不要重定向它。
   - 默认文件编码为 UTF-16 LE（带 BOM）。当写入其他工具要读取的文件时，请给 \`Out-File\`/\`Set-Content\` 传入 \`-Encoding utf8\`。
   - \`ConvertFrom-Json\` 返回 PSCustomObject 而非哈希表。\`-AsHashtable\` 不可用。`
  }
  if (edition === 'core') {
    return `PowerShell 版本：PowerShell 7+ (pwsh)
   - 管道链运算符 \`&&\` 和 \`||\` 可用，行为与 bash 类似。当 cmd2 应仅在 cmd1 成功时运行时，优先用 \`cmd1 && cmd2\` 而非 \`cmd1; cmd2\`。
   - 三元（\`$cond ? $a : $b\`）、空值合并（\`??\`）和空值条件（\`?.\`）运算符可用。
   - 默认文件编码为 UTF-8 无 BOM。`
  }
  // 检测尚未确定（首次构建提示词时尚未有任何工具调用）或未安装 PS。
  // 给出保守的、兼容 5.1 的指引。
  return `PowerShell 版本：未知——为兼容性按 Windows PowerShell 5.1 处理
   - 不要使用 \`&&\`、\`||\`、三元 \`?:\`、空值合并 \`??\` 或空值条件 \`?.\`。这些仅 PowerShell 7+ 支持，在 5.1 上会解析报错。
   - 条件串联命令：\`A; if ($?) { B }\`。无条件：\`A; B\`。`
}

export async function getPrompt(): Promise<string> {
  const backgroundNote = getBackgroundUsageNote()
  const sleepGuidance = getSleepGuidance()
  const edition = await getPowerShellEdition()

  return `执行一条 PowerShell 命令，可带可选超时。工作目录在命令之间保持；shell 状态（变量、函数）不保持。

重要：本工具用于通过 PowerShell 进行终端操作：git、npm、docker 及 PS cmdlet。不要将其用于文件操作（读取、写入、编辑、搜索、查找文件）——请改用专门的工具。

${getEditionSection(edition)}

执行命令前，请遵循以下步骤：

1. 目录校验：
   - 如果命令会新建目录或文件，先用 \`Get-ChildItem\`（或 \`ls\`）校验父目录是否存在且位置正确

2. 命令执行：
   - 对含空格的文件路径务必用双引号括起来
   - 捕获命令的输出。

PowerShell 语法说明：
   - 变量使用 $ 前缀：$myVar = "value"
   - 转义字符是反引号（\`），不是反斜杠
   - 使用 Verb-Noun 风格的 cmdlet 命名：Get-ChildItem、Set-Location、New-Item、Remove-Item
   - 常见别名：ls (Get-ChildItem)、cd (Set-Location)、cat (Get-Content)、rm (Remove-Item)
   - 管道运算符 | 与 bash 类似，但传递的是对象而非文本
   - 使用 Select-Object、Where-Object、ForEach-Object 进行筛选和变换
   - 字符串插值："Hello $name" 或 "Hello $($obj.Property)"
   - 注册表访问使用 PSDrive 前缀：\`HKLM:\\SOFTWARE\\...\`、\`HKCU:\\...\`——而非裸的 \`HKEY_LOCAL_MACHINE\\...\`
   - 环境变量：用 \`$env:NAME\` 读取，用 \`$env:NAME = "value"\` 设置（不要用 \`Set-Variable\` 或 bash 的 \`export\`）
   - 通过调用运算符调用路径含空格的原生 exe：\`& "C:\\Program Files\\App\\app.exe" arg1 arg2\`

交互式与阻塞命令（会挂起——本工具以 -NonInteractive 运行）：
   - 绝不要使用 \`Read-Host\`、\`Get-Credential\`、\`Out-GridView\`、\`$Host.UI.PromptForChoice\` 或 \`pause\`
   - 破坏性 cmdlet（\`Remove-Item\`、\`Stop-Process\`、\`Clear-Content\` 等）可能会提示确认。当你确实希望该操作继续时，请加上 \`-Confirm:$false\`。对只读/隐藏项使用 \`-Force\`。
   - 绝不要使用 \`git rebase -i\`、\`git add -i\` 或其他会打开交互式编辑器的命令

向原生可执行文件传递多行字符串（提交信息、文件内容）：
   - 使用单引号 here-string，这样 PowerShell 不会展开其中的 \`$\` 或反引号。结束的 \`'@\` 必须在独立一行且位于第 0 列（无前导空白）——缩进它是解析错误：
<example>
git commit -m @'
提交信息在这。
第二行带 $literal 美元符号。
'@
</example>
   - 使用 \`@'...'@\`（单引号、字面量），而非 \`@"..."@\`（双引号、插值），除非你需要变量展开
   - 对于包含 \`-\`、\`@\` 或其他 PowerShell 会解析为运算符的字符的参数，请使用停止解析令牌：\`git log --% --format=%H\`

用法说明：
  - command 参数是必需的。
  - 你可以指定可选超时（毫秒，最多 ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} 分钟）。若未指定，命令将在 ${getDefaultTimeoutMs()}ms（${getDefaultTimeoutMs() / 60000} 分钟）后超时。
  - 为这条命令写一段清晰、简洁的描述会非常有帮助。
  - 若输出超过 ${getMaxOutputLength()} 个字符，返回前将被截断。
${backgroundNote ? backgroundNote + '\n' : ''}\
  - 除非明确指示，否则避免用 PowerShell 运行已有专门工具的命令：
    - 文件搜索：使用 ${GLOB_TOOL_NAME}（不要用 Get-ChildItem -Recurse）
    - 内容搜索：使用 ${GREP_TOOL_NAME}（不要用 Select-String）
    - 读取文件：使用 ${FILE_READ_TOOL_NAME}（不要用 Get-Content）
    - 编辑文件：使用 ${FILE_EDIT_TOOL_NAME}
    - 写入文件：使用 ${FILE_WRITE_TOOL_NAME}（不要用 Set-Content/Out-File）
    - 沟通交互：直接输出文本（不要用 Write-Output/Write-Host）
  - 在单条消息中发出多条命令时：
    - 若命令相互独立、可并行执行，请在单条消息里多次调用 ${POWERSHELL_TOOL_NAME} 工具。
    - 若命令相互依赖、必须顺序执行，请在单次 ${POWERSHELL_TOOL_NAME} 调用中串联（参见上文版本相关的串联语法）。
    - 仅在需要按顺序执行但不在乎前面命令是否失败时使用 \`;\`。
    - 不要用换行符分隔命令（在带引号的字符串和 here-string 中换行是可以的）
  - 不要在命令前加 \`cd\` 或 \`Set-Location\`——工作目录已自动设置为正确的项目目录。
${sleepGuidance ? sleepGuidance + '\n' : ''}\
  - 对于 git 命令：
    - 优先新建提交，而不是 amend 既有提交。
    - 在执行破坏性操作（如 git reset --hard、git push --force、git checkout --）之前，考虑是否有更安全的替代方案能达到同样目的。仅当你确认破坏性操作确实是最佳选择时才使用。
    - 除非用户明确要求，否则不要跳过钩子（--no-verify）或绕过签名（--no-gpg-sign、-c commit.gpgsign=false）。若钩子失败，请调查并修复根本问题。`
}
