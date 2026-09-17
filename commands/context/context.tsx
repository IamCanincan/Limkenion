import { feature } from 'bun:bundle';
import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { ContextVisualization } from '../../components/ContextVisualization.js';
import { microcompactMessages } from '../../services/compact/microCompact.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import type { Message } from '../../types/message.js';
import { analyzeContextUsage } from '../../utils/analyzeContext.js';
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js';
import { renderToAnsiString } from '../../utils/staticRender.js';

/**
 * 在调用 API 之前应用与 query.ts 相同的上下文变换，使 /context 显示的是模型实际看到的
 * 内容，而非 REPL 的原始历史。若缺少 projectView，token 计数会按折叠掉的量高估——
 * 用户看到 "180k, 3 spans collapsed"，而 API 实际看到 120k。
 */
function toApiView(messages: Message[]): Message[] {
  let view = getMessagesAfterCompactBoundary(messages);
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      projectView
    } = require('../../services/contextCollapse/operations.js') as typeof import('../../services/contextCollapse/operations.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    view = projectView(view);
  }
  return view;
}
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const {
    messages,
    getAppState,
    options: {
      mainLoopModel,
      tools
    }
  } = context;
  const apiView = toApiView(messages);

  // 应用微压缩，获得发送给 API 的消息的准确表示
  const {
    messages: compactedMessages
  } = await microcompactMessages(apiView);

  // 获取终端宽度以便自适应尺寸
  const terminalWidth = process.stdout.columns || 80;
  const appState = getAppState();

  // 使用压缩后的消息分析上下文
  // 将原始消息作为最后一个参数传入，以便准确提取 API 用量
  const data = await analyzeContextUsage(compactedMessages, mainLoopModel, async () => appState.toolPermissionContext, tools, appState.agentDefinitions, terminalWidth, context,
  // 传入完整上下文供 system prompt 计算
  undefined,
  // mainThreadAgentDefinition
  apiView // 供 API 用量提取的原始消息
  );

  // 渲染为 ANSI 字符串以保留颜色，并像 local 命令那样传给 onDone
  const output = await renderToAnsiString(<ContextVisualization data={data} />);
  onDone(output);
  return null;
}