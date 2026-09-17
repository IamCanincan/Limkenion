import type { ContentBlockParam } from '../../types/llm-protocol.js';
import React from 'react';
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js';
import { checkOverageGate, confirmOverage, launchRemoteReview } from './reviewRemote.js';
import { UltrareviewOverageDialog } from './UltrareviewOverageDialog.js';
function contentBlocksToString(blocks: ContentBlockParam[]): string {
  return blocks.map(b => b.type === 'text' ? b.text : '').filter(Boolean).join('\n');
}
async function launchAndDone(args: string, context: Parameters<LocalJSXCommandCall>[1], onDone: LocalJSXCommandOnDone, billingNote: string, signal?: AbortSignal): Promise<void> {
  const result = await launchRemoteReview(args, context, billingNote);
  // 用户在约 5 秒的启动过程中按下了 Escape —— 对话框已显示
  // “cancelled” 并卸载，因此跳过 onDone（否则会写入已失效的
  // transcript 槽位），并让调用方跳过 confirmOverage。
  if (signal?.aborted) return;
  if (result) {
    onDone(contentBlocksToString(result), {
      shouldQuery: true
    });
  } else {
    // 前置条件失败现在会在上方返回具体的 ContentBlockParam[]。
    // 只有 teleport 失败（PR 模式）或非 github 仓库时才会走到
    // 这里的 null —— 两者都是 CCR/仓库连接问题。
    onDone('Ultrareview failed to launch the remote session. Check that this is a GitHub repo and try again.', {
      display: 'system'
    });
  }
}
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const gate = await checkOverageGate();
  if (gate.kind === 'not-enabled') {
    onDone('Free ultrareviews used. Enable Extra Usage at https://limkenion.ai/settings/billing to continue.', {
      display: 'system'
    });
    return null;
  }
  if (gate.kind === 'low-balance') {
    onDone(`Balance too low to launch ultrareview ($${gate.available.toFixed(2)} available, $10 minimum). Top up at https://limkenion.ai/settings/billing`, {
      display: 'system'
    });
    return null;
  }
  if (gate.kind === 'needs-confirm') {
    return <UltrareviewOverageDialog onProceed={async signal => {
      await launchAndDone(args, context, onDone, ' This review bills as Extra Usage.', signal);
      // 仅在启动未被中止后才持久化确认标志 ——
      // 否则启动期间按 Escape 会让该标志保持设置，
      // 并在下次尝试时跳过此对话框。
      if (!signal.aborted) confirmOverage();
    }} onCancel={() => onDone('Ultrareview cancelled.', {
      display: 'system'
    })} />;
  }

  // gate.kind === 'proceed'
  await launchAndDone(args, context, onDone, gate.billingNote);
  return null;
};