import { c as _c } from "react/compiler-runtime";
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { setupTerminal, shouldOfferTerminalSetup } from '../commands/terminalSetup/terminalSetup.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Link, Newline, Text, useTheme } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { isLimkenionAuthEnabled } from '../utils/auth.js';
import { normalizeApiKeyForConfig } from '../utils/authPortable.js';
import { getCustomApiKeyStatus } from '../utils/config.js';
import { env } from '../utils/env.js';
import { isRunningOnHomespace } from '../utils/envUtils.js';
import { PreflightStep } from '../utils/preflightChecks.js';
import type { ThemeSetting } from '../utils/theme.js';
import { ApproveApiKey } from './ApproveApiKey.js';
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js';
import { Select } from './CustomSelect/select.js';
import { WelcomeV2 } from './LogoV2/WelcomeV2.js';
import { PressEnterToContinue } from './PressEnterToContinue.js';
import { ThemePicker } from './ThemePicker.js';
import { OrderedList } from './ui/OrderedList.js';
type StepId = 'preflight' | 'theme' | 'oauth' | 'api-key' | 'security' | 'terminal-setup';
interface OnboardingStep {
  id: StepId;
  component: React.ReactNode;
}
type Props = {
  onDone(): void;
};
export function Onboarding({
  onDone
}: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [skipOAuth, setSkipOAuth] = useState(false);
  const [oauthEnabled] = useState(() => isLimkenionAuthEnabled());
  const [theme] = useTheme();
  useEffect(() => {
    logEvent('limkenion_began_setup', {
      oauthEnabled
    });
  }, [oauthEnabled]);
  function goToNextStep() {
    if (currentStepIndex < steps.length - 1) {
      const nextIndex = currentStepIndex + 1;
      setCurrentStepIndex(nextIndex);
      logEvent('limkenion_onboarding_step', {
        oauthEnabled,
        stepId: steps[nextIndex]?.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
    } else {
      onDone();
    }
  }
  const exitState = useExitOnCtrlCDWithKeybindings();

  // 定义所有引导步骤
  const securityStep = <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>安全须知：</Text>
      <Box flexDirection="column" width={70}>
        {/**
         * OrderedList 在条件渲染时会对条目错误编号，
         * 因此将所有条目都放在 if/else 中
         */}
        <OrderedList>
          <OrderedList.Item>
            <Text>Limkenion 可能会犯错</Text>
            <Text dimColor wrap="wrap">
              你应该始终复核 Limkenion 的回复，尤其是在
              <Newline />
              运行代码时。
              <Newline />
            </Text>
          </OrderedList.Item>
          <OrderedList.Item>
            <Text>
              由于存在提示注入风险，仅应对你信任的代码使用
            </Text>
            <Text dimColor wrap="wrap">
              更多详情请参阅：
              <Newline />
              <Link url="" />
            </Text>
          </OrderedList.Item>
        </OrderedList>
      </Box>
      <PressEnterToContinue />
    </Box>;
  const preflightStep = <PreflightStep onSuccess={goToNextStep} />;
  // 创建步骤数组——根据 reAuth 和 oauthEnabled 决定包含哪些步骤
  const apiKeyNeedingApproval = useMemo(() => {
    // 如需则添加 API 密钥步骤
    // 在 homespace 中，LIMKENION_API_KEY 会被保留在子进程的
    // process.env 中，但 Limkenion 本身会忽略它（参见 auth.ts）。
    if (!process.env.LIMKENION_API_KEY || isRunningOnHomespace()) {
      return '';
    }
    const customApiKeyTruncated = normalizeApiKeyForConfig(process.env.LIMKENION_API_KEY);
    if (getCustomApiKeyStatus(customApiKeyTruncated) === 'new') {
      return customApiKeyTruncated;
    }
  }, []);
  function handleApiKeyDone(approved: boolean) {
    if (approved) {
      setSkipOAuth(true);
    }
    goToNextStep();
  }
  const steps: OnboardingStep[] = [];
  if (oauthEnabled) {
    steps.push({
      id: 'preflight',
      component: preflightStep
    });
  }
  // 主题选择器已移除：它是上游 Code 的引导遗留物。主题
  // 从配置中设置（带默认值），之后仍可通过 /theme 更改。
  // 在 API 密钥驱动的设置流程中无需在引导阶段询问主题。
  if (apiKeyNeedingApproval) {
    steps.push({
      id: 'api-key',
      component: <ApproveApiKey customApiKeyTruncated={apiKeyNeedingApproval} onDone={handleApiKeyDone} />
    });
  }
  if (oauthEnabled) {
    steps.push({
      id: 'oauth',
      component: <SkippableStep skip={skipOAuth} onSkip={goToNextStep}>
          <ConsoleOAuthFlow onDone={goToNextStep} />
        </SkippableStep>
    });
  }
  steps.push({
    id: 'security',
    component: securityStep
  });
  if (shouldOfferTerminalSetup()) {
    steps.push({
      id: 'terminal-setup',
      component: <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>是否使用 Limkenion 的终端配置？</Text>
          <Box flexDirection="column" width={70} gap={1}>
            <Text>
              为获得最佳编码体验，请为你的终端启用推荐的设置
              <Newline />
              ：{' '}
              {env.terminal === 'Apple_Terminal' ? 'Option+Enter 用于换行并显示视觉铃声' : 'Shift+Enter 用于换行'}
            </Text>
            <Select options={[{
            label: '是，使用推荐配置',
            value: 'install'
          }, {
            label: '不用，稍后通过 /terminal-setup',
            value: 'no'
          }]} onChange={value => {
            if (value === 'install') {
              // 错误已在 setupTerminal 中记录，此处直接吞掉并继续
              void setupTerminal(theme).catch(() => {}).finally(goToNextStep);
            } else {
              goToNextStep();
            }
          }} onCancel={() => goToNextStep()} />
            <Text dimColor>
              {exitState.pending ? <>再次按 {exitState.keyName} 退出</> : <>按回车确认 · 按 Esc 跳过</>}
            </Text>
          </Box>
        </Box>
    });
  }
  const currentStep = steps[currentStepIndex];

  // 处理在安全步骤按 Enter 和在终端配置步骤按 Escape
  // 依赖与 goToNextStep 内部使用的保持一致
  const handleSecurityContinue = useCallback(() => {
    if (currentStepIndex === steps.length - 1) {
      onDone();
    } else {
      goToNextStep();
    }
  }, [currentStepIndex, steps.length, oauthEnabled, onDone]);
  const handleTerminalSetupSkip = useCallback(() => {
    goToNextStep();
  }, [currentStepIndex, steps.length, oauthEnabled, onDone]);
  useKeybindings({
    'confirm:yes': handleSecurityContinue
  }, {
    context: 'Confirmation',
    isActive: currentStep?.id === 'security'
  });
  useKeybindings({
    'confirm:no': handleTerminalSetupSkip
  }, {
    context: 'Confirmation',
    isActive: currentStep?.id === 'terminal-setup'
  });
  return <Box flexDirection="column">
      <WelcomeV2 />
      <Box flexDirection="column" marginTop={1}>
        {currentStep?.component}
        {exitState.pending && <Box padding={1}>
            <Text dimColor>再次按 {exitState.keyName} 退出</Text>
          </Box>}
      </Box>
    </Box>;
}
export function SkippableStep(t0) {
  const $ = _c(4);
  const {
    skip,
    onSkip,
    children
  } = t0;
  let t1;
  let t2;
  if ($[0] !== onSkip || $[1] !== skip) {
    t1 = () => {
      if (skip) {
        onSkip();
      }
    };
    t2 = [skip, onSkip];
    $[0] = onSkip;
    $[1] = skip;
    $[2] = t1;
    $[3] = t2;
  } else {
    t1 = $[2];
    t2 = $[3];
  }
  useEffect(t1, t2);
  if (skip) {
    return null;
  }
  return children;
}