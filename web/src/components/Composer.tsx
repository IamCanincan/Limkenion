import { useEffect, useRef, useState } from 'react'
import type { CommandInfo, ImageAttachment } from '../types'
import { CommandPalette } from './CommandPalette'
import { FileMentionPalette } from './FileMentionPalette'

interface Props {
  commands: CommandInfo[]
  files: string[]
  onSend: (text: string, images?: ImageAttachment[]) => void
  onCancel: () => void
  streaming: boolean
  onRequestFiles: () => void
}

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 找出光标前的 @ 提及（@ 必须在行首或空白之后，且其后无空白）。 */
function mentionAt(value: string): { query: string; start: number } | null {
  const at = value.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(value[at - 1]!)) return null
  const rest = value.slice(at + 1)
  if (/\s/.test(rest)) return null
  return { query: rest, start: at }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

export function Composer({ commands, files, onSend, onCancel, streaming, onRequestFiles }: Props) {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Open the command palette whenever the input starts with "/" and no space yet.
  useEffect(() => {
    setPaletteOpen(/^\/[^\s]*$/.test(value))
    setMention(mentionAt(value))
  }, [value])

  // @ 提及需要文件索引，首次触发时向服务端要一次。
  useEffect(() => {
    if (mention !== null && files.length === 0) onRequestFiles()
  }, [mention, files.length, onRequestFiles])

  const addFiles = async (list: FileList | File[]) => {
    setImageError(null)
    const incoming = [...list]
    const accepted: ImageAttachment[] = []
    for (const f of incoming) {
      if (images.length + accepted.length >= MAX_IMAGES) {
        setImageError(`最多 ${MAX_IMAGES} 张图片`)
        break
      }
      if (!ACCEPTED.includes(f.type)) {
        setImageError(`不支持的格式：${f.type || f.name}`)
        continue
      }
      if (f.size > MAX_IMAGE_BYTES) {
        setImageError(`图片过大（上限 4MB）：${f.name}`)
        continue
      }
      try {
        accepted.push({ dataUrl: await readAsDataUrl(f), name: f.name })
      } catch {
        setImageError('读取图片失败')
      }
    }
    if (accepted.length > 0) setImages(prev => [...prev, ...accepted].slice(0, MAX_IMAGES))
  }

  const resetHeight = () => {
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  const submit = () => {
    const text = value.trim()
    if ((text.length === 0 && images.length === 0) || streaming) return
    onSend(text, images.length > 0 ? images : undefined)
    setValue('')
    setImages([])
    setImageError(null)
    setPaletteOpen(false)
    setMention(null)
    resetHeight()
  }

  const completeCommand = (c: CommandInfo) => {
    const hint = c.argumentHint ? ' ' : ''
    setValue(`/${c.name}${hint}`)
    taRef.current?.focus()
  }

  const runCommandNow = (c: CommandInfo) => {
    setValue('')
    setPaletteOpen(false)
    onSend(`/${c.name}`)
    resetHeight()
  }

  const insertMention = (path: string) => {
    if (mention === null) return
    setValue(value.slice(0, mention.start) + '@' + path + ' ')
    setMention(null)
    taRef.current?.focus()
  }

  const canSend = value.trim().length > 0 || images.length > 0

  return (
    <div className="composer">
      {paletteOpen && (
        <CommandPalette
          commands={commands}
          query={value}
          onSelect={completeCommand}
          onRun={runCommandNow}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {!paletteOpen && mention !== null && (
        <FileMentionPalette
          files={files}
          query={mention.query}
          onSelect={insertMention}
          onClose={() => setMention(null)}
        />
      )}
      {(images.length > 0 || imageError) && (
        <div className="composer-attachments">
          {images.map((img, i) => (
            <div key={i} className="attachment">
              <img src={img.dataUrl} alt={img.name} title={img.name} />
              <button
                className="attachment-remove"
                title="移除"
                onClick={() => setImages(prev => prev.filter((_, idx) => idx !== i))}
              >
                ×
              </button>
            </div>
          ))}
          {imageError && <span className="attachment-error">{imageError}</span>}
        </div>
      )}
      <div className="composer-inner">
        <button className="attach" title="添加图片" onClick={() => fileRef.current?.click()}>
          ⌗
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED.join(',')}
          multiple
          hidden
          onChange={e => {
            if (e.target.files) void addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <textarea
          ref={taRef}
          value={value}
          placeholder="输入消息，/ 命令，@ 引用文件，可粘贴图片，Enter 发送，Shift+Enter 换行"
          rows={1}
          onChange={e => {
            setValue(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 200) + 'px'
          }}
          onPaste={e => {
            const items = [...(e.clipboardData?.items ?? [])]
            const files = items
              .filter(it => it.kind === 'file')
              .map(it => it.getAsFile())
              .filter((f): f is File => f !== null)
            if (files.length > 0) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
          onKeyDown={e => {
            if (
              (paletteOpen || mention !== null) &&
              (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab')
            ) {
              // Palette handles navigation via its window-level listener.
              e.preventDefault()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {streaming ? (
          <button className="stop" onClick={onCancel} title="中断">
            ■
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!canSend} title="发送">
            ↑
          </button>
        )}
      </div>
    </div>
  )
}
