import * as React from 'react';
import { type GroveDecision, GroveDialog, PrivacySettingsDialog } from '../../components/grove/Grove.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { getGroveNoticeConfig, getGroveSettings, isQualifiedForGrove } from '../../services/api/grove.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
const FALLBACK_MESSAGE = 'Review and manage your privacy settings at ';
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode | null> {
  const qualified = await isQualifiedForGrove();
  if (!qualified) {
    onDone(FALLBACK_MESSAGE);
    return null;
  }
  const [settingsResult, configResult] = await Promise.all([getGroveSettings(), getGroveNoticeConfig()]);
  // API 失败时隐藏对话框（重试之后）
  if (!settingsResult.success) {
    onDone(FALLBACK_MESSAGE);
    return null;
  }
  const settings = settingsResult.data;
  const config = configResult.success ? configResult.data : null;
  async function onDoneWithDecision(decision: GroveDecision) {
    if (decision === 'escape' || decision === 'defer') {
      onDone('Privacy settings dialog dismissed', {
        display: 'system'
      });
      return;
    }
    await onDoneWithSettingsCheck();
  }
  async function onDoneWithSettingsCheck() {
    const updatedSettingsResult = await getGroveSettings();
    if (!updatedSettingsResult.success) {
      onDone('Unable to retrieve updated privacy settings', {
        display: 'system'
      });
      return;
    }
    const updatedSettings = updatedSettingsResult.data;
    const groveStatus = updatedSettings.grove_enabled ? 'true' : 'false';
    onDone(`"Help improve Limkenion" set to ${groveStatus}.`);
    if (settings.grove_enabled !== null && settings.grove_enabled !== updatedSettings.grove_enabled) {
      logEvent('limkenion_grove_policy_toggled', {
        state: updatedSettings.grove_enabled as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        location: 'settings' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
    }
  }

  // 如果用户已经接受条款，则直接显示
  // 隐私设置。
  if (settings.grove_enabled !== null) {
    return <PrivacySettingsDialog settings={settings} domainExcluded={config?.domain_excluded} onDone={onDoneWithSettingsCheck}></PrivacySettingsDialog>;
  }

  // 对尚未接受条款的用户显示 GroveDialog
  return <GroveDialog showIfAlreadyViewed={true} onDone={onDoneWithDecision} location={'settings'} />;
}