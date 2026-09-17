import { join } from 'path';
import React from 'react';
import { ExportDialog } from '../../components/ExportDialog.js';
import type { ToolUseContext } from '../../Tool.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import type { Message } from '../../types/message.js';
import { getCwd } from '../../utils/cwd.js';
import { renderMessagesToPlainText } from '../../utils/exportRenderer.js';
import { writeFileSync_DEPRECATED } from '../../utils/slowOperations.js';
function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}
export function extractFirstPrompt(messages: Message[]): string {
  const firstUserMessage = messages.find(msg => msg.type === 'user');
  if (!firstUserMessage || firstUserMessage.type !== 'user') {
    return '';
  }
  const content = firstUserMessage.message?.content;
  let result = '';
  if (typeof content === 'string') {
    result = content.trim();
  } else if (Array.isArray(content)) {
    const textContent = content.find(item => item.type === 'text');
    if (textContent && 'text' in textContent) {
      result = textContent.text.trim();
    }
  }

  // 只取第一行并限制长度
  result = result.split('\n')[0] || '';
  if (result.length > 50) {
    result = result.substring(0, 49) + '…';
  }
  return result;
}
export function sanitizeFilename(text: string): string {
  // 将特殊字符替换为连字符
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, '') // 移除特殊字符
  .replace(/\s+/g, '-') // 将空格替换为连字符
  .replace(/-+/g, '-') // 将多个连字符合并为一个
  .replace(/^-|-$/g, ''); // 移除首尾连字符
}
async function exportWithReactRenderer(context: ToolUseContext): Promise<string> {
  const tools = context.options.tools || [];
  return renderMessagesToPlainText(context.messages, tools);
}
export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext, args: string): Promise<React.ReactNode> {
  // 渲染对话内容
  const content = await exportWithReactRenderer(context);

  // 若提供了参数，则直接写入文件并跳过对话框
  const filename = args.trim();
  if (filename) {
    const finalFilename = filename.endsWith('.txt') ? filename : filename.replace(/\.[^.]+$/, '') + '.txt';
    const filepath = join(getCwd(), finalFilename);
    try {
      writeFileSync_DEPRECATED(filepath, content, {
        encoding: 'utf-8',
        flush: true
      });
      onDone(`Conversation exported to: ${filepath}`);
      return null;
    } catch (error) {
      onDone(`Failed to export conversation: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  // 根据首个提示词或时间戳生成默认文件名
  const firstPrompt = extractFirstPrompt(context.messages);
  const timestamp = formatTimestamp(new Date());
  let defaultFilename: string;
  if (firstPrompt) {
    const sanitized = sanitizeFilename(firstPrompt);
    defaultFilename = sanitized ? `${timestamp}-${sanitized}.txt` : `conversation-${timestamp}.txt`;
  } else {
    defaultFilename = `conversation-${timestamp}.txt`;
  }

  // 未提供参数时返回对话框组件
  return <ExportDialog content={content} defaultFilename={defaultFilename} onDone={result => {
    onDone(result.message);
  }} />;
}