import { readFileSync } from 'fs';
import type { Command } from '../commands.js';
import { DIAMOND_OPEN } from '../constants/figures.js';
import { getRemoteSessionUrl } from '../constants/product.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../services/analytics/index.js';
import type { AppState } from '../state/AppStateStore.js';
import { checkRemoteAgentEligibility, formatPreconditionError, RemoteAgentTask, type RemoteAgentTaskState, registerRemoteAgentTask } from '../tasks/RemoteAgentTask/RemoteAgentTask.js';
import type { LocalJSXCommandCall } from '../types/command.js';
import { logForDebugging } from '../utils/debug.js';
import { errorMessage } from '../utils/errors.js';
import { logError } from '../utils/log.js';
import { enqueuePendingNotification } from '../utils/messageQueueManager.js';
import { ALL_MODEL_CONFIGS } from '../utils/model/configs.js';
import { updateTaskState } from '../utils/task/framework.js';
import { archiveRemoteSession, teleportToRemote } from '../utils/teleport.js';
import { pollForApprovedExitPlanMode, UltraplanPollError } from '../utils/ultraplan/ccrSession.js';

// TODO(prod-hardening): OAuth token may go stale over the 30min poll;
// 考虑刷新。

// 多代理探索较慢；30 分钟超时。
const ULTRAPLAN_TIMEOUT_MS = 30 * 60 * 1000;
export const CCR_TERMS_URL = 'https://code.limkenion.com/docs/en/limkenion-on-the-web';

// CCR 针对第一方 API 运行 —— 使用规范 ID，而非
// getModelStrings() 返回的提供者特定字符串（本地 CLI 上可能是
// Bedrock ARN 或 Vertex ID）。在调用时而非模块加载时读取：import 时
// GrowthBook 缓存为空，且 `/config` Gates 可在两次调用之间切换它。
function getUltraplanModel(): string {
  return getFeatureValue_CACHED_MAY_BE_STALE('limkenion_ultraplan_model', ALL_MODEL_CONFIGS.deepseekV4Pro.firstParty);
}

// prompt.txt 被包裹在 <system-reminder> 中，使 CCR 浏览器隐藏脚手架
// （CLI_BLOCK_TAGS 由 stripSystemNotifications 丢弃），
// 同时模型仍能看到完整文本。
// 措辞刻意避开功能名称，因为远程 CCR CLI 在任何标签剥离之前
// 就对原始输入运行关键词检测，prompt 中裸 "ultraplan" 会自触发
// /ultraplan，而它在无头模式下会作为 "Unknown skill" 被过滤
//
// Bundler 将 .txt 内联为字符串；测试运行器将其包装为 {default}。
/* eslint-disable @typescript-eslint/no-require-imports */
const _rawPrompt = require('../utils/ultraplan/prompt.txt');
/* eslint-enable @typescript-eslint/no-require-imports */
const DEFAULT_INSTRUCTIONS: string = (typeof _rawPrompt === 'string' ? _rawPrompt : _rawPrompt.default).trimEnd();

// 仅开发用的 prompt 覆盖，在模块加载时急切解析。
// 仅限 ant 构建（USER_TYPE 是构建期定义，
// 因此覆盖路径会从外部构建中 DCE 掉）。
// 仅支持 Shell 设置的环境变量，因此顶层 process.env 读取没问题
// —— settings.env 从不注入此值。
/* eslint-disable custom-rules/no-process-env-top-level, custom-rules/no-sync-fs -- ant-only dev override; eager top-level read is the point (crash at startup, not silently inside the slash-command try/catch) */
const ULTRAPLAN_INSTRUCTIONS: string = DEFAULT_INSTRUCTIONS;
/* eslint-enable custom-rules/no-process-env-top-level, custom-rules/no-sync-fs */

/**
 * 组装初始 CCR 用户消息。seedPlan 和 blurb 保持在
 * system-reminder 之外，使浏览器能渲染它们；脚手架被隐藏。
 */
