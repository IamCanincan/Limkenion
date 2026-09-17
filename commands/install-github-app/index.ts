import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const installGitHubApp = {
  type: 'local-jsx',
  name: 'install-github-app',
  description: '为仓库配置 Limkenion GitHub Actions',
  availability: ['limkenion-ai', 'console'],
  // 无网站与云服务：这套流程要安装 limkenion.ai 的 GitHub App，
  // 该服务并不存在，整条链路（安装 → 授权 → 回跳）都走不通。
  isEnabled: () => false,
  load: () => import('./install-github-app.js'),
} satisfies Command

export default installGitHubApp
