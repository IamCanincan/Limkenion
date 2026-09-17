import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Byline } from '../../components/design-system/Byline.js';
import { SearchBox } from '../../components/SearchBox.js';
import { useSearchInput } from '../../hooks/useSearchInput.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- useInput needed for raw search mode text input
import { Box, Text, useInput, useTerminalFocus } from '../../ink.js';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import type { LoadedPlugin } from '../../types/plugin.js';
import { count } from '../../utils/array.js';
import { openBrowser } from '../../utils/browser.js';
import { logForDebugging } from '../../utils/debug.js';
import { errorMessage } from '../../utils/errors.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { formatInstallCount, getInstallCounts } from '../../utils/plugins/installCounts.js';
import { isPluginGloballyInstalled } from '../../utils/plugins/installedPluginsManager.js';
import { createPluginId, detectEmptyMarketplaceReason, type EmptyMarketplaceReason, formatFailureDetails, formatMarketplaceLoadingErrors, loadMarketplacesWithGracefulDegradation } from '../../utils/plugins/marketplaceHelpers.js';
import { loadKnownMarketplacesConfig } from '../../utils/plugins/marketplaceManager.js';
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js';
import { installPluginFromMarketplace } from '../../utils/plugins/pluginInstallationHelpers.js';
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js';
import { plural } from '../../utils/stringUtils.js';
import { truncateToWidth } from '../../utils/truncate.js';
import { findPluginOptionsTarget, PluginOptionsFlow } from './PluginOptionsFlow.js';
import { PluginTrustWarning } from './PluginTrustWarning.js';
import { buildPluginDetailsMenuOptions, extractGitHubRepo, type InstallablePlugin } from './pluginDetailsHelpers.js';
import type { ViewState as ParentViewState } from './types.js';
import { usePagination } from './usePagination.js';
type Props = {
  error: string | null;
  setError: (error: string | null) => void;
  result: string | null;
  setResult: (result: string | null) => void;
  setViewState: (state: ParentViewState) => void;
  onInstallComplete?: () => void | Promise<void>;
  onSearchModeChange?: (isActive: boolean) => void;
  targetPlugin?: string;
};
type ViewState = 'plugin-list' | 'plugin-details' | {
  type: 'plugin-options';
  plugin: LoadedPlugin;
  pluginId: string;
};
export function DiscoverPlugins({
  error,
  setError,
  result: _result,
  setResult,
  setViewState: setParentViewState,
  onInstallComplete,
  onSearchModeChange,
  targetPlugin
}: Props): React.ReactNode {
  // 视图状态
  const [viewState, setViewState] = useState<ViewState>('plugin-list');
  const [selectedPlugin, setSelectedPlugin] = useState<InstallablePlugin | null>(null);

  // 数据状态
  const [availablePlugins, setAvailablePlugins] = useState<InstallablePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [installCounts, setInstallCounts] = useState<Map<string, number> | null>(null);

  // 搜索状态
  const [isSearchMode, setIsSearchModeRaw] = useState(false);
  const setIsSearchMode = useCallback((active: boolean) => {
    setIsSearchModeRaw(active);
    onSearchModeChange?.(active);
  }, [onSearchModeChange]);
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset
  } = useSearchInput({
    isActive: viewState === 'plugin-list' && isSearchMode && !loading,
    onExit: () => {
      setIsSearchMode(false);
    }
  });
  const isTerminalFocused = useTerminalFocus();
  const {
    columns: terminalWidth
  } = useTerminalSize();

  // 根据搜索词过滤插件
  const filteredPlugins = useMemo(() => {
    if (!searchQuery) return availablePlugins;
    const lowerQuery = searchQuery.toLowerCase();
    return availablePlugins.filter(plugin => plugin.entry.name.toLowerCase().includes(lowerQuery) || plugin.entry.description?.toLowerCase().includes(lowerQuery) || plugin.marketplaceName.toLowerCase().includes(lowerQuery));
  }, [availablePlugins, searchQuery]);

  // 选中状态
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedForInstall, setSelectedForInstall] = useState<Set<string>>(new Set());
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());

  // 插件列表分页（连续滚动）
  const pagination = usePagination<InstallablePlugin>({
    totalItems: filteredPlugins.length,
    selectedIndex
  });

  // 搜索词变化时重置选中项
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  // 详情视图状态
  const [detailsMenuIndex, setDetailsMenuIndex] = useState(0);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // 非致命错误的警告状态
  const [warning, setWarning] = useState<string | null>(null);

  // 空状态原因
  const [emptyReason, setEmptyReason] = useState<EmptyMarketplaceReason | null>(null);

  // 从所有市场加载全部插件
  useEffect(() => {
    async function loadAllPlugins() {
      try {
        const config = await loadKnownMarketplacesConfig();

        // 以优雅降级的方式加载各市场
        const {
          marketplaces,
          failures
        } = await loadMarketplacesWithGracefulDegradation(config);

        // 从所有市场收集全部插件
        const allPlugins: InstallablePlugin[] = [];
        for (const {
          name,
          data: marketplace
        } of marketplaces) {
          if (marketplace) {
            for (const entry of marketplace.plugins) {
              const pluginId = createPluginId(entry.name, name);
              allPlugins.push({
                entry,
                marketplaceName: name,
                pluginId,
                // 仅在全局安装（user/managed 作用域）时才阻止。
                // project/local 作用域的安装不会阻止 —— 用户可能想
                // 提升为 user 作用域，使其在各处都可用（gh-29997）。
                isInstalled: isPluginGloballyInstalled(pluginId)
              });
            }
          }
        }

        // 过滤掉已安装及被策略阻止的插件
        const uninstalledPlugins = allPlugins.filter(p => !p.isInstalled && !isPluginBlockedByPolicy(p.pluginId));

        // 获取安装次数并按热度排序
        try {
          const counts = await getInstallCounts();
          setInstallCounts(counts);
          if (counts) {
            // 按安装次数降序排序，次数相同则按字母序
            uninstalledPlugins.sort((a_0, b_0) => {
              const countA = counts.get(a_0.pluginId) ?? 0;
              const countB = counts.get(b_0.pluginId) ?? 0;
              if (countA !== countB) return countB - countA;
              return a_0.entry.name.localeCompare(b_0.entry.name);
            });
          } else {
            // 无次数数据 —— 按字母序排序
            uninstalledPlugins.sort((a_1, b_1) => a_1.entry.name.localeCompare(b_1.entry.name));
          }
        } catch (error_0) {
          // 记录错误，然后优雅降级为字母序排序
          logForDebugging(`Failed to fetch install counts: ${errorMessage(error_0)}`);
          uninstalledPlugins.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
        }
        setAvailablePlugins(uninstalledPlugins);

        // 若无可用插件则判定空状态原因
        const configuredCount = Object.keys(config).length;
        if (uninstalledPlugins.length === 0) {
          const reason = await detectEmptyMarketplaceReason({
            configuredMarketplaceCount: configuredCount,
            failedMarketplaceCount: failures.length
          });
          setEmptyReason(reason);
        }

        // 处理市场加载错误/警告
        const successCount = count(marketplaces, m => m.data !== null);
        const errorResult = formatMarketplaceLoadingErrors(failures, successCount);
        if (errorResult) {
          if (errorResult.type === 'warning') {
            setWarning(errorResult.message + '. Showing available plugins.');
          } else {
            throw new Error(errorResult.message);
          }
        }

        // 处理 targetPlugin —— 直接导航到插件详情
        // 在 allPlugins 中搜索（过滤之前），以便优雅处理已安装的插件
        if (targetPlugin) {
          const foundPlugin = allPlugins.find(p_0 => p_0.entry.name === targetPlugin);
          if (foundPlugin) {
            if (foundPlugin.isInstalled) {
              setError(`Plugin '${foundPlugin.pluginId}' is already installed. Use '/plugin' to manage existing plugins.`);
            } else {
              setSelectedPlugin(foundPlugin);
              setViewState('plugin-details');
            }
          } else {
            setError(`Plugin "${targetPlugin}" not found in any marketplace`);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load plugins');
      } finally {
        setLoading(false);
      }
    }
    void loadAllPlugins();
  }, [setError, targetPlugin]);

  // 安装所选插件
  const installSelectedPlugins = async () => {
    if (selectedForInstall.size === 0) return;
    const pluginsToInstall = availablePlugins.filter(p_1 => selectedForInstall.has(p_1.pluginId));
    setInstallingPlugins(new Set(pluginsToInstall.map(p_2 => p_2.pluginId)));
    let successCount_0 = 0;
    let failureCount = 0;
    const newFailedPlugins: Array<{
      name: string;
      reason: string;
    }> = [];
    for (const plugin_0 of pluginsToInstall) {
      const result = await installPluginFromMarketplace({
        pluginId: plugin_0.pluginId,
        entry: plugin_0.entry,
        marketplaceName: plugin_0.marketplaceName,
        scope: 'user'
      });
      if (result.success) {
        successCount_0++;
      } else {
        failureCount++;
        newFailedPlugins.push({
          name: plugin_0.entry.name,
          reason: result.error
        });
      }
    }
    setInstallingPlugins(new Set());
    setSelectedForInstall(new Set());
    clearAllCaches();

    // 处理安装结果
    if (failureCount === 0) {
      const message = `✓ Installed ${successCount_0} ${plural(successCount_0, 'plugin')}. ` + `Run /reload-plugins to activate.`;
      setResult(message);
    } else if (successCount_0 === 0) {
      setError(`Failed to install: ${formatFailureDetails(newFailedPlugins, true)}`);
    } else {
      const message_0 = `✓ Installed ${successCount_0} of ${successCount_0 + failureCount} plugins. ` + `Failed: ${formatFailureDetails(newFailedPlugins, false)}. ` + `Run /reload-plugins to activate successfully installed plugins.`;
      setResult(message_0);
    }
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
  const handleSinglePluginInstall = async (plugin_1: InstallablePlugin, scope: 'user' | 'project' | 'local' = 'user') => {
    setIsInstalling(true);
    setInstallError(null);
    const result_0 = await installPluginFromMarketplace({
      pluginId: plugin_1.pluginId,
      entry: plugin_1.entry,
      marketplaceName: plugin_1.marketplaceName,
      scope
    });
    if (result_0.success) {
      const loaded = await findPluginOptionsTarget(plugin_1.pluginId);
      if (loaded) {
        setIsInstalling(false);
        setViewState({
          type: 'plugin-options',
          plugin: loaded,
          pluginId: plugin_1.pluginId
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

  // 在 plugin-details 视图中按 Escape —— 返回 plugin-list
  useKeybinding('confirm:no', () => {
    setViewState('plugin-list');
    setSelectedPlugin(null);
  }, {
    context: 'Confirmation',
    isActive: viewState === 'plugin-details'
  });

  // 在 plugin-list 视图中按 Escape（非搜索模式）—— 退出到上级菜单
  useKeybinding('confirm:no', () => {
    setParentViewState({
      type: 'menu'
    });
  }, {
    context: 'Confirmation',
    isActive: viewState === 'plugin-list' && !isSearchMode
  });

  // 处理进入搜索模式（非 Escape 键）
  useInput((input, _key) => {
    const keyIsNotCtrlOrMeta = !_key.ctrl && !_key.meta;
    if (!isSearchMode) {
      // 用 '/' 或任意可打印字符进入搜索模式
      if (input === '/' && keyIsNotCtrlOrMeta) {
        setIsSearchMode(true);
        setSearchQuery('');
      } else if (keyIsNotCtrlOrMeta && input.length > 0 && !/^\s+$/.test(input) &&
      // 导航键不进入搜索模式
      input !== 'j' && input !== 'k' && input !== 'i') {
        setIsSearchMode(true);
        setSearchQuery(input);
      }
    }
  }, {
    isActive: viewState === 'plugin-list' && !loading
  });

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
      if (selectedIndex < filteredPlugins.length - 1) {
        pagination.handleSelectionChange(selectedIndex + 1, setSelectedIndex);
      }
    },
    'select:accept': () => {
      if (selectedIndex === filteredPlugins.length && selectedForInstall.size > 0) {
        void installSelectedPlugins();
      } else if (selectedIndex < filteredPlugins.length) {
        const plugin_2 = filteredPlugins[selectedIndex];
        if (plugin_2) {
          if (plugin_2.isInstalled) {
            setParentViewState({
              type: 'manage-plugins',
              targetPlugin: plugin_2.entry.name,
              targetMarketplace: plugin_2.marketplaceName
            });
          } else {
            setSelectedPlugin(plugin_2);
            setViewState('plugin-details');
            setDetailsMenuIndex(0);
            setInstallError(null);
          }
        }
      }
    }
  }, {
    context: 'Select',
    isActive: viewState === 'plugin-list' && !isSearchMode
  });
  useKeybindings({
    'plugin:toggle': () => {
      if (selectedIndex < filteredPlugins.length) {
        const plugin_3 = filteredPlugins[selectedIndex];
        if (plugin_3 && !plugin_3.isInstalled) {
          const newSelection = new Set(selectedForInstall);
          if (newSelection.has(plugin_3.pluginId)) {
            newSelection.delete(plugin_3.pluginId);
          } else {
            newSelection.add(plugin_3.pluginId);
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
    isActive: viewState === 'plugin-list' && !isSearchMode
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
      plugin: plugin_4,
      pluginId: pluginId_0
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
    return <PluginOptionsFlow plugin={plugin_4} pluginId={pluginId_0} onDone={(outcome, detail) => {
      switch (outcome) {
        case 'configured':
          finish(`✓ Installed and configured ${plugin_4.name}. Run /reload-plugins to apply.`);
          break;
        case 'skipped':
          finish(`✓ Installed ${plugin_4.name}. Run /reload-plugins to apply.`);
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

  // 插件详情视图
  if (viewState === 'plugin-details' && selectedPlugin) {
    const hasHomepage_1 = selectedPlugin.entry.homepage;
    const githubRepo_1 = extractGitHubRepo(selectedPlugin);
    const menuOptions = buildPluginDetailsMenuOptions(hasHomepage_1, githubRepo_1);
    return <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Plugin details</Text>
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{selectedPlugin.entry.name}</Text>
          <Text dimColor>from {selectedPlugin.marketplaceName}</Text>
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

        <PluginTrustWarning />

        {installError && <Box marginBottom={1}>
            <Text color="error">Error: {installError}</Text>
          </Box>}

        <Box flexDirection="column">
          {menuOptions.map((option, index) => <Box key={option.action}>
              {detailsMenuIndex === index && <Text>{'> '}</Text>}
              {detailsMenuIndex !== index && <Text>{'  '}</Text>}
              <Text bold={detailsMenuIndex === index}>
                {isInstalling && option.action.startsWith('install-') ? 'Installing…' : option.label}
              </Text>
            </Box>)}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            <Byline>
              <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="select" />
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
            </Byline>
          </Text>
        </Box>
      </Box>;
  }

  // 空状态
  if (availablePlugins.length === 0) {
    return <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Discover plugins</Text>
        </Box>
        <EmptyStateMessage reason={emptyReason} />
        <Box marginTop={1}>
          <Text dimColor italic>
            Esc to go back
          </Text>
        </Box>
      </Box>;
  }

  // 从分页中获取可见的插件
  const visiblePlugins = pagination.getVisibleItems(filteredPlugins);
  return <Box flexDirection="column">
      <Box>
        <Text bold>Discover plugins</Text>
        {pagination.needsPagination && <Text dimColor>
            {' '}
            ({pagination.scrollPosition.current}/
            {pagination.scrollPosition.total})
          </Text>}
      </Box>

      {/* 搜索框 */}
      <Box marginBottom={1}>
        <SearchBox query={searchQuery} isFocused={isSearchMode} isTerminalFocused={isTerminalFocused} width={terminalWidth - 4} cursorOffset={searchCursorOffset} />
      </Box>

      {/* 警告横幅 */}
      {warning && <Box marginBottom={1}>
          <Text color="warning">
            {figures.warning} {warning}
          </Text>
        </Box>}

      {/* 无搜索结果 */}
      {filteredPlugins.length === 0 && searchQuery && <Box marginBottom={1}>
          <Text dimColor>No plugins match &quot;{searchQuery}&quot;</Text>
        </Box>}

      {/* 向上滚动指示器 */}
      {pagination.scrollPosition.canScrollUp && <Box>
          <Text dimColor> {figures.arrowUp} more above</Text>
        </Box>}

      {/* 插件列表 —— 在 key 中使用 startIndex 以在滚动时强制重新渲染 */}
      {visiblePlugins.map((plugin_5, visibleIndex) => {
      const actualIndex = pagination.toActualIndex(visibleIndex);
      const isSelected = selectedIndex === actualIndex;
      const isSelectedForInstall = selectedForInstall.has(plugin_5.pluginId);
      const isInstallingThis = installingPlugins.has(plugin_5.pluginId);
      const isLast = visibleIndex === visiblePlugins.length - 1;
      return <Box key={`${pagination.startIndex}-${plugin_5.pluginId}`} flexDirection="column" marginBottom={isLast && !error ? 0 : 1}>
            <Box>
              <Text color={isSelected && !isSearchMode ? 'suggestion' : undefined}>
                {isSelected && !isSearchMode ? figures.pointer : ' '}{' '}
              </Text>
              <Text>
                {isInstallingThis ? figures.ellipsis : isSelectedForInstall ? figures.radioOn : figures.radioOff}{' '}
                {plugin_5.entry.name}
                <Text dimColor> · {plugin_5.marketplaceName}</Text>
                {plugin_5.entry.tags?.includes('community-managed') && <Text dimColor> [Community Managed]</Text>}
                {installCounts && plugin_5.marketplaceName === OFFICIAL_MARKETPLACE_NAME && <Text dimColor>
                      {' · '}
                      {formatInstallCount(installCounts.get(plugin_5.pluginId) ?? 0)}{' '}
                      installs
                    </Text>}
              </Text>
            </Box>
            {plugin_5.entry.description && <Box marginLeft={4}>
                <Text dimColor>
                  {truncateToWidth(plugin_5.entry.description, 60)}
                </Text>
              </Box>}
          </Box>;
    })}

      {/* 向下滚动指示器 */}
      {pagination.scrollPosition.canScrollDown && <Box>
          <Text dimColor> {figures.arrowDown} more below</Text>
        </Box>}

      {/* 错误消息 */}
      {error && <Box marginTop={1}>
          <Text color="error">
            {figures.cross} {error}
          </Text>
        </Box>}

      <DiscoverPluginsKeyHint hasSelection={selectedForInstall.size > 0} canToggle={selectedIndex < filteredPlugins.length && !filteredPlugins[selectedIndex]?.isInstalled} />
    </Box>;
}
function DiscoverPluginsKeyHint(t0) {
  const $ = _c(10);
  const {
    hasSelection,
    canToggle
  } = t0;
  let t1;
  if ($[0] !== hasSelection) {
    t1 = hasSelection && <ConfigurableShortcutHint action="plugin:install" context="Plugin" fallback="i" description="install" bold={true} />;
    $[0] = hasSelection;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Text>type to search</Text>;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== canToggle) {
    t3 = canToggle && <ConfigurableShortcutHint action="plugin:toggle" context="Plugin" fallback="Space" description="toggle" />;
    $[3] = canToggle;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  let t5;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="details" />;
    t5 = <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />;
    $[5] = t4;
    $[6] = t5;
  } else {
    t4 = $[5];
    t5 = $[6];
  }
  let t6;
  if ($[7] !== t1 || $[8] !== t3) {
    t6 = <Box marginTop={1}><Text dimColor={true} italic={true}><Byline>{t1}{t2}{t3}{t4}{t5}</Byline></Text></Box>;
    $[7] = t1;
    $[8] = t3;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  return t6;
}

/**
 * Discover 屏幕的上下文感知空状态提示
 */
function EmptyStateMessage(t0) {
  const $ = _c(6);
  const {
    reason
  } = t0;
  switch (reason) {
    case "git-not-installed":
      {
        let t1;
        if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <><Text dimColor={true}>Git is required to install marketplaces.</Text><Text dimColor={true}>Please install git and restart Limkenion.</Text></>;
          $[0] = t1;
        } else {
          t1 = $[0];
        }
        return t1;
      }
    case "all-blocked-by-policy":
      {
        let t1;
        if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <><Text dimColor={true}>Your organization policy does not allow any external marketplaces.</Text><Text dimColor={true}>Contact your administrator.</Text></>;
          $[1] = t1;
        } else {
          t1 = $[1];
        }
        return t1;
      }
    case "policy-restricts-sources":
      {
        let t1;
        if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <><Text dimColor={true}>Your organization restricts which marketplaces can be added.</Text><Text dimColor={true}>Switch to the Marketplaces tab to view allowed sources.</Text></>;
          $[2] = t1;
        } else {
          t1 = $[2];
        }
        return t1;
      }
    case "all-marketplaces-failed":
      {
        let t1;
        if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <><Text dimColor={true}>Failed to load marketplace data.</Text><Text dimColor={true}>Check your network connection.</Text></>;
          $[3] = t1;
        } else {
          t1 = $[3];
        }
        return t1;
      }
    case "all-plugins-installed":
      {
        let t1;
        if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <><Text dimColor={true}>All available plugins are already installed.</Text><Text dimColor={true}>Check for new plugins later or add more marketplaces.</Text></>;
          $[4] = t1;
        } else {
          t1 = $[4];
        }
        return t1;
      }
    case "no-marketplaces-configured":
    default:
      {
        let t1;
        if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <><Text dimColor={true}>No plugins available.</Text><Text dimColor={true}>Add a marketplace first using the Marketplaces tab.</Text></>;
          $[5] = t1;
        } else {
          t1 = $[5];
        }
        return t1;
      }
  }
}