export function buildUltraplanPrompt(blurb: string, seedPlan?: string): string {
  const parts: string[] = [];
  if (seedPlan) {
    parts.push('Here is a draft plan to refine:', '', seedPlan, '');
  }
  parts.push(ULTRAPLAN_INSTRUCTIONS);
  if (blurb) {
    parts.push('', blurb);
  }
  return parts.join('\n');
}
function startDetachedPoll(taskId: string, sessionId: string, url: string, getAppState: () => AppState, setAppState: (f: (prev: AppState) => AppState) => void): void {
  const started = Date.now();
  let failed = false;
  void (async () => {
    try {
      const {
        plan,
        rejectCount,
        executionTarget
      } = await pollForApprovedExitPlanMode(sessionId, ULTRAPLAN_TIMEOUT_MS, phase => {
        if (phase === 'needs_input') logEvent('limkenion_ultraplan_awaiting_input', {});
        updateTaskState<RemoteAgentTaskState>(taskId, setAppState, t => {
          if (t.status !== 'running') return t;
          const next = phase === 'running' ? undefined : phase;
          return t.ultraplanPhase === next ? t : {
            ...t,
            ultraplanPhase: next
          };
        });
      }, () => getAppState().tasks?.[taskId]?.status !== 'running');
      logEvent('limkenion_ultraplan_approved', {
        duration_ms: Date.now() - started,
        plan_length: plan.length,
        reject_count: rejectCount,
        execution_target: executionTarget as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      if (executionTarget === 'remote') {
        // 用户已在浏览器 PlanModal 中选择 "execute in CCR" —— 远程
        // 会话现在正在编码。跳过 archive（ARCHIVE 无运行检查，
        // 会在执行中途终止进程）并跳过选择对话框（已选择）。
        // 以任务状态为守卫，使 stopUltraplan 之后才 resolve 的 poll
        // 不会为已终止的会话发送通知。
        const task = getAppState().tasks?.[taskId];
        if (task?.status !== 'running') return;
        updateTaskState<RemoteAgentTaskState>(taskId, setAppState, t => t.status !== 'running' ? t : {
          ...t,
          status: 'completed',
          endTime: Date.now()
        });
        setAppState(prev => prev.ultraplanSessionUrl === url ? {
          ...prev,
          ultraplanSessionUrl: undefined
        } : prev);
        enqueuePendingNotification({
          value: [`Ultraplan 已批准 —— 正在 Limkenion on the web 中执行。前往查看进度：${url}`, '', '远程会话结束后，结果将作为 pull request 落地。这里无需任何操作。'].join('\n'),
          mode: 'task-notification'
        });
      } else {
        // Teleport：设置 pendingChoice，使 REPL 挂载 UltraplanChoiceDialog。
        // 对话框在选择时负责 archive 与 URL 清理。以任务状态为守卫，
        // 使 stopUltraplan 之后才 resolve 的 poll 不会让对话框
        // 为已终止的会话复活。
        setAppState(prev => {
          const task = prev.tasks?.[taskId];
          if (!task || task.status !== 'running') return prev;
          return {
            ...prev,
            ultraplanPendingChoice: {
              plan,
              sessionId,
              taskId
            }
          };
        });
      }
    } catch (e) {
      // 若任务已被停止（stopUltraplan 将 status 设为 killed），
      // poll 报错属预期 —— 跳过失败通知与清理
      // （kill() 已 archive；stopUltraplan 已清除 URL）。
      const task = getAppState().tasks?.[taskId];
      if (task?.status !== 'running') return;
      failed = true;
      logEvent('limkenion_ultraplan_failed', {
        duration_ms: Date.now() - started,
        reason: (e instanceof UltraplanPollError ? e.reason : 'network_or_unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        reject_count: e instanceof UltraplanPollError ? e.rejectCount : undefined
      });
      enqueuePendingNotification({
        value: `Ultraplan 失败：${errorMessage(e)}\n\n会话：${url}`,
        mode: 'task-notification'
      });
      // 错误路径拥有清理权；teleport 路径交由对话框处理；远程
      // 路径已在上方处理了自己的清理。
      void archiveRemoteSession(sessionId).catch(e => logForDebugging(`ultraplan archive 失败：${String(e)}`));
      setAppState(prev =>
      // 与此 poll 的 URL 比较，使重新启动的较新会话的
      // URL 不会被过期 poll 的报错清除。
      prev.ultraplanSessionUrl === url ? {
        ...prev,
        ultraplanSessionUrl: undefined
      } : prev);
    } finally {
      // 远程路径已在上方将 status 设为 completed；teleport 路径
      // 保持 status=running，使 pill 在 UltraplanChoiceDialog 在用户
      // 选择后完成任务之前显示 ultraplanPhase 状态。若在此设为 completed，
      // 会在 pill 能渲染阶段状态前把任务从 isBackgroundTask 中过滤掉。
      // 失败路径无对话框，因此在此处负责状态转移。
      if (failed) {
        updateTaskState<RemoteAgentTaskState>(taskId, setAppState, t => t.status !== 'running' ? t : {
          ...t,
          status: 'failed',
          endTime: Date.now()
        });
      }
    }
  })();
}

// 立即渲染，使终端在数秒的 teleportToRemote 往返期间不显得卡住。
function buildLaunchMessage(disconnectedBridge?: boolean): string {
  // Bridge 已移除 —— 无断开前缀。
  const prefix = '';
  return `${DIAMOND_OPEN} ultraplan\n${prefix}正在启动 Limkenion on the web…`;
}
function buildSessionReadyMessage(url: string): string {
  return `${DIAMOND_OPEN} ultraplan · 在 Limkenion on the web 中监控进度 ${url}\n你可以继续工作 —— 当 ${DIAMOND_OPEN} 填满时，按下 ↓ 查看结果`;
}
function buildAlreadyActiveMessage(url: string | undefined): string {
  return url ? `ultraplan: 已在轮询。打开 ${url} 查看状态，或等待计划落到此处。` : 'ultraplan: 正在启动。请等待会话开始。';
}

/**
 * 停止正在运行的 ultraplan：archive 远程会话（暂停它但保持
 * URL 可见）、终止本地任务记录（清除 pill），并清除
 * ultraplanSessionUrl（重新武装关键词触发器）。startDetachedPoll 的
 * shouldStop 回调在其下一拍看到 killed 状态并抛出异常；
 * 当 status !== 'running' 时 catch 块提前返回。
 */
export async function stopUltraplan(taskId: string, sessionId: string, setAppState: (f: (prev: AppState) => AppState) => void): Promise<void> {
  // RemoteAgentTask.kill 会 archive 会话（带 .catch）—— 此处无需
  // 单独调用 archive。
  await RemoteAgentTask.kill(taskId, setAppState);
  setAppState(prev => prev.ultraplanSessionUrl || prev.ultraplanPendingChoice || prev.ultraplanLaunching ? {
    ...prev,
    ultraplanSessionUrl: undefined,
    ultraplanPendingChoice: undefined,
    ultraplanLaunching: undefined
  } : prev);
  const url = getRemoteSessionUrl(sessionId, process.env.SESSION_INGRESS_URL);
  enqueuePendingNotification({
    value: `Ultraplan 已停止。\n\n会话：${url}`,
    mode: 'task-notification'
  });
  enqueuePendingNotification({
    value: '用户已停止上方的 ultraplan 会话。请勿响应该停止通知 —— 等待他们的下一条消息。',
    mode: 'task-notification',
    isMeta: true
  });
}

/**
 * 斜杠命令、关键词触发器以及计划审批对话框 "Ultraplan" 按钮的
 * 共用入口。当存在 seedPlan（对话框路径）时，它会被前置为待优化的
 * 草案；该情况下 blurb 可能为空。
 *
 * 立即以面向用户的消息 resolve。资格检查、
 * 会话创建与任务注册以分离方式运行，失败通过
 * enqueuePendingNotification 呈现。
 */
export async function launchUltraplan(opts: {
  blurb: string;
  seedPlan?: string;
  getAppState: () => AppState;
  setAppState: (f: (prev: AppState) => AppState) => void;
  signal: AbortSignal;
  /** 若调用方在启动前断开了 Remote Control，则为 true。 */
  disconnectedBridge?: boolean;
  /**
   * 在 teleportToRemote 以会话 URL resolve 时调用一次。拥有
   * setMessages 的调用方（REPL）会将其作为第二条转录消息追加，
   * 使 URL 无需打开 ↓ 详情视图即可见。无
   * 转录访问权限的调用方（ExitPlanModePermissionRequest）省略此回调
   * —— pill 仍会显示实时状态。
   */
  onSessionReady?: (msg: string) => void;
}): Promise<string> {
  const {
    blurb,
    seedPlan,
    getAppState,
    setAppState,
    signal,
    disconnectedBridge,
    onSessionReady
  } = opts;
  const {
    ultraplanSessionUrl: active,
    ultraplanLaunching
  } = getAppState();
  if (active || ultraplanLaunching) {
    logEvent('limkenion_ultraplan_create_failed', {
      reason: (active ? 'already_polling' : 'already_launching') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return buildAlreadyActiveMessage(active);
  }
  if (!blurb && !seedPlan) {
    // 无事件 —— 单独执行 /ultraplan 是查询用法，而不是一次尝试。
    return [
    // 通过 <Markdown> 渲染；裸 <message> 会被当作 HTML 分词
    // 并被丢弃。用反斜杠转义尖括号。
    '用法：/ultraplan \\<prompt\\>，或在提示的任意位置包含 "ultraplan"', '在你的提示中', '', '使用我们最强大模型的高级多代理计划模式', '(Opus)。在 Limkenion on the web 中运行。当计划就绪时，', '你可以在 web 会话中执行，或将其发回此处。', '远程规划期间终端保持空闲。', '需要 /login。', '', `条款：${CCR_TERMS_URL}`].join('\n');
  }

  // 在分离流程之前同步设置，防止 teleportToRemote 窗口期内的重复启动。
  setAppState(prev => prev.ultraplanLaunching ? prev : {
    ...prev,
    ultraplanLaunching: true
  });
  void launchDetached({
    blurb,
    seedPlan,
    getAppState,
    setAppState,
    signal,
    onSessionReady
  });
  return buildLaunchMessage(disconnectedBridge);
}
async function launchDetached(opts: {
  blurb: string;
  seedPlan?: string;
  getAppState: () => AppState;
  setAppState: (f: (prev: AppState) => AppState) => void;
  signal: AbortSignal;
  onSessionReady?: (msg: string) => void;
}): Promise<void> {
  const {
    blurb,
    seedPlan,
    getAppState,
    setAppState,
    signal,
    onSessionReady
  } = opts;
  // 提升声明，使 catch 块在 teleportToRemote 成功后出错时能 archive
  // 远程会话（避免 30 分钟的孤立会话）。
  let sessionId: string | undefined;
  try {
    const model = getUltraplanModel();
    const eligibility = await checkRemoteAgentEligibility();
    if (!eligibility.eligible) {
      logEvent('limkenion_ultraplan_create_failed', {
        reason: 'precondition' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        precondition_errors: eligibility.errors.map(e => e.type).join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      const reasons = eligibility.errors.map(formatPreconditionError).join('\n');
      enqueuePendingNotification({
        value: `ultraplan: 无法启动远程会话 ——\n${reasons}`,
        mode: 'task-notification'
      });
      return;
    }
    const prompt = buildUltraplanPrompt(blurb, seedPlan);
    let bundleFailMsg: string | undefined;
    const session = await teleportToRemote({
      initialMessage: prompt,
      description: blurb || '优化本地计划',
      model,
      permissionMode: 'plan',
      ultraplan: true,
      signal,
      useDefaultEnvironment: true,
      onBundleFail: msg => {
        bundleFailMsg = msg;
      }
    });
    if (!session) {
      logEvent('limkenion_ultraplan_create_failed', {
        reason: (bundleFailMsg ? 'bundle_fail' : 'teleport_null') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      enqueuePendingNotification({
        value: `ultraplan: 会话创建失败${bundleFailMsg ? ` —— ${bundleFailMsg}` : ''}。使用 --debug 查看详情。`,
        mode: 'task-notification'
      });
      return;
    }
    sessionId = session.id;
    const url = getRemoteSessionUrl(session.id, process.env.SESSION_INGRESS_URL);
    setAppState(prev => ({
      ...prev,
      ultraplanSessionUrl: url,
      ultraplanLaunching: undefined
    }));
    onSessionReady?.(buildSessionReadyMessage(url));
    logEvent('limkenion_ultraplan_launched', {
      has_seed_plan: Boolean(seedPlan),
      model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    // TODO(#23985): 将 registerRemoteAgentTask + startDetachedPoll 替换为
    // startRemoteSessionPolling 内部的 ExitPlanModeScanner。
    const {
      taskId
    } = registerRemoteAgentTask({
      remoteTaskType: 'ultraplan',
      session: {
        id: session.id,
        title: blurb || 'Ultraplan'
      },
      command: blurb,
      context: {
        abortController: new AbortController(),
        getAppState,
        setAppState
      },
      isUltraplan: true
    });
    startDetachedPoll(taskId, session.id, url, getAppState, setAppState);
  } catch (e) {
    logError(e);
    logEvent('limkenion_ultraplan_create_failed', {
      reason: 'unexpected_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    enqueuePendingNotification({
      value: `ultraplan: 意外错误 —— ${errorMessage(e)}`,
      mode: 'task-notification'
    });
    if (sessionId) {
      // teleport 成功后出错 —— archive，使远程不会在无人轮询的情况下
      // 空跑 30 分钟。
      void archiveRemoteSession(sessionId).catch(err => logForDebugging('ultraplan: failed to archive orphaned session', err));
      // ultraplanSessionUrl 可能在抛出异常前已被设置；清除它，
      // 使 "already polling" 守卫不会阻塞未来的启动。
      setAppState(prev => prev.ultraplanSessionUrl ? {
        ...prev,
        ultraplanSessionUrl: undefined
      } : prev);
    }
  } finally {
    // 成功时为空操作：设置 url 的 setAppState 已清除它。
    setAppState(prev => prev.ultraplanLaunching ? {
      ...prev,
      ultraplanLaunching: undefined
    } : prev);
  }
}
const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const blurb = args.trim();

  // 裸 /ultraplan（无参数、无 seed plan）只显示用法 —— 不弹对话框。
  if (!blurb) {
    const msg = await launchUltraplan({
      blurb,
      getAppState: context.getAppState,
      setAppState: context.setAppState,
      signal: context.abortController.signal
    });
    onDone(msg, {
      display: 'system'
    });
    return null;
  }

  // 守卫与 launchUltraplan 自身的检查一致 —— 在会话已活动或
  // 正在启动时显示对话框会浪费用户的点击，并在启动失败前
  // 就设置 hasSeenUltraplanTerms。
  const {
    ultraplanSessionUrl: active,
    ultraplanLaunching
  } = context.getAppState();
  if (active || ultraplanLaunching) {
    logEvent('limkenion_ultraplan_create_failed', {
      reason: (active ? 'already_polling' : 'already_launching') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    onDone(buildAlreadyActiveMessage(active), {
      display: 'system'
    });
    return null;
  }

  // 通过 focusedInputDialog（底部区域，类似
  // 权限对话框）挂载启动前对话框，而非返回 JSX（转录区域，
  // 锚定在回滚记录顶部）。REPL.tsx 在选择时处理启动/清除/取消。
  context.setAppState(prev => ({
    ...prev,
    ultraplanLaunchPending: {
      blurb
    }
  }));
  // 'skip' 抑制（无内容）回显 —— 对话框的选择处理器
  // 添加真正的 /ultraplan 回显 + 启动确认。
  onDone(undefined, {
    display: 'skip'
  });
  return null;
};
export default {
  type: 'local-jsx',
  name: 'ultraplan',
  description: `约 10–30 分钟 · Limkenion on the web 起草一份可编辑和批准的高级计划。参见 ${CCR_TERMS_URL}`,
  argumentHint: '<prompt>',
  isEnabled: () => false,
  load: () => Promise.resolve({
    call
  })
} satisfies Command;