import type { Command } from '../../commands.js'
import { hasLimkenionApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: hasLimkenionApiKeyAuth()
      ? '切换 Limkenion 账号'
      : '使用你的 Limkenion 账号登录',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
