import { c as _c } from "react/compiler-runtime";
import chalk from 'chalk';
import * as React from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { ModelPicker } from '../../components/ModelPicker.js';
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import type { EffortLevel } from '../../utils/effort.js';
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js';
import { clearFastModeCooldown, isFastModeAvailable, isFastModeEnabled, isFastModeSupportedByModel } from '../../utils/fastMode.js';
import { MODEL_ALIASES } from '../../utils/model/aliases.js';
import { getDefaultMainLoopModelSetting, is1mContextMergeEnabled, renderDefaultModelSetting } from '../../utils/model/model.js';
import { isModelAllowed } from '../../utils/model/modelAllowlist.js';
import { validateModel } from '../../utils/model/validateModel.js';
import { setRuntimeReasoningEffort } from '../../services/api/openai-compat.js';
function ModelPickerWrapper(t0) {
  const $ = _c(17);
  const {
    onDone
  } = t0;
  const mainLoopModel = useAppState(_temp);
  const mainLoopModelForSession = useAppState(_temp2);
  const isFastMode = useAppState(_temp3);
  const setAppState = useSetAppState();
  let t1;
  if ($[0] !== mainLoopModel || $[1] !== onDone) {
    t1 = function handleCancel() {
      logEvent("limkenion_model_command_menu", {
        action: "cancel" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      const displayModel = renderModelLabel(mainLoopModel);
      onDone(`保留模型为 ${chalk.bold(displayModel)}`, {
        display: "system"
      });
    };
    $[0] = mainLoopModel;
    $[1] = onDone;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const handleCancel = t1;
  let t2;
  if ($[3] !== isFastMode || $[4] !== mainLoopModel || $[5] !== onDone || $[6] !== setAppState) {
    t2 = function handleSelect(model, effort) {
      logEvent("limkenion_model_command_menu", {
        action: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        from_model: mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        to_model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      setAppState(prev => ({
        ...prev,
        mainLoopModel: model,
        mainLoopModelForSession: null
      }));
      let message = `模型已设为 ${chalk.bold(renderModelLabel(model))}`;
      if (effort !== undefined) {
        message = message + `，投入度 ${chalk.bold(effort)}`;
      }
      let wasFastModeToggledOn = undefined;
      if (isFastModeEnabled()) {
        clearFastModeCooldown();
        if (!isFastModeSupportedByModel(model) && isFastMode) {
          setAppState(_temp4);
          wasFastModeToggledOn = false;
        } else {
          if (isFastModeSupportedByModel(model) && isFastModeAvailable() && isFastMode) {
            message = message + " · Fast 模式：已开启";
            wasFastModeToggledOn = true;
          }
        }
      }
      if (isBilledAsExtraUsage(model, wasFastModeToggledOn === true, is1mContextMergeEnabled())) {
        message = message + " · 计费为额外用量";
      }
      if (wasFastModeToggledOn === false) {
        message = message + " · Fast 模式：已关闭";
      }
      onDone(message);
    };
    $[3] = isFastMode;
    $[4] = mainLoopModel;
    $[5] = onDone;
    $[6] = setAppState;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  const handleSelect = t2;
  let t3;
  if ($[8] !== isFastMode || $[9] !== mainLoopModel) {
    t3 = isFastModeEnabled() && isFastMode && isFastModeSupportedByModel(mainLoopModel) && isFastModeAvailable();
    $[8] = isFastMode;
    $[9] = mainLoopModel;
    $[10] = t3;
  } else {
    t3 = $[10];
  }
  let t4;
  if ($[11] !== handleCancel || $[12] !== handleSelect || $[13] !== mainLoopModel || $[14] !== mainLoopModelForSession || $[15] !== t3) {
    t4 = <ModelPicker initial={mainLoopModel} sessionModel={mainLoopModelForSession} onSelect={handleSelect} onCancel={handleCancel} isStandaloneCommand={true} showFastModeNotice={t3} />;
    $[11] = handleCancel;
    $[12] = handleSelect;
    $[13] = mainLoopModel;
    $[14] = mainLoopModelForSession;
    $[15] = t3;
    $[16] = t4;
  } else {
    t4 = $[16];
  }
  return t4;
}
function _temp4(prev_0) {
  return {
    ...prev_0,
    fastMode: false
  };
}
function _temp3(s_1) {
  return s_1.fastMode;
}
function _temp2(s_0) {
  return s_0.mainLoopModelForSession;
}
function _temp(s) {
  return s.mainLoopModel;
}
function SetModelAndClose({
  args,
  onDone
}: {
  args: string;
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
}): React.ReactNode {
  const isFastMode = useAppState(s => s.fastMode);
  const setAppState = useSetAppState();
  const model = args === 'default' ? null : args;
  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(`模型「${model}」不可用。你的组织限制了可用的模型。`, {
          display: 'system'
        });
        return;
      }

      // 跳过默认模型的校验
      if (!model) {
        setModel(null);
        return;
      }

      // 跳过已知别名的校验 —— 它们是预定义的，应当可用
      if (isKnownAlias(model)) {
        setModel(model);
        return;
      }

      // 校验并设置自定义模型
      try {
        // 对非别名不要使用 parseUserSpecifiedModel，因为它会把输入转为小写，
        // 而模型名称区分大小写
        const {
          valid,
          error: error_0
        } = await validateModel(model);
        if (valid) {
          setModel(model);
        } else {
          onDone(error_0 || `模型「${model}」未找到`, {
            display: 'system'
          });
        }
      } catch (error) {
        onDone(`校验模型失败：${(error as Error).message}`, {
          display: 'system'
        });
      }
    }
    function setModel(modelValue: string | null): void {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelForSession: null
      }));
      let message = `模型已设为 ${chalk.bold(renderModelLabel(modelValue))}`;
      let wasFastModeToggledOn = undefined;
      if (isFastModeEnabled()) {
        clearFastModeCooldown();
        if (!isFastModeSupportedByModel(modelValue) && isFastMode) {
          setAppState(prev_0 => ({
            ...prev_0,
            fastMode: false
          }));
          wasFastModeToggledOn = false;
          // 不要在设置中更新快速模式，因为这是一次自动降级
        } else if (isFastModeSupportedByModel(modelValue) && isFastMode) {
          message += ` · Fast 模式：已开启`;
          wasFastModeToggledOn = true;
        }
      }
      if (isBilledAsExtraUsage(modelValue, wasFastModeToggledOn === true, is1mContextMergeEnabled())) {
        message += ` · 计费为额外用量`;
      }
      if (wasFastModeToggledOn === false) {
        // 快速模式已被关闭，在额外用量计费之后显示后缀
        message += ` · Fast 模式：已关闭`;
      }
      onDone(message);
    }
    void handleModelChange();
  }, [model, onDone, setAppState]);
  return null;
}
function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(model.toLowerCase().trim());
}
function ShowModelAndClose(t0) {
  const {
    onDone
  } = t0;
  const mainLoopModel = useAppState(_temp7);
  const mainLoopModelForSession = useAppState(_temp8);
  const effortValue = useAppState(_temp9);
  const displayModel = renderModelLabel(mainLoopModel);
  const effortInfo = effortValue !== undefined ? `（投入度：${effortValue}）` : "";
  if (mainLoopModelForSession) {
    onDone(`当前模型：${chalk.bold(renderModelLabel(mainLoopModelForSession))}（由 plan 模式的会话语义覆盖）\n基础模型：${displayModel}${effortInfo}`);
  } else {
    onDone(`当前模型：${displayModel}${effortInfo}`);
  }
  return null;
}
function _temp9(s_1) {
  return s_1.effortValue;
}
function _temp8(s_0) {
  return s_0.mainLoopModelForSession;
}
function _temp7(s) {
  return s.mainLoopModel;
}
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || '';
  if (COMMON_INFO_ARGS.includes(args)) {
    logEvent('limkenion_model_command_inline_help', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return <ShowModelAndClose onDone={onDone} />;
  }
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone('运行 /model 打开模型选择菜单，运行 /model [模型名] 设置模型，或运行 /model [low|medium|high] 设置推理投入度。', {
      display: 'system'
    });
    return;
  }
  // 推理强度：/model low|medium|high 运行时切换（OpenAI 兼容模式下生效，
  // 对全部后续请求生效，无需重启；API 的 reasoning_effort 仅接受这三档）。
  if (args === 'low' || args === 'medium' || args === 'high') {
    setRuntimeReasoningEffort(args);
    onDone(`推理投入度已设为 ${chalk.bold(args)}`, {
      display: 'system'
    });
    return;
  }
  if (args) {
    logEvent('limkenion_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return <SetModelAndClose args={args} onDone={onDone} />;
  }
  return <ModelPickerWrapper onDone={onDone} />;
};
function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(model ?? getDefaultMainLoopModelSetting());
  return model === null ? `${rendered}（默认）` : rendered;
}