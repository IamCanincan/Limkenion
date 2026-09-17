import React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { Login } from '../login/login.js';
import { runExtraUsage } from './extra-usage-core.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode | null> {
  const result = await runExtraUsage();
  if (result.type === 'message') {
    onDone(result.value);
    return null;
  }
  return <Login startingMessage={'需要配置 DeepSeek API Key 后继续。/extra-usage 依赖 DeepSeek 计费。按 Ctrl-C 取消。'} onDone={success => {
    context.onChangeAPIKey();
    onDone(success ? '已配置 DeepSeek API Key' : '已取消配置');
  }} />;
}