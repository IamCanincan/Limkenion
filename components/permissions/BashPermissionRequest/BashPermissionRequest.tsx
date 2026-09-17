import { c as _c } from "react/compiler-runtime";
import { feature } from 'bun:bundle';
import figures from 'figures';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useTheme } from '../../../ink.js';
import { useKeybinding } from '../../../keybindings/useKeybinding.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../../services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../../services/analytics/index.js';
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js';
import { useAppState } from '../../../state/AppState.js';
import { BashTool } from '../../../tools/BashTool/BashTool.js';
import { getFirstWordPrefix, getSimpleCommandPrefix } from '../../../tools/BashTool/bashPermissions.js';
import { getDestructiveCommandWarning } from '../../../tools/BashTool/destructiveCommandWarning.js';
import { parseSedEditCommand } from '../../../tools/BashTool/sedEditParser.js';
import { shouldUseSandbox } from '../../../tools/BashTool/shouldUseSandbox.js';
import { getCompoundCommandPrefixesStatic } from '../../../utils/bash/prefix.js';
import { createPromptRuleContent, generateGenericDescription, getBashPromptAllowDescriptions, isClassifierPermissionsEnabled } from '../../../utils/permissions/bashClassifier.js';
import { extractRules } from '../../../utils/permissions/PermissionUpdate.js';
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js';
import { SandboxManager } from '../../../utils/sandbox/sandbox-adapter.js';
import { Select } from '../../CustomSelect/select.js';
import { ShimmerChar } from '../../Spinner/ShimmerChar.js';
import { useShimmerAnimation } from '../../Spinner/useShimmerAnimation.js';
import { type UnaryEvent, usePermissionRequestLogging } from '../hooks.js';
import { PermissionDecisionDebugInfo } from '../PermissionDecisionDebugInfo.js';
import { PermissionDialog } from '../PermissionDialog.js';
import { PermissionExplainerContent, usePermissionExplainerUI } from '../PermissionExplanation.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';
import { SedEditPermissionRequest } from '../SedEditPermissionRequest/SedEditPermissionRequest.js';
import { useShellPermissionFeedback } from '../useShellPermissionFeedback.js';
import { logUnaryPermissionEvent } from '../utils.js';
import { bashToolUseOptions } from './bashToolUseOptions.js';
const CHECKING_TEXT = '正在尝试自动批准\u2026';

// 将 20fps 的 shimmer 时钟与 BashPermissionRequestInner 隔离。在此之前，
// useShimmerAnimation 位于 535 行的 Internal 组件体内，因此每 50ms 的
// 时钟节拍都会重新渲染整个对话框（PermissionDialog + Select + 所有子组件），
// 持续约分类器通常所需的 1-3 秒。Inner 还具有 Compiler bailout（见下文），
// 因此没有任何内容被自动记忆化——每次分类器检查都会重建整个 JSX 树，共 20-60 次。
function ClassifierCheckingSubtitle() {
  const $ = _c(6);
  const [ref, glimmerIndex] = useShimmerAnimation("requesting", CHECKING_TEXT, false);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = [...CHECKING_TEXT];
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  let t1;
  if ($[1] !== glimmerIndex) {
    t1 = <Text>{t0.map((char, i) => <ShimmerChar key={i} char={char} index={i} glimmerIndex={glimmerIndex} messageColor="inactive" shimmerColor="subtle" />)}</Text>;
    $[1] = glimmerIndex;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  let t2;
  if ($[3] !== ref || $[4] !== t1) {
    t2 = <Box ref={ref}>{t1}</Box>;
    $[3] = ref;
    $[4] = t1;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  return t2;
}
export function BashPermissionRequest(props) {
  const $ = _c(21);
  const {
    toolUseConfirm,
    toolUseContext,
    onDone,
    onReject,
    verbose,
    workerBadge
  } = props;
  let command;
  let description;
  let t0;
  if ($[0] !== toolUseConfirm.input) {
    ({
      command,
      description
    } = BashTool.inputSchema.parse(toolUseConfirm.input));
    t0 = parseSedEditCommand(command);
    $[0] = toolUseConfirm.input;
    $[1] = command;
    $[2] = description;
    $[3] = t0;
  } else {
    command = $[1];
    description = $[2];
    t0 = $[3];
  }
  const sedInfo = t0;
  if (sedInfo) {
    let t1;
    if ($[4] !== onDone || $[5] !== onReject || $[6] !== sedInfo || $[7] !== toolUseConfirm || $[8] !== toolUseContext || $[9] !== verbose || $[10] !== workerBadge) {
      t1 = <SedEditPermissionRequest toolUseConfirm={toolUseConfirm} toolUseContext={toolUseContext} onDone={onDone} onReject={onReject} verbose={verbose} workerBadge={workerBadge} sedInfo={sedInfo} />;
      $[4] = onDone;
      $[5] = onReject;
      $[6] = sedInfo;
      $[7] = toolUseConfirm;
      $[8] = toolUseContext;
      $[9] = verbose;
      $[10] = workerBadge;
      $[11] = t1;
    } else {
      t1 = $[11];
    }
    return t1;
  }
  let t1;
  if ($[12] !== command || $[13] !== description || $[14] !== onDone || $[15] !== onReject || $[16] !== toolUseConfirm || $[17] !== toolUseContext || $[18] !== verbose || $[19] !== workerBadge) {
    t1 = <BashPermissionRequestInner toolUseConfirm={toolUseConfirm} toolUseContext={toolUseContext} onDone={onDone} onReject={onReject} verbose={verbose} workerBadge={workerBadge} command={command} description={description} />;
    $[12] = command;
    $[13] = description;
    $[14] = onDone;
    $[15] = onReject;
    $[16] = toolUseConfirm;
    $[17] = toolUseContext;
    $[18] = verbose;
    $[19] = workerBadge;
    $[20] = t1;
  } else {
    t1 = $[20];
  }
  return t1;
}

// 使用 hooks 的内部组件——仅针对非 MCP CLI 命令调用
function BashPermissionRequestInner({
  toolUseConfirm,
  toolUseContext,
  onDone,
  onReject,
  verbose: _verbose,
  workerBadge,
  command,
  description
}: PermissionRequestProps & {
  command: string;
  description?: string;
}): React.ReactNode {
  const [theme] = useTheme();
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const explainerState = usePermissionExplainerUI({
    toolName: toolUseConfirm.tool.name,
    toolInput: toolUseConfirm.input,
    toolDescription: toolUseConfirm.description,
    messages: toolUseContext.messages
  });
  const {
    yesInputMode,
    noInputMode,
    yesFeedbackModeEntered,
    noFeedbackModeEntered,
    acceptFeedback,
    rejectFeedback,
    setAcceptFeedback,
    setRejectFeedback,
    focusedOption,
    handleInputModeToggle,
    handleReject,
    handleFocus
  } = useShellPermissionFeedback({
    toolUseConfirm,
    onDone,
    onReject,
    explainerVisible: explainerState.visible
  });
  const [showPermissionDebug, setShowPermissionDebug] = useState(false);
  const [classifierDescription, setClassifierDescription] = useState(description || '');
  // 记录初始描述（来自属性或异步生成）是否为空。
  // 一旦收到非空描述，此值将保持为 false。
  const [initialClassifierDescriptionEmpty, setInitialClassifierDescriptionEmpty] = useState(!description?.trim());

  // 为分类器异步生成通用描述
  useEffect(() => {
    if (!isClassifierPermissionsEnabled()) return;
    const abortController = new AbortController();
    generateGenericDescription(command, description, abortController.signal).then(generic => {
      if (generic && !abortController.signal.aborted) {
        setClassifierDescription(generic);
        setInitialClassifierDescriptionEmpty(false);
      }
    }).catch(() => {}); // 出错时保留原始描述
    return () => abortController.abort();
  }, [command, description]);

  // GH#11380：对于复合命令（cd src && git status && npm test），后端已通过
  // tree-sitter 拆分 + 逐子命令权限检查计算出正确的逐子命令建议。
  // decisionReason.type === 'subcommandResults' 标记此路径。下面的同步前缀
  // 启发式（getSimpleCommandPrefix/getFirstWordPrefix）针对整个复合字符串操作，
  // 并选取前两个词——从而产生诸如 `Bash(cd src:*)` 或 `Bash(./script.sh && npm test)`
  // 这样永远不会再次匹配的死规则。用户会在 settings.local.json 中积累 150 多条这样的规则。
  //
  // 当复合命令恰好只有一条 Bash 规则（例如 `cd src && npm test`，其中 cd 是
  // 只读的 → 仅 npm test 需要批准）时，从后端规则中植入可编辑输入。
  // 当复合命令有 2 条或更多规则时，editablePrefix 保持 undefined，以便
  // bashToolUseOptions 回退到 yes-apply-suggestions，这样会原子地保存所有
  // 逐子命令规则。
  const isCompound = toolUseConfirm.permissionResult.decisionReason?.type === 'subcommandResults';

  // 可编辑前缀——先同步地用我们能提取的最佳前缀初始化，
  // 然后针对复合命令通过 tree-sitter 细化。同步路径很重要，因为
  // TREE_SITTER_BASH 仅针对 ant 版本启用：在外部构建中，下面的异步
  // 细化总是解析为 []，这个初始值就是用户看到的内容。
  //
  // 惰性初始化器：如果留在渲染体内，每次渲染都会运行正则 + 拆分；
  // 它仅用于初始状态。
  const [editablePrefix, setEditablePrefix] = useState<string | undefined>(() => {
    if (isCompound) {
      // 对于复合命令，后端建议是唯一可信来源。
      // 单条规则 → 填充可编辑输入，以便用户可以细化它。
      // 多条/零条规则 → undefined → 由 yes-apply-suggestions 处理。
      const backendBashRules = extractRules('suggestions' in toolUseConfirm.permissionResult ? toolUseConfirm.permissionResult.suggestions : undefined).filter(r => r.toolName === BashTool.name && r.ruleContent);
      return backendBashRules.length === 1 ? backendBashRules[0]!.ruleContent : undefined;
    }
    const two = getSimpleCommandPrefix(command);
    if (two) return `${two}:*`;
    const one = getFirstWordPrefix(command);
    if (one) return `${one}:*`;
    return command;
  });
  const hasUserEditedPrefix = useRef(false);
  const onEditablePrefixChange = useCallback((value: string) => {
    hasUserEditedPrefix.current = true;
    setEditablePrefix(value);
  }, []);
  useEffect(() => {
    // 跳过复合命令的异步细化——后端已经运行了完整的逐子命令分析，
    // 并且其建议是正确的。
    if (isCompound) return;
    let cancelled = false;
    getCompoundCommandPrefixesStatic(command, subcmd => BashTool.isReadOnly({
      command: subcmd
    })).then(prefixes => {
      if (cancelled || hasUserEditedPrefix.current) return;
      if (prefixes.length > 0) {
        setEditablePrefix(`${prefixes[0]}:*`);
      }
    }).catch(() => {}); // 在 tree-sitter 失败时保留同步前缀
    return () => {
      cancelled = true;
    };
  }, [command, isCompound]);

  // 跟踪分类器检查是否曾进行过（完成后仍然保留）。
  // classifierCheckInProgress 在入队时（interactiveHandler）一次性设置，
  // 并且只会从 true→false 转变，因此捕获挂载时的值就足够了——无需
  // latch/ref。feature() 三元表达式让该属性读取保持在外部构建之外
  // （用于 forbidden-string 检查）。
  const [classifierWasChecking] = useState(feature('BASH_CLASSIFIER') ? !!toolUseConfirm.classifierCheckInProgress : false);

  // 这些仅由工具输入派生（对于对话框生命周期而言是固定的）。
  // shimmer 时钟以前位于此组件内，并在分类器运行时以 20fps 的速度重新渲染它
  //（参见上面的 ClassifierCheckingSubtitle 了解该提取）。React Compiler 无法自动
  // 记忆化导入的函数（无法证明无副作用），因此这个 useMemo 仍然防范任何
  // 重新渲染来源（例如 Inner 状态更新）。与 PR#20730 相同模式。
  const {
    destructiveWarning: destructiveWarning_0,
    sandboxingEnabled: sandboxingEnabled_0,
    isSandboxed: isSandboxed_0
  } = useMemo(() => {
    const destructiveWarning = getFeatureValue_CACHED_MAY_BE_STALE('limkenion_destructive_command_warning', false) ? getDestructiveCommandWarning(command) : null;
    const sandboxingEnabled = SandboxManager.isSandboxingEnabled();
    const isSandboxed = sandboxingEnabled && shouldUseSandbox(toolUseConfirm.input);
    return {
      destructiveWarning,
      sandboxingEnabled,
      isSandboxed
    };
  }, [command, toolUseConfirm.input]);
  const unaryEvent = useMemo<UnaryEvent>(() => ({
    completion_type: 'tool_use_single',
    language_name: 'none'
  }), []);
  usePermissionRequestLogging(toolUseConfirm, unaryEvent);
  const existingAllowDescriptions = useMemo(() => getBashPromptAllowDescriptions(toolPermissionContext), [toolPermissionContext]);
  const options = useMemo(() => bashToolUseOptions({
    suggestions: toolUseConfirm.permissionResult.behavior === 'ask' ? toolUseConfirm.permissionResult.suggestions : undefined,
    decisionReason: toolUseConfirm.permissionResult.decisionReason,
    onRejectFeedbackChange: setRejectFeedback,
    onAcceptFeedbackChange: setAcceptFeedback,
    onClassifierDescriptionChange: setClassifierDescription,
    classifierDescription,
    initialClassifierDescriptionEmpty,
    existingAllowDescriptions,
    yesInputMode,
    noInputMode,
    editablePrefix,
    onEditablePrefixChange
  }), [toolUseConfirm, classifierDescription, initialClassifierDescriptionEmpty, existingAllowDescriptions, yesInputMode, noInputMode, editablePrefix, onEditablePrefixChange]);

  // 通过快捷键切换权限调试信息
  const handleToggleDebug = useCallback(() => {
    setShowPermissionDebug(prev => !prev);
  }, []);
  useKeybinding('permission:toggleDebug', handleToggleDebug, {
    context: 'Confirmation'
  });

  // 允许按 Esc 在自动批准后关闭对勾标记
  const handleDismissCheckmark = useCallback(() => {
    toolUseConfirm.onDismissCheckmark?.();
  }, [toolUseConfirm]);
  useKeybinding('confirm:no', handleDismissCheckmark, {
    context: 'Confirmation',
    isActive: feature('BASH_CLASSIFIER') ? !!toolUseConfirm.classifierAutoApproved : false
  });
  function onSelect(value_0: string) {
    // 为分析将选项映射为数值（logEvent 中不允许使用字符串）
    let optionIndex: Record<string, number> = {
      yes: 1,
      'yes-apply-suggestions': 2,
      'yes-prefix-edited': 2,
      no: 3
    };
    if (feature('BASH_CLASSIFIER')) {
      optionIndex = {
        yes: 1,
        'yes-apply-suggestions': 2,
        'yes-prefix-edited': 2,
        'yes-classifier-reviewed': 3,
        no: 4
      };
    }
    logEvent('limkenion_permission_request_option_selected', {
      option_index: optionIndex[value_0],
      explainer_visible: explainerState.visible
    });
    const toolNameForAnalytics = sanitizeToolNameForAnalytics(toolUseConfirm.tool.name) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    if (value_0 === 'yes-prefix-edited') {
      const trimmedPrefix = (editablePrefix ?? '').trim();
      logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
      if (!trimmedPrefix) {
        toolUseConfirm.onAllow(toolUseConfirm.input, []);
      } else {
        const prefixUpdates: PermissionUpdate[] = [{
          type: 'addRules',
          rules: [{
            toolName: BashTool.name,
            ruleContent: trimmedPrefix
          }],
          behavior: 'allow',
          destination: 'localSettings'
        }];
        toolUseConfirm.onAllow(toolUseConfirm.input, prefixUpdates);
      }
      onDone();
      return;
    }
    if (feature('BASH_CLASSIFIER') && value_0 === 'yes-classifier-reviewed') {
      const trimmedDescription = classifierDescription.trim();
      logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
      if (!trimmedDescription) {
        toolUseConfirm.onAllow(toolUseConfirm.input, []);
      } else {
        const permissionUpdates: PermissionUpdate[] = [{
          type: 'addRules',
          rules: [{
            toolName: BashTool.name,
            ruleContent: createPromptRuleContent(trimmedDescription)
          }],
          behavior: 'allow',
          destination: 'session'
        }];
        toolUseConfirm.onAllow(toolUseConfirm.input, permissionUpdates);
      }
      onDone();
      return;
    }
    switch (value_0) {
      case 'yes':
        {
          const trimmedFeedback_0 = acceptFeedback.trim();
          logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
          // 记录带反馈上下文的接受提交
          logEvent('limkenion_accept_submitted', {
            toolName: toolNameForAnalytics,
            isMcp: toolUseConfirm.tool.isMcp ?? false,
            has_instructions: !!trimmedFeedback_0,
            instructions_length: trimmedFeedback_0.length,
            entered_feedback_mode: yesFeedbackModeEntered
          });
          toolUseConfirm.onAllow(toolUseConfirm.input, [], trimmedFeedback_0 || undefined);
          onDone();
          break;
        }
      case 'yes-apply-suggestions':
        {
          logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
          // 如果存在则提取建议（对 'ask' 和 'passthrough' 行为均有效）
          const permissionUpdates_0 = 'suggestions' in toolUseConfirm.permissionResult ? toolUseConfirm.permissionResult.suggestions || [] : [];
          toolUseConfirm.onAllow(toolUseConfirm.input, permissionUpdates_0);
          onDone();
          break;
        }
      case 'no':
        {
          const trimmedFeedback = rejectFeedback.trim();

          // 记录带反馈上下文的拒绝提交
          logEvent('limkenion_reject_submitted', {
            toolName: toolNameForAnalytics,
            isMcp: toolUseConfirm.tool.isMcp ?? false,
            has_instructions: !!trimmedFeedback,
            instructions_length: trimmedFeedback.length,
            entered_feedback_mode: noFeedbackModeEntered
          });

          // 处理拒绝（带或不带反馈）
          handleReject(trimmedFeedback || undefined);
          break;
        }
    }
  }
  const classifierSubtitle = feature('BASH_CLASSIFIER') ? toolUseConfirm.classifierAutoApproved ? <Text>
        <Text color="success">{figures.tick} 已自动批准</Text>
        {toolUseConfirm.classifierMatchedRule && <Text dimColor>
            {' \u00b7 匹配 "'}
            {toolUseConfirm.classifierMatchedRule}
            {'"'}
          </Text>}
      </Text> : toolUseConfirm.classifierCheckInProgress ? <ClassifierCheckingSubtitle /> : classifierWasChecking ? <Text dimColor>需要手动批准</Text> : undefined : undefined;
  return <PermissionDialog workerBadge={workerBadge} title={sandboxingEnabled_0 && !isSandboxed_0 ? 'Bash 命令（非沙箱）' : 'Bash 命令'} subtitle={classifierSubtitle}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text dimColor={explainerState.visible}>
          {BashTool.renderToolUseMessage({
          command,
          description
        }, {
          theme,
          verbose: true
        } // 始终显示完整命令
        )}
        </Text>
        {!explainerState.visible && <Text dimColor>{toolUseConfirm.description}</Text>}
        <PermissionExplainerContent visible={explainerState.visible} promise={explainerState.promise} />
      </Box>
      {showPermissionDebug ? <>
          <PermissionDecisionDebugInfo permissionResult={toolUseConfirm.permissionResult} toolName="Bash" />
          {toolUseContext.options.debug && <Box justifyContent="flex-end" marginTop={1}>
              <Text dimColor>Ctrl-D 以隐藏调试信息</Text>
            </Box>}
        </> : <>
          <Box flexDirection="column">
            <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="command" />
            {destructiveWarning_0 && <Box marginBottom={1}>
                <Text color="warning" dimColor={feature('BASH_CLASSIFIER') ? toolUseConfirm.classifierAutoApproved : false}>
                  {destructiveWarning_0}
                </Text>
              </Box>}
            <Text dimColor={feature('BASH_CLASSIFIER') ? toolUseConfirm.classifierAutoApproved : false}>
              是否继续？
            </Text>
            <Select options={feature('BASH_CLASSIFIER') ? toolUseConfirm.classifierAutoApproved ? options.map(o => ({
          ...o,
          disabled: true
        })) : options : options} isDisabled={feature('BASH_CLASSIFIER') ? toolUseConfirm.classifierAutoApproved : false} inlineDescriptions onChange={onSelect} onCancel={() => handleReject()} onFocus={handleFocus} onInputModeToggle={handleInputModeToggle} />
          </Box>
          <Box justifyContent="space-between" marginTop={1}>
            <Text dimColor>
              Esc 以取消
              {(focusedOption === 'yes' && !yesInputMode || focusedOption === 'no' && !noInputMode) && ' · Tab 以修改'}
              {explainerState.enabled && ` · ctrl+e 以${explainerState.visible ? '隐藏' : '解释'}`}
            </Text>
            {toolUseContext.options.debug && <Text dimColor>Ctrl+d 以显示调试信息</Text>}
          </Box>
        </>}
    </PermissionDialog>;
}