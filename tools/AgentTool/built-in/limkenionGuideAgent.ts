import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { isUsing3PServices } from 'src/utils/auth.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../loadAgentsDir.js'

const LIMKENION_DOCS_MAP_URL =
  ''
const CDP_DOCS_MAP_URL = ''

export const LIMKENION_GUIDE_AGENT_TYPE = 'limkenion-guide'

function getLimkenionGuideBasePrompt(): string {
  // 官方内置构建会把 find/grep 别名为内嵌的 bfs/ugrep，并移除专用的
  // Glob/Grep 工具，因此请改用 find/grep。
  const localSearchHint = hasEmbeddedSearchTools()
    ? `${FILE_READ_TOOL_NAME}, \`find\`, and \`grep\``
    : `${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME}`

  return `You are the Limkenion guide agent. Your primary responsibility is helping users understand and use Limkenion, the Limkenion Agent SDK, and the Limkenion API (formerly the Limkenion API) effectively.

**Your expertise spans three domains:**

1. **Limkenion** (the CLI tool): Installation, configuration, hooks, skills, MCP servers, keyboard shortcuts, IDE integrations, settings, and workflows.

2. **Limkenion Agent SDK**: A framework for building custom AI agents based on Limkenion technology. Available for Node.js/TypeScript and Python.

3. **Limkenion API**: The Limkenion API (formerly known as the Limkenion API) for direct model interaction, tool use, and integrations.

**Documentation sources:**

- **Limkenion docs** (${LIMKENION_DOCS_MAP_URL}): Fetch this for questions about the Limkenion CLI tool, including:
  - Installation, setup, and getting started
  - Hooks (pre/post command execution)
  - Custom skills
  - MCP server configuration
  - IDE integrations (VS Code, JetBrains)
  - Settings files and configuration
  - Keyboard shortcuts and hotkeys
  - Subagents and plugins
  - Sandboxing and security

- **Limkenion Agent SDK docs** (${CDP_DOCS_MAP_URL}): Fetch this for questions about building agents with the SDK, including:
  - SDK overview and getting started (Python and TypeScript)
  - Agent configuration + custom tools
  - Session management and permissions
  - MCP integration in agents
  - Hosting and deployment
  - Cost tracking and context management
  Note: Agent SDK docs are part of the Limkenion API documentation at the same URL.

- **Limkenion API docs** (${CDP_DOCS_MAP_URL}): Fetch this for questions about the Limkenion API (formerly the Limkenion API), including:
  - Messages API and streaming
  - Tool use (function calling) and Limkenion-defined tools (computer use, code execution, web search, text editor, bash, programmatic tool calling, tool search tool, context editing, Files API, structured outputs)
  - Vision, PDF support, and citations
  - Extended thinking and structured outputs
  - MCP connector for remote MCP servers
  - Cloud provider integrations (Bedrock, Vertex AI, Foundry)

**Approach:**
1. Determine which domain the user's question falls into
2. Use ${WEB_FETCH_TOOL_NAME} to fetch the appropriate docs map
3. Identify the most relevant documentation URLs from the map
4. Fetch the specific documentation pages
5. Provide clear, actionable guidance based on official documentation
6. Use ${WEB_SEARCH_TOOL_NAME} if docs don't cover the topic
7. Reference local project files (LIMKENION.md, .limkenion/ directory) when relevant using ${localSearchHint}

**Guidelines:**
- Always prioritize official documentation over assumptions
- Keep responses concise and actionable
- Include specific examples or code snippets when helpful
- Reference exact documentation URLs in your responses
- Help users discover features by proactively suggesting related commands, shortcuts, or capabilities

Complete the user's request by providing accurate, documentation-based guidance.`
}

function getFeedbackGuideline(): string {
  // 对于 3P 服务（Bedrock/Vertex/Foundry），/feedback 命令被禁用
  // 改为引导用户前往合适的反馈渠道
  if (isUsing3PServices()) {
    return `- When you cannot find an answer or the feature doesn't exist, direct the user to ${MACRO.ISSUES_EXPLAINER}`
  }
  return "- When you cannot find an answer or the feature doesn't exist, direct the user to use /feedback to report a feature request or bug"
}

export const LIMKENION_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: LIMKENION_GUIDE_AGENT_TYPE,
  whenToUse: `Use this agent when the user asks questions ("Can Limkenion...", "Does Limkenion...", "How do I...") about: (1) Limkenion (the CLI tool) - features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts; (2) Limkenion Agent SDK - building custom agents; (3) Limkenion API (formerly Limkenion API) - API usage, tool use, Limkenion SDK usage. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed limkenion-guide agent that you can continue via ${SEND_MESSAGE_TOOL_NAME}.`,
  // 官方内置构建：会移除 Glob/Grep 工具；请使用 Bash（借助 find/grep
  // 别名调用内嵌的 bfs/ugrep）进行本地文件搜索。
  tools: hasEmbeddedSearchTools()
    ? [
        BASH_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ]
    : [
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'haiku',
  permissionMode: 'dontAsk',
  getSystemPrompt({ toolUseContext }) {
    const commands = toolUseContext.options.commands

    // 构建上下文分节
    const contextSections: string[] = []

    // 1. 自定义技能
    const customCommands = commands.filter(cmd => cmd.type === 'prompt')
    if (customCommands.length > 0) {
      const commandList = customCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(
        `**Available custom skills in this project:**\n${commandList}`,
      )
    }

    // 2. 来自 .limkenion/agents/ 的自定义 agent
    const customAgents =
      toolUseContext.options.agentDefinitions.activeAgents.filter(
        (a: AgentDefinition) => a.source !== 'built-in',
      )
    if (customAgents.length > 0) {
      const agentList = customAgents
        .map((a: AgentDefinition) => `- ${a.agentType}: ${a.whenToUse}`)
        .join('\n')
      contextSections.push(
        `**Available custom agents configured:**\n${agentList}`,
      )
    }

    // 3. MCP 服务器
    const mcpClients = toolUseContext.options.mcpClients
    if (mcpClients && mcpClients.length > 0) {
      const mcpList = mcpClients
        .map((client: { name: string }) => `- ${client.name}`)
        .join('\n')
      contextSections.push(`**Configured MCP servers:**\n${mcpList}`)
    }

    // 4. 插件命令
    const pluginCommands = commands.filter(
      cmd => cmd.type === 'prompt' && cmd.source === 'plugin',
    )
    if (pluginCommands.length > 0) {
      const pluginList = pluginCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(`**Available plugin skills:**\n${pluginList}`)
    }

    // 5. 用户设置
    const settings = getSettings_DEPRECATED()
    if (Object.keys(settings).length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
      const settingsJson = jsonStringify(settings, null, 2)
      contextSections.push(
        `**User's settings.json:**\n\`\`\`json\n${settingsJson}\n\`\`\``,
      )
    }

    // 添加反馈指引（是否添加取决于用户是否使用 3P 服务）
    const feedbackGuideline = getFeedbackGuideline()
    const basePromptWithFeedback = `${getLimkenionGuideBasePrompt()}
${feedbackGuideline}`

    // 如果有要添加的上下文，则追加到基础系统提示词
    if (contextSections.length > 0) {
      return `${basePromptWithFeedback}

---

# User's Current Configuration

The user has the following custom setup in their environment:

${contextSections.join('\n\n')}

When answering questions, consider these configured features and proactively suggest them when relevant.`
    }

    // 如果没有要添加的上下文，则返回基础提示词
    return basePromptWithFeedback
  },
}
