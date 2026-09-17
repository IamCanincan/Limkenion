import figures from 'figures';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Byline } from '../../components/design-system/Byline.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import type { LoadedPlugin } from '../../types/plugin.js';
import { count } from '../../utils/array.js';
import { openBrowser } from '../../utils/browser.js';
import { logForDebugging } from '../../utils/debug.js';
import { errorMessage } from '../../utils/errors.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { formatInstallCount, getInstallCounts } from '../../utils/plugins/installCounts.js';
import { isPluginGloballyInstalled, isPluginInstalled } from '../../utils/plugins/installedPluginsManager.js';
import { createPluginId, formatFailureDetails, formatMarketplaceLoadingErrors, getMarketplaceSourceDisplay, loadMarketplacesWithGracefulDegradation } from '../../utils/plugins/marketplaceHelpers.js';
import { getMarketplace, loadKnownMarketplacesConfig } from '../../utils/plugins/marketplaceManager.js';
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js';
import { installPluginFromMarketplace } from '../../utils/plugins/pluginInstallationHelpers.js';
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js';
import { plural } from '../../utils/stringUtils.js';
import { truncateToWidth } from '../../utils/truncate.js';
import { findPluginOptionsTarget, PluginOptionsFlow } from './PluginOptionsFlow.js';
import { PluginTrustWarning } from './PluginTrustWarning.js';
import { buildPluginDetailsMenuOptions, extractGitHubRepo, type InstallablePlugin, PluginSelectionKeyHint } from './pluginDetailsHelpers.js';
import type { ViewState as ParentViewState } from './types.js';
import { usePagination } from './usePagination.js';
type Props = {
  error: string | null;
  setError: (error: string | null) => void;
  result: string | null;
  setResult: (result: string | null) => void;
  setViewState: (state: ParentViewState) => void;
  onInstallComplete?: () => void | Promise<void>;
  targetMarketplace?: string;
  targetPlugin?: string;
};
type ViewState = 'marketplace-list' | 'plugin-list' | 'plugin-details' | {
  type: 'plugin-options';
  plugin: LoadedPlugin;
  pluginId: string;
};
type MarketplaceInfo = {
  name: string;
  totalPlugins: number;
  installedCount: number;
  source?: string;
};
export function BrowseMarketplace({
  error,
  setError,
  result: _result,
  setResult,
  setViewState: setParentViewState,
  onInstallComplete,
  targetMarketplace,
  targetPlugin
}: Props): React.ReactNode {
  // 视图状态
  const [viewState, setViewState] = useState<ViewState>('marketplace-list');
  const [selectedMarketplace, setSelectedMarketplace] = useState<string | null>(null);
  const [selectedPlugin, setSelectedPlugin] = useState<InstallablePlugin | null>(null);

  // 数据状态
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([]);
  const [availablePlugins, setAvailablePlugins] = useState<InstallablePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [installCounts, setInstallCounts] = useState<Map<string, number> | null>(null);

  // 选中状态
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedForInstall, setSelectedForInstall] = useState<Set<string>>(new Set());
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());

  // 插件列表分页（连续滚动）
  const pagination = usePagination<InstallablePlugin>({
    totalItems: availablePlugins.length,
    selectedIndex
  });

  // 详情视图状态
  const [detailsMenuIndex, setDetailsMenuIndex] = useState(0);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // 非致命错误的警告状态（例如部分市场加载失败）
  const [warning, setWarning] = useState<string | null>(null);

  // 处理 Escape 返回 —— 依 viewState 而定的导航
  const handleBack = React.useCallback(() => {
    if (viewState === 'plugin-list') {
      // 若通过 targetMarketplace 直接导航到某个市场，
      // 则返回 manage-marketplaces 并展示该市场的详情
      if (targetMarketplace) {
        setParentViewState({
          type: 'manage-marketplaces',
          targetMarketplace
        });
      } else if (marketplaces.length === 1) {
        // 若只有一个市场，则跳过 marketplace-list 视图，
        // 因为加载时我们已经自动越过它了
        setParentViewState({
          type: 'menu'
        });
      } else {
        setViewState('marketplace-list');
        setSelectedMarketplace(null);
        setSelectedForInstall(new Set());
      }
    } else if (viewState === 'plugin-details') {
      setViewState('plugin-list');
      setSelectedPlugin(null);
    } else {
      // 在根层级（marketplace-list）时，退出插件菜单
      setParentViewState({
        type: 'menu'
      });
    }
  }, [viewState, targetMarketplace, setParentViewState, marketplaces.length]);
  useKeybinding('confirm:no', handleBack, {
    context: 'Confirmation'
  });

  // 加载各市场并统计已安装的插件数
  useEffect(() => {
    async function loadMarketplaceData() {
      try {
        const config = await loadKnownMarketplacesConfig();

        // 以优雅降级的方式加载各市场
        const {
          marketplaces: marketplaces_0,
          failures
        } = await loadMarketplacesWithGracefulDegradation(config);
        const marketplaceInfos: MarketplaceInfo[] = [];
        for (const {
          name,
          config: marketplaceConfig,
          data: marketplace
        } of marketplaces_0) {
          if (marketplace) {
            // 统计来自该市场的插件已安装数量
            const installedFromThisMarketplace = count(marketplace.plugins, plugin => isPluginInstalled(createPluginId(plugin.name, name)));
            marketplaceInfos.push({
              name,
              totalPlugins: marketplace.plugins.length,
              installedCount: installedFromThisMarketplace,
              source: getMarketplaceSourceDisplay(marketplaceConfig.source)
            });
          }
        }

        // 排序使 limkenion-plugin-directory 始终排在首位
        marketplaceInfos.sort((a, b) => {
          if (a.name === 'limkenion-plugin-directory') return -1;
          if (b.name === 'limkenion-plugin-directory') return 1;
          return 0;
        });
        setMarketplaces(marketplaceInfos);

        // 处理市场加载错误/警告
        const successCount = count(marketplaces_0, m => m.data !== null);
        const errorResult = formatMarketplaceLoadingErrors(failures, successCount);
        if (errorResult) {
          if (errorResult.type === 'warning') {
            setWarning(errorResult.message + '. Showing available marketplaces.');
          } else {
            throw new Error(errorResult.message);
          }
        }

        // 若只有一个市场则跳过市场选择
        if (marketplaceInfos.length === 1 && !targetMarketplace && !targetPlugin) {
          const singleMarketplace = marketplaceInfos[0];
          if (singleMarketplace) {
            setSelectedMarketplace(singleMarketplace.name);
            setViewState('plugin-list');
          }
        }

        // 市场加载完成后处理 targetMarketplace 与 targetPlugin
        if (targetPlugin) {
          // 在所有市场中搜索该插件
          let foundPlugin: InstallablePlugin | null = null;
          let foundMarketplace: string | null = null;
          for (const [name_0] of Object.entries(config)) {
            const marketplace_0 = await getMarketplace(name_0);
            if (marketplace_0) {
              const plugin_0 = marketplace_0.plugins.find(p => p.name === targetPlugin);
              if (plugin_0) {
                const pluginId = createPluginId(plugin_0.name, name_0);
                foundPlugin = {
                  entry: plugin_0,
                  marketplaceName: name_0,
                  pluginId,
                  // isPluginGloballyInstalled：仅当存在 user/managed 作用域时
                  // 才阻止（因为无可添加）。project/local 作用域的安装不会
                  // 阻止 —— 用户可能想提升为 user 作用域（gh-29997）。
                  isInstalled: isPluginGloballyInstalled(pluginId)
                };
                foundMarketplace = name_0;
                break;
              }
            }
          }
          if (foundPlugin && foundMarketplace) {
            // 仅对全局（user/managed）安装进行阻止 —— project/local 作用域
            // 意味着用户可能仍想添加一条 user 作用域记录，使该
            // 插件在其他项目中也可用（gh-29997、gh-29240、gh-29392）。
            // plugin-details 视图提供全部三种作用域选项；后端
            // （installPluginOp → addInstalledPlugin）已支持
            // 每个插件有多条作用域记录。
            const pluginId_0 = foundPlugin.pluginId;
            const globallyInstalled = isPluginGloballyInstalled(pluginId_0);
            if (globallyInstalled) {
              setError(`Plugin '${pluginId_0}' is already installed globally. Use '/plugin' to manage existing plugins.`);
            } else {
              // 导航到插件详情视图
              setSelectedMarketplace(foundMarketplace);
              setSelectedPlugin(foundPlugin);
              setViewState('plugin-details');
            }
          } else {
            setError(`Plugin "${targetPlugin}" not found in any marketplace`);
          }
        } else if (targetMarketplace) {
          // 直接导航到指定的市场
          const marketplaceExists = marketplaceInfos.some(m_0 => m_0.name === targetMarketplace);
          if (marketplaceExists) {
            setSelectedMarketplace(targetMarketplace);
            setViewState('plugin-list');
          } else {
            setError(`Marketplace "${targetMarketplace}" not found`);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load marketplaces');
      } finally {
        setLoading(false);
      }
    }
    void loadMarketplaceData();
  }, [setError, targetMarketplace, targetPlugin]);

  // 选中市场后加载插件
  useEffect(() => {
    if (!selectedMarketplace) return;
    let cancelled = false;
    async function loadPluginsForMarketplace(marketplaceName: string) {
      setLoading(true);
      try {
        const marketplace_1 = await getMarketplace(marketplaceName);
        if (cancelled) return;
        if (!marketplace_1) {
          throw new Error(`Failed to load marketplace: ${marketplaceName}`);
        }

        // 过滤掉已安装的插件
        const installablePlugins: InstallablePlugin[] = [];
        for (const entry of marketplace_1.plugins) {
          const pluginId_1 = createPluginId(entry.name, marketplaceName);
          if (isPluginBlockedByPolicy(pluginId_1)) continue;
          installablePlugins.push({
            entry,
            marketplaceName: marketplaceName,
            pluginId: pluginId_1,
            // 仅在全局作用域（user/managed）时才标记为“已安装”。
            // project/local 安装不会阻止 —— 用户可通过
            // plugin-details 视图添加 user 作用域（gh-29997）。
            isInstalled: isPluginGloballyInstalled(pluginId_1)
          });
        }

        // 获取安装次数并按热度排序
        try {
          const counts = await getInstallCounts();
          if (cancelled) return;
          setInstallCounts(counts);
          if (counts) {
            // 按安装次数降序排序，次数相同则按字母序
            installablePlugins.sort((a_1, b_1) => {
              const countA = counts.get(a_1.pluginId) ?? 0;
              const countB = counts.get(b_1.pluginId) ?? 0;
              if (countA !== countB) return countB - countA;
              return a_1.entry.name.localeCompare(b_1.entry.name);
            });
          } else {
            // 无次数数据 —— 按字母序排序
            installablePlugins.sort((a_2, b_2) => a_2.entry.name.localeCompare(b_2.entry.name));
          }
        } catch (error_0) {
          if (cancelled) return;
          // 记录错误，然后优雅降级为字母序排序
          logForDebugging(`Failed to fetch install counts: ${errorMessage(error_0)}`);
          installablePlugins.sort((a_0, b_0) => a_0.entry.name.localeCompare(b_0.entry.name));
        }
        setAvailablePlugins(installablePlugins);
        setSelectedIndex(0);
        setSelectedForInstall(new Set());
      } catch (err_0) {
        if (cancelled) return;
        setError(err_0 instanceof Error ? err_0.message : 'Failed to load plugins');
      } finally {
        setLoading(false);
      }
    }
    void loadPluginsForMarketplace(selectedMarketplace);
    return () => {
      cancelled = true;
    };
  }, [selectedMarketplace, setError]);

  // 安装所选插件
  const installSelectedPlugins = async () => {
    if (selectedForInstall.size === 0) return;
    const pluginsToInstall = availablePlugins.filter(p_0 => selectedForInstall.has(p_0.pluginId));
    setInstallingPlugins(new Set(pluginsToInstall.map(p_1 => p_1.pluginId)));
    let successCount_0 = 0;
    let failureCount = 0;
    const newFailedPlugins: Array<{
      name: string;
      reason: string;
    }> = [];
    for (const plugin_1 of pluginsToInstall) {
      const result = await installPluginFromMarketplace({
        pluginId: plugin_1.pluginId,
        entry: plugin_1.entry,
        marketplaceName: plugin_1.marketplaceName,
        scope: 'user'
      });
      if (result.success) {
        successCount_0++;
      } else {
        failureCount++;
        newFailedPlugins.push({
          name: plugin_1.entry.name,
          reason: result.error
        });
      }
    }
    setInstallingPlugins(new Set());
    setSelectedForInstall(new Set());
    clearAllCaches();

    // 处理安装结果
    if (failureCount === 0) {
      // 全部成功
      const message = `✓ Installed ${successCount_0} ${plural(successCount_0, 'plugin')}. ` + `Run /reload-plugins to activate.`;
      setResult(message);
    } else if (successCount_0 === 0) {
      // 全部失败 —— 显示错误及原因
      setError(`Failed to install: ${formatFailureDetails(newFailedPlugins, true)}`);
    } else {
      // 部分成功 —— 显示部分成功结果
      const message_0 = `✓ Installed ${successCount_0} of ${successCount_0 + failureCount} plugins. ` + `Failed: ${formatFailureDetails(newFailedPlugins, false)}. ` + `Run /reload-plugins to activate successfully installed plugins.`;
      setResult(message_0);
    }

    // 处理完成回调与导航
    if (successCount_0 > 0) {
      if (onInstallComplete) {
        await onInstallComplete();
      }
    }
    setParentViewState({
      type: 'menu'
    });
  };

  // 从详情视图安装单个插件
  const handleSinglePluginInstall = async (plugin_2: InstallablePlugin, scope: 'user' | 'project' | 'local' = 'user') => {
    setIsInstalling(true);
    setInstallError(null);
    const result_0 = await installPluginFromMarketplace({
      pluginId: plugin_2.pluginId,
      entry: plugin_2.entry,
      marketplaceName: plugin_2.marketplaceName,
      scope
    });
    if (result_0.success) {
      const loaded = await findPluginOptionsTarget(plugin_2.pluginId);
      if (loaded) {
        setIsInstalling(false);
        setViewState({
          type: 'plugin-options',
          plugin: loaded,
          pluginId: plugin_2.pluginId
        });
        return;
      }
      setResult(result_0.message);
      if (onInstallComplete) {
        await onInstallComplete();
      }
      setParentViewState({
        type: 'menu'
      });
    } else {
      setIsInstalling(false);
      setInstallError(result_0.error);
    }
  };

  // 处理错误状态
  useEffect(() => {
    if (error) {
      setResult(error);
    }
  }, [error, setResult]);

  // marketplace-list 导航
  useKeybindings({
    'select:previous': () => {
      if (selectedIndex > 0) {
        setSelectedIndex(selectedIndex - 1);
      }
    },
    'select:next': () => {
      if (selectedIndex < marketplaces.length - 1) {
        setSelectedIndex(selectedIndex + 1);
      }
    },
    'select:accept': () => {
      const marketplace_2 = marketplaces[selectedIndex];
      if (marketplace_2) {
        setSelectedMarketplace(marketplace_2.name);
        setViewState('plugin-list');
      }
    }
  }, {
    context: 'Select',
    isActive: viewState === 'marketplace-list'
  });

  // plugin-list 导航
  useKeybindings({
    'select:previous': () => {
      if (selectedIndex > 0) {
        pagination.handleSelectionChange(selectedIndex - 1, setSelectedIndex);
      }
    },
    'select:next': () => {
      if (selectedIndex < availablePlugins.length - 1) {
        pagination.handleSelectionChange(selectedIndex + 1, setSelectedIndex);
      }
    },
    'select:accept': () => {
      if (selectedIndex === availablePlugins.length && selectedForInstall.size > 0) {
        void installSelectedPlugins();
      } else if (selectedIndex < availablePlugins.length) {
        const plugin_3 = availablePlugins[selectedIndex];
        if (plugin_3) {
          if (plugin_3.isInstalled) {
            setParentViewState({
              type: 'manage-plugins',
              targetPlugin: plugin_3.entry.name,
              targetMarketplace: plugin_3.marketplaceName
            });
          } else {
            setSelectedPlugin(plugin_3);
            setViewState('plugin-details');
            setDetailsMenuIndex(0);
            setInstallError(null);
          }
        }
      }
    }
  }, {
    context: 'Select',
    isActive: viewState === 'plugin-list'
  });
  useKeybindings({
    'plugin:toggle': () => {
      if (selectedIndex < availablePlugins.length) {
        const plugin_4 = availablePlugins[selectedIndex];
        if (plugin_4 && !plugin_4.isInstalled) {
          const newSelection = new Set(selectedForInstall);
          if (newSelection.has(plugin_4.pluginId)) {
            newSelection.delete(plugin_4.pluginId);
          } else {
            newSelection.add(plugin_4.pluginId);
          }
          setSelectedForInstall(newSelection);
        }
      }
    },
    'plugin:install': () => {
      if (selectedForInstall.size > 0) {
        void installSelectedPlugins();
      }
    }
  }, {
    context: 'Plugin',
    isActive: viewState === 'plugin-list'
  });

  // plugin-details 导航
  const detailsMenuOptions = React.useMemo(() => {
    if (!selectedPlugin) return [];
    const hasHomepage = selectedPlugin.entry.homepage;
    const githubRepo = extractGitHubRepo(selectedPlugin);
    return buildPluginDetailsMenuOptions(hasHomepage, githubRepo);
  }, [selectedPlugin]);
  useKeybindings({
    'select:previous': () => {
      if (detailsMenuIndex > 0) {
        setDetailsMenuIndex(detailsMenuIndex - 1);
      }
    },
    'select:next': () => {
      if (detailsMenuIndex < detailsMenuOptions.length - 1) {
        setDetailsMenuIndex(detailsMenuIndex + 1);
      }
    },
    'select:accept': () => {
      if (!selectedPlugin) return;
      const action = detailsMenuOptions[detailsMenuIndex]?.action;
      const hasHomepage_0 = selectedPlugin.entry.homepage;
      const githubRepo_0 = extractGitHubRepo(selectedPlugin);
      if (action === 'install-user') {
        void handleSinglePluginInstall(selectedPlugin, 'user');
      } else if (action === 'install-project') {
        void handleSinglePluginInstall(selectedPlugin, 'project');
      } else if (action === 'install-local') {
        void handleSinglePluginInstall(selectedPlugin, 'local');
      } else if (action === 'homepage' && hasHomepage_0) {
        void openBrowser(hasHomepage_0);
      } else if (action === 'github' && githubRepo_0) {
        void openBrowser(`https://github.com/${githubRepo_0}`);
      } else if (action === 'back') {
        setViewState('plugin-list');
        setSelectedPlugin(null);
      }
    }
  }, {
    context: 'Select',
    isActive: viewState === 'plugin-details' && !!selectedPlugin
  });
  if (typeof viewState === 'object' && viewState.type === 'plugin-options') {
    const {
      plugin: plugin_5,
      pluginId: pluginId_2
    } = viewState;
    function finish(msg: string): void {
      setResult(msg);
      if (onInstallComplete) {
        void onInstallComplete();
      }
      setParentViewState({
        type: 'menu'
      });
    }
    return <PluginOptionsFlow plugin={plugin_5} pluginId={pluginId_2} onDone={(outcome, detail) => {
      switch (outcome) {
        case 'configured':
          finish(`✓ Installed and configured ${plugin_5.name}. Run /reload-plugins to apply.`);
          break;
        case 'skipped':
          finish(`✓ Installed ${plugin_5.name}. Run /reload-plugins to apply.`);
          break;
        case 'error':
          finish(`Installed but failed to save config: ${detail}`);
          break;
      }
    }} />;
  }

  // 加载状态
  if (loading) {
    return <Text>Loading…</Text>;
  }

  // 错误状态
  if (error) {
    return <Text color="error">{error}</Text>;
  }

  // 市场选择视图
  if (viewState === 'marketplace-list') {
    if (marketplaces.length === 0) {
      return <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Select marketplace</Text>
          </Box>
          <Text>No marketplaces configured.</Text>
          <Text dimColor>
            Add a marketplace first using {"'Add marketplace'"}.
          </Text>
          <Box marginTop={1} paddingLeft={1}>
            <Text dimColor>
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
            </Text>
          </Box>
        </Box>;
    }
    return <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Select marketplace</Text>
        </Box>

        {/* 市场加载失败的警告横幅 */}
        {warning && <Box marginBottom={1} flexDirection="column">
            <Text color="warning">
              {figures.warning} {warning}
            </Text>
          </Box>}
        {marketplaces.map((marketplace_3, index) => <Box key={marketplace_3.name} flexDirection="column" marginBottom={index < marketplaces.length - 1 ? 1 : 0}>
            <Box>
              <Text color={selectedIndex === index ? 'suggestion' : undefined}>
                {selectedIndex === index ? figures.pointer : ' '}{' '}
                {marketplace_3.name}
              </Text>
            </Box>
            <Box marginLeft={2}>
              <Text dimColor>
                {marketplace_3.totalPlugins}{' '}
                {plural(marketplace_3.totalPlugins, 'plugin')} available
                {marketplace_3.installedCount > 0 && ` · ${marketplace_3.installedCount} already installed`}
                {marketplace_3.source && ` · ${marketplace_3.source}`}
              </Text>
            </Box>
          </Box>)}

        <Box marginTop={1}>
          <Text dimColor italic>
            <Byline>
              <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="select" />
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
            </Byline>
          </Text>
        </Box>
      </Box>;
  }

  // 插件详情视图
  if (viewState === 'plugin-details' && selectedPlugin) {
    const hasHomepage_1 = selectedPlugin.entry.homepage;
    const githubRepo_1 = extractGitHubRepo(selectedPlugin);
    const menuOptions = buildPluginDetailsMenuOptions(hasHomepage_1, githubRepo_1);
    return <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Plugin Details</Text>
        </Box>

        {/* 插件元数据 */}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{selectedPlugin.entry.name}</Text>
          {selectedPlugin.entry.version && <Text dimColor>Version: {selectedPlugin.entry.version}</Text>}
          {selectedPlugin.entry.description && <Box marginTop={1}>
              <Text>{selectedPlugin.entry.description}</Text>
            </Box>}
          {selectedPlugin.entry.author && <Box marginTop={1}>
              <Text dimColor>
                By:{' '}
                {typeof selectedPlugin.entry.author === 'string' ? selectedPlugin.entry.author : selectedPlugin.entry.author.name}
              </Text>
            </Box>}
        </Box>

        {/* 将要安装的内容 */}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Will install:</Text>
          {selectedPlugin.entry.commands && <Text dimColor>
              · Commands:{' '}
              {Array.isArray(selectedPlugin.entry.commands) ? selectedPlugin.entry.commands.join(', ') : Object.keys(selectedPlugin.entry.commands).join(', ')}
            </Text>}
          {selectedPlugin.entry.agents && <Text dimColor>
              · Agents:{' '}
              {Array.isArray(selectedPlugin.entry.agents) ? selectedPlugin.entry.agents.join(', ') : Object.keys(selectedPlugin.entry.agents).join(', ')}
            </Text>}
          {selectedPlugin.entry.hooks && <Text dimColor>
              · Hooks: {Object.keys(selectedPlugin.entry.hooks).join(', ')}
            </Text>}
          {selectedPlugin.entry.mcpServers && <Text dimColor>
              · MCP Servers:{' '}
              {Array.isArray(selectedPlugin.entry.mcpServers) ? selectedPlugin.entry.mcpServers.join(', ') : typeof selectedPlugin.entry.mcpServers === 'object' ? Object.keys(selectedPlugin.entry.mcpServers).join(', ') : 'configured'}
            </Text>}
          {!selectedPlugin.entry.commands && !selectedPlugin.entry.agents && !selectedPlugin.entry.hooks && !selectedPlugin.entry.mcpServers && <>
                {typeof selectedPlugin.entry.source === 'object' && 'source' in selectedPlugin.entry.source && (selectedPlugin.entry.source.source === 'github' || selectedPlugin.entry.source.source === 'url' || selectedPlugin.entry.source.source === 'npm' || selectedPlugin.entry.source.source === 'pip') ? <Text dimColor>
                    · Component summary not available for remote plugin
                  </Text> :
          // TODO：真正扫描本地插件目录以展示真实的组件
          // 这需要访问文件系统来检查：
          // - commands/ 目录并列出文件
          // - agents/ 目录并列出文件
          // - hooks/ 目录并列出文件
          // - .mcp.json 或 mcp-servers.json 文件
          <Text dimColor>
                    · Components will be discovered at installation
                  </Text>}
              </>}
        </Box>

        <PluginTrustWarning />

        {/* 错误消息 */}
        {installError && <Box marginBottom={1}>
            <Text color="error">Error: {installError}</Text>
          </Box>}

        {/* 菜单选项 */}
        <Box flexDirection="column">
          {menuOptions.map((option, index_0) => <Box key={option.action}>
              {detailsMenuIndex === index_0 && <Text>{'> '}</Text>}
              {detailsMenuIndex !== index_0 && <Text>{'  '}</Text>}
              <Text bold={detailsMenuIndex === index_0}>
                {isInstalling && option.action === 'install' ? 'Installing…' : option.label}
              </Text>
            </Box>)}
        </Box>

        <Box marginTop={1} paddingLeft={1}>
          <Text dimColor>
            <Byline>
              <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="select" />
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
            </Byline>
          </Text>
        </Box>
      </Box>;
  }

  // 插件安装视图
  if (availablePlugins.length === 0) {
    return <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Install plugins</Text>
        </Box>
        <Text dimColor>No new plugins available to install.</Text>
        <Text dimColor>
          All plugins from this marketplace are already installed.
        </Text>
        <Box marginLeft={3}>
          <Text dimColor italic>
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
          </Text>
        </Box>
      </Box>;
  }

  // 从分页中获取可见的插件
  const visiblePlugins = pagination.getVisibleItems(availablePlugins);
  return <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Install Plugins</Text>
      </Box>

      {/* 向上滚动指示器 */}
      {pagination.scrollPosition.canScrollUp && <Box>
          <Text dimColor> {figures.arrowUp} more above</Text>
        </Box>}

      {/* 插件列表 */}
      {visiblePlugins.map((plugin_6, visibleIndex) => {
      const actualIndex = pagination.toActualIndex(visibleIndex);
      const isSelected = selectedIndex === actualIndex;
      const isSelectedForInstall = selectedForInstall.has(plugin_6.pluginId);
      const isInstalling_0 = installingPlugins.has(plugin_6.pluginId);
      const isLast = visibleIndex === visiblePlugins.length - 1;
      return <Box key={plugin_6.pluginId} flexDirection="column" marginBottom={isLast && !error ? 0 : 1}>
            <Box>
              <Text color={isSelected ? 'suggestion' : undefined}>
                {isSelected ? figures.pointer : ' '}{' '}
              </Text>
              <Text color={plugin_6.isInstalled ? 'success' : undefined}>
                {plugin_6.isInstalled ? figures.tick : isInstalling_0 ? figures.ellipsis : isSelectedForInstall ? figures.radioOn : figures.radioOff}{' '}
                {plugin_6.entry.name}
                {plugin_6.entry.category && <Text dimColor> [{plugin_6.entry.category}]</Text>}
                {plugin_6.entry.tags?.includes('community-managed') && <Text dimColor> [Community Managed]</Text>}
                {plugin_6.isInstalled && <Text dimColor> (installed)</Text>}
                {installCounts && selectedMarketplace === OFFICIAL_MARKETPLACE_NAME && <Text dimColor>
                      {' · '}
                      {formatInstallCount(installCounts.get(plugin_6.pluginId) ?? 0)}{' '}
                      installs
                    </Text>}
              </Text>
            </Box>
            {plugin_6.entry.description && <Box marginLeft={4}>
                <Text dimColor>
                  {truncateToWidth(plugin_6.entry.description, 60)}
                </Text>
                {plugin_6.entry.version && <Text dimColor> · v{plugin_6.entry.version}</Text>}
              </Box>}
          </Box>;
    })}

      {/* 向下滚动指示器 */}
      {pagination.scrollPosition.canScrollDown && <Box>
          <Text dimColor> {figures.arrowDown} more below</Text>
        </Box>}

      {/* UI 中显示的错误消息 */}
      {error && <Box marginTop={1}>
          <Text color="error">
            {figures.cross} {error}
          </Text>
        </Box>}

      <PluginSelectionKeyHint hasSelection={selectedForInstall.size > 0} />
    </Box>;
}