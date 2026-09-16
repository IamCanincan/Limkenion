import { useEffect, useRef, useState } from 'react'
import type { PermissionMode, Settings, ThemeMode } from '../types'

interface Props {
  settings: Settings | null
  onSet: (key: 'theme' | 'permissionMode', value: string) => void
}

const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: '每次确认',
  acceptEdits: '自动放行编辑',
  plan: '计划模式',
  bypassPermissions: '全部放行',
}

const PERMISSION_DESC: Record<PermissionMode, string> = {
  default: '危险工具（执行/写盘）每次弹窗确认',
  acceptEdits: '自动放行 Write/Edit/NotebookEdit，执行类仍需确认',
  plan: '禁止一切有副作用的操作，只做只读探查',
  bypassPermissions: '不再弹窗，全部放行（谨慎使用）',
}

const THEME_LABEL: Record<ThemeMode, string> = {
  dark: '暗色',
  light: '亮色',
  system: '跟随系统',
}

/**
 * 顶栏设置：权限模式 + 主题（对齐 CLI 的 /permissions 与 /theme）。
 */
export function SettingsControls({ settings, onSet }: Props) {
  const [open, setOpen] = useState<'permission' | 'theme' | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const mode: PermissionMode = settings?.permissionMode ?? 'default'
  const theme: ThemeMode = settings?.theme ?? 'dark'

  return (
    <div className="settings-controls" ref={ref}>
      <div className="setting-group">
        <button
          className={`setting-btn ${mode === 'plan' ? 'warn' : mode === 'bypassPermissions' ? 'danger' : ''}`}
          onClick={() => setOpen(open === 'permission' ? null : 'permission')}
          title="权限模式（/permissions）"
        >
          权限 · {PERMISSION_LABEL[mode]}
        </button>
        {open === 'permission' && (
          <div className="setting-menu">
            {(Object.keys(PERMISSION_LABEL) as PermissionMode[]).map(m => (
              <button
                key={m}
                className={m === mode ? 'active' : ''}
                onClick={() => {
                  onSet('permissionMode', m)
                  setOpen(null)
                }}
              >
                <span className="setting-name">{PERMISSION_LABEL[m]}</span>
                <span className="setting-desc">{PERMISSION_DESC[m]}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="setting-group">
        <button
          className="setting-btn"
          onClick={() => setOpen(open === 'theme' ? null : 'theme')}
          title="主题（/theme）"
        >
          主题 · {THEME_LABEL[theme]}
        </button>
        {open === 'theme' && (
          <div className="setting-menu">
            {(Object.keys(THEME_LABEL) as ThemeMode[]).map(t => (
              <button
                key={t}
                className={t === theme ? 'active' : ''}
                onClick={() => {
                  onSet('theme', t)
                  setOpen(null)
                }}
              >
                <span className="setting-name">{THEME_LABEL[t]}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
