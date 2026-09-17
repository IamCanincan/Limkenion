import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import {
  getKeybindingsPath,
  isKeybindingCustomizationEnabled,
} from '../../keybindings/loadUserBindings.js'
import { generateKeybindingsTemplate } from '../../keybindings/template.js'
import { getErrnoCode } from '../../utils/errors.js'
import { editFileInEditor } from '../../utils/promptEditor.js'

export async function call(): Promise<{ type: 'text'; value: string }> {
  if (!isKeybindingCustomizationEnabled()) {
    return {
      type: 'text',
      value:
        'Keybinding customization is not enabled. This feature is currently in preview.',
    }
  }

  const keybindingsPath = getKeybindingsPath()

  // 以 'wx' 标志写入模板（独占创建）—— 若文件已存在则会以 EEXIST
  // 失败。这样可避免 stat 预检查（TOCTOU 竞态 + 额外的系统调用）。
  let fileExists = false
  await mkdir(dirname(keybindingsPath), { recursive: true })
  try {
    await writeFile(keybindingsPath, generateKeybindingsTemplate(), {
      encoding: 'utf-8',
      flag: 'wx',
    })
  } catch (e: unknown) {
    if (getErrnoCode(e) === 'EEXIST') {
      fileExists = true
    } else {
      throw e
    }
  }

  // 在编辑器中打开
  const result = await editFileInEditor(keybindingsPath)
  if (result.error) {
    return {
      type: 'text',
      value: `${fileExists ? 'Opened' : 'Created'} ${keybindingsPath}. Could not open in editor: ${result.error}`,
    }
  }
  return {
    type: 'text',
    value: fileExists
      ? `Opened ${keybindingsPath} in your editor.`
      : `Created ${keybindingsPath} with template. Opened in your editor.`,
  }
}
