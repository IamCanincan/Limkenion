import reject from 'lodash-es/reject.js'
import { z } from 'zod/v4'
import { performMCPOAuthFlow } from '../../services/mcp/auth.js'
import {
  clearMcpAuthCache,
  reconnectMcpServerImpl,
} from '../../services/mcp/client.js'
import {
  buildMcpToolName,
  getMcpPrefix,
} from '../../services/mcp/mcpStringUtils.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'

const inputSchema = lazySchema(() => z.object({}))
type InputSchema = ReturnType<typeof inputSchema>

export type McpAuthOutput = {
  status: 'auth_url' | 'unsupported' | 'error'
  message: string
  authUrl?: string
}

function getConfigUrl(config: ScopedMcpServerConfig): string | undefined {
  if ('url' in config) return config.url
  return undefined
}

/**
 * 为已安装但未认证的 MCP 服务器创建一个伪工具。当服务器真实工具不可用时，
 * 以该伪工具占位，使模型知道服务器存在，并可代表用户启动 OAuth 流程。
 *
 * 调用时，该方法以 skipBrowserOpen 启动 performMCPOAuthFlow，并返回授权 URL。
 * OAuth 回调在后台完成；一旦触发，reconnectMcpServerImpl 运行，并通过现有的
 * 基于前缀的替换逻辑将服务器的真实工具换入 appState.mcp.tools
 * （useManageMCPConnections.updateServer 会清除任何匹配 mcp__<server>__*
 * 的内容，因此该伪工具会被自动移除）。
 */
export function createMcpAuthTool(
  serverName: string,
  config: ScopedMcpServerConfig,
): Tool<InputSchema, McpAuthOutput> {
  const url = getConfigUrl(config)
  const transport = config.type ?? 'stdio'
  const location = url ? `${transport} at ${url}` : transport

  const description =
    `MCP 服务器 \`${serverName}\`（${location}）已安装，但需要认证。` +
    `调用此工具可启动 OAuth 流程——你将收到一个可分享给用户的授权 URL。` +
    `用户在其浏览器中完成授权后，该服务器的真实工具将自动变为可用。`

  return {
    name: buildMcpToolName(serverName, 'authenticate'),
    isMcp: true,
    mcpInfo: { serverName, toolName: 'authenticate' },
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    toAutoClassifierInput: () => serverName,
    userFacingName: () => `${serverName} - 认证 (MCP)`,
    maxResultSizeChars: 10_000,
    renderToolUseMessage: () => `为 MCP 服务器 ${serverName} 进行认证`,
    async description() {
      return description
    },
    async prompt() {
      return description
    },
    get inputSchema(): InputSchema {
      return inputSchema()
    },
    async checkPermissions(input): Promise<PermissionDecision> {
      return { behavior: 'allow', updatedInput: input }
    },
    async call(_input, context) {
      // limkenion.ai 连接器使用独立的认证流程（见 MCPRemoteServerMenu 中的
      // handleLimkenionAIAuth），我们在此不程序化触发——只需将用户指向 /mcp。
      if (config.type === 'limkenionai-proxy') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `这是 limkenion.ai MCP 连接器。请让用户运行 /mcp 并选择“${serverName}”进行认证。`,
          },
        }
      }

      // performMCPOAuthFlow 仅接受 sse/http。needs-auth 状态仅在 HTTP 401
      // （UnauthorizedError）时设置，因此其他传输不应到达此处，但仍做防御处理。
      if (config.type !== 'sse' && config.type !== 'http') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `服务器“${serverName}”使用 ${transport} 传输，该传输不支持从此工具发起 OAuth。请让用户运行 /mcp 并手动认证。`,
          },
        }
      }

      const sseOrHttpConfig = config as (
        | McpSSEServerConfig
        | McpHTTPServerConfig
      ) & { scope: ScopedMcpServerConfig['scope'] }

      // 镜像 cli/print.ts 的 mcp_authenticate：启动流程，通过 onAuthorizationUrl
      // 捕获 URL 并立即返回。该流程的 Promise 在稍后浏览器回调触发时解析。
      let resolveAuthUrl: ((url: string) => void) | undefined
      const authUrlPromise = new Promise<string>(resolve => {
        resolveAuthUrl = resolve
      })

      const controller = new AbortController()
      const { setAppState } = context

      const oauthPromise = performMCPOAuthFlow(
        serverName,
        sseOrHttpConfig,
        u => resolveAuthUrl?.(u),
        controller.signal,
        { skipBrowserOpen: true },
      )

      // 后台续执行：一旦 OAuth 完成，重连并将真实工具换入 appState。基于前缀的
      // 替换会自动移除该伪工具，因为它共享 mcp__<server>__ 前缀。
      void oauthPromise
        .then(async () => {
          clearMcpAuthCache()
          const result = await reconnectMcpServerImpl(serverName, config)
          const prefix = getMcpPrefix(serverName)
          setAppState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.map(c =>
                c.name === serverName ? result.client : c,
              ),
              tools: [
                ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                ...result.tools,
              ],
              commands: [
                ...reject(prev.mcp.commands, c => c.name?.startsWith(prefix)),
                ...result.commands,
              ],
              resources: result.resources
                ? { ...prev.mcp.resources, [serverName]: result.resources }
                : prev.mcp.resources,
            },
          }))
          logMCPDebug(
            serverName,
            `OAuth complete, reconnected with ${result.tools.length} tool(s)`,
          )
        })
        .catch(err => {
          logMCPError(
            serverName,
            `OAuth flow failed after tool-triggered start: ${errorMessage(err)}`,
          )
        })

      try {
        // 竞态：获取 URL，或流程无需 URL 即完成（例如 XAA 使用缓存的 IdP 令牌——静默认证）。
        const authUrl = await Promise.race([
          authUrlPromise,
          oauthPromise.then(() => null as string | null),
        ])

        if (authUrl) {
          return {
            data: {
              status: 'auth_url' as const,
              authUrl,
              message: `请让用户在其浏览器中打开此 URL 以授权 ${serverName} MCP 服务器：\n\n${authUrl}\n\n一旦用户完成流程，该服务器的工具将自动变为可用。`,
            },
          }
        }

        return {
          data: {
            status: 'auth_url' as const,
            message: `${serverName} 的认证已静默完成。该服务器的工具现在应该已可用。`,
          },
        }
      } catch (err) {
        return {
          data: {
            status: 'error' as const,
            message: `为 ${serverName} 启动 OAuth 流程失败：${errorMessage(err)}。请让用户运行 /mcp 并手动认证。`,
          },
        }
      }
    },
    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: data.message,
      }
    },
  } satisfies Tool<InputSchema, McpAuthOutput>
}
