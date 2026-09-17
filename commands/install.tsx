import { c as _c } from "react/compiler-runtime";
import { homedir } from 'node:os';
import { join } from 'node:path';
import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { StatusIcon } from '../components/design-system/StatusIcon.js';
import { Box, render, Text } from '../ink.js';
import { logForDebugging } from '../utils/debug.js';
import { env } from '../utils/env.js';
import { errorMessage } from '../utils/errors.js';
import { checkInstall, cleanupNpmInstallations, cleanupShellAliases, installLatest } from '../utils/nativeInstaller/index.js';
import { getInitialSettings, updateSettingsForSource } from '../utils/settings/settings.js';
interface InstallProps {
  onDone: (result: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  force?: boolean;
  target?: string; // 'latest'、'stable'，或类似 '1.0.34' 的版本号
}
type InstallState = {
  type: 'checking';
} | {
  type: 'cleaning-npm';
} | {
  type: 'installing';
  version: string;
} | {
  type: 'setting-up';
} | {
  type: 'set-up';
  messages: string[];
} | {
  type: 'success';
  version: string;
  setupMessages?: string[];
} | {
  type: 'error';
  message: string;
  warnings?: string[];
};
function getInstallationPath(): string {
  const isWindows = env.platform === 'win32';
  const homeDir = homedir();
  if (isWindows) {
    // 转换为 Windows 风格路径
    const windowsPath = join(homeDir, '.local', 'bin', 'limkenion.exe');
    // 为 Windows 显示将正斜杠替换为反斜杠
    return windowsPath.replace(/\//g, '\\');
  }
  return '~/.local/bin/limkenion';
}
function SetupNotes(t0) {
  const $ = _c(5);
  const {
    messages
  } = t0;
  if (messages.length === 0) {
    return null;
  }
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Box><Text color="warning"><StatusIcon status="warning" withSpace={true} />Setup notes:</Text></Box>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  if ($[1] !== messages) {
    t2 = messages.map(_temp);
    $[1] = messages;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== t2) {
    t3 = <Box flexDirection="column" gap={0} marginBottom={1}>{t1}{t2}</Box>;
    $[3] = t2;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  return t3;
}
function _temp(message, index) {
  return <Box key={index} marginLeft={2}><Text dimColor={true}>• {message}</Text></Box>;
}
function Install({
  onDone,
  force,
  target
}: InstallProps): React.ReactNode {
  const [state, setState] = useState<InstallState>({
    type: 'checking'
  });
  useEffect(() => {
    async function run() {
      try {
        logForDebugging(`Install: Starting installation process (force=${force}, target=${target})`);

        // 先安装原生构建
        const channelOrVersion = target || getInitialSettings()?.autoUpdatesChannel || 'latest';
        setState({
          type: 'installing',
          version: channelOrVersion
        });

        // 传入 force 标志，即使已是最新也触发重装
        logForDebugging(`Install: Calling installLatest(channelOrVersion=${channelOrVersion}, forceReinstall=${force})`);
        const result = await installLatest(channelOrVersion, force);
        logForDebugging(`Install: installLatest returned version=${result.latestVersion}, wasUpdated=${result.wasUpdated}, lockFailed=${result.lockFailed}`);

        // 专门检查锁失败
        if (result.lockFailed) {
          throw new Error('Could not install - another process is currently installing Limkenion. Please try again in a moment.');
        }

        // 若无法获取版本号，可能存在问题
        if (!result.latestVersion) {
          logForDebugging('Install: Failed to retrieve version information during install', {
            level: 'error'
          });
        }
        if (!result.wasUpdated) {
          logForDebugging('Install: Already up to date');
        }

        // 配置启动器与 shell 集成
        setState({
          type: 'setting-up'
        });
        const setupMessages = await checkInstall(true);
        logForDebugging(`Install: Setup launcher completed with ${setupMessages.length} messages`);
        if (setupMessages.length > 0) {
          setupMessages.forEach(msg => logForDebugging(`Install: Setup message: ${msg.message}`));
        }

        // 原生安装已成功，现在清理旧的 npm 安装
        logForDebugging('Install: Cleaning up npm installations after successful install');
        const {
          removed,
          errors,
          warnings
        } = await cleanupNpmInstallations();
        if (removed > 0) {
          logForDebugging(`Cleaned up ${removed} npm installation(s)`);
        }
        if (errors.length > 0) {
          logForDebugging(`Cleanup errors: ${errors.join(', ')}`);
          // 忽略清理错误继续执行 —— 原生安装已经成功
        }

        // 清理旧的 shell 别名
        const aliasMessages = await cleanupShellAliases();
        if (aliasMessages.length > 0) {
          logForDebugging(`Shell alias cleanup: ${aliasMessages.map(m => m.message).join('; ')}`);
        }

        // 记录成功事件
        logEvent('limkenion_limkenion_install_command', {
          has_version: result.latestVersion ? 1 : 0,
          forced: force ? 1 : 0
        });

        // 若用户显式指定了渠道，则将其保存到设置中
        if (target === 'latest' || target === 'stable') {
          updateSettingsForSource('userSettings', {
            autoUpdatesChannel: target
          });
          logForDebugging(`Install: Saved autoUpdatesChannel=${target} to user settings`);
        }

        // 合并所有警告/信息消息（将 SetupMessage 转为字符串）
        const allWarnings = [...warnings, ...aliasMessages.map(m_0 => m_0.message)];

        // 检查是否存在任何安装错误或提示
        if (setupMessages.length > 0) {
          setState({
            type: 'set-up',
            messages: setupMessages.map(m_1 => m_1.message)
          });
          // 仍标记为成功，但同时显示安装消息与清理警告
          setTimeout(setState, 2000, {
            type: 'success' as const,
            version: result.latestVersion || 'current',
            setupMessages: [...setupMessages.map(m_2 => m_2.message), ...allWarnings]
          });
        } else {
          // 没有安装消息，直接进入成功状态（但若有清理警告仍会显示）
          logForDebugging('Install: Shell PATH already configured');
          setState({
            type: 'success',
            version: result.latestVersion || 'current',
            setupMessages: allWarnings.length > 0 ? allWarnings : undefined
          });
        }
      } catch (error) {
        logForDebugging(`Install command failed: ${error}`, {
          level: 'error'
        });
        setState({
          type: 'error',
          message: errorMessage(error)
        });
      }
    }
    void run();
  }, [force, target]);
  useEffect(() => {
    if (state.type === 'success') {
      // 留出时间让成功消息渲染后再退出
      setTimeout(onDone, 2000, 'Limkenion installation completed successfully', {
        display: 'system' as const
      });
    } else if (state.type === 'error') {
      // 留出时间让错误消息渲染后再退出
      setTimeout(onDone, 3000, 'Limkenion installation failed', {
        display: 'system' as const
      });
    }
  }, [state, onDone]);
  return <Box flexDirection="column" marginTop={1}>
      {state.type === 'checking' && <Text color="limkenion">Checking installation status...</Text>}

      {state.type === 'cleaning-npm' && <Text color="warning">Cleaning up old npm installations...</Text>}

      {state.type === 'installing' && <Text color="limkenion">
          Installing Limkenion native build {state.version}...
        </Text>}

      {state.type === 'setting-up' && <Text color="limkenion">Setting up launcher and shell integration...</Text>}

      {state.type === 'set-up' && <SetupNotes messages={state.messages} />}

      {state.type === 'success' && <Box flexDirection="column" gap={1}>
          <Box>
            <StatusIcon status="success" withSpace />
            <Text color="success" bold>
              Limkenion successfully installed!
            </Text>
          </Box>
          <Box marginLeft={2} flexDirection="column" gap={1}>
            {state.version !== 'current' && <Box>
                <Text dimColor>Version: </Text>
                <Text color="limkenion">{state.version}</Text>
              </Box>}
            <Box>
              <Text dimColor>Location: </Text>
              <Text color="text">{getInstallationPath()}</Text>
            </Box>
          </Box>
          <Box marginLeft={2} flexDirection="column" gap={1}>
            <Box marginTop={1}>
              <Text dimColor>Next: Run </Text>
              <Text color="limkenion" bold>
                limkenion --help
              </Text>
              <Text dimColor> to get started</Text>
            </Box>
          </Box>
          {state.setupMessages && <SetupNotes messages={state.setupMessages} />}
        </Box>}

      {state.type === 'error' && <Box flexDirection="column" gap={1}>
          <Box>
            <StatusIcon status="error" withSpace />
            <Text color="error">Installation failed</Text>
          </Box>
          <Text color="error">{state.message}</Text>
          <Box marginTop={1}>
            <Text dimColor>Try running with --force to override checks</Text>
          </Box>
        </Box>}
    </Box>;
}

// 仅从 cli.tsx 使用，不作为斜杠命令
export const install = {
  type: 'local-jsx' as const,
  name: 'install',
  description: '安装 Limkenion 原生构建',
  argumentHint: '[options]',
  async call(onDone: (result: string, options?: {
    display?: CommandResultDisplay;
  }) => void, _context: unknown, args: string[]) {
    // 解析参数
    const force = args.includes('--force');
    const nonFlagArgs = args.filter(arg => !arg.startsWith('--'));
    const target = nonFlagArgs[0]; // 'latest'、'stable'，或类似 '1.0.34' 的版本号

    const {
      unmount
    } = await render(<Install onDone={(result, options) => {
      unmount();
      onDone(result, options);
    }} force={force} target={target} />);
  }
};