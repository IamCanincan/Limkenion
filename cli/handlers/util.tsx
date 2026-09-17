import { c as _c } from "react/compiler-runtime";
/**
 * Miscellaneous subcommand handlers — extracted from main.tsx for lazy loading.
 * setup-token, doctor, install
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */

import { cwd } from 'process';
import React from 'react';
import { WelcomeV2 } from '../../components/LogoV2/WelcomeV2.js';
import { useManagePlugins } from '../../hooks/useManagePlugins.js';
import type { Root } from '../../ink.js';
import { Box, Text } from '../../ink.js';
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js';
import { logEvent } from '../../services/analytics/index.js';
import { MCPConnectionManager } from '../../services/mcp/MCPConnectionManager.js';
import { AppStateProvider } from '../../state/AppState.js';
import { onChangeAppState } from '../../state/onChangeAppState.js';
import { isLimkenionAuthEnabled } from '../../utils/auth.js';
export async function setupTokenHandler(root: Root): Promise<void> {
  logEvent('limkenion_setup_token_command', {});
  const showAuthWarning = !isLimkenionAuthEnabled();
  const {
    ConsoleOAuthFlow
  } = await import('../../components/ConsoleOAuthFlow.js');
  await new Promise<void>(resolve => {
    root.render(<AppStateProvider onChangeAppState={onChangeAppState}>
        <KeybindingSetup>
          <Box flexDirection="column" gap={1}>
            <WelcomeV2 />
            {showAuthWarning && <Box flexDirection="column">
                <Text color="warning">
                  警告：你已经通过环境变量或 API key 辅助方式配置了认证。
                </Text>
                <Text color="warning">
                  setup-token 命令将创建一个新的 OAuth token，你可以用其代替。
                </Text>
              </Box>}
            <ConsoleOAuthFlow onDone={() => {
            void resolve();
          }} mode="setup-token" startingMessage="这将引导你为 Limkenion 账号创建长期（1 年）有效的认证 token。需要 Limkenion 订阅。" />
          </Box>
        </KeybindingSetup>
      </AppStateProvider>);
  });
  root.unmount();
  process.exit(0);
}

// DoctorWithPlugins wrapper + doctor handler
const DoctorLazy = React.lazy(() => import('../../screens/Doctor.js').then(m => ({
  default: m.Doctor
})));
function DoctorWithPlugins(t0) {
  const $ = _c(2);
  const {
    onDone
  } = t0;
  useManagePlugins();
  let t1;
  if ($[0] !== onDone) {
    t1 = <React.Suspense fallback={null}><DoctorLazy onDone={onDone} /></React.Suspense>;
    $[0] = onDone;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
}
export async function doctorHandler(root: Root): Promise<void> {
  logEvent('limkenion_doctor_command', {});
  await new Promise<void>(resolve => {
    root.render(<AppStateProvider>
        <KeybindingSetup>
          <MCPConnectionManager dynamicMcpConfig={undefined} isStrictMcpConfig={false}>
            <DoctorWithPlugins onDone={() => {
            void resolve();
          }} />
          </MCPConnectionManager>
        </KeybindingSetup>
      </AppStateProvider>);
  });
  root.unmount();
  process.exit(0);
}

// install handler
export async function installHandler(target: string | undefined, options: {
  force?: boolean;
}): Promise<void> {
  const {
    setup
  } = await import('../../setup.js');
  await setup(cwd(), 'default', false, false, undefined, false);
  const {
    install
  } = await import('../../commands/install.js');
  await new Promise<void>(resolve => {
    const args: string[] = [];
    if (target) args.push(target);
    if (options.force) args.push('--force');
    void install.call(result => {
      void resolve();
      process.exit(result.includes('failed') ? 1 : 0);
    }, {}, args);
  });
}