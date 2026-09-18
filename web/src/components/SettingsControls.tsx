import { useEffect, useRef, useState } from 'react'
import type { EffortLevel, PermissionMode, Settings, ThemeMode } from '../types'

interface Props {
  settings: Settings | null
  onSet: (key: 'theme' | 'permissionMode' | 'effortLevel' | 'outputStyle', value: string | null) => void
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

/** 推理强度档位 —— 与 CLI 的 /effort 一致（utils/effort.ts 的 EFFORT_LEVELS）。 */
const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  max: '最高',
}

const EFFORT_DESC: Record<EffortLevel, string> = {
  low: '思考链最短，最快最省',
  medium: '均衡',
  high: '思考更充分，适合复杂改动',
  max: '最深的思考链（仅 deepseek-v4-pro）',
}

/** 输出风格 —— 内置四种；服务端会把非内置值当作自定义指令原文注入系统提示。 */
const OUTPUT_STYLE_LABEL: Record<string, string> = {
  default: '默认',
  concise: '简洁',
  explanatory: '讲解',
  learning: '学习',
}

const OUTPUT_STYLE_DESC: Record<string, string> = {
  default: '标准回答风格',
  concise: '直给结论和代码，少铺垫',
  explanatory: '附简要原因和关键取舍',
  learning: '分步骤讲解，提示常见坑',
}

/**
 * 顶栏设置：权限模式 + 主题 + 推理强度
 * （对齐 CLI 的 /permissions、/theme、/effort）。
 */
export function SettingsControls({ settings, onSet }: Props) {
  const [open, setOpen] = useState<'permission' | 'theme' | 'effort' | 'style' | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const mode: PermissionMode = settings?.permissionMode ?? 'default'
  const style = settings?.outputStyle ?? 'default'
  const theme: ThemeMode = settings?.theme ?? 'dark'
  const effort: EffortLevel | null = settings?.effortLevel ?? null
  // max 在当前模型上会被降级 —— 按钮上标出来，避免用户以为没生效
  const downgraded = effort === 'max' && settings?.effectiveEffort === 'high'

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
          onClick={() => setOpen(open === 'style' ? null : 'style')}
          title="输出风格（/style）—— 影响模型的回答方式"
        >
          风格 · {OUTPUT_STYLE_LABEL[style] ?? '自定义'}
        </button>
        {open === 'style' && (
          <div className="setting-menu">
            {Object.keys(OUTPUT_STYLE_LABEL).map(k => (
              <button
                key={k}
                className={k === style ? 'active' : ''}
                onClick={() => {
                  onSet('outputStyle', k)
                  setOpen(null)
                }}
              >
                <span className="setting-name">{OUTPUT_STYLE_LABEL[k]}</span>
                <span className="setting-desc">{OUTPUT_STYLE_DESC[k]}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="setting-group">
        <button
          className="setting-btn"
          onClick={() => setOpen(open === 'effort' ? null : 'effort')}
          title="推理强度（/effort）—— 控制模型的思考链长度"
        >
          推理 · {effort ? EFFORT_LABEL[effort] : '默认'}
          {downgraded ? '（实为高）' : ''}
        </button>
        {open === 'effort' && (
          <div className="setting-menu">
            <button
              className={effort === null ? 'active' : ''}
              onClick={() => {
                onSet('effortLevel', null)
                setOpen(null)
              }}
            >
              <span className="setting-name">默认</span>
              <span className="setting-desc">不指定，由服务端决定（思考链开启）</span>
            </button>
            {(Object.keys(EFFORT_LABEL) as EffortLevel[]).map(l => (
              <button
                key={l}
                className={l === effort ? 'active' : ''}
                onClick={() => {
                  onSet('effortLevel', l)
                  setOpen(null)
                }}
              >
                <span className="setting-name">{EFFORT_LABEL[l]}</span>
                <span className="setting-desc">{EFFORT_DESC[l]}</span>
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
