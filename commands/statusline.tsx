import type { ContentBlockParam } from '../types/llm-protocol.js';
import type { Command } from '../commands.js';
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js';
const statusline = {
  type: 'prompt',
  description: "设置 Limkenion 的状态栏界面",
  contentLength: 0,
  // 动态内容
  aliases: [],
  name: 'statusline',
  progressMessage: 'setting up statusLine',
  allowedTools: [AGENT_TOOL_NAME, 'Read(~/**)', 'Edit(~/.limkenion/settings.json)'],
  source: 'builtin',
  disableNonInteractive: true,
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const prompt = args.trim() || 'Configure my statusLine from my shell PS1 configuration';
    return [{
      type: 'text',
      text: `Create an ${AGENT_TOOL_NAME} with subagent_type "statusline-setup" and the prompt "${prompt}"`
    }];
  }
} satisfies Command;
export default statusline;