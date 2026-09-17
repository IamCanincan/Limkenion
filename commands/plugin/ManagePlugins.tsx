import figures from 'figures';
import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Byline } from '../../components/design-system/Byline.js';
import { MCPRemoteServerMenu } from '../../components/mcp/MCPRemoteServerMenu.js';
import { MCPStdioServerMenu } from '../../components/mcp/MCPStdioServerMenu.js';
import { MCPToolDetailView } from '../../components/mcp/MCPToolDetailView.js';
import { MCPToolListView } from '../../components/mcp/MCPToolListView.js';
import type { LimkenionAIServerInfo, HTTPServerInfo, SSEServerInfo, StdioServerInfo } from '../../components/mcp/types.js';
import { SearchBox } from '../../components/SearchBox.js';
import { useSearchInput } from '../../hooks/useSearchInput.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- useInput needed for raw search mode text input
import { Box, Text, useInput, useTerminalFocus } from '../../ink.js';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import { getBuiltinPluginDefinition } from '../../plugins/builtinPlugins.js';
import { useMcpToggleEnabled } from '../../services/mcp/MCPConnectionManager.js';
import type { MCPServerConnection, McpLimkenionAIProxyServerConfig, McpHTTPServerConfig, McpSSEServerConfig, McpStdioServerConfig } from '../../services/mcp/types.js';
import { filterToolsByServer } from '../../services/mcp/utils.js';
import { disablePluginOp, enablePluginOp, getPluginInstallationFromV2, isInstallableScope, isPluginEnabledAtProjectScope, uninstallPluginOp, updatePluginOp } from '../../services/plugins/pluginOperations.js';
import { useAppState } from '../../state/AppState.js';
import type { Tool } from '../../Tool.js';
import type { LoadedPlugin, PluginError } from '../../types/plugin.js';
import { count } from '../../utils/array.js';
import { openBrowser } from '../../utils/browser.js';
import { logForDebugging } from '../../utils/debug.js';
import { errorMessage, toError } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js';
import { getMarketplace } from '../../utils/plugins/marketplaceManager.js';
import { isMcpbSource, loadMcpbFile, type McpbNeedsConfigResult, type UserConfigValues } from '../../utils/plugins/mcpbHandler.js';
import { getPluginDataDirSize, pluginDataDirPath } from '../../utils/plugins/pluginDirectories.js';
import { getFlaggedPlugins, markFlaggedPluginsSeen, removeFlaggedPlugin } from '../../utils/plugins/pluginFlagging.js';
import { type PersistablePluginScope, parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js';
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js';
import { loadPluginOptions, type PluginOptionSchema, savePluginOptions } from '../../utils/plugins/pluginOptionsStorage.js';
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js';
import { getPluginEditableScopes } from '../../utils/plugins/pluginStartupCheck.js';
import { getSettings_DEPRECATED, getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { plural } from '../../utils/stringUtils.js';
import { formatErrorMessage, getErrorGuidance } from './PluginErrors.js';
import { PluginOptionsDialog } from './PluginOptionsDialog.js';
import { PluginOptionsFlow } from './PluginOptionsFlow.js';
import type { ViewState as ParentViewState } from './types.js';
import { UnifiedInstalledCell } from './UnifiedInstalledCell.js';
import type { UnifiedInstalledItem } from './unifiedTypes.js';
import { usePagination } from './usePagination.js';
type Props = {
  setViewState: (state: ParentViewState) => void;
  setResult: (result: string | null) => void;
  onManageComplete?: () => void | Promise<void>;
  onSearchModeChange?: (isActive: boolean) => void;
  targetPlugin?: string;
  targetMarketplace?: string;
  action?: 'enable' | 'disable' | 'uninstall';
};
type FlaggedPluginInfo = {
  id: string;
  name: string;
  marketplace: string;
  reason: string;
  text: string;
  flaggedAt: string;
};
type FailedPluginInfo = {
  id: string;
  name: string;
  marketplace: string;
  errors: PluginError[];
  scope: PersistablePluginScope;
};
type ViewState = 'plugin-list' | 'plugin-details' | 'configuring' | {
  type: 'plugin-options';
} | {
  type: 'configuring-options';
  schema: PluginOptionSchema;
} | 'confirm-project-uninstall' | {
  type: 'confirm-data-cleanup';
  size: {
    bytes: number;
    human: string;
  };
} | {
  type: 'flagged-detail';
  plugin: FlaggedPluginInfo;
} | {
  type: 'failed-plugin-details';
  plugin: FailedPluginInfo;
} | {
  type: 'mcp-detail';
  client: MCPServerConnection;
} | {
  type: 'mcp-tools';
  client: MCPServerConnection;
} | {
  type: 'mcp-tool-detail';
  client: MCPServerConnection;
  tool: Tool;
};
type MarketplaceInfo = {
  name: string;
  installedPlugins: LoadedPlugin[];
  enabledCount?: number;
  disabledCount?: number;
};
type PluginState = {
  plugin: LoadedPlugin;
  marketplace: string;
  scope?: 'user' | 'project' | 'local' | 'managed' | 'builtin';
  pendingEnable?: boolean; // 切换启用/禁用
  pendingUpdate?: boolean; // 已标记待更新
};

/**
 * 从目录中获取基础文件名（不含 .md 扩展名）列表
 * @param dirPath 要列出文件的目录路径
 * @returns 不含 .md 扩展名的基础文件名数组
 * @example
 * // 假设目录包含：agent-sdk-verifier-py.md、agent-sdk-verifier-ts.md、README.txt
 * await getBaseFileNames('/path/to/agents')
 * // 返回：['agent-sdk-verifier-py', 'agent-sdk-verifier-ts']
 */
async function getBaseFileNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, {
      withFileTypes: true
    });
    return entries.filter((entry: Dirent) => entry.isFile() && entry.name.endsWith('.md')).map((entry: Dirent) => {
      // 专门移除 .md 扩展名
      const baseName = path.basename(entry.name, '.md');
      return baseName;
    });
  } catch (error) {
    const errorMsg = errorMessage(error);
    logForDebugging(`Failed to read plugin components from ${dirPath}: ${errorMsg}`, {
      level: 'error'
    });
    logError(toError(error));
    // 返回空数组以允许优雅降级 —— 仍可显示插件详情
    return [];
  }
}

/**
 * 从技能目录中获取技能目录名列表
 * 技能即包含 SKILL.md 文件的目录
 * @param dirPath 要扫描的技能目录路径
 * @returns 包含 SKILL.md 的技能目录名数组
 * @example
 * // 假设目录包含：my-skill/SKILL.md、another-skill/SKILL.md、README.txt
 * await getSkillDirNames('/path/to/skills')
 * // 返回：['my-skill', 'another-skill']
 */
async function getSkillDirNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, {
      withFileTypes: true
    });
    const skillNames: string[] = [];
    for (const entry of entries) {
      // 检查它是目录还是符号链接（符号链接可能指向技能目录）
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // 检查该目录是否包含 SKILL.md 文件
        const skillFilePath = path.join(dirPath, entry.name, 'SKILL.md');
        try {
          const st = await fs.stat(skillFilePath);
          if (st.isFile()) {
            skillNames.push(entry.name);
          }
        } catch {
          // 该目录中没有 SKILL.md 文件，跳过
        }
      }
    }
    return skillNames;
  } catch (error) {
    const errorMsg = errorMessage(error);
    logForDebugging(`Failed to read skill directories from ${dirPath}: ${errorMsg}`, {
      level: 'error'
    });
    logError(toError(error));
    // 返回空数组以允许优雅降级 —— 仍可显示插件详情
    return [];
  }
}

// 用于显示已安装插件组件的组件
function PluginComponentsDisplay({
  plugin,
  marketplace
}: {
  plugin: LoadedPlugin;
  marketplace: string;
}): React.ReactNode {
  const [components, setComponents] = useState<{
    commands?: string | string[] | Record<string, unknown> | null;
    agents?: string | string[] | Record<string, unknown> | null;
    skills?: string | string[] | Record<string, unknown> | null;
    hooks?: unknown;
    mcpServers?: unknown;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    async function loadComponents() {
      try {
        // 内置插件没有市场条目 —— 直接
        // 从已注册的定义中读取。
        if (marketplace === 'builtin') {
          const builtinDef = getBuiltinPluginDefinition(plugin.name);
          if (builtinDef) {
            const skillNames = builtinDef.skills?.map(s => s.name) ?? [];
            const hookEvents = builtinDef.hooks ? Object.keys(builtinDef.hooks) : [];
            const mcpServerNames = builtinDef.mcpServers ? Object.keys(builtinDef.mcpServers) : [];
            setComponents({
              commands: null,
              agents: null,
              skills: skillNames.length > 0 ? skillNames : null,
              hooks: hookEvents.length > 0 ? hookEvents : null,
              mcpServers: mcpServerNames.length > 0 ? mcpServerNames : null
            });
          } else {
            setError(`Built-in plugin ${plugin.name} not found`);
          }
          setLoading(false);
          return;
        }
        const marketplaceData = await getMarketplace(marketplace);
        // 在数组中找到该插件条目
        const pluginEntry = marketplaceData.plugins.find(p => p.name === plugin.name);
        if (pluginEntry) {
          // 合并来自两个来源的命令
          const commandPathList = [];
          if (plugin.commandsPath) {
            commandPathList.push(plugin.commandsPath);
          }
          if (plugin.commandsPaths) {
            commandPathList.push(...plugin.commandsPaths);
          }

          // 从所有命令路径获取基础文件名
          const commandList: string[] = [];
          for (const commandPath of commandPathList) {
            if (typeof commandPath === 'string') {
              // commandPath 已是完整路径
              const baseNames = await getBaseFileNames(commandPath);
              commandList.push(...baseNames);
            }
          }

          // 合并来自两个来源的 agent
          const agentPathList = [];
          if (plugin.agentsPath) {
            agentPathList.push(plugin.agentsPath);
          }
          if (plugin.agentsPaths) {
            agentPathList.push(...plugin.agentsPaths);
          }

          // 从所有 agent 路径获取基础文件名
          const agentList: string[] = [];
          for (const agentPath of agentPathList) {
            if (typeof agentPath === 'string') {
              // agentPath 已是完整路径
              const baseNames_0 = await getBaseFileNames(agentPath);
              agentList.push(...baseNames_0);
            }
          }

          // 合并来自两个来源的技能
          const skillPathList = [];
          if (plugin.skillsPath) {
            skillPathList.push(plugin.skillsPath);
          }
          if (plugin.skillsPaths) {
            skillPathList.push(...plugin.skillsPaths);
          }

          // 从所有技能路径获取技能目录名
          // 技能即包含 SKILL.md 文件的目录
          const skillList: string[] = [];
          for (const skillPath of skillPathList) {
            if (typeof skillPath === 'string') {
              // skillPath 已是技能目录的完整路径
              const skillDirNames = await getSkillDirNames(skillPath);
              skillList.push(...skillDirNames);
            }
          }

          // 合并来自两个来源的钩子
          const hooksList = [];
          if (plugin.hooksConfig) {
            hooksList.push(Object.keys(plugin.hooksConfig));
          }
          if (pluginEntry.hooks) {
            hooksList.push(pluginEntry.hooks);
          }

          // 合并来自两个来源的 MCP 服务器
          const mcpServersList = [];
          if (plugin.mcpServers) {
            mcpServersList.push(Object.keys(plugin.mcpServers));
          }
          if (pluginEntry.mcpServers) {
            mcpServersList.push(pluginEntry.mcpServers);
          }
          setComponents({
            commands: commandList.length > 0 ? commandList : null,
            agents: agentList.length > 0 ? agentList : null,
            skills: skillList.length > 0 ? skillList : null,
            hooks: hooksList.length > 0 ? hooksList : null,
            mcpServers: mcpServersList.length > 0 ? mcpServersList : null
          });
        } else {
          setError(`Plugin ${plugin.name} not found in marketplace`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load components');
      } finally {
        setLoading(false);
      }
    }
    void loadComponents();
  }, [plugin.name, plugin.commandsPath, plugin.commandsPaths, plugin.agentsPath, plugin.agentsPaths, plugin.skillsPath, plugin.skillsPaths, plugin.hooksConfig, plugin.mcpServers, marketplace]);
  if (loading) {
    return null; // 不显示加载状态，以获得更简洁的 UI
  }
  if (error) {
    return <Box flexDirection="column" marginBottom={1}>
        <Text bold>Components:</Text>
        <Text dimColor>Error: {error}</Text>
      </Box>;
  }
  if (!components) {
    return null; // 无组件信息可用
  }
  const hasComponents = components.commands || components.agents || components.skills || components.hooks || components.mcpServers;
  if (!hasComponents) {
    return null; // 未定义任何组件
  }
  return <Box flexDirection="column" marginBottom={1}>
      <Text bold>Installed components:</Text>
      {components.commands ? <Text dimColor>
          • Commands:{' '}
          {typeof components.commands === 'string' ? components.commands : Array.isArray(components.commands) ? components.commands.join(', ') : Object.keys(components.commands).join(', ')}
        </Text> : null}
      {components.agents ? <Text dimColor>
          • Agents:{' '}
          {typeof components.agents === 'string' ? components.agents : Array.isArray(components.agents) ? components.agents.join(', ') : Object.keys(components.agents).join(', ')}
        </Text> : null}
      {components.skills ? <Text dimColor>
          • Skills:{' '}
          {typeof components.skills === 'string' ? components.skills : Array.isArray(components.skills) ? components.skills.join(', ') : Object.keys(components.skills).join(', ')}
        </Text> : null}
      {components.hooks ? <Text dimColor>
          • Hooks:{' '}
          {typeof components.hooks === 'string' ? components.hooks : Array.isArray(components.hooks) ? components.hooks.map(String).join(', ') : typeof components.hooks === 'object' && components.hooks !== null ? Object.keys(components.hooks).join(', ') : String(components.hooks)}
        </Text> : null}
      {components.mcpServers ? <Text dimColor>
          • MCP Servers:{' '}
          {typeof components.mcpServers === 'string' ? components.mcpServers : Array.isArray(components.mcpServers) ? components.mcpServers.map(String).join(', ') : typeof components.mcpServers === 'object' && components.mcpServers !== null ? Object.keys(components.mcpServers).join(', ') : String(components.mcpServers)}
        </Text> : null}
    </Box>;
}

/**
 * 检查插件是否来自本地来源且无法远程更新
 * @returns 若为本地则返回错误消息，若为远程/可更新则返回 null
 */
async function checkIfLocalPlugin(pluginName: string, marketplaceName: string): Promise<string | null> {
  const marketplace = await getMarketplace(marketplaceName);
  const entry = marketplace?.plugins.find(p => p.name === pluginName);
  if (entry && typeof entry.source === 'string') {
    return `Local plugins cannot be updated remotely. To update, modify the source at: ${entry.source}`;
  }
  return null;
}

/**
 * 过滤掉被组织策略（policySettings）强制禁用的插件。
 * 这些插件被组织阻止，用户无法重新启用。
 * 直接检查 policySettings 而非安装作用域，因为受管
 * 设置不会创建 scope 为 'managed' 的安装记录。
 */
export function filterManagedDisabledPlugins(plugins: LoadedPlugin[]): LoadedPlugin[] {
  return plugins.filter(plugin => {
    const marketplace = plugin.source.split('@')[1] || 'local';
    return !isPluginBlockedByPolicy(`${plugin.name}@${marketplace}`);
  });
}
export function ManagePlugins({
  setViewState: setParentViewState,
  setResult,
  onManageComplete,
  onSearchModeChange,
  targetPlugin,
  targetMarketplace,
  action
}: Props): React.ReactNode {
  // 用于 MCP 访问的应用状态
  const mcpClients = useAppState(s => s.mcp.clients);
  const mcpTools = useAppState(s_0 => s_0.mcp.tools);
  const pluginErrors = useAppState(s_1 => s_1.plugins.errors);
  const flaggedPlugins = getFlaggedPlugins();

  // 搜索状态
  const [isSearchMode, setIsSearchModeRaw] = useState(false);
  const setIsSearchMode = useCallback((active: boolean) => {
    setIsSearchModeRaw(active);
    onSearchModeChange?.(active);
  }, [onSearchModeChange]);
  const isTerminalFocused = useTerminalFocus();
  const {
    columns: terminalWidth
  } = useTerminalSize();

  // 视图状态
  const [viewState, setViewState] = useState<ViewState>('plugin-list');
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset
  } = useSearchInput({
    isActive: viewState === 'plugin-list' && isSearchMode,
    onExit: () => {
      setIsSearchMode(false);
    }
  });
  const [selectedPlugin, setSelectedPlugin] = useState<PluginState | null>(null);

  // 数据状态
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([]);
  const [pluginStates, setPluginStates] = useState<PluginState[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingToggles, setPendingToggles] = useState<Map<string, 'will-enable' | 'will-disable'>>(new Map());

  // 用于防止用户导航离开后自动导航再次触发的守卫
  // （父组件从不清理 targetPlugin）。
  const hasAutoNavigated = useRef(false);
  // 自动导航落地后要触发的自动操作（enable/disable/uninstall）。
  // 用 ref 而非 state：它由一次性 effect 消费，而该 effect 已会在
  // viewState/selectedPlugin 变化时重跑，因此用会触发渲染的 state 变量是多余的。
  const pendingAutoActionRef = useRef<'enable' | 'disable' | 'uninstall' | undefined>(undefined);

  // MCP 切换钩子
  const toggleMcpServer = useMcpToggleEnabled();

  // 处理 Escape 返回 —— 依 viewState 而定的导航
  const handleBack = React.useCallback(() => {
    if (viewState === 'plugin-details') {
      setViewState('plugin-list');
      setSelectedPlugin(null);
      setProcessError(null);
    } else if (typeof viewState === 'object' && viewState.type === 'failed-plugin-details') {
      setViewState('plugin-list');
      setProcessError(null);
    } else if (viewState === 'configuring') {
      setViewState('plugin-details');
      setConfigNeeded(null);
    } else if (typeof viewState === 'object' && (viewState.type === 'plugin-options' || viewState.type === 'configuring-options')) {
      // 中途取消 —— 插件已启用，直接退回列表即可。
      // 用户之后若需要，可通过 Configure 选项菜单进行配置。
      setViewState('plugin-list');
      setSelectedPlugin(null);
      setResult('Plugin enabled. Configuration skipped — run /reload-plugins to apply.');
      if (onManageComplete) {
        void onManageComplete();
      }
    } else if (typeof viewState === 'object' && viewState.type === 'flagged-detail') {
      setViewState('plugin-list');
      setProcessError(null);
    } else if (typeof viewState === 'object' && viewState.type === 'mcp-detail') {
      setViewState('plugin-list');
      setProcessError(null);
    } else if (typeof viewState === 'object' && viewState.type === 'mcp-tools') {
      setViewState({
        type: 'mcp-detail',
        client: viewState.client
      });
    } else if (typeof viewState === 'object' && viewState.type === 'mcp-tool-detail') {
      setViewState({
        type: 'mcp-tools',
        client: viewState.client
      });
    } else {
      if (pendingToggles.size > 0) {
        setResult('Run /reload-plugins to apply plugin changes.');
        return;
      }
      setParentViewState({
        type: 'menu'
      });
    }
  }, [viewState, setParentViewState, pendingToggles, setResult]);

  // 非搜索模式下按 Escape —— 返回。
  // 排除 confirm-project-uninstall（它在 Confirmation 上下文中
  // 有自己的 confirm:no 处理器 —— 若让它触发会产生竞争处理器）
  // 以及 confirm-data-cleanup（使用原始 useInput，其中 n 与 escape 是
  // 不同的动作：保留数据 vs 取消）。
  useKeybinding('confirm:no', handleBack, {
    context: 'Confirmation',
    isActive: (viewState !== 'plugin-list' || !isSearchMode) && viewState !== 'confirm-project-uninstall' && !(typeof viewState === 'object' && viewState.type === 'confirm-data-cleanup')
  });

  // 获取 MCP 状态的辅助函数
  const getMcpStatus = (client: MCPServerConnection): 'connected' | 'disabled' | 'pending' | 'needs-auth' | 'failed' => {
    if (client.type === 'connected') return 'connected';
    if (client.type === 'disabled') return 'disabled';
    if (client.type === 'pending') return 'pending';
    if (client.type === 'needs-auth') return 'needs-auth';
    return 'failed';
  };

  // 从插件和 MCP 服务器派生出统一条目
  const unifiedItems = useMemo(() => {
    const mergedSettings = getSettings_DEPRECATED();

    // 构建插件名 -> 子 MCP 的映射
    // 插件 MCP 的名称形如 "plugin:pluginName:serverName"
    const pluginMcpMap = new Map<string, Array<{
      displayName: string;
      client: MCPServerConnection;
    }>>();
    for (const client_0 of mcpClients) {
      if (client_0.name.startsWith('plugin:')) {
        const parts = client_0.name.split(':');
        if (parts.length >= 3) {
          const pluginName = parts[1]!;
          const serverName = parts.slice(2).join(':');
          const existing = pluginMcpMap.get(pluginName) || [];
          existing.push({
            displayName: serverName,
            client: client_0
          });
          pluginMcpMap.set(pluginName, existing);
        }
      }
    }

    // 构建插件条目（暂未排序）
    type PluginWithChildren = {
      item: UnifiedInstalledItem & {
        type: 'plugin';
      };
      originalScope: 'user' | 'project' | 'local' | 'managed' | 'builtin';
      childMcps: Array<{
        displayName: string;
        client: MCPServerConnection;
      }>;
    };
    const pluginsWithChildren: PluginWithChildren[] = [];
    for (const state of pluginStates) {
      const pluginId = `${state.plugin.name}@${state.marketplace}`;
      const isEnabled = mergedSettings?.enabledPlugins?.[pluginId] !== false;
      const errors = pluginErrors.filter(e => 'plugin' in e && e.plugin === state.plugin.name || e.source === pluginId || e.source.startsWith(`${state.plugin.name}@`));

      // 内置插件使用 'builtin' 作用域；其他则从 V2 数据中查询。
      const originalScope = state.plugin.isBuiltin ? 'builtin' : state.scope || 'user';
      pluginsWithChildren.push({
        item: {
          type: 'plugin',
          id: pluginId,
          name: state.plugin.name,
          description: state.plugin.manifest.description,
          marketplace: state.marketplace,
          scope: originalScope,
          isEnabled,
          errorCount: errors.length,
          errors,
          plugin: state.plugin,
          pendingEnable: state.pendingEnable,
          pendingUpdate: state.pendingUpdate,
          pendingToggle: pendingToggles.get(pluginId)
        },
        originalScope,
        childMcps: pluginMcpMap.get(state.plugin.name) || []
      });
    }

    // 查找孤立错误（完全加载失败的插件所对应的错误）
    const matchedPluginIds = new Set(pluginsWithChildren.map(({
      item
    }) => item.id));
    const matchedPluginNames = new Set(pluginsWithChildren.map(({
      item: item_0
    }) => item_0.name));
    const orphanErrorsBySource = new Map<string, typeof pluginErrors>();
    for (const error of pluginErrors) {
      if (matchedPluginIds.has(error.source) || 'plugin' in error && typeof error.plugin === 'string' && matchedPluginNames.has(error.plugin)) {
        continue;
      }
      const existing_0 = orphanErrorsBySource.get(error.source) || [];
      existing_0.push(error);
      orphanErrorsBySource.set(error.source, existing_0);
    }
    const pluginScopes = getPluginEditableScopes();
    const failedPluginItems: UnifiedInstalledItem[] = [];
    for (const [pluginId_0, errors_0] of orphanErrorsBySource) {
      // 跳过已在被标记区块中显示的插件
      if (pluginId_0 in flaggedPlugins) continue;
      const parsed = parsePluginIdentifier(pluginId_0);
      const pluginName_0 = parsed.name || pluginId_0;
      const marketplace = parsed.marketplace || 'unknown';
      const rawScope = pluginScopes.get(pluginId_0);
      // 'flag' 仅限当前会话（来自 --plugin-dir / flagSettings），undefined
      // 表示该插件不在任何设置来源中。两者都默认为 'user'，
      // 因为 UnifiedInstalledItem 没有 'flag' 作用域变体。
      const scope = rawScope === 'flag' || rawScope === undefined ? 'user' : rawScope;
      failedPluginItems.push({
        type: 'failed-plugin',
        id: pluginId_0,
        name: pluginName_0,
        marketplace,
        scope,
        errorCount: errors_0.length,
        errors: errors_0
      });
    }

    // 构建独立的 MCP 条目
    const standaloneMcps: UnifiedInstalledItem[] = [];
    for (const client_1 of mcpClients) {
      if (client_1.name === 'ide') continue;
      if (client_1.name.startsWith('plugin:')) continue;
      standaloneMcps.push({
        type: 'mcp',
        id: `mcp:${client_1.name}`,
        name: client_1.name,
        description: undefined,
        scope: client_1.config.scope,
        status: getMcpStatus(client_1),
        client: client_1
      });
    }

    // 定义用于展示的作用域顺序
    const scopeOrder: Record<string, number> = {
      flagged: -1,
      project: 0,
      local: 1,
      user: 2,
      enterprise: 3,
      managed: 4,
      dynamic: 5,
      builtin: 6
    };

    // 通过合并插件（含其子 MCP）与独立 MCP 构建最终列表
    // 按作用域分组，避免重复的作用域标题
    const unified: UnifiedInstalledItem[] = [];

    // 创建 scope -> 条目的映射，以便正确合并
    const itemsByScope = new Map<string, UnifiedInstalledItem[]>();

    // 添加插件及其子 MCP
    for (const {
      item: item_1,
      originalScope: originalScope_0,
      childMcps
    } of pluginsWithChildren) {
      const scope_0 = item_1.scope;
      if (!itemsByScope.has(scope_0)) {
        itemsByScope.set(scope_0, []);
      }
      itemsByScope.get(scope_0)!.push(item_1);
      // 在插件之后紧接添加缩进的子 MCP（使用原始作用域，而非 'flagged'）。
      // 内置插件在展示时映射为 'user'，因为 MCP 的 ConfigScope 不含 'builtin'。
      for (const {
        displayName,
        client: client_2
      } of childMcps) {
        const displayScope = originalScope_0 === 'builtin' ? 'user' : originalScope_0;
        if (!itemsByScope.has(displayScope)) {
          itemsByScope.set(displayScope, []);
        }
        itemsByScope.get(displayScope)!.push({
          type: 'mcp',
          id: `mcp:${client_2.name}`,
          name: displayName,
          description: undefined,
          scope: displayScope,
          status: getMcpStatus(client_2),
          client: client_2,
          indented: true
        });
      }
    }

    // 将独立 MCP 添加到各自的作用域分组
    for (const mcp of standaloneMcps) {
      const scope_1 = mcp.scope;
      if (!itemsByScope.has(scope_1)) {
        itemsByScope.set(scope_1, []);
      }
      itemsByScope.get(scope_1)!.push(mcp);
    }

    // 将失败的插件添加到各自的作用域分组
    for (const failedPlugin of failedPluginItems) {
      const scope_2 = failedPlugin.scope;
      if (!itemsByScope.has(scope_2)) {
        itemsByScope.set(scope_2, []);
      }
      itemsByScope.get(scope_2)!.push(failedPlugin);
    }

    // 从用户设置中添加被标记（下架）的插件。
    // 原因/文本从缓存的安全消息文件中查找。
    for (const [pluginId_1, entry] of Object.entries(flaggedPlugins)) {
      const parsed_0 = parsePluginIdentifier(pluginId_1);
      const pluginName_1 = parsed_0.name || pluginId_1;
      const marketplace_0 = parsed_0.marketplace || 'unknown';
      if (!itemsByScope.has('flagged')) {
        itemsByScope.set('flagged', []);
      }
      itemsByScope.get('flagged')!.push({
        type: 'flagged-plugin',
        id: pluginId_1,
        name: pluginName_1,
        marketplace: marketplace_0,
        scope: 'flagged',
        reason: 'delisted',
        text: 'Removed from marketplace',
        flaggedAt: entry.flaggedAt
      });
    }

    // 排序作用域并构建最终列表
    const sortedScopes = [...itemsByScope.keys()].sort((a, b) => (scopeOrder[a] ?? 99) - (scopeOrder[b] ?? 99));
    for (const scope_3 of sortedScopes) {
      const items = itemsByScope.get(scope_3)!;

      // 将条目拆分为插件组（含其子 MCP）与独立 MCP
      // 这能保留朴素的排序会破坏的父子关系
      const pluginGroups: UnifiedInstalledItem[][] = [];
      const standaloneMcpsInScope: UnifiedInstalledItem[] = [];
      let i = 0;
      while (i < items.length) {
        const item_2 = items[i]!;
        if (item_2.type === 'plugin' || item_2.type === 'failed-plugin' || item_2.type === 'flagged-plugin') {
          // 将插件及其子 MCP 归为一组
          const group: UnifiedInstalledItem[] = [item_2];
          i++;
          // 向后查看缩进的子 MCP
          let nextItem = items[i];
          while (nextItem?.type === 'mcp' && nextItem.indented) {
            group.push(nextItem);
            i++;
            nextItem = items[i];
          }
          pluginGroups.push(group);
        } else if (item_2.type === 'mcp' && !item_2.indented) {
          // 独立 MCP（不是某插件的子项）
          standaloneMcpsInScope.push(item_2);
          i++;
        } else {
          // 跳过孤立的缩进 MCP（不应发生）
          i++;
        }
      }

      // 按插件名对插件组排序（每组的第一项）
      pluginGroups.sort((a_0, b_0) => a_0[0]!.name.localeCompare(b_0[0]!.name));

      // 按名称对独立 MCP 排序
      standaloneMcpsInScope.sort((a_1, b_1) => a_1.name.localeCompare(b_1.name));

      // 构建最终列表：插件（含其子项）在前，独立 MCP 在后
      for (const group_0 of pluginGroups) {
        unified.push(...group_0);
      }
      unified.push(...standaloneMcpsInScope);
    }
    return unified;
  }, [pluginStates, mcpClients, pluginErrors, pendingToggles, flaggedPlugins]);

  // 在 Installed 视图渲染被标记插件时将其标记为已读。
  // 距 seenAt 满 48 小时后，它们会在下次加载时自动清除。
  const flaggedIds = useMemo(() => unifiedItems.filter(item_3 => item_3.type === 'flagged-plugin').map(item_4 => item_4.id), [unifiedItems]);
  useEffect(() => {
    if (flaggedIds.length > 0) {
      void markFlaggedPluginsSeen(flaggedIds);
    }
  }, [flaggedIds]);

  // 根据搜索词过滤条目（匹配名称或描述）
  const filteredItems = useMemo(() => {
    if (!searchQuery) return unifiedItems;
    const lowerQuery = searchQuery.toLowerCase();
    return unifiedItems.filter(item_5 => item_5.name.toLowerCase().includes(lowerQuery) || 'description' in item_5 && item_5.description?.toLowerCase().includes(lowerQuery));
  }, [unifiedItems, searchQuery]);

  // 选中状态
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 统一列表分页（连续滚动）
  const pagination = usePagination<UnifiedInstalledItem>({
    totalItems: filteredItems.length,
    selectedIndex,
    maxVisible: 8
  });

  // 详情视图状态
  const [detailsMenuIndex, setDetailsMenuIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);

  // 配置状态
  const [configNeeded, setConfigNeeded] = useState<McpbNeedsConfigResult | null>(null);
  const [_isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [selectedPluginHasMcpb, setSelectedPluginHasMcpb] = useState(false);

  // 检测所选插件是否带 MCPB
  // 读取原始 marketplace.json，以兼容旧的缓存市场
  useEffect(() => {
    if (!selectedPlugin) {
      setSelectedPluginHasMcpb(false);
      return;
    }
    async function detectMcpb() {
      // 先检查插件 manifest
      const mcpServersSpec = selectedPlugin!.plugin.manifest.mcpServers;
      let hasMcpb = false;
      if (mcpServersSpec) {
        hasMcpb = typeof mcpServersSpec === 'string' && isMcpbSource(mcpServersSpec) || Array.isArray(mcpServersSpec) && mcpServersSpec.some(s_2 => typeof s_2 === 'string' && isMcpbSource(s_2));
      }

      // 若不在 manifest 中，则直接读取原始 marketplace.json（绕过 schema 校验）
      // 这样即使面对 MCPB 支持之前的旧缓存市场也能工作
      if (!hasMcpb) {
        try {
          const marketplaceDir = path.join(selectedPlugin!.plugin.path, '..');
          const marketplaceJsonPath = path.join(marketplaceDir, '.limkenion-plugin', 'marketplace.json');
          const content = await fs.readFile(marketplaceJsonPath, 'utf-8');
          const marketplace_1 = jsonParse(content);
          const entry_0 = marketplace_1.plugins?.find((p: {
            name: string;
          }) => p.name === selectedPlugin!.plugin.name);
          if (entry_0?.mcpServers) {
            const spec = entry_0.mcpServers;
            hasMcpb = typeof spec === 'string' && isMcpbSource(spec) || Array.isArray(spec) && spec.some((s_3: unknown) => typeof s_3 === 'string' && isMcpbSource(s_3));
          }
        } catch (err) {
          logForDebugging(`Failed to read raw marketplace.json: ${err}`);
        }
      }
      setSelectedPluginHasMcpb(hasMcpb);
    }
    void detectMcpb();
  }, [selectedPlugin]);

  // 按市场分组加载已安装的插件
  useEffect(() => {
    async function loadInstalledPlugins() {
      setLoading(true);
      try {
        const {
          enabled,
          disabled
        } = await loadAllPlugins();
        const mergedSettings = getSettings_DEPRECATED(); // 使用合并后的设置以尊重所有层级

        const allPlugins = filterManagedDisabledPlugins([...enabled, ...disabled]);

        // 按市场对插件分组
        const pluginsByMarketplace: Record<string, LoadedPlugin[]> = {};
        for (const plugin of allPlugins) {
          const marketplace = plugin.source.split('@')[1] || 'local';
          if (!pluginsByMarketplace[marketplace]) {
            pluginsByMarketplace[marketplace] = [];
          }
          pluginsByMarketplace[marketplace]!.push(plugin);
        }

        // 创建带启用/禁用计数的市场信息数组
        const marketplaceInfos: MarketplaceInfo[] = [];
        for (const [name, plugins] of Object.entries(pluginsByMarketplace)) {
          const enabledCount = count(plugins, p => {
            const pluginId = `${p.name}@${name}`;
            return mergedSettings?.enabledPlugins?.[pluginId] !== false;
          });
          const disabledCount = plugins.length - enabledCount;
          marketplaceInfos.push({
            name,
            installedPlugins: plugins,
            enabledCount,
            disabledCount
          });
        }

        // 排序市场：limkenion-plugin-directory 优先，其余按字母序
        marketplaceInfos.sort((a, b) => {
          if (a.name === 'limkenion-plugin-directory') return -1;
          if (b.name === 'limkenion-plugin-directory') return 1;
          return a.name.localeCompare(b.name);
        });
        setMarketplaces(marketplaceInfos);

        // 构建所有插件状态的扁平列表
        const allStates: PluginState[] = [];
        for (const marketplace of marketplaceInfos) {
          for (const plugin of marketplace.installedPlugins) {
            const pluginId = `${plugin.name}@${marketplace.name}`;
            // 内置插件没有 V2 安装记录 —— 跳过查询。
            const scope = plugin.isBuiltin ? 'builtin' : getPluginInstallationFromV2(pluginId).scope;
            allStates.push({
              plugin,
              marketplace: marketplace.name,
              scope,
              pendingEnable: undefined,
              pendingUpdate: false
            });
          }
        }
        setPluginStates(allStates);
        setSelectedIndex(0);
      } finally {
        setLoading(false);
      }
    }
    void loadInstalledPlugins();
  }, []);

  // 若指定了目标插件则自动导航到它（仅一次）
  useEffect(() => {
    if (hasAutoNavigated.current) return;
    if (targetPlugin && marketplaces.length > 0 && !loading) {
      // targetPlugin 可能是 `name` 或 `name@marketplace`（parseArgs 会原样
      // 传递原始参数）。解析它，使 p.name 匹配在两种情况下都能工作。
      const {
        name: targetName,
        marketplace: targetMktFromId
      } = parsePluginIdentifier(targetPlugin);
      const effectiveTargetMarketplace = targetMarketplace ?? targetMktFromId;

      // 若提供了 targetMarketplace 则使用它，否则搜索全部
      const marketplacesToSearch = effectiveTargetMarketplace ? marketplaces.filter(m => m.name === effectiveTargetMarketplace) : marketplaces;

      // 先检查成功加载的插件
      for (const marketplace_2 of marketplacesToSearch) {
        const plugin = marketplace_2.installedPlugins.find(p_0 => p_0.name === targetName);
        if (plugin) {
          // 从 V2 数据获取作用域，以便正确处理操作
          const pluginId_2 = `${plugin.name}@${marketplace_2.name}`;
          const {
            scope: scope_4
          } = getPluginInstallationFromV2(pluginId_2);
          const pluginState: PluginState = {
            plugin,
            marketplace: marketplace_2.name,
            scope: scope_4,
            pendingEnable: undefined,
            pendingUpdate: false
          };
          setSelectedPlugin(pluginState);
          setViewState('plugin-details');
          pendingAutoActionRef.current = action;
          hasAutoNavigated.current = true;
          return;
        }
      }

      // 回退到失败的插件（有错误但未加载的那些）
      const failedItem = unifiedItems.find(item_6 => item_6.type === 'failed-plugin' && item_6.name === targetName);
      if (failedItem && failedItem.type === 'failed-plugin') {
        setViewState({
          type: 'failed-plugin-details',
          plugin: {
            id: failedItem.id,
            name: failedItem.name,
            marketplace: failedItem.marketplace,
            errors: failedItem.errors,
            scope: failedItem.scope
          }
        });
        hasAutoNavigated.current = true;
      }

      // 在已加载和失败的插件中都未匹配 —— 关闭对话框并给出
      // 提示，而不是静默落到插件列表上。仅在
      // 请求了某个操作时这样做（例如 /plugin uninstall X）；
      // 单纯导航（/plugin manage）仍应只显示列表。
      if (!hasAutoNavigated.current && action) {
        hasAutoNavigated.current = true;
        setResult(`Plugin "${targetPlugin}" is not installed in this project`);
      }
    }
  }, [targetPlugin, targetMarketplace, marketplaces, loading, unifiedItems, action, setResult]);

  // 处理来自详情视图的单个插件操作
  const handleSingleOperation = async (operation: 'enable' | 'disable' | 'update' | 'uninstall') => {
    if (!selectedPlugin) return;
    const pluginScope = selectedPlugin.scope || 'user';
    const isBuiltin = pluginScope === 'builtin';

    // 内置插件只能启用/禁用，不能更新/卸载。
    if (isBuiltin && (operation === 'update' || operation === 'uninstall')) {
      setProcessError('Built-in plugins cannot be updated or uninstalled.');
      return;
    }

    // managed 作用域的插件只能更新，不能启用/禁用/卸载
    if (!isBuiltin && !isInstallableScope(pluginScope) && operation !== 'update') {
      setProcessError('This plugin is managed by your organization. Contact your admin to disable it.');
      return;
    }
    setIsProcessing(true);
    setProcessError(null);
    try {
      const pluginId_3 = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
      let reverseDependents: string[] | undefined;

      // enable/disable 省略 scope —— pluginScope 是来自
      // installed_plugins.json 的安装作用域（文件缓存的位置），它可能与
      // 设置作用域（启用状态所在处）不一致。传入它会触发
      // 跨作用域守卫。自动检测会找到正确的作用域。#38084
      switch (operation) {
        case 'enable':
          {
            const enableResult = await enablePluginOp(pluginId_3);
            if (!enableResult.success) {
              throw new Error(enableResult.message);
            }
            break;
          }
        case 'disable':
          {
            const disableResult = await disablePluginOp(pluginId_3);
            if (!disableResult.success) {
              throw new Error(disableResult.message);
            }
            reverseDependents = disableResult.reverseDependents;
            break;
          }
        case 'uninstall':
          {
            if (isBuiltin) break; // 已在上方守卫；收窄 pluginScope
            if (!isInstallableScope(pluginScope)) break;
            // 若插件在 .limkenion/settings.json（与团队共享）中启用，
            // 则转入确认对话框，改为提供在
            // settings.local.json 中禁用的选项。直接检查设置文件 ——
            // 即使插件同时被项目级启用，`pluginScope`（来自
            // installed_plugins.json）也可能是 'user'，而卸载该 user 作用域
            // 的安装会让项目级启用仍然生效。
            if (isPluginEnabledAtProjectScope(pluginId_3)) {
              setIsProcessing(false);
              setViewState('confirm-project-uninstall');
              return;
            }
            // 若插件有持久化数据（${LIMKENION_PLUGIN_DATA}）且当前
            // 是最后一个作用域，则在删除前提示。对于多作用域
            // 安装，无论用户按 y/n，操作的 isLastScope 检查都不会删除 ——
            // 显示该对话框会误导用户（按 "y" → 什么也不会发生）。
            // 长度检查对应 pluginOperations.ts:513。
            const installs = loadInstalledPluginsV2().plugins[pluginId_3];
            const isLastScope = !installs || installs.length <= 1;
            const dataSize = isLastScope ? await getPluginDataDirSize(pluginId_3) : null;
            if (dataSize) {
              setIsProcessing(false);
              setViewState({
                type: 'confirm-data-cleanup',
                size: dataSize
              });
              return;
            }
            const result_0 = await uninstallPluginOp(pluginId_3, pluginScope);
            if (!result_0.success) {
              throw new Error(result_0.message);
            }
            reverseDependents = result_0.reverseDependents;
            break;
          }
        case 'update':
          {
            if (isBuiltin) break; // 已在上方守卫；收窄 pluginScope
            const result = await updatePluginOp(pluginId_3, pluginScope);
            if (!result.success) {
              throw new Error(result.message);
            }
            // 若已是最新版本，则显示消息并退出
            if (result.alreadyUpToDate) {
              setResult(`${selectedPlugin.plugin.name} is already at the latest version (${result.newVersion}).`);
              if (onManageComplete) {
                await onManageComplete();
              }
              setParentViewState({
                type: 'menu'
              });
              return;
            }
            // 成功 —— 将在下方显示标准消息
            break;
          }
      }

      // 操作（enable、disable、uninstall、update）现在使用集中式函数，
      // 它们自行处理设置更新，因此这里只需清理缓存
      clearAllCaches();

      // 若插件最终处于启用状态，则提示填写 manifest.userConfig + channel
      // userConfig。重新读取设置，而不是依据 `operation ===
      // 'enable'` 判断：安装时即启用，因此菜单首先显示的是 "Disable"。
      // PluginOptionsFlow 自身会检查 getUnconfiguredOptions —— 若
      // 无需填写，它会立即调用 onDone('skipped')。
      const pluginIdNow = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
      const settingsAfter = getSettings_DEPRECATED();
      const enabledAfter = settingsAfter?.enabledPlugins?.[pluginIdNow] !== false;
      if (enabledAfter) {
        setIsProcessing(false);
        setViewState({
          type: 'plugin-options'
        });
        return;
      }
      const operationName = operation === 'enable' ? 'Enabled' : operation === 'disable' ? 'Disabled' : operation === 'update' ? 'Updated' : 'Uninstalled';

      // 单行警告 —— 通知超时约 8 秒，多行会滚出屏幕。
      // 持久记录位于 Errors 标签页（重载后为 dependency-unsatisfied）。
      const depWarn = reverseDependents && reverseDependents.length > 0 ? ` · required by ${reverseDependents.join(', ')}` : '';
      const message = `✓ ${operationName} ${selectedPlugin.plugin.name}${depWarn}. Run /reload-plugins to apply.`;
      setResult(message);
      if (onManageComplete) {
        await onManageComplete();
      }
      setParentViewState({
        type: 'menu'
      });
    } catch (error_0) {
      setIsProcessing(false);
      const errorMessage = error_0 instanceof Error ? error_0.message : String(error_0);
      setProcessError(`Failed to ${operation}: ${errorMessage}`);
      logError(toError(error_0));
    }
  };

  // Latest-ref：让自动操作 effect 能调用当前闭包，而无需把
  // handleSingleOperation（每次渲染都会重建）加入其依赖。
  const handleSingleOperationRef = useRef(handleSingleOperation);
  handleSingleOperationRef.current = handleSingleOperation;

  // 自动导航落到 plugin-details 后，自动执行 action 属性
  // （/plugin uninstall X、/plugin enable X 等）。
  useEffect(() => {
    if (viewState === 'plugin-details' && selectedPlugin && pendingAutoActionRef.current) {
      const pending = pendingAutoActionRef.current;
      pendingAutoActionRef.current = undefined;
      void handleSingleOperationRef.current(pending);
    }
  }, [viewState, selectedPlugin]);

  // 处理切换启用/禁用
  const handleToggle = React.useCallback(() => {
    if (selectedIndex >= filteredItems.length) return;
    const item_7 = filteredItems[selectedIndex];
    if (item_7?.type === 'flagged-plugin') return;
    if (item_7?.type === 'plugin') {
      const pluginId_4 = `${item_7.plugin.name}@${item_7.marketplace}`;
      const mergedSettings_0 = getSettings_DEPRECATED();
      const currentPending = pendingToggles.get(pluginId_4);
      const isEnabled_0 = mergedSettings_0?.enabledPlugins?.[pluginId_4] !== false;
      const pluginScope_0 = item_7.scope;
      const isBuiltin_0 = pluginScope_0 === 'builtin';
      if (isBuiltin_0 || isInstallableScope(pluginScope_0)) {
        const newPending = new Map(pendingToggles);
        // 省略 scope —— 参见 handleSingleOperation 中 enable/disable 的注释。
        if (currentPending) {
          // 取消：将操作还原回原始状态
          newPending.delete(pluginId_4);
          void (async () => {
            try {
              if (currentPending === 'will-disable') {
                await enablePluginOp(pluginId_4);
              } else {
                await disablePluginOp(pluginId_4);
              }
              clearAllCaches();
            } catch (err_0) {
              logError(err_0);
            }
          })();
        } else {
          newPending.set(pluginId_4, isEnabled_0 ? 'will-disable' : 'will-enable');
          void (async () => {
            try {
              if (isEnabled_0) {
                await disablePluginOp(pluginId_4);
              } else {
                await enablePluginOp(pluginId_4);
              }
              clearAllCaches();
            } catch (err_1) {
              logError(err_1);
            }
          })();
        }
        setPendingToggles(newPending);
      }
    } else if (item_7?.type === 'mcp') {
      void toggleMcpServer(item_7.client.name);
    }
  }, [selectedIndex, filteredItems, pendingToggles, pluginStates, toggleMcpServer]);

  // 处理 plugin-list 中的接受（Enter）
  const handleAccept = React.useCallback(() => {
    if (selectedIndex >= filteredItems.length) return;
    const item_8 = filteredItems[selectedIndex];
    if (item_8?.type === 'plugin') {
      const state_0 = pluginStates.find(s_4 => s_4.plugin.name === item_8.plugin.name && s_4.marketplace === item_8.marketplace);
      if (state_0) {
        setSelectedPlugin(state_0);
        setViewState('plugin-details');
        setDetailsMenuIndex(0);
        setProcessError(null);
      }
    } else if (item_8?.type === 'flagged-plugin') {
      setViewState({
        type: 'flagged-detail',
        plugin: {
          id: item_8.id,
          name: item_8.name,
          marketplace: item_8.marketplace,
          reason: item_8.reason,
          text: item_8.text,
          flaggedAt: item_8.flaggedAt
        }
      });
      setProcessError(null);
    } else if (item_8?.type === 'failed-plugin') {
      setViewState({
        type: 'failed-plugin-details',
        plugin: {
          id: item_8.id,
          name: item_8.name,
          marketplace: item_8.marketplace,
          errors: item_8.errors,
          scope: item_8.scope
        }
      });
      setDetailsMenuIndex(0);
      setProcessError(null);
    } else if (item_8?.type === 'mcp') {
      setViewState({
        type: 'mcp-detail',
        client: item_8.client
      });
      setProcessError(null);
    }
  }, [selectedIndex, filteredItems, pluginStates]);

  // plugin-list 导航（非搜索模式）
  useKeybindings({
    'select:previous': () => {
      if (selectedIndex === 0) {
        setIsSearchMode(true);
      } else {
        pagination.handleSelectionChange(selectedIndex - 1, setSelectedIndex);
      }
    },
    'select:next': () => {
      if (selectedIndex < filteredItems.length - 1) {
        pagination.handleSelectionChange(selectedIndex + 1, setSelectedIndex);
      }
    },
    'select:accept': handleAccept
  }, {
    context: 'Select',
    isActive: viewState === 'plugin-list' && !isSearchMode
  });
  useKeybindings({
    'plugin:toggle': handleToggle
  }, {
    context: 'Plugin',
    isActive: viewState === 'plugin-list' && !isSearchMode
  });

  // 处理 flagged-detail 视图中的忽略操作
  const handleFlaggedDismiss = React.useCallback(() => {
    if (typeof viewState !== 'object' || viewState.type !== 'flagged-detail') return;
    void removeFlaggedPlugin(viewState.plugin.id);
    setViewState('plugin-list');
  }, [viewState]);
  useKeybindings({
    'select:accept': handleFlaggedDismiss
  }, {
    context: 'Select',
    isActive: typeof viewState === 'object' && viewState.type === 'flagged-detail'
  });

  // 构建详情菜单项（导航需要）
  const detailsMenuItems = React.useMemo(() => {
    if (viewState !== 'plugin-details' || !selectedPlugin) return [];
    const mergedSettings_1 = getSettings_DEPRECATED();
    const pluginId_5 = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
    const isEnabled_1 = mergedSettings_1?.enabledPlugins?.[pluginId_5] !== false;
    const isBuiltin_1 = selectedPlugin.marketplace === 'builtin';
    const menuItems: Array<{
      label: string;
      action: () => void;
    }> = [];
    menuItems.push({
      label: isEnabled_1 ? 'Disable plugin' : 'Enable plugin',
      action: () => void handleSingleOperation(isEnabled_1 ? 'disable' : 'enable')
    });

    // Update/Uninstall 选项 —— 内置插件不可用
    if (!isBuiltin_1) {
      menuItems.push({
        label: selectedPlugin.pendingUpdate ? 'Unmark for update' : 'Mark for update',
        action: async () => {
          try {
            const localError = await checkIfLocalPlugin(selectedPlugin.plugin.name, selectedPlugin.marketplace);
            if (localError) {
              setProcessError(localError);
              return;
            }
            const newStates = [...pluginStates];
            const index = newStates.findIndex(s_5 => s_5.plugin.name === selectedPlugin.plugin.name && s_5.marketplace === selectedPlugin.marketplace);
            if (index !== -1) {
              newStates[index]!.pendingUpdate = !selectedPlugin.pendingUpdate;
              setPluginStates(newStates);
              setSelectedPlugin({
                ...selectedPlugin,
                pendingUpdate: !selectedPlugin.pendingUpdate
              });
            }
          } catch (error_1) {
            setProcessError(error_1 instanceof Error ? error_1.message : 'Failed to check plugin update availability');
          }
        }
      });
      if (selectedPluginHasMcpb) {
        menuItems.push({
          label: 'Configure',
          action: async () => {
            setIsLoadingConfig(true);
            try {
              const mcpServersSpec_0 = selectedPlugin.plugin.manifest.mcpServers;
              let mcpbPath: string | null = null;
              if (typeof mcpServersSpec_0 === 'string' && isMcpbSource(mcpServersSpec_0)) {
                mcpbPath = mcpServersSpec_0;
              } else if (Array.isArray(mcpServersSpec_0)) {
                for (const spec_0 of mcpServersSpec_0) {
                  if (typeof spec_0 === 'string' && isMcpbSource(spec_0)) {
                    mcpbPath = spec_0;
                    break;
                  }
                }
              }
              if (!mcpbPath) {
                setProcessError('No MCPB file found in plugin');
                setIsLoadingConfig(false);
                return;
              }
              const pluginId_6 = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
              const result_1 = await loadMcpbFile(mcpbPath, selectedPlugin.plugin.path, pluginId_6, undefined, undefined, true);
              if ('status' in result_1 && result_1.status === 'needs-config') {
                setConfigNeeded(result_1);
                setViewState('configuring');
              } else {
                setProcessError('Failed to load MCPB for configuration');
              }
            } catch (err_2) {
              const errorMsg = errorMessage(err_2);
              setProcessError(`Failed to load configuration: ${errorMsg}`);
            } finally {
              setIsLoadingConfig(false);
            }
          }
        });
      }
      if (selectedPlugin.plugin.manifest.userConfig && Object.keys(selectedPlugin.plugin.manifest.userConfig).length > 0) {
        menuItems.push({
          label: 'Configure options',
          action: () => {
            setViewState({
              type: 'configuring-options',
              schema: selectedPlugin.plugin.manifest.userConfig!
            });
          }
        });
      }
      menuItems.push({
        label: 'Update now',
        action: () => void handleSingleOperation('update')
      });
      menuItems.push({
        label: 'Uninstall',
        action: () => void handleSingleOperation('uninstall')
      });
    }
    if (selectedPlugin.plugin.manifest.homepage) {
      menuItems.push({
        label: 'Open homepage',
        action: () => void openBrowser(selectedPlugin.plugin.manifest.homepage!)
      });
    }
    if (selectedPlugin.plugin.manifest.repository) {
      menuItems.push({
        // 通用标签 —— manifest.repository 可能是 GitLab、Bitbucket、
        // Azure DevOps 等（gh-31598）。pluginDetailsHelpers.tsx:74 保留
        // 'View on GitHub'，因为那条路径有显式的 isGitHub 检查。
        label: 'View repository',
        action: () => void openBrowser(selectedPlugin.plugin.manifest.repository!)
      });
    }
    menuItems.push({
      label: 'Back to plugin list',
      action: () => {
        setViewState('plugin-list');
        setSelectedPlugin(null);
        setProcessError(null);
      }
    });
    return menuItems;
  }, [viewState, selectedPlugin, selectedPluginHasMcpb, pluginStates]);

  // plugin-details 导航
  useKeybindings({
    'select:previous': () => {
      if (detailsMenuIndex > 0) {
        setDetailsMenuIndex(detailsMenuIndex - 1);
      }
    },
    'select:next': () => {
      if (detailsMenuIndex < detailsMenuItems.length - 1) {
        setDetailsMenuIndex(detailsMenuIndex + 1);
      }
    },
    'select:accept': () => {
      if (detailsMenuItems[detailsMenuIndex]) {
        detailsMenuItems[detailsMenuIndex]!.action();
      }
    }
  }, {
    context: 'Select',
    isActive: viewState === 'plugin-details' && !!selectedPlugin
  });

  // 失败插件详情：只有 “Uninstall” 选项，处理 Enter
  useKeybindings({
    'select:accept': () => {
      if (typeof viewState === 'object' && viewState.type === 'failed-plugin-details') {
        void (async () => {
          setIsProcessing(true);
          setProcessError(null);
          const pluginId_7 = viewState.plugin.id;
          const pluginScope_1 = viewState.plugin.scope;
          // 将 scope 传给 uninstallPluginOp，以便找到正确的 V2
          // 安装记录并清理磁盘上的文件。若不可安装则降级为
          // 默认作用域（例如 'managed'，不过该情况
          // 由下方的 isActive 守卫）。deleteDataDir=false：这是
          // 针对加载失败插件的恢复路径 —— 它可能
          // 可重装，因此不要静默删掉 ${LIMKENION_PLUGIN_DATA}。
          // 常规卸载路径会提示；这条路径则保留数据。
          const result_2 = isInstallableScope(pluginScope_1) ? await uninstallPluginOp(pluginId_7, pluginScope_1, false) : await uninstallPluginOp(pluginId_7, 'user', false);
          let success = result_2.success;
          if (!success) {
            // 插件从未安装过（仅在 enabledPlugins 设置中）。
            // 直接从所有可编辑的设置来源中移除。
            const editableSources = ['userSettings' as const, 'projectSettings' as const, 'localSettings' as const];
            for (const source of editableSources) {
              const settings = getSettingsForSource(source);
              if (settings?.enabledPlugins?.[pluginId_7] !== undefined) {
                updateSettingsForSource(source, {
                  enabledPlugins: {
                    ...settings.enabledPlugins,
                    [pluginId_7]: undefined
                  }
                });
                success = true;
              }
            }
            // 清除记忆化缓存，使下次 loadAllPlugins() 能读取到设置变更
            clearAllCaches();
          }
          if (success) {
            if (onManageComplete) {
              await onManageComplete();
            }
            setIsProcessing(false);
            // 返回列表（不要 setResult —— 那会关闭整个对话框）
            setViewState('plugin-list');
          } else {
            setIsProcessing(false);
            setProcessError(result_2.message);
          }
        })();
      }
    }
  }, {
    context: 'Select',
    isActive: typeof viewState === 'object' && viewState.type === 'failed-plugin-details' && viewState.plugin.scope !== 'managed'
  });

  // confirm-project-uninstall：y/enter 在 settings.local.json 中禁用，n/escape 取消
  useKeybindings({
    'confirm:yes': () => {
      if (!selectedPlugin) return;
      setIsProcessing(true);
      setProcessError(null);
      const pluginId_8 = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
      // 直接写入 `false` —— disablePluginOp 的跨作用域守卫会
      // 拒绝该操作（插件尚未在 localSettings 中；而这条覆盖
      // 正是关键所在）。
      const {
        error: error_2
      } = updateSettingsForSource('localSettings', {
        enabledPlugins: {
          ...getSettingsForSource('localSettings')?.enabledPlugins,
          [pluginId_8]: false
        }
      });
      if (error_2) {
        setIsProcessing(false);
        setProcessError(`Failed to write settings: ${error_2.message}`);
        return;
      }
      clearAllCaches();
      setResult(`✓ Disabled ${selectedPlugin.plugin.name} in .limkenion/settings.local.json. Run /reload-plugins to apply.`);
      if (onManageComplete) void onManageComplete();
      setParentViewState({
        type: 'menu'
      });
    },
    'confirm:no': () => {
      setViewState('plugin-details');
      setProcessError(null);
    }
  }, {
    context: 'Confirmation',
    isActive: viewState === 'confirm-project-uninstall' && !!selectedPlugin && !isProcessing
  });

  // Confirm-data-cleanup：y 卸载并删除数据目录，n 卸载但保留，
  // esc 取消。使用原始 useInput 是因为：(1) Confirmation 上下文把
  // enter 映射为 confirm:yes，这会让 Enter 删除数据目录 —— 一个
  // UI 文本（"y to delete · n to keep"）并未告知的破坏性默认行为；
  // (2) 不同于 confirm-project-uninstall（使用 useKeybindings，其中 n 和
  // escape 都映射为 confirm:no），这里 n 和 escape 是不同
  // 的动作（保留数据 vs 取消），因此刻意保留原始 useInput。
  // eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw y/n/esc; Enter must not trigger destructive delete
  useInput((input, key) => {
    if (!selectedPlugin) return;
    const pluginId_9 = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
    const pluginScope_2 = selectedPlugin.scope;
    // 该对话框只能从 uninstall 分支到达（该分支有 isBuiltin
    // 守卫），但 TS 无法跨 viewState 转换追踪这一点。
    if (!pluginScope_2 || pluginScope_2 === 'builtin' || !isInstallableScope(pluginScope_2)) return;
    const doUninstall = async (deleteDataDir: boolean) => {
      setIsProcessing(true);
      setProcessError(null);
      try {
        const result_3 = await uninstallPluginOp(pluginId_9, pluginScope_2, deleteDataDir);
        if (!result_3.success) throw new Error(result_3.message);
        clearAllCaches();
        const suffix = deleteDataDir ? '' : ' · data preserved';
        setResult(`${figures.tick} ${result_3.message}${suffix}`);
        if (onManageComplete) void onManageComplete();
        setParentViewState({
          type: 'menu'
        });
      } catch (e_0) {
        setIsProcessing(false);
        setProcessError(e_0 instanceof Error ? e_0.message : String(e_0));
      }
    };
    if (input === 'y' || input === 'Y') {
      void doUninstall(true);
    } else if (input === 'n' || input === 'N') {
      void doUninstall(false);
    } else if (key.escape) {
      setViewState('plugin-details');
      setProcessError(null);
    }
  }, {
    isActive: typeof viewState === 'object' && viewState.type === 'confirm-data-cleanup' && !!selectedPlugin && !isProcessing
  });

  // 搜索词变化时重置选中项
  React.useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  // 处理进入搜索模式的输入（文本输入由 useSearchInput 钩子处理）
  // eslint-disable-next-line custom-rules/prefer-use-keybindings -- useInput needed for raw search mode text input
  useInput((input_0, key_0) => {
    const keyIsNotCtrlOrMeta = !key_0.ctrl && !key_0.meta;
    if (isSearchMode) {
      // 文本输入由 useSearchInput 钩子处理
      return;
    }

    // 用 '/' 或任意可打印字符进入搜索模式（导航键除外）
    if (input_0 === '/' && keyIsNotCtrlOrMeta) {
      setIsSearchMode(true);
      setSearchQuery('');
      setSelectedIndex(0);
    } else if (keyIsNotCtrlOrMeta && input_0.length > 0 && !/^\s+$/.test(input_0) && input_0 !== 'j' && input_0 !== 'k' && input_0 !== ' ') {
      setIsSearchMode(true);
      setSearchQuery(input_0);
      setSelectedIndex(0);
    }
  }, {
    isActive: viewState === 'plugin-list'
  });

  // 加载状态
  if (loading) {
    return <Text>Loading installed plugins…</Text>;
  }

  // 未安装任何插件或 MCP
  if (unifiedItems.length === 0) {
    return <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Manage plugins</Text>
        </Box>
        <Text>No plugins or MCP servers installed.</Text>
        <Box marginTop={1}>
          <Text dimColor>Esc to go back</Text>
        </Box>
      </Box>;
  }
  if (typeof viewState === 'object' && viewState.type === 'plugin-options' && selectedPlugin) {
    const pluginId_10 = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
    function finish(msg: string): void {
      setResult(msg);
      // 无论配置是已保存还是被跳过，插件都处于启用状态
      // —— onManageComplete → markPluginsChanged →
      // 持久的 "run /reload-plugins" 提示。
      if (onManageComplete) {
        void onManageComplete();
      }
      setParentViewState({
        type: 'menu'
      });
    }
    return <PluginOptionsFlow plugin={selectedPlugin.plugin} pluginId={pluginId_10} onDone={(outcome, detail) => {
      switch (outcome) {
        case 'configured':
          finish(`✓ Enabled and configured ${selectedPlugin.plugin.name}. Run /reload-plugins to apply.`);
          break;
        case 'skipped':
          finish(`✓ Enabled ${selectedPlugin.plugin.name}. Run /reload-plugins to apply.`);
          break;
        case 'error':
          finish(`Failed to save configuration: ${detail}`);
          break;
      }
    }} />;
  }

  // Configure 选项（来自 Manage 菜单）
  if (typeof viewState === 'object' && viewState.type === 'configuring-options' && selectedPlugin) {
    const pluginId_11 = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
    return <PluginOptionsDialog title={`Configure ${selectedPlugin.plugin.name}`} subtitle="Plugin options" configSchema={viewState.schema} initialValues={loadPluginOptions(pluginId_11)} onSave={values => {
      try {
        savePluginOptions(pluginId_11, values, viewState.schema);
        clearAllCaches();
        setResult('Configuration saved. Run /reload-plugins for changes to take effect.');
      } catch (err_3) {
        setProcessError(`Failed to save configuration: ${errorMessage(err_3)}`);
      }
      setViewState('plugin-details');
    }} onCancel={() => setViewState('plugin-details')} />;
  }

  // 配置视图
  if (viewState === 'configuring' && configNeeded && selectedPlugin) {
    const pluginId_12 = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
    async function handleSave(config: UserConfigValues) {
      if (!configNeeded || !selectedPlugin) return;
      try {
        // 再次查找 MCPB 路径
        const mcpServersSpec_1 = selectedPlugin.plugin.manifest.mcpServers;
        let mcpbPath_0: string | null = null;
        if (typeof mcpServersSpec_1 === 'string' && isMcpbSource(mcpServersSpec_1)) {
          mcpbPath_0 = mcpServersSpec_1;
        } else if (Array.isArray(mcpServersSpec_1)) {
          for (const spec_1 of mcpServersSpec_1) {
            if (typeof spec_1 === 'string' && isMcpbSource(spec_1)) {
              mcpbPath_0 = spec_1;
              break;
            }
          }
        }
        if (!mcpbPath_0) {
          setProcessError('No MCPB file found');
          setViewState('plugin-details');
          return;
        }

        // 使用提供的配置重新加载
        await loadMcpbFile(mcpbPath_0, selectedPlugin.plugin.path, pluginId_12, undefined, config);

        // 成功 —— 返回详情
        setProcessError(null);
        setConfigNeeded(null);
        setViewState('plugin-details');
        setResult('Configuration saved. Run /reload-plugins for changes to take effect.');
      } catch (err_4) {
        const errorMsg_0 = errorMessage(err_4);
        setProcessError(`Failed to save configuration: ${errorMsg_0}`);
        setViewState('plugin-details');
      }
    }
    function handleCancel() {
      setConfigNeeded(null);
      setViewState('plugin-details');
    }
    return <PluginOptionsDialog title={`Configure ${configNeeded.manifest.name}`} subtitle={`Plugin: ${selectedPlugin.plugin.name}`} configSchema={configNeeded.configSchema} initialValues={configNeeded.existingConfig} onSave={handleSave} onCancel={handleCancel} />;
  }

  // 被标记插件的详情视图
  if (typeof viewState === 'object' && viewState.type === 'flagged-detail') {
    const fp = viewState.plugin;
    return <Box flexDirection="column">
        <Box>
          <Text bold>
            {fp.name} @ {fp.marketplace}
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Status: </Text>
          <Text color="error">Removed</Text>
        </Box>

        <Box marginBottom={1} flexDirection="column">
          <Text color="error">
            Removed from marketplace · reason: {fp.reason}
          </Text>
          <Text>{fp.text}</Text>
          <Text dimColor>
            Flagged on {new Date(fp.flaggedAt).toLocaleDateString()}
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text>{figures.pointer} </Text>
            <Text color="suggestion">Dismiss</Text>
          </Box>
        </Box>

        <Byline>
          <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="dismiss" />
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
        </Byline>
      </Box>;
  }

  // Confirm-project-uninstall：就共享的 .limkenion/settings.json 给出警告，
  // 改为提供在 settings.local.json 中禁用的选项。
  if (viewState === 'confirm-project-uninstall' && selectedPlugin) {
    return <Box flexDirection="column">
        <Text bold color="warning">
          {selectedPlugin.plugin.name} is enabled in .limkenion/settings.json
          (shared with your team)
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Disable it just for you in .limkenion/settings.local.json?</Text>
          <Text dimColor>
            This has the same effect as uninstalling, without affecting other
            contributors.
          </Text>
        </Box>
        {processError && <Box marginTop={1}>
            <Text color="error">{processError}</Text>
          </Box>}
        <Box marginTop={1}>
          {isProcessing ? <Text dimColor>Disabling…</Text> : <Byline>
              <ConfigurableShortcutHint action="confirm:yes" context="Confirmation" fallback="y" description="disable" />
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
            </Byline>}
        </Box>
      </Box>;
  }

  // Confirm-data-cleanup：在删除 ${LIMKENION_PLUGIN_DATA} 目录前提示
  if (typeof viewState === 'object' && viewState.type === 'confirm-data-cleanup' && selectedPlugin) {
    return <Box flexDirection="column">
        <Text bold>
          {selectedPlugin.plugin.name} has {viewState.size.human} of persistent
          data
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Delete it along with the plugin?</Text>
          <Text dimColor>
            {pluginDataDirPath(`${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`)}
          </Text>
        </Box>
        {processError && <Box marginTop={1}>
            <Text color="error">{processError}</Text>
          </Box>}
        <Box marginTop={1}>
          {isProcessing ? <Text dimColor>Uninstalling…</Text> : <Text>
              <Text bold>y</Text> to delete · <Text bold>n</Text> to keep ·{' '}
              <Text bold>esc</Text> to cancel
            </Text>}
        </Box>
      </Box>;
  }

  // 插件详情视图
  if (viewState === 'plugin-details' && selectedPlugin) {
    const mergedSettings_2 = getSettings_DEPRECATED(); // 使用合并后的设置以尊重所有层级
    const pluginId_13 = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
    const isEnabled_2 = mergedSettings_2?.enabledPlugins?.[pluginId_13] !== false;

    // 计算插件错误区块
    const filteredPluginErrors = pluginErrors.filter(e_1 => 'plugin' in e_1 && e_1.plugin === selectedPlugin.plugin.name || e_1.source === pluginId_13 || e_1.source.startsWith(`${selectedPlugin.plugin.name}@`));
    const pluginErrorsSection = filteredPluginErrors.length === 0 ? null : <Box flexDirection="column" marginBottom={1}>
          <Text bold color="error">
            {filteredPluginErrors.length}{' '}
            {plural(filteredPluginErrors.length, 'error')}:
          </Text>
          {filteredPluginErrors.map((error_3, i_0) => {
        const guidance = getErrorGuidance(error_3);
        return <Box key={i_0} flexDirection="column" marginLeft={2}>
                <Text color="error">{formatErrorMessage(error_3)}</Text>
                {guidance && <Text dimColor italic>
                    {figures.arrowRight} {guidance}
                  </Text>}
              </Box>;
      })}
        </Box>;
    return <Box flexDirection="column">
        <Box>
          <Text bold>
            {selectedPlugin.plugin.name} @ {selectedPlugin.marketplace}
          </Text>
        </Box>

        {/* 作用域 */}
        <Box>
          <Text dimColor>Scope: </Text>
          <Text>{selectedPlugin.scope || 'user'}</Text>
        </Box>

        {/* 插件详情 */}
        {selectedPlugin.plugin.manifest.version && <Box>
            <Text dimColor>Version: </Text>
            <Text>{selectedPlugin.plugin.manifest.version}</Text>
          </Box>}

        {selectedPlugin.plugin.manifest.description && <Box marginBottom={1}>
            <Text>{selectedPlugin.plugin.manifest.description}</Text>
          </Box>}

        {selectedPlugin.plugin.manifest.author && <Box>
            <Text dimColor>Author: </Text>
            <Text>{selectedPlugin.plugin.manifest.author.name}</Text>
          </Box>}

        {/* 当前状态 */}
        <Box marginBottom={1}>
          <Text dimColor>Status: </Text>
          <Text color={isEnabled_2 ? 'success' : 'warning'}>
            {isEnabled_2 ? 'Enabled' : 'Disabled'}
          </Text>
          {selectedPlugin.pendingUpdate && <Text color="suggestion"> · Marked for update</Text>}
        </Box>

        {/* 已安装组件 */}
        <PluginComponentsDisplay plugin={selectedPlugin.plugin} marketplace={selectedPlugin.marketplace} />

        {/* 插件错误 */}
        {pluginErrorsSection}

        {/* 菜单 */}
        <Box marginTop={1} flexDirection="column">
          {detailsMenuItems.map((item_9, index_0) => {
          const isSelected = index_0 === detailsMenuIndex;
          return <Box key={index_0}>
                {isSelected && <Text>{figures.pointer} </Text>}
                {!isSelected && <Text>{'  '}</Text>}
                <Text bold={isSelected} color={item_9.label.includes('Uninstall') ? 'error' : item_9.label.includes('Update') ? 'suggestion' : undefined}>
                  {item_9.label}
                </Text>
              </Box>;
        })}
        </Box>

        {/* 处理中状态 */}
        {isProcessing && <Box marginTop={1}>
            <Text>Processing…</Text>
          </Box>}

        {/* 错误消息 */}
        {processError && <Box marginTop={1}>
            <Text color="error">{processError}</Text>
          </Box>}

        <Box marginTop={1}>
          <Text dimColor italic>
            <Byline>
              <ConfigurableShortcutHint action="select:previous" context="Select" fallback="↑" description="navigate" />
              <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="select" />
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
            </Byline>
          </Text>
        </Box>
      </Box>;
  }

  // 失败插件详情视图
  if (typeof viewState === 'object' && viewState.type === 'failed-plugin-details') {
    const failedPlugin_0 = viewState.plugin;
    const firstError = failedPlugin_0.errors[0];
    const errorMessage_0 = firstError ? formatErrorMessage(firstError) : 'Failed to load';
    return <Box flexDirection="column">
        <Text>
          <Text bold>{failedPlugin_0.name}</Text>
          <Text dimColor> @ {failedPlugin_0.marketplace}</Text>
          <Text dimColor> ({failedPlugin_0.scope})</Text>
        </Text>
        <Text color="error">{errorMessage_0}</Text>

        {failedPlugin_0.scope === 'managed' ? <Box marginTop={1}>
            <Text dimColor>
              Managed by your organization — contact your admin
            </Text>
          </Box> : <Box marginTop={1}>
            <Text color="suggestion">{figures.pointer} </Text>
            <Text bold>Remove</Text>
          </Box>}

        {isProcessing && <Text>Processing…</Text>}
        {processError && <Text color="error">{processError}</Text>}

        <Box marginTop={1}>
          <Text dimColor italic>
            <Byline>
              {failedPlugin_0.scope !== 'managed' && <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="remove" />}
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
            </Byline>
          </Text>
        </Box>
      </Box>;
  }

  // MCP 详情视图
  if (typeof viewState === 'object' && viewState.type === 'mcp-detail') {
    const client_3 = viewState.client;
    const serverToolsCount = filterToolsByServer(mcpTools, client_3.name).length;

    // MCP 菜单的通用处理器
    const handleMcpViewTools = () => {
      setViewState({
        type: 'mcp-tools',
        client: client_3
      });
    };
    const handleMcpCancel = () => {
      setViewState('plugin-list');
    };
    const handleMcpComplete = (result_4?: string) => {
      if (result_4) {
        setResult(result_4);
      }
      setViewState('plugin-list');
    };

    // 将 MCPServerConnection 转换为对应的 ServerInfo 类型
    const scope_5 = client_3.config.scope;
    const configType = client_3.config.type;
    if (configType === 'stdio') {
      const server: StdioServerInfo = {
        name: client_3.name,
        client: client_3,
        scope: scope_5,
        transport: 'stdio',
        config: client_3.config as McpStdioServerConfig
      };
      return <MCPStdioServerMenu server={server} serverToolsCount={serverToolsCount} onViewTools={handleMcpViewTools} onCancel={handleMcpCancel} onComplete={handleMcpComplete} borderless />;
    } else if (configType === 'sse') {
      const server_0: SSEServerInfo = {
        name: client_3.name,
        client: client_3,
        scope: scope_5,
        transport: 'sse',
        isAuthenticated: undefined,
        config: client_3.config as McpSSEServerConfig
      };
      return <MCPRemoteServerMenu server={server_0} serverToolsCount={serverToolsCount} onViewTools={handleMcpViewTools} onCancel={handleMcpCancel} onComplete={handleMcpComplete} borderless />;
    } else if (configType === 'http') {
      const server_1: HTTPServerInfo = {
        name: client_3.name,
        client: client_3,
        scope: scope_5,
        transport: 'http',
        isAuthenticated: undefined,
        config: client_3.config as McpHTTPServerConfig
      };
      return <MCPRemoteServerMenu server={server_1} serverToolsCount={serverToolsCount} onViewTools={handleMcpViewTools} onCancel={handleMcpCancel} onComplete={handleMcpComplete} borderless />;
    } else if (configType === 'limkenionai-proxy') {
      const server_2: LimkenionAIServerInfo = {
        name: client_3.name,
        client: client_3,
        scope: scope_5,
        transport: 'limkenionai-proxy',
        isAuthenticated: undefined,
        config: client_3.config as McpLimkenionAIProxyServerConfig
      };
      return <MCPRemoteServerMenu server={server_2} serverToolsCount={serverToolsCount} onViewTools={handleMcpViewTools} onCancel={handleMcpCancel} onComplete={handleMcpComplete} borderless />;
    }

    // 降级处理 —— 不应发生，但要优雅处理
    setViewState('plugin-list');
    return null;
  }

  // MCP 工具视图
  if (typeof viewState === 'object' && viewState.type === 'mcp-tools') {
    const client_4 = viewState.client;
    const scope_6 = client_4.config.scope;
    const configType_0 = client_4.config.type;

    // 为 MCPToolListView 构建 ServerInfo
    let server_3: StdioServerInfo | SSEServerInfo | HTTPServerInfo | LimkenionAIServerInfo;
    if (configType_0 === 'stdio') {
      server_3 = {
        name: client_4.name,
        client: client_4,
        scope: scope_6,
        transport: 'stdio',
        config: client_4.config as McpStdioServerConfig
      };
    } else if (configType_0 === 'sse') {
      server_3 = {
        name: client_4.name,
        client: client_4,
        scope: scope_6,
        transport: 'sse',
        isAuthenticated: undefined,
        config: client_4.config as McpSSEServerConfig
      };
    } else if (configType_0 === 'http') {
      server_3 = {
        name: client_4.name,
        client: client_4,
        scope: scope_6,
        transport: 'http',
        isAuthenticated: undefined,
        config: client_4.config as McpHTTPServerConfig
      };
    } else {
      server_3 = {
        name: client_4.name,
        client: client_4,
        scope: scope_6,
        transport: 'limkenionai-proxy',
        isAuthenticated: undefined,
        config: client_4.config as McpLimkenionAIProxyServerConfig
      };
    }
    return <MCPToolListView server={server_3} onSelectTool={(tool: Tool) => {
      setViewState({
        type: 'mcp-tool-detail',
        client: client_4,
        tool
      });
    }} onBack={() => setViewState({
      type: 'mcp-detail',
      client: client_4
    })} />;
  }

  // MCP 工具详情视图
  if (typeof viewState === 'object' && viewState.type === 'mcp-tool-detail') {
    const {
      client: client_5,
      tool: tool_0
    } = viewState;
    const scope_7 = client_5.config.scope;
    const configType_1 = client_5.config.type;

    // 为 MCPToolDetailView 构建 ServerInfo
    let server_4: StdioServerInfo | SSEServerInfo | HTTPServerInfo | LimkenionAIServerInfo;
    if (configType_1 === 'stdio') {
      server_4 = {
        name: client_5.name,
        client: client_5,
        scope: scope_7,
        transport: 'stdio',
        config: client_5.config as McpStdioServerConfig
      };
    } else if (configType_1 === 'sse') {
      server_4 = {
        name: client_5.name,
        client: client_5,
        scope: scope_7,
        transport: 'sse',
        isAuthenticated: undefined,
        config: client_5.config as McpSSEServerConfig
      };
    } else if (configType_1 === 'http') {
      server_4 = {
        name: client_5.name,
        client: client_5,
        scope: scope_7,
        transport: 'http',
        isAuthenticated: undefined,
        config: client_5.config as McpHTTPServerConfig
      };
    } else {
      server_4 = {
        name: client_5.name,
        client: client_5,
        scope: scope_7,
        transport: 'limkenionai-proxy',
        isAuthenticated: undefined,
        config: client_5.config as McpLimkenionAIProxyServerConfig
      };
    }
    return <MCPToolDetailView tool={tool_0} server={server_4} onBack={() => setViewState({
      type: 'mcp-tools',
      client: client_5
    })} />;
  }

  // 插件列表视图（主要管理界面）
  const visibleItems = pagination.getVisibleItems(filteredItems);
  return <Box flexDirection="column">
      {/* 搜索框 */}
      <Box marginBottom={1}>
        <SearchBox query={searchQuery} isFocused={isSearchMode} isTerminalFocused={isTerminalFocused} width={terminalWidth - 4} cursorOffset={searchCursorOffset} />
      </Box>

      {/* 无搜索结果 */}
      {filteredItems.length === 0 && searchQuery && <Box marginBottom={1}>
          <Text dimColor>No items match &quot;{searchQuery}&quot;</Text>
        </Box>}

      {/* 向上滚动指示器 */}
      {pagination.scrollPosition.canScrollUp && <Box>
          <Text dimColor> {figures.arrowUp} more above</Text>
        </Box>}

      {/* 按作用域分组的插件与 MCP 统一列表 */}
      {visibleItems.map((item_10, visibleIndex) => {
      const actualIndex = pagination.toActualIndex(visibleIndex);
      const isSelected_0 = actualIndex === selectedIndex && !isSearchMode;

      // 检查是否需要显示作用域标题
      const prevItem = visibleIndex > 0 ? visibleItems[visibleIndex - 1] : null;
      const showScopeHeader = !prevItem || prevItem.scope !== item_10.scope;

      // 获取作用域标签
      const getScopeLabel = (scope_8: string): string => {
        switch (scope_8) {
          case 'flagged':
            return 'Flagged';
          case 'project':
            return 'Project';
          case 'local':
            return 'Local';
          case 'user':
            return 'User';
          case 'enterprise':
            return 'Enterprise';
          case 'managed':
            return 'Managed';
          case 'builtin':
            return 'Built-in';
          case 'dynamic':
            return 'Built-in';
          default:
            return scope_8;
        }
      };
      return <React.Fragment key={item_10.id}>
            {showScopeHeader && <Box marginTop={visibleIndex > 0 ? 1 : 0} paddingLeft={2}>
                <Text dimColor={item_10.scope !== 'flagged'} color={item_10.scope === 'flagged' ? 'warning' : undefined} bold={item_10.scope === 'flagged'}>
                  {getScopeLabel(item_10.scope)}
                </Text>
              </Box>}
            <UnifiedInstalledCell item={item_10} isSelected={isSelected_0} />
          </React.Fragment>;
    })}

      {/* 向下滚动指示器 */}
      {pagination.scrollPosition.canScrollDown && <Box>
          <Text dimColor> {figures.arrowDown} more below</Text>
        </Box>}

      {/* 帮助文本 */}
      <Box marginTop={1} marginLeft={1}>
        <Text dimColor italic>
          <Byline>
            <Text>type to search</Text>
            <ConfigurableShortcutHint action="plugin:toggle" context="Plugin" fallback="Space" description="toggle" />
            <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="details" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
          </Byline>
        </Text>
      </Box>

      {/* 插件变更的重载免责声明 */}
      {pendingToggles.size > 0 && <Box marginLeft={1}>
          <Text dimColor italic>
            Run /reload-plugins to apply changes
          </Text>
        </Box>}
    </Box>;
}