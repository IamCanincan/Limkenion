import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { parseSlashCommandToolsFromFrontmatter } from '../utils/markdownConfigLoader.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import { createMovedToPluginCommand } from './createMovedToPluginCommand.js'

const SECURITY_REVIEW_MARKDOWN = `---
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git show:*), Bash(git remote show:*), Read, Glob, Grep, LS, Task
description: 对当前分支的待确认更改执行一次安全审查
---

你是一名资深安全工程师，正在对本分支上的更改进行一次聚焦的安全审查。

GIT STATUS:

\`\`\`
!\`git status\`
\`\`\`

FILES MODIFIED:

\`\`\`
!\`git diff --name-only origin/HEAD...\`
\`\`\`

COMMITS:

\`\`\`
!\`git log --no-decorate origin/HEAD...\`
\`\`\`

DIFF CONTENT:

\`\`\`
!\`git diff origin/HEAD...\`
\`\`\`

请审查上面的完整 diff。它包含该 PR 中的全部代码改动。


OBJECTIVE:
开展一次以安全为聚焦点的代码审查，识别具有真实可利用潜力的 HIGH-CONFIDENCE 安全漏洞。这不是一次泛泛的代码审查——只聚焦本 PR 新引入的安全影响。不要对既有的安全问题发表意见。

CRITICAL INSTRUCTIONS:
1. 尽量减少误报：只在你能对实际可利用性有 >80% 把握时才标记问题
2. 避免噪音：跳过纯理论问题、风格问题或低影响发现
3. 聚焦影响：优先考虑可能导致未授权访问、数据泄露或系统沦陷的漏洞
4. 排除项：不要报告以下问题类型：
   - 拒绝服务（DOS）漏洞，即使它们允许服务中断
   - 存储在磁盘上的机密或敏感数据（这些由其他流程处理）
   - 限流或资源耗尽问题

SECURITY CATEGORIES TO EXAMINE:

**Input Validation Vulnerabilities（输入验证漏洞）:**
- 通过未经净化的用户输入导致 SQL 注入
- 系统调用或子进程中的命令注入
- XML 解析中的 XXE 注入
- 模板引擎中的模板注入
- 数据库查询中的 NoSQL 注入
- 文件操作中的路径遍历

**Authentication & Authorization Issues（认证与授权问题）:**
- 认证绕过逻辑
- 提权路径
- 会话管理缺陷
- JWT 令牌漏洞
- 授权逻辑绕过

**Crypto & Secrets Management（加密与机密管理）:**
- 硬编码的 API 密钥、密码或令牌
- 弱加密算法或实现
- 不当的密钥存储或管理
- 加密随机性问题
- 证书校验绕过

**Injection & Code Execution（注入与代码执行）:**
- 通过反序列化导致的远程代码执行
- Python 中的 Pickle 注入
- YAML 反序列化漏洞
- 动态代码执行中的 Eval 注入
- Web 应用中的 XSS 漏洞（反射型、存储型、基于 DOM 型）

**Data Exposure（数据暴露）:**
- 敏感数据被记录或存储
- PII 处理违规
- API 端点数据泄露
- 调试信息暴露

其他注意事项：
- 即使某问题只能从本地网络被利用，它仍然可能是 HIGH 严重性问题

ANALYSIS METHODOLOGY（分析方法论）:

Phase 1 - Repository Context Research（代码库上下文研究，使用文件搜索工具）:
- 识别在用的既有安全框架与库
- 查找代码库中已确立的安全编码模式
- 检查既有的净化与校验模式
- 理解项目的安全模型与威胁模型

Phase 2 - Comparative Analysis（对比分析）:
- 将新代码改动与既有安全模式对比
- 找出背离既有安全实践之处
- 查找不一致的安全实现
- 标记引入了新攻击面的代码

Phase 3 - Vulnerability Assessment（漏洞评估）:
- 检查每个被修改文件的安全影响
- 追踪从用户输入到敏感操作的数据流
- 查找被不安全地跨过的权限边界
- 识别注入点与不安全的反序列化

REQUIRED OUTPUT FORMAT（要求的输出格式）:

你必须以 markdown 输出你的发现。markdown 输出应包含文件、行号、严重性、类别（例如 \`sql_injection\` 或 \`xss\`）、描述、利用场景与修复建议。

例如：

# Vuln 1: XSS: \`foo.py:42\`

* Severity: High
* Description: 来自 \`username\` 参数的用户输入未经转义直接插入到 HTML 中，允许反射型 XSS 攻击
* Exploit Scenario: 攻击者构造类似 /bar?q=<script>alert(document.cookie)</script> 的 URL，在受害者浏览器中执行 JavaScript，从而实现会话劫持或数据窃取
* Recommendation: 对所有渲染到 HTML 的用户输入使用 Flask 的 escape() 函数或启用了自动转义的 Jinja2 模板

SEVERITY GUIDELINES（严重性指南）:
- **HIGH**: 可直接利用、导致 RCE、数据泄露或认证绕过的漏洞
- **MEDIUM**: 需要特定条件但影响显著、的漏洞
- **LOW**: 纵深防御问题或较低影响的漏洞

CONFIDENCE SCORING（置信度评分）:
- 0.9-1.0: 已识别确定的可利用路径，如可能则加以测试
- 0.8-0.9: 具有已知利用方法的清晰漏洞模式
- 0.7-0.8: 需要特定条件才能利用的可疑模式
- 低于 0.7: 不要报告（过于推测性）

FINAL REMINDER（最终提醒）:
只聚焦 HIGH 与 MEDIUM 的发现。与其用误报淹没报告，不如漏掉一些理论问题。每条发现都应该是安全工程师在 PR 审查中会自信提出的内容。

FALSE POSITIVE FILTERING（误报过滤）:

> 你无需运行命令来复现漏洞，只需阅读代码来判断它是否是一个真实漏洞。不要使用 bash 工具，也不要写入任何文件。
>
> HARD EXCLUSIONS（硬性排除项）- 自动排除符合以下模式、的发现：
> 1. 拒绝服务（DOS）漏洞或资源耗尽攻击。
> 2. 存储到磁盘、但其余部分得到妥善保护的机密或凭据。
> 3. 限流问题或服务过载场景。
> 4. 内存消耗或 CPU 耗尽问题。
> 5. 对非安全关键字段的输入校验缺失而未被证明有安全影响。
> 6. 针对 GitHub Action 工作流的输入净化问题，除非能清晰地被不受信输入触发。
> 7. 缺少加固措施。代码不要求实现所有安全最佳实践，只标记具体漏洞。
> 8. 属理论而非实际问题的竞争条件或时序攻击。只有当竞争条件确实会造成具体问题时才报告。
> 9. 过时第三方库相关的漏洞。这些单独管理，不应在这里报告。
> 10. 内存安全问题（如缓冲区溢出或 use-after-free 漏洞）在 rust 中不可能发生。不要报告 rust 或任何其他内存安全语言的内存安全问题。
> 11. 仅用作单元测试或仅在运行测试时使用的文件。
> 12. 日志伪造问题。将未经净化的用户输入输出到日志并不是漏洞。
> 13. 只能控制路径的 SSRF 漏洞。只有能控制主机或协议时 SSRF 才是问题。
> 14. 在 AI 系统提示词中包含用户可控内容不是漏洞。
> 15. 正则注入。将不受信内容注入正则不是漏洞。
> 16. 正则 DOS 问题。
> 16. 不安全的文档。不要报告文档文件（如 markdown 文件）中的任何发现。
> 17. 缺少审计日志不是漏洞。
>
> PRECEDENTS（先例）-
> 1. 以明文记录高价值机密是漏洞。记录 URL 被认为是安全的。
> 2. UUID 可被认为不可猜测，无需校验。
> 3. 环境变量与 CLI 标志是受信任的值。攻击者在安全环境中通常无法修改它们。任何依赖控制环境变量的攻击均无效。
> 4. 资源管理问题（如内存或文件描述符泄漏）不算有效发现。
> 5. 微妙或低影响的 Web 漏洞（如 tabnabbing、XS-Leaks、原型污染、开放重定向）除非置信度极高，否则不应报告。
> 6. React 与 Angular 通常对 XSS 是安全的。除非使用 dangerouslySetInnerHTML、bypassSecurityTrustHtml 或类似方法，否则这些框架无需对用户输入进行净化或转义。不要在 React 或 Angular 组件或 tsx 文件中报告 XSS 漏洞，除非它们使用了不安全的方法。
> 7. github action 工作流中的大多数漏洞在实践中并不可利用。在验证 github action 工作流漏洞之前，请确保它是具体且有非常明确的攻击路径的。
> 8. 客户端 JS/TS 代码缺少权限检查或认证不是漏洞。客户端代码不受信任、无需实现这些检查，它们由服务端处理。这同样适用于所有将不受信数据发送到后端的流程，后端负责校验并净化所有输入。
> 9. 只有当 MEDIUM 发现属于显而易见且具体的问题时才包含它们。
> 10. ipython notebook（*.ipynb 文件）中的大多数漏洞在实践中并不可利用。在验证 notebook 漏洞之前，请确保它是具体且有非常明确的攻击路径，能让不受信任输入触发漏洞。
> 11. 记录非 PII 数据不是漏洞，即使数据可能敏感。只在暴露机密、密码或个人身份信息（PII）等敏感信息时报告日志记录漏洞。
> 12. shell 脚本中的命令注入漏洞在实践中通常并不可利用，因为 shell 脚本通常不以不受信的用户输入运行。只有当 shell 脚本中的命令注入漏洞具体且对不受信输入具有非常明确的攻击路径时才报告。
>
> SIGNAL QUALITY CRITERIA（信号质量准则）- 对剩余发现进行评估：
> 1. 是否存在具体、可利用且具有清晰攻击路径的漏洞？
> 2. 这代表真实安全风险还是理论上的最佳实践？
> 3. 是否有具体的代码位置和复现步骤？
> 4. 这一发现对安全团队来说是否可执行?
>
> 对每条发现，从 1-10 给出置信度评分：
> - 1-3: 低置信度，很可能是误报或噪音
> - 4-6: 中置信度，需要调查
> - 7-10: 高置信度，很可能是真实漏洞

START ANALYSIS（开始分析）:

现在开始你的分析。分 3 步进行：

1. 使用一个子任务来识别漏洞。使用仓库探索工具理解代码库上下文，然后分析 PR 变更的安全影响。在该子任务的提示词中，包含以上全部内容。
2. 然后，对上述子任务识别出的每条漏洞，创建一个新子任务来过滤误报。将这些子任务作为并行子任务启动。在这些子任务的提示词中，包含 "FALSE POSITIVE FILTERING" 指令中的所有内容。
3. 过滤掉子任务报告置信度低于 8 的漏洞。

你的最终回复必须只包含该 markdown 报告，不含其他内容。`

export default createMovedToPluginCommand({
  name: 'security-review',
  description:
    '对当前分支的待确认更改执行一次安全审查',
  progressMessage: '正在分析代码更改以识别安全风险',
  pluginName: 'security-review',
  pluginCommand: 'security-review',
  async getPromptWhileMarketplaceIsPrivate(_args, context) {
    // Parse frontmatter from the markdown
    const parsed = parseFrontmatter(SECURITY_REVIEW_MARKDOWN)

    // Parse allowed tools from frontmatter
    const allowedTools = parseSlashCommandToolsFromFrontmatter(
      parsed.frontmatter['allowed-tools'],
    )

    // Execute bash commands in the prompt
    const processedContent = await executeShellCommandsInPrompt(
      parsed.content,
      {
        ...context,
        getAppState() {
          const appState = context.getAppState()
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                command: allowedTools,
              },
            },
          }
        },
      },
      'security-review',
    )

    return [
      {
        type: 'text',
        text: processedContent,
      },
    ]
  },
})
