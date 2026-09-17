import * as React from 'react';
import { Text } from '../../ink.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, _context: LocalJSXCommandContext): Promise<React.ReactNode> {
  // Limkenion 是纯本地 DeepSeek 工具：没有在线订阅或升级服务。
  setTimeout(onDone, 0, 'no-op');
  return <Text>Limkenion 是纯本地 DeepSeek 工具，没有在线订阅或升级套餐。请设置 DEEPSEEK_API_KEY / OPENAI_API_KEY 环境变量即可使用。</Text>;
}