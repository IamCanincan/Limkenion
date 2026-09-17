import * as React from 'react';
import { Text } from '../ink.js';
import { isLimkenionAISubscriber } from '../utils/auth.js';
import { isChromeExtensionInstalled, shouldEnableLimkenionInChrome } from '../utils/limkenionInChrome/setup.js';
import { isRunningOnHomespace } from '../utils/envUtils.js';
import { useStartupNotification } from './notifs/useStartupNotification.js';
function getChromeFlag(): boolean | undefined {
  if (process.argv.includes('--chrome')) {
    return true;
  }
  if (process.argv.includes('--no-chrome')) {
    return false;
  }
  return undefined;
}
export function useChromeExtensionNotification() {
  useStartupNotification(_temp);
}
async function _temp() {
  const chromeFlag = getChromeFlag();
  if (!shouldEnableLimkenionInChrome(chromeFlag)) {
    return null;
  }
  if (true && !isLimkenionAISubscriber()) {
    return {
      key: "chrome-requires-subscription",
      jsx: <Text color="error">Limkenion in Chrome 需要远端订阅，本构建不可用</Text>,
      priority: "immediate",
      timeoutMs: 5000
    };
  }
  const installed = await isChromeExtensionInstalled();
  if (!installed && !isRunningOnHomespace()) {
    return {
      key: "chrome-extension-not-detected",
      jsx: <Text color="warning">Chrome extension not detected ·  to install</Text>,
      priority: "immediate",
      timeoutMs: 3000
    };
  }
  if (chromeFlag === undefined) {
    return {
      key: "limkenion-in-chrome-default-enabled",
      text: "Limkenion in Chrome enabled \xB7 /chrome",
      priority: "low"
    };
  }
  return null;
}