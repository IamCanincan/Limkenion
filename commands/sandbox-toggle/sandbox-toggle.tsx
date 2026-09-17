import { relative } from 'path';
import React from 'react';
import { getCwdState } from '../../bootstrap/state.js';
import { SandboxSettings } from '../../components/sandbox/SandboxSettings.js';
import { color } from '../../ink.js';
import { getPlatform } from '../../utils/platform.js';
import { addToExcludedCommands, SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { getSettings_DEPRECATED, getSettingsFilePathForSource } from '../../utils/settings/settings.js';
import type { ThemeName } from '../../utils/theme.js';
export async function call(onDone: (result?: string) => void, _context: unknown, args?: string): Promise<React.ReactNode | null> {
  const settings = getSettings_DEPRECATED();
  const themeName: ThemeName = settings.theme as ThemeName || 'light';
  const platform = getPlatform();
  if (!SandboxManager.isSupportedPlatform()) {
    // WSL1 用户会看到此项，因为 isSupportedPlatform 对 WSL1 返回 false
    const errorMessage = platform === 'wsl' ? 'Error: Sandboxing requires WSL2. WSL1 is not supported.' : 'Error: Sandboxing is currently only supported on macOS, Linux, and WSL2.';
    const message = color('error', themeName)(errorMessage);
    onDone(message);
    return null;
  }

  // 检查依赖 —— 获取带错误/警告的结构化结果
  const depCheck = SandboxManager.checkDependencies();

  // 检查平台是否在 enabledPlatforms 列表中（未公开的企业设置）
  if (!SandboxManager.isPlatformInEnabledList()) {
    const message = color('error', themeName)(`Error: Sandboxing is disabled for this platform (${platform}) via the enabledPlatforms setting.`);
    onDone(message);
    return null;
  }

  // 检查沙箱设置是否被更高优先级的设置锁定
  if (SandboxManager.areSandboxSettingsLockedByPolicy()) {
    const message = color('error', themeName)('Error: Sandbox settings are overridden by a higher-priority configuration and cannot be changed locally.');
    onDone(message);
    return null;
  }

  // 解析参数
  const trimmedArgs = args?.trim() || '';

  // 若无参数，显示交互式菜单
  if (!trimmedArgs) {
    return <SandboxSettings onComplete={onDone} depCheck={depCheck} />;
  }

  // 处理子命令
  if (trimmedArgs) {
    const parts = trimmedArgs.split(' ');
    const subcommand = parts[0];
    if (subcommand === 'exclude') {
      // 处理 exclude 子命令
      const commandPattern = trimmedArgs.slice('exclude '.length).trim();
      if (!commandPattern) {
        const message = color('error', themeName)('Error: Please provide a command pattern to exclude (e.g., /sandbox exclude "npm run test:*")');
        onDone(message);
        return null;
      }

      // 如果存在引号则移除
      const cleanPattern = commandPattern.replace(/^["']|["']$/g, '');

      // 添加到 excludedCommands
      addToExcludedCommands(cleanPattern);

      // 获取本地设置路径并使其相对于工作目录
      const localSettingsPath = getSettingsFilePathForSource('localSettings');
      const relativePath = localSettingsPath ? relative(getCwdState(), localSettingsPath) : '.limkenion/settings.local.json';
      const message = color('success', themeName)(`Added "${cleanPattern}" to excluded commands in ${relativePath}`);
      onDone(message);
      return null;
    } else {
      // 未知子命令
      const message = color('error', themeName)(`Error: Unknown subcommand "${subcommand}". Available subcommand: exclude`);
      onDone(message);
      return null;
    }
  }

  // 不应到达此处，因为上面已处理所有情况
  return null;
}