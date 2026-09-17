import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { useInterval } from 'usehooks-ts';
import { useUpdateNotification } from '../hooks/useUpdateNotification.js';
import { Box, Text } from '../ink.js';
import { type AutoUpdaterResult, getLatestVersion, getMaxVersion, type InstallStatus, installGlobalPackage, shouldSkipVersion } from '../utils/autoUpdater.js';
import { getGlobalConfig, isAutoUpdaterDisabled } from '../utils/config.js';
import { logForDebugging } from '../utils/debug.js';
import { getCurrentInstallationType } from '../utils/doctorDiagnostic.js';
import { installOrUpdateLimkenionPackage, localInstallationExists } from '../utils/localInstaller.js';
import { removeInstalledSymlink } from '../utils/nativeInstaller/index.js';
import { gt, gte } from '../utils/semver.js';
import { getInitialSettings } from '../utils/settings/settings.js';
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
export function AutoUpdater({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose
}: Props): React.ReactNode {
  const [versions, setVersions] = useState<{
    global?: string | null;
    latest?: string | null;
  }>({});
  const [hasLocalInstall, setHasLocalInstall] = useState(false);
  const updateSemver = useUpdateNotification(autoUpdaterResult?.version);
  useEffect(() => {
    void localInstallationExists().then(setHasLocalInstall);
  }, []);

  // 将最新的 isUpdating 值记录在 ref 中，使记忆化的 checkForUpdates
  // 回调始终能看到当前值。否则，30 分钟
  // 的定时器会以过期的闭包触发（其中 isUpdating 为 false），
  // 导致在一个 installGlobalPackage() 正在进行时并发执行另一个。
  const isUpdatingRef = useRef(isUpdating);
  isUpdatingRef.current = isUpdating;
  const checkForUpdates = React.useCallback(async () => {
    if (isUpdatingRef.current) {
      return;
    }
    if ("production" === 'test' || "production" === 'development') {
      logForDebugging('AutoUpdater: 在测试/开发环境中跳过更新检查');
      return;
    }
    const currentVersion = MACRO.VERSION;
    const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest';
    let latestVersion = await getLatestVersion(channel);
    const isDisabled = isAutoUpdaterDisabled();

    // 检查是否设置了最大版本（服务端用于自动更新的熔断开关）
    const maxVersion = await getMaxVersion();
    if (maxVersion && latestVersion && gt(latestVersion, maxVersion)) {
      logForDebugging(`AutoUpdater: 已设置 maxVersion ${maxVersion}，将更新上限从 ${latestVersion} 调整为 ${maxVersion}`);
      if (gte(currentVersion, maxVersion)) {
        logForDebugging(`AutoUpdater: 当前版本 ${currentVersion} 已达到或超过 maxVersion ${maxVersion}，跳过更新`);
        setVersions({
          global: currentVersion,
          latest: latestVersion
        });
        return;
      }
      latestVersion = maxVersion;
    }
    setVersions({
      global: currentVersion,
      latest: latestVersion
    });

    // 判断是否需要更新并执行更新
    if (!isDisabled && currentVersion && latestVersion && !gte(currentVersion, latestVersion) && !shouldSkipVersion(latestVersion)) {
      const startTime = Date.now();
      onChangeIsUpdating(true);

      // 移除 native 安装器的符号链接，因为我们改用基于 JS 的更新
      // 但仅当用户尚未迁移到 native 安装方式时
      const config = getGlobalConfig();
      if (config.installMethod !== 'native') {
        await removeInstalledSymlink();
      }

      // 检测实际正在运行的安装类型
      const installationType = await getCurrentInstallationType();
      logForDebugging(`AutoUpdater: 检测到安装类型：${installationType}`);

      // 对开发版构建跳过更新
      if (installationType === 'development') {
        logForDebugging('AutoUpdater: 无法自动更新开发版构建');
        onChangeIsUpdating(false);
        return;
      }

      // 根据实际运行方式选择相应的更新方法
      let installStatus: InstallStatus;
      let updateMethod: 'local' | 'global';
      if (installationType === 'npm-local') {
        // 本地安装使用本地更新
        logForDebugging('AutoUpdater: 使用本地更新方法');
        updateMethod = 'local';
        installStatus = await installOrUpdateLimkenionPackage(channel);
      } else if (installationType === 'npm-global') {
        // 全局安装使用全局更新
        logForDebugging('AutoUpdater: 使用全局更新方法');
        updateMethod = 'global';
        installStatus = await installGlobalPackage();
      } else if (installationType === 'native') {
        // 不应发生——native 应使用 NativeAutoUpdater
        logForDebugging('AutoUpdater: 非 native 更新器中出现了意外的 native 安装');
        onChangeIsUpdating(false);
        return;
      } else {
        // 对未知类型回退到基于配置的检测
        logForDebugging(`AutoUpdater: 未知安装类型，回退到配置检测`);
        const isMigrated = config.installMethod === 'local';
        updateMethod = isMigrated ? 'local' : 'global';
        if (isMigrated) {
          installStatus = await installOrUpdateLimkenionPackage(channel);
        } else {
          installStatus = await installGlobalPackage();
        }
      }
      onChangeIsUpdating(false);
      if (installStatus === 'success') {
        logEvent('limkenion_auto_updater_success', {
          fromVersion: currentVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          toVersion: latestVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs: Date.now() - startTime,
          wasMigrated: updateMethod === 'local',
          installationType: installationType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      } else {
        logEvent('limkenion_auto_updater_fail', {
          fromVersion: currentVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          attemptedVersion: latestVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          status: installStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs: Date.now() - startTime,
          wasMigrated: updateMethod === 'local',
          installationType: installationType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      }
      onAutoUpdaterResult({
        version: latestVersion,
        status: installStatus
      });
    }
    // 依赖中刻意省略 isUpdating；我们改为读取 isUpdatingRef
    // 以保证守卫始终是最新的，同时不改变回调
    // 身份（否则会重新触发下面的首次检查 useEffect）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: isUpdating read via ref
  }, [onAutoUpdaterResult]);

  // 首次检查
  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  // 每 30 分钟检查一次
  useInterval(checkForUpdates, 30 * 60 * 1000);
  if (!autoUpdaterResult?.version && (!versions.global || !versions.latest)) {
    return null;
  }
  if (!autoUpdaterResult?.version && !isUpdating) {
    return null;
  }
  return <Box flexDirection="row" gap={1}>
      {verbose && <Text dimColor wrap="truncate">
          globalVersion: {versions.global} &middot; latestVersion:{' '}
          {versions.latest}
        </Text>}
      {isUpdating ? <>
          <Box>
            <Text color="text" dimColor wrap="truncate">
              正在自动更新…
            </Text>
          </Box>
        </> : autoUpdaterResult?.status === 'success' && showSuccessMessage && updateSemver && <Text color="success" wrap="truncate">
            ✓ 更新已安装 · 重启以生效
          </Text>}
      {(autoUpdaterResult?.status === 'install_failed' || autoUpdaterResult?.status === 'no_permissions') && <Text color="error" wrap="truncate">
          ✗ 自动更新失败 · 请尝试 <Text bold>limkenion doctor</Text> 或{' '}
          <Text bold>
            {hasLocalInstall ? `cd ~/.limkenion/local && npm update ${MACRO.PACKAGE_URL}` : `npm i -g ${MACRO.PACKAGE_URL}`}
          </Text>
        </Text>}
    </Box>;
}