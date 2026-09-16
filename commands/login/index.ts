import type { Command } from '../../commands.js'
import { hasLimkenionApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: hasLimkenionApiKeyAuth()
      ? 'Switch Limkenion accounts'
      : 'Sign in with your Limkenion account',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
