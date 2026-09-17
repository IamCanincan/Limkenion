// 依赖用户设置的 Git 相关行为。
//
// 本文件放在 git.ts 之外，因为 git.ts 位于 vscode 扩展的依赖图里，
// 必须保持不依赖 settings.ts——后者会传递性地引入 @opentelemetry/api +
// undici（在 vscode 中被禁止）。这也会形成循环：
// settings.ts → git/gitignore.ts → git.ts，于是 git.ts → settings.ts 成环。
//
// 如果你想在 git.ts 里加 `import settings`——别这么做。把它放这里来。

import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

export function shouldIncludeGitInstructions(): boolean {
  const envVal = process.env.LIMKENION_DISABLE_GIT_INSTRUCTIONS
  if (isEnvTruthy(envVal)) return false
  if (isEnvDefinedFalsy(envVal)) return true
  return getInitialSettings().includeGitInstructions ?? true
}
