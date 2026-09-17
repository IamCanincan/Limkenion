import type { Command } from '../../commands.js'
import { hasLimkenionApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: hasLimkenionApiKeyAuth()
      ? '重新配置 DeepSeek API Key'
      : '配置 DeepSeek / OpenAI 兼容 API Key',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
