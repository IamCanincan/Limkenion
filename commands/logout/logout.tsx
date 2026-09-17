import * as React from 'react';
import { Text } from '../../ink.js';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js';
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js';
// flushTelemetry 采用惰性加载，以避免启动时引入约 1.1MB 的 OpenTelemetry
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js';
import { getLimkenionAIOAuthTokens, removeApiKey } from '../../utils/auth.js';
import { clearBetasCaches } from '../../utils/betas.js';
import { saveGlobalConfig } from '../../utils/config.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { getSecureStorage } from '../../utils/secureStorage/index.js';
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js';
import { resetUserCache } from '../../utils/user.js';
export async function performLogout({
  clearOnboarding = false
}): Promise<void> {
  // 在清除凭据之前先刷写遥测，以防组织数据泄漏
  const {
    flushTelemetry
  } = await import('../../utils/telemetry/instrumentation.js');
  await flushTelemetry();
  await removeApiKey();

  // 登出时清除所有安全存储数据
  const secureStorage = getSecureStorage();
  secureStorage.delete();
  await clearAuthRelatedCaches();
  saveGlobalConfig(current => {
    const updated = {
      ...current
    };
    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false;
      updated.subscriptionNoticeCount = 0;
      updated.hasAvailableSubscription = false;
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: []
        };
      }
    }
    updated.oauthAccount = undefined;
    return updated;
  });
}

// 清除所有必须在用户/会话/认证变化时失效的记忆化内容
export async function clearAuthRelatedCaches(): Promise<void> {
  // 清除 OAuth 令牌缓存
  getLimkenionAIOAuthTokens.cache?.clear?.();
  clearBetasCaches();
  clearToolSchemaCache();

  // 在 GrowthBook 刷新之前清除用户数据缓存，以便其读取到新的凭据
  resetUserCache();
  refreshGrowthBookAfterAuthChange();

  // 清除 Grove 配置缓存
  getGroveNoticeConfig.cache?.clear?.();
  getGroveSettings.cache?.clear?.();

  // 清除远程托管设置缓存
  await clearRemoteManagedSettingsCache();

  // 清除策略限制缓存
  await clearPolicyLimitsCache();
}
export async function call(): Promise<React.ReactNode> {
  await performLogout({
    clearOnboarding: true
  });
  const message = <Text>已登出。本地凭据已清除。</Text>;
  setTimeout(() => {
    gracefulShutdownSync(0, 'logout');
  }, 200);
  return message;
}