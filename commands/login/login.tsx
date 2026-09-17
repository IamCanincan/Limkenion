import { c as _c } from "react/compiler-runtime";
import { feature } from 'bun:bundle';
import * as React from 'react';
import { resetCostState } from '../../bootstrap/state.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { Text } from '../../ink.js';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { refreshPolicyLimits } from '../../services/policyLimits/index.js';
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { stripSignatureBlocks } from '../../utils/messages.js';
import { checkAndDisableAutoModeIfNeeded, checkAndDisableBypassPermissionsIfNeeded, resetAutoModeGateCheck, resetBypassPermissionsCheck } from '../../utils/permissions/bypassPermissionsKillswitch.js';
import { resetUserCache } from '../../utils/user.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <Login onDone={async success => {
    context.onChangeAPIKey();
    // 携带签名的块（thinking、connector_text）与 API 密钥绑定 ——
    // 需剥离它们，以免新密钥拒绝失效的签名。
    context.setMessages(stripSignatureBlocks);
    if (success) {
      // 登录后的刷新逻辑。需与 src/interactiveHelpers.tsx 中的引导流程保持同步
      // 切换账户时重置成本状态
      resetCostState();
      // 登录后刷新远程托管的设置（非阻塞）
      void refreshRemoteManagedSettings();
      // 登录后刷新策略限制（非阻塞）
      void refreshPolicyLimits();
      // 在 GrowthBook 刷新之前清除用户数据缓存，以便其读取到新的凭据
      resetUserCache();
      // 登录后刷新 GrowthBook 以获取更新的功能开关（例如用于 远端服务 的 MCP）
      refreshGrowthBookAfterAuthChange();
      // 重置 killswitch 门禁检查并以新组织重新运行
      resetBypassPermissionsCheck();
      const appState = context.getAppState();
      void checkAndDisableBypassPermissionsIfNeeded(appState.toolPermissionContext, context.setAppState);
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        resetAutoModeGateCheck();
        void checkAndDisableAutoModeIfNeeded(appState.toolPermissionContext, context.setAppState, appState.fastMode);
      }
      // 递增 authVersion 以触发钩子中依赖认证的数据重新拉取（例如 MCP 服务器）
      context.setAppState(prev => ({
        ...prev,
        authVersion: prev.authVersion + 1
      }));
    }
    onDone(success ? '已配置 DeepSeek API Key' : '已取消配置');
  }} />;
}
export function Login(props) {
  const $ = _c(12);
  const mainLoopModel = useMainLoopModel();
  let t0;
  if ($[0] !== mainLoopModel || $[1] !== props) {
    t0 = () => props.onDone(false, mainLoopModel);
    $[0] = mainLoopModel;
    $[1] = props;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  let t1;
  if ($[3] !== mainLoopModel || $[4] !== props) {
    t1 = () => props.onDone(true, mainLoopModel);
    $[3] = mainLoopModel;
    $[4] = props;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  let t2;
  if ($[6] !== props.startingMessage || $[7] !== t1) {
    t2 = <ConsoleOAuthFlow onDone={t1} startingMessage={props.startingMessage} />;
    $[6] = props.startingMessage;
    $[7] = t1;
    $[8] = t2;
  } else {
    t2 = $[8];
  }
  let t3;
  if ($[9] !== t0 || $[10] !== t2) {
    t3 = <Dialog title="登录 / API Key" onCancel={t0} color="permission" inputGuide={_temp}>{t2}</Dialog>;
    $[9] = t0;
    $[10] = t2;
    $[11] = t3;
  } else {
    t3 = $[11];
  }
  return t3;
}
function _temp(exitState) {
  return exitState.pending ? <Text>再次按下 {exitState.keyName} 退出</Text> : <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />;
}