import { feature } from 'bun:bundle'
import { getModelOptions } from '../../utils/model/modelOptions.js'
import {
  getOptionsForSetting,
  SUPPORTED_SETTINGS,
} from './supportedSettings.js'

export const DESCRIPTION = '获取或设置 Limkenion 配置设置。'

/**
 * 从注册表中生成提示文档
 */
export function generatePrompt(): string {
  const globalSettings: string[] = []
  const projectSettings: string[] = []

  for (const [key, config] of Object.entries(SUPPORTED_SETTINGS)) {
    // 跳过模型——它有单独一节，带动态选项
    if (key === 'model') continue
    const options = getOptionsForSetting(key)
    let line = `- ${key}`

    if (options) {
      line += `: ${options.map(o => `"${o}"`).join(', ')}`
    } else if (config.type === 'boolean') {
      line += `: true/false`
    }

    line += ` - ${config.description}`

    if (config.source === 'global') {
      globalSettings.push(line)
    } else {
      projectSettings.push(line)
    }
  }

  const modelSection = generateModelSection()

  return `获取或设置 Limkenion 配置设置。

  查看或更改 Limkenion 设置。当用户请求配置更改、询问当前设置，或调整某一设置对他们有益时使用。


## 用法
- **获取当前值：** 省略 "value" 参数
- **设置新值：** 提供 "value" 参数

## 可配置项列表
以下设置可供你修改：

### 全局设置（存储在 ~/.limkenion.json 中）
${globalSettings.join('\n')}

### 项目设置（存储在 settings.json 中）
${projectSettings.join('\n')}

${modelSection}
## 示例
- 获取主题：{ "setting": "theme" }
- 设置深色主题：{ "setting": "theme", "value": "dark" }
- 启用 vim 模式：{ "setting": "editorMode", "value": "vim" }
- 启用详细输出：{ "setting": "verbose", "value": true }
- 更换模型：{ "setting": "model", "value": "deepseek-v4-pro" }
- 更改权限模式：{ "setting": "permissions.defaultMode", "value": "plan" }
`
}

function generateModelSection(): string {
  try {
    const options = getModelOptions()
    const lines = options.map(o => {
      const value = o.value === null ? 'null/"default"' : `"${o.value}"`
      return `  - ${value}: ${o.descriptionForModel ?? o.description}`
    })
    return `## 模型
- model - 覆盖默认模型。可用选项：
${lines.join('\n')}`
  } catch {
    return `## 模型
- model - 覆盖默认模型（deepseek-flash、deepseek-v4-pro）`
  }
}
