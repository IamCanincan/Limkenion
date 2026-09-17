/**
 * 安装后/启用后的配置提示词。
 *
 * 给定一个 LoadedPlugin，同时检查顶层 manifest.userConfig 和
 * 按通道划分的 userConfig。通过 PluginOptionsDialog 逐个走完
 * 未配置项，并用相应的存储函数保存。若没有需要填写的内容，
 * 则立即调用 onDone('skipped')。
 */

import * as React from 'react';
import type { LoadedPlugin } from '../../types/plugin.js';
import { errorMessage } from '../../utils/errors.js';
import { loadMcpServerUserConfig, saveMcpServerUserConfig } from '../../utils/plugins/mcpbHandler.js';
import { getUnconfiguredChannels, type UnconfiguredChannel } from '../../utils/plugins/mcpPluginIntegration.js';
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js';
import { getUnconfiguredOptions, loadPluginOptions, type PluginOptionSchema, type PluginOptionValues, savePluginOptions } from '../../utils/plugins/pluginOptionsStorage.js';
import { PluginOptionsDialog } from './PluginOptionsDialog.js';

/**
 * 安装后查找：返回刚安装的 pluginId 对应的 LoadedPlugin，
 * 以便调用方转交给 PluginOptionsFlow。如果该插件因某种原因
 * 没有出现在最新一次加载中，则返回 undefined —— 调用方将
 * undefined 视为“继续关闭”。
 *
 * 安装流程应该已经清空缓存；loadAllPlugins 会读取全新数据。
 */
export async function findPluginOptionsTarget(pluginId: string): Promise<LoadedPlugin | undefined> {
  const {
    enabled,
    disabled
  } = await loadAllPlugins();
  return [...enabled, ...disabled].find(p => p.repository === pluginId || p.source === pluginId);
}

/**
 * 遍历过程中的单个对话框步骤。顶层选项和通道都会
 * 归约为这一形状 —— 唯一区别在于运行哪个保存函数。
 */
type ConfigStep = {
  key: string;
  title: string;
  subtitle: string;
  schema: PluginOptionSchema;
  /** 返回所有已保存的值，以便 PluginOptionsDialog 预填充，
   *  并在重新配置时跳过未变更的敏感字段。 */
  load: () => PluginOptionValues | undefined;
  save: (values: PluginOptionValues) => void;
};
type Props = {
  plugin: LoadedPlugin;
  /** `name@marketplace` —— savePluginOptions / saveMcpServerUserConfig 的键。 */
  pluginId: string;
  /**
   * `configured` = 用户填写了所有字段。`skipped` = 无需配置，
   * 或用户取消了。`error` = 保存时抛出异常。
   */
  onDone: (outcome: 'configured' | 'skipped' | 'error', detail?: string) => void;
};
export function PluginOptionsFlow({
  plugin,
  pluginId,
  onDone
}: Props): React.ReactNode {
  // 挂载时只构建一次步骤列表。保存后再调用会丢掉
  // 我们刚刚配置过的那一项。
  const [steps] = React.useState<ConfigStep[]>(() => {
    const result: ConfigStep[] = [];

    // 顶层 manifest.userConfig
    const unconfigured = getUnconfiguredOptions(plugin);
    if (Object.keys(unconfigured).length > 0) {
      result.push({
        key: 'top-level',
        title: `Configure ${plugin.name}`,
        subtitle: 'Plugin options',
        schema: unconfigured,
        load: () => loadPluginOptions(pluginId),
        save: values => savePluginOptions(pluginId, values, plugin.manifest.userConfig!)
      });
    }

    // 按通道划分的 userConfig（assistant 模式通道）
    const channels: UnconfiguredChannel[] = getUnconfiguredChannels(plugin);
    for (const channel of channels) {
      result.push({
        key: `channel:${channel.server}`,
        title: `Configure ${channel.displayName}`,
        subtitle: `Plugin: ${plugin.name}`,
        schema: channel.configSchema,
        load: () => loadMcpServerUserConfig(pluginId, channel.server) ?? undefined,
        save: values_0 => saveMcpServerUserConfig(pluginId, channel.server, values_0, channel.configSchema)
      });
    }
    return result;
  });
  const [index, setIndex] = React.useState(0);

  // 最新值 ref：让 effect 闭包引用当前的 onDone，而无需在
  // 父组件重新渲染时重新执行。
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;

  // 无需配置 → 通知调用方并且不渲染任何内容。用 effect，
  // 而不是内联调用：在我们的渲染期间调用父组件的 setState
  // 违反 React 的 hooks 规则。
  React.useEffect(() => {
    if (steps.length === 0) {
      onDoneRef.current('skipped');
    }
  }, [steps.length]);
  if (steps.length === 0) {
    return null;
  }
  const current = steps[index]!;
  function handleSave(values_1: PluginOptionValues): void {
    try {
      current.save(values_1);
    } catch (err) {
      onDone('error', errorMessage(err));
      return;
    }
    const next = index + 1;
    if (next < steps.length) {
      setIndex(next);
    } else {
      onDone('configured');
    }
  }

  // 进入下一步时，key 会强制重新挂载 —— 否则 React 会复用
  // 该实例，并把 PluginOptionsDialog 内部的 useState
  //（字段索引、已输入的值）一并带过去。
  return <PluginOptionsDialog key={current.key} title={current.title} subtitle={current.subtitle} configSchema={current.schema} initialValues={current.load()} onSave={handleSave} onCancel={() => onDone('skipped')} />;
}