import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Byline } from '../../components/design-system/Byline.js';
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- useInput needed for marketplace-specific u/r shortcuts and y/n confirmation not in keybinding schema
import { Box, Text, useInput } from '../../ink.js';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import type { LoadedPlugin } from '../../types/plugin.js';
import { count } from '../../utils/array.js';
import { shouldSkipPluginAutoupdate } from '../../utils/config.js';
import { errorMessage } from '../../utils/errors.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { createPluginId, formatMarketplaceLoadingErrors, getMarketplaceSourceDisplay, loadMarketplacesWithGracefulDegradation } from '../../utils/plugins/marketplaceHelpers.js';
import { loadKnownMarketplacesConfig, refreshMarketplace, removeMarketplaceSource, setMarketplaceAutoUpdate } from '../../utils/plugins/marketplaceManager.js';
import { updatePluginsForMarketplaces } from '../../utils/plugins/pluginAutoupdate.js';
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js';
import { isMarketplaceAutoUpdate } from '../../utils/plugins/schemas.js';
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { plural } from '../../utils/stringUtils.js';
import type { ViewState } from './types.js';
type Props = {
  setViewState: (state: ViewState) => void;
  error?: string | null;
  setError?: (error: string | null) => void;
  setResult: (result: string | null) => void;
  exitState: {
    pending: boolean;
    keyName: 'Ctrl-C' | 'Ctrl-D' | null;
  };
  onManageComplete?: () => void | Promise<void>;
  targetMarketplace?: string;
  action?: 'update' | 'remove';
};
type MarketplaceState = {
  name: string;
  source: string;
  lastUpdated?: string;
  pluginCount?: number;
  installedPlugins?: LoadedPlugin[];
  pendingUpdate?: boolean;
  pendingRemove?: boolean;
  autoUpdate?: boolean;
};
type InternalViewState = 'list' | 'details' | 'confirm-remove';
export function ManageMarketplaces({
  setViewState,
  error,
  setError,
  setResult,
  exitState,
  onManageComplete,
  targetMarketplace,
  action
}: Props): React.ReactNode {
  const [marketplaceStates, setMarketplaceStates] = useState<MarketplaceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [internalView, setInternalView] = useState<InternalViewState>('list');
  const [selectedMarketplace, setSelectedMarketplace] = useState<MarketplaceState | null>(null);
  const [detailsMenuIndex, setDetailsMenuIndex] = useState(0);
  const hasAttemptedAutoAction = useRef(false);

  // 加载各市场及其已安装的插件
  useEffect(() => {
    async function loadMarketplaces() {
      try {
        const config = await loadKnownMarketplacesConfig();
        const {
          enabled,
          disabled
        } = await loadAllPlugins();
        const allPlugins = [...enabled, ...disabled];

        // 以优雅降级的方式加载各市场
        const {
          marketplaces,
          failures
        } = await loadMarketplacesWithGracefulDegradation(config);
        const states: MarketplaceState[] = [];
        for (const {
          name,
          config: entry,
          data: marketplace
        } of marketplaces) {
          // 获取从该市场安装的所有插件
          const installedFromMarketplace = allPlugins.filter(plugin => plugin.source.endsWith(`@${name}`));
          states.push({
            name,
            source: getMarketplaceSourceDisplay(entry.source),
            lastUpdated: entry.lastUpdated,
            pluginCount: marketplace?.plugins.length,
            installedPlugins: installedFromMarketplace,
            pendingUpdate: false,
            pendingRemove: false,
            autoUpdate: isMarketplaceAutoUpdate(name, entry)
          });
        }

        // 排序：limkenion-plugin-directory 优先，其余按字母序
        states.sort((a, b) => {
          if (a.name === 'limkenion-plugin-directory') return -1;
          if (b.name === 'limkenion-plugin-directory') return 1;
          return a.name.localeCompare(b.name);
        });
        setMarketplaceStates(states);

        // 处理市场加载错误/警告
        const successCount = count(marketplaces, m => m.data !== null);
        const errorResult = formatMarketplaceLoadingErrors(failures, successCount);
        if (errorResult) {
          if (errorResult.type === 'warning') {
            setProcessError(errorResult.message);
          } else {
            throw new Error(errorResult.message);
          }
        }

        // 若提供了 target 和 action 则自动执行
        if (targetMarketplace && !hasAttemptedAutoAction.current && !error) {
          hasAttemptedAutoAction.current = true;
          const targetIndex = states.findIndex(s => s.name === targetMarketplace);
          if (targetIndex >= 0) {
            const targetState = states[targetIndex];
            if (action) {
              // 将操作标记为待处理并执行
              setSelectedIndex(targetIndex + 1); // +1 是因为 “Add Marketplace” 位于索引 0
              const newStates = [...states];
              if (action === 'update') {
                newStates[targetIndex]!.pendingUpdate = true;
              } else if (action === 'remove') {
                newStates[targetIndex]!.pendingRemove = true;
              }
              setMarketplaceStates(newStates);
              // 立即应用变更
              setTimeout(applyChanges, 100, newStates);
            } else if (targetState) {
              // 无操作 —— 仅显示该市场的详情视图
              setSelectedIndex(targetIndex + 1); // +1 是因为 “Add Marketplace” 位于索引 0
              setSelectedMarketplace(targetState);
              setInternalView('details');
            }
          } else if (setError) {
            setError(`Marketplace not found: ${targetMarketplace}`);
          }
        }
      } catch (err) {
        if (setError) {
          setError(err instanceof Error ? err.message : 'Failed to load marketplaces');
        }
        setProcessError(err instanceof Error ? err.message : 'Failed to load marketplaces');
      } finally {
        setLoading(false);
      }
    }
    void loadMarketplaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, [targetMarketplace, action, error]);

  // 检查是否存在任何待处理的变更
  const hasPendingChanges = () => {
    return marketplaceStates.some(state => state.pendingUpdate || state.pendingRemove);
  };

  // 获取待处理操作的数量
  const getPendingCounts = () => {
    const updateCount = count(marketplaceStates, s => s.pendingUpdate);
    const removeCount = count(marketplaceStates, s => s.pendingRemove);
    return {
      updateCount,
      removeCount
    };
  };

  // 应用所有待处理的变更
  const applyChanges = async (states?: MarketplaceState[]) => {
    const statesToProcess = states || marketplaceStates;
    const wasInDetailsView = internalView === 'details';
    setIsProcessing(true);
    setProcessError(null);
    setSuccessMessage(null);
    setProgressMessage(null);
    try {
      const settings = getSettingsForSource('userSettings');
      let updatedCount = 0;
      let removedCount = 0;
      const refreshedMarketplaces = new Set<string>();
      for (const state of statesToProcess) {
        // 处理移除
        if (state.pendingRemove) {
          // 先卸载该市场中的所有插件
          if (state.installedPlugins && state.installedPlugins.length > 0) {
            const newEnabledPlugins = {
              ...settings?.enabledPlugins
            };
            for (const plugin of state.installedPlugins) {
              const pluginId = createPluginId(plugin.name, state.name);
              // 标记为已禁用/已卸载
              newEnabledPlugins[pluginId] = false;
            }
            updateSettingsForSource('userSettings', {
              enabledPlugins: newEnabledPlugins
            });
          }

          // 然后移除该市场
          await removeMarketplaceSource(state.name);
          removedCount++;
          logEvent('limkenion_marketplace_removed', {
            marketplace_name: state.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            plugins_uninstalled: state.installedPlugins?.length || 0
          });
          continue;
        }

        // 处理更新
        if (state.pendingUpdate) {
          // 逐个刷新市场以提高效率并报告进度
          await refreshMarketplace(state.name, (message: string) => {
            setProgressMessage(message);
          });
          updatedCount++;
          refreshedMarketplaces.add(state.name.toLowerCase());
          logEvent('limkenion_marketplace_updated', {
            marketplace_name: state.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
        }
      }

      // 市场克隆刷新后，将这些市场中已安装的插件
      // 提升到新版本。否则加载器的
      // 未命中缓存逻辑（copyPluginToVersionedCache）会在下次
      // loadAllPlugins() 调用时创建新版本目录，但 installed_plugins.json
      // 仍停留在旧版本 —— 于是 cleanupOrphanedPluginVersionsInBackground
      // 会在下次启动时给新目录打上 .orphaned_at。见 #29512。
      // 真正写入 installed_plugins.json 的是 updatePluginOp
      // （在该辅助函数内部调用），它经由 updateInstallationPathOnDisk 完成。
      let updatedPluginCount = 0;
      if (refreshedMarketplaces.size > 0) {
        const updatedPluginIds = await updatePluginsForMarketplaces(refreshedMarketplaces);
        updatedPluginCount = updatedPluginIds.length;
      }

      // 变更后清理缓存
      clearAllCaches();

      // 调用完成回调
      if (onManageComplete) {
        await onManageComplete();
      }

      // 重新加载市场数据以显示更新的时间戳
      const config = await loadKnownMarketplacesConfig();
      const {
        enabled,
        disabled
      } = await loadAllPlugins();
      const allPlugins = [...enabled, ...disabled];
      const {
        marketplaces
      } = await loadMarketplacesWithGracefulDegradation(config);
      const newStates: MarketplaceState[] = [];
      for (const {
        name,
        config: entry,
        data: marketplace
      } of marketplaces) {
        const installedFromMarketplace = allPlugins.filter(plugin => plugin.source.endsWith(`@${name}`));
        newStates.push({
          name,
          source: getMarketplaceSourceDisplay(entry.source),
          lastUpdated: entry.lastUpdated,
          pluginCount: marketplace?.plugins.length,
          installedPlugins: installedFromMarketplace,
          pendingUpdate: false,
          pendingRemove: false,
          autoUpdate: isMarketplaceAutoUpdate(name, entry)
        });
      }

      // 排序：limkenion-plugin-directory 优先，其余按字母序
      newStates.sort((a, b) => {
        if (a.name === 'limkenion-plugin-directory') return -1;
        if (b.name === 'limkenion-plugin-directory') return 1;
        return a.name.localeCompare(b.name);
      });
      setMarketplaceStates(newStates);

      // 用新数据更新所选市场的引用
      if (wasInDetailsView && selectedMarketplace) {
        const updatedMarketplace = newStates.find(s => s.name === selectedMarketplace.name);
        if (updatedMarketplace) {
          setSelectedMarketplace(updatedMarketplace);
        }
      }

      // 构建成功消息
      const actions: string[] = [];
      if (updatedCount > 0) {
        const pluginPart = updatedPluginCount > 0 ? ` (${updatedPluginCount} ${plural(updatedPluginCount, 'plugin')} bumped)` : '';
        actions.push(`Updated ${updatedCount} ${plural(updatedCount, 'marketplace')}${pluginPart}`);
      }
      if (removedCount > 0) {
        actions.push(`Removed ${removedCount} ${plural(removedCount, 'marketplace')}`);
      }
      if (actions.length > 0) {
        const successMsg = `${figures.tick} ${actions.join(', ')}`;
        // 若此前处于详情视图，则留在那里并显示成功
        if (wasInDetailsView) {
          setSuccessMessage(successMsg);
        } else {
          // 否则显示结果并退出到菜单
          setResult(successMsg);
          setTimeout(setViewState, 2000, {
            type: 'menu' as const
          });
        }
      } else if (!wasInDetailsView) {
        setViewState({
          type: 'menu'
        });
      }
    } catch (err) {
      const errorMsg = errorMessage(err);
      setProcessError(errorMsg);
      if (setError) {
        setError(errorMsg);
      }
    } finally {
      setIsProcessing(false);
      setProgressMessage(null);
    }
  };

  // 处理确认移除市场
  const confirmRemove = async () => {
    if (!selectedMarketplace) return;

    // 标记为待移除并应用
    const newStates = marketplaceStates.map(state => state.name === selectedMarketplace.name ? {
      ...state,
      pendingRemove: true
    } : state);
    setMarketplaceStates(newStates);
    await applyChanges(newStates);
  };

  // 为详情视图构建菜单选项
  const buildDetailsMenuOptions = (marketplace: MarketplaceState | null): Array<{
    label: string;
    secondaryLabel?: string;
    value: string;
  }> => {
    if (!marketplace) return [];
    const options: Array<{
      label: string;
      secondaryLabel?: string;
      value: string;
    }> = [{
      label: `Browse plugins (${marketplace.pluginCount ?? 0})`,
      value: 'browse'
    }, {
      label: 'Update marketplace',
      secondaryLabel: marketplace.lastUpdated ? `(last updated ${new Date(marketplace.lastUpdated).toLocaleDateString()})` : undefined,
      value: 'update'
    }];

    // 仅当自动更新器未被全局禁用时才显示自动更新开关
    if (!shouldSkipPluginAutoupdate()) {
      options.push({
        label: marketplace.autoUpdate ? 'Disable auto-update' : 'Enable auto-update',
        value: 'toggle-auto-update'
      });
    }
    options.push({
      label: 'Remove marketplace',
      value: 'remove'
    });
    return options;
  };

  // 处理切换某个市场的自动更新
  const handleToggleAutoUpdate = async (marketplace: MarketplaceState) => {
    const newAutoUpdate = !marketplace.autoUpdate;
    try {
      await setMarketplaceAutoUpdate(marketplace.name, newAutoUpdate);

      // 更新本地状态
      setMarketplaceStates(prev => prev.map(state => state.name === marketplace.name ? {
        ...state,
        autoUpdate: newAutoUpdate
      } : state));

      // 更新所选市场的引用
      setSelectedMarketplace(prev => prev ? {
        ...prev,
        autoUpdate: newAutoUpdate
      } : prev);
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : 'Failed to update setting');
    }
  };

  // 在详情或 confirm-remove 视图中按 Escape —— 返回列表
  useKeybinding('confirm:no', () => {
    setInternalView('list');
    setDetailsMenuIndex(0);
  }, {
    context: 'Confirmation',
    isActive: !isProcessing && (internalView === 'details' || internalView === 'confirm-remove')
  });

  // 在列表视图中按 Escape 且存在待处理变更 —— 清除待处理变更
  useKeybinding('confirm:no', () => {
    setMarketplaceStates(prev => prev.map(state => ({
      ...state,
      pendingUpdate: false,
      pendingRemove: false
    })));
    setSelectedIndex(0);
  }, {
    context: 'Confirmation',
    isActive: !isProcessing && internalView === 'list' && hasPendingChanges()
  });

  // 在列表视图中按 Escape 且无待处理变更 —— 退出到上级菜单
  useKeybinding('confirm:no', () => {
    setViewState({
      type: 'menu'
    });
  }, {
    context: 'Confirmation',
    isActive: !isProcessing && internalView === 'list' && !hasPendingChanges()
  });

  // 列表视图 —— 导航（上/下/回车，经由可配置的按键绑定）
  useKeybindings({
    'select:previous': () => setSelectedIndex(prev => Math.max(0, prev - 1)),
    'select:next': () => {
      const totalItems = marketplaceStates.length + 1;
      setSelectedIndex(prev => Math.min(totalItems - 1, prev + 1));
    },
    'select:accept': () => {
      const marketplaceIndex = selectedIndex - 1;
      if (selectedIndex === 0) {
        setViewState({
          type: 'add-marketplace'
        });
      } else if (hasPendingChanges()) {
        void applyChanges();
      } else {
        const marketplace = marketplaceStates[marketplaceIndex];
        if (marketplace) {
          setSelectedMarketplace(marketplace);
          setInternalView('details');
          setDetailsMenuIndex(0);
        }
      }
    }
  }, {
    context: 'Select',
    isActive: !isProcessing && internalView === 'list'
  });

  // 列表视图 —— 市场专属操作（u/r 快捷键）
  useInput(input => {
    const marketplaceIndex = selectedIndex - 1;
    if ((input === 'u' || input === 'U') && marketplaceIndex >= 0) {
      setMarketplaceStates(prev => prev.map((state, idx) => idx === marketplaceIndex ? {
        ...state,
        pendingUpdate: !state.pendingUpdate,
        pendingRemove: state.pendingUpdate ? state.pendingRemove : false
      } : state));
    } else if ((input === 'r' || input === 'R') && marketplaceIndex >= 0) {
      const marketplace = marketplaceStates[marketplaceIndex];
      if (marketplace) {
        setSelectedMarketplace(marketplace);
        setInternalView('confirm-remove');
      }
    }
  }, {
    isActive: !isProcessing && internalView === 'list'
  });

  // 详情视图 —— 导航
  useKeybindings({
    'select:previous': () => setDetailsMenuIndex(prev => Math.max(0, prev - 1)),
    'select:next': () => {
      const menuOptions = buildDetailsMenuOptions(selectedMarketplace);
      setDetailsMenuIndex(prev => Math.min(menuOptions.length - 1, prev + 1));
    },
    'select:accept': () => {
      if (!selectedMarketplace) return;
      const menuOptions = buildDetailsMenuOptions(selectedMarketplace);
      const selectedOption = menuOptions[detailsMenuIndex];
      if (selectedOption?.value === 'browse') {
        setViewState({
          type: 'browse-marketplace',
          targetMarketplace: selectedMarketplace.name
        });
      } else if (selectedOption?.value === 'update') {
        const newStates = marketplaceStates.map(state => state.name === selectedMarketplace.name ? {
          ...state,
          pendingUpdate: true
        } : state);
        setMarketplaceStates(newStates);
        void applyChanges(newStates);
      } else if (selectedOption?.value === 'toggle-auto-update') {
        void handleToggleAutoUpdate(selectedMarketplace);
      } else if (selectedOption?.value === 'remove') {
        setInternalView('confirm-remove');
      }
    }
  }, {
    context: 'Select',
    isActive: !isProcessing && internalView === 'details'
  });

  // confirm-remove 视图 —— y/n 输入
  useInput(input => {
    if (input === 'y' || input === 'Y') {
      void confirmRemove();
    } else if (input === 'n' || input === 'N') {
      setInternalView('list');
      setSelectedMarketplace(null);
    }
  }, {
    isActive: !isProcessing && internalView === 'confirm-remove'
  });
  if (loading) {
    return <Text>Loading marketplaces…</Text>;
  }
  if (marketplaceStates.length === 0) {
    return <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Manage marketplaces</Text>
        </Box>

        {/* Add Marketplace 选项 */}
        <Box flexDirection="row" gap={1}>
          <Text color="suggestion">{figures.pointer} +</Text>
          <Text bold color="suggestion">
            Add Marketplace
          </Text>
        </Box>

        <Box marginLeft={3}>
          <Text dimColor italic>
            {exitState.pending ? <>Press {exitState.keyName} again to go back</> : <Byline>
                <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="select" />
                <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
              </Byline>}
          </Text>
        </Box>
      </Box>;
  }

  // 显示确认对话框
  if (internalView === 'confirm-remove' && selectedMarketplace) {
    const pluginCount = selectedMarketplace.installedPlugins?.length || 0;
    return <Box flexDirection="column">
        <Text bold color="warning">
          Remove marketplace <Text italic>{selectedMarketplace.name}</Text>?
        </Text>
        <Box flexDirection="column">
          {pluginCount > 0 && <Box marginTop={1}>
              <Text color="warning">
                This will also uninstall {pluginCount}{' '}
                {plural(pluginCount, 'plugin')} from this marketplace:
              </Text>
            </Box>}
          {selectedMarketplace.installedPlugins && selectedMarketplace.installedPlugins.length > 0 && <Box flexDirection="column" marginTop={1} marginLeft={2}>
                {selectedMarketplace.installedPlugins.map(plugin => <Text key={plugin.name} dimColor>
                    • {plugin.name}
                  </Text>)}
              </Box>}
          <Box marginTop={1}>
            <Text>
              Press <Text bold>y</Text> to confirm or <Text bold>n</Text> to
              cancel
            </Text>
          </Box>
        </Box>
      </Box>;
  }

  // 显示市场详情
  if (internalView === 'details' && selectedMarketplace) {
    // 检查该市场当前是否正在处理中
    // 先检查 pendingUpdate，以便用户按下 Enter 时立即显示更新中状态
    const isUpdating = selectedMarketplace.pendingUpdate || isProcessing;
    const menuOptions = buildDetailsMenuOptions(selectedMarketplace);
    return <Box flexDirection="column">
        <Text bold>{selectedMarketplace.name}</Text>
        <Text dimColor>{selectedMarketplace.source}</Text>
        <Box marginTop={1}>
          <Text>
            {selectedMarketplace.pluginCount || 0} available{' '}
            {plural(selectedMarketplace.pluginCount || 0, 'plugin')}
          </Text>
        </Box>

        {/* 已安装插件区块 */}
        {selectedMarketplace.installedPlugins && selectedMarketplace.installedPlugins.length > 0 && <Box flexDirection="column" marginTop={1}>
              <Text bold>
                Installed plugins ({selectedMarketplace.installedPlugins.length}
                ):
              </Text>
              <Box flexDirection="column" marginLeft={1}>
                {selectedMarketplace.installedPlugins.map(plugin => <Box key={plugin.name} flexDirection="row" gap={1}>
                    <Text>{figures.bullet}</Text>
                    <Box flexDirection="column">
                      <Text>{plugin.name}</Text>
                      <Text dimColor>{plugin.manifest.description}</Text>
                    </Box>
                  </Box>)}
              </Box>
            </Box>}

        {/* 处理中指示器 */}
        {isUpdating && <Box marginTop={1} flexDirection="column">
            <Text color="limkenion">Updating marketplace…</Text>
            {progressMessage && <Text dimColor>{progressMessage}</Text>}
          </Box>}

        {/* 成功消息 */}
        {!isUpdating && successMessage && <Box marginTop={1}>
            <Text color="limkenion">{successMessage}</Text>
          </Box>}

        {/* 错误消息 */}
        {!isUpdating && processError && <Box marginTop={1}>
            <Text color="error">{processError}</Text>
          </Box>}

        {/* 菜单选项 */}
        {!isUpdating && <Box flexDirection="column" marginTop={1}>
            {menuOptions.map((option, idx) => {
          if (!option) return null;
          const isSelected = idx === detailsMenuIndex;
          return <Box key={option.value}>
                  <Text color={isSelected ? 'suggestion' : undefined}>
                    {isSelected ? figures.pointer : ' '} {option.label}
                  </Text>
                  {option.secondaryLabel && <Text dimColor> {option.secondaryLabel}</Text>}
                </Box>;
        })}
          </Box>}

        {/* 启用自动更新时在底部显示说明文字 */}
        {!isUpdating && !shouldSkipPluginAutoupdate() && selectedMarketplace.autoUpdate && <Box marginTop={1}>
              <Text dimColor>
                Auto-update enabled. Limkenion will automatically update this
                marketplace and its installed plugins.
              </Text>
            </Box>}

        <Box marginLeft={3}>
          <Text dimColor italic>
            {isUpdating ? <>Please wait…</> : <Byline>
                <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="select" />
                <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
              </Byline>}
          </Text>
        </Box>
      </Box>;
  }

  // 显示市场列表
  const {
    updateCount,
    removeCount
  } = getPendingCounts();
  return <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Manage marketplaces</Text>
      </Box>

      {/* Add Marketplace 选项 */}
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Text color={selectedIndex === 0 ? 'suggestion' : undefined}>
          {selectedIndex === 0 ? figures.pointer : ' '} +
        </Text>
        <Text bold color={selectedIndex === 0 ? 'suggestion' : undefined}>
          Add Marketplace
        </Text>
      </Box>

      {/* 市场列表 */}
      <Box flexDirection="column">
        {marketplaceStates.map((state, idx) => {
        const isSelected = idx + 1 === selectedIndex; // +1 是因为 Add Marketplace 位于索引 0

        // 构建状态指示器
        const indicators: string[] = [];
        if (state.pendingUpdate) indicators.push('UPDATE');
        if (state.pendingRemove) indicators.push('REMOVE');
        return <Box key={state.name} flexDirection="row" gap={1} marginBottom={1}>
              <Text color={isSelected ? 'suggestion' : undefined}>
                {isSelected ? figures.pointer : ' '}{' '}
                {state.pendingRemove ? figures.cross : figures.bullet}
              </Text>
              <Box flexDirection="column" flexGrow={1}>
                <Box flexDirection="row" gap={1}>
                  <Text bold strikethrough={state.pendingRemove} dimColor={state.pendingRemove}>
                    {state.name === 'limkenion-plugins-official' && <Text color="limkenion">✻ </Text>}
                    {state.name}
                    {state.name === 'limkenion-plugins-official' && <Text color="limkenion"> ✻</Text>}
                  </Text>
                  {indicators.length > 0 && <Text color="warning">[{indicators.join(', ')}]</Text>}
                </Box>
                <Text dimColor>{state.source}</Text>
                <Text dimColor>
                  {state.pluginCount !== undefined && <>{state.pluginCount} available</>}
                  {state.installedPlugins && state.installedPlugins.length > 0 && <> • {state.installedPlugins.length} installed</>}
                  {state.lastUpdated && <>
                      {' '}
                      • Updated{' '}
                      {new Date(state.lastUpdated).toLocaleDateString()}
                    </>}
                </Text>
              </Box>
            </Box>;
      })}
      </Box>

      {/* 待处理变更摘要 */}
      {hasPendingChanges() && <Box marginTop={1} flexDirection="column">
          <Text>
            <Text bold>Pending changes:</Text>{' '}
            <Text dimColor>Enter to apply</Text>
          </Text>
          {updateCount > 0 && <Text>
              • Update {updateCount} {plural(updateCount, 'marketplace')}
            </Text>}
          {removeCount > 0 && <Text color="warning">
              • Remove {removeCount} {plural(removeCount, 'marketplace')}
            </Text>}
        </Box>}

      {/* 处理中指示器 */}
      {isProcessing && <Box marginTop={1}>
          <Text color="limkenion">Processing changes…</Text>
        </Box>}

      {/* 错误显示 */}
      {processError && <Box marginTop={1}>
          <Text color="error">{processError}</Text>
        </Box>}

      <ManageMarketplacesKeyHints exitState={exitState} hasPendingActions={hasPendingChanges()} />
    </Box>;
}
type ManageMarketplacesKeyHintsProps = {
  exitState: Props['exitState'];
  hasPendingActions: boolean;
};
function ManageMarketplacesKeyHints(t0) {
  const $ = _c(18);
  const {
    exitState,
    hasPendingActions
  } = t0;
  if (exitState.pending) {
    let t1;
    if ($[0] !== exitState.keyName) {
      t1 = <Box marginTop={1}><Text dimColor={true} italic={true}>Press {exitState.keyName} again to go back</Text></Box>;
      $[0] = exitState.keyName;
      $[1] = t1;
    } else {
      t1 = $[1];
    }
    return t1;
  }
  let t1;
  if ($[2] !== hasPendingActions) {
    t1 = hasPendingActions && <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="apply changes" />;
    $[2] = hasPendingActions;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  let t2;
  if ($[4] !== hasPendingActions) {
    t2 = !hasPendingActions && <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="select" />;
    $[4] = hasPendingActions;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  let t3;
  if ($[6] !== hasPendingActions) {
    t3 = !hasPendingActions && <KeyboardShortcutHint shortcut="u" action="update" />;
    $[6] = hasPendingActions;
    $[7] = t3;
  } else {
    t3 = $[7];
  }
  let t4;
  if ($[8] !== hasPendingActions) {
    t4 = !hasPendingActions && <KeyboardShortcutHint shortcut="r" action="remove" />;
    $[8] = hasPendingActions;
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  const t5 = hasPendingActions ? "cancel" : "go back";
  let t6;
  if ($[10] !== t5) {
    t6 = <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description={t5} />;
    $[10] = t5;
    $[11] = t6;
  } else {
    t6 = $[11];
  }
  let t7;
  if ($[12] !== t1 || $[13] !== t2 || $[14] !== t3 || $[15] !== t4 || $[16] !== t6) {
    t7 = <Box marginTop={1}><Text dimColor={true} italic={true}><Byline>{t1}{t2}{t3}{t4}{t6}</Byline></Text></Box>;
    $[12] = t1;
    $[13] = t2;
    $[14] = t3;
    $[15] = t4;
    $[16] = t6;
    $[17] = t7;
  } else {
    t7 = $[17];
  }
  return t7;
}