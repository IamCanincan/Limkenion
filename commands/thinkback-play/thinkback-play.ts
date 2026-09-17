import { join } from 'path'
import type { LocalCommandResult } from '../../commands.js'
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js'
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js'
import { playAnimation } from '../thinkback/thinkback.js'

const INTERNAL_MARKETPLACE_NAME = 'limkenion-marketplace'
const SKILL_NAME = 'thinkback'

function getPluginId(): string {
  const marketplaceName =
    OFFICIAL_MARKETPLACE_NAME
  return `thinkback@${marketplaceName}`
}

export async function call(): Promise<LocalCommandResult> {
  // 从已安装插件配置获取技能目录
  const v2Data = loadInstalledPluginsV2()
  const pluginId = getPluginId()
  const installations = v2Data.plugins[pluginId]

  if (!installations || installations.length === 0) {
    return {
      type: 'text' as const,
      value:
        'Thinkback 插件未安装。请先运行 /think-back 安装它。',
    }
  }

  const firstInstall = installations[0]
  if (!firstInstall?.installPath) {
    return {
      type: 'text' as const,
      value: '未找到 Thinkback 插件的安装路径。',
    }
  }

  const skillDir = join(firstInstall.installPath, 'skills', SKILL_NAME)
  const result = await playAnimation(skillDir)
  return { type: 'text' as const, value: result.message }
}
