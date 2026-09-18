import { useState } from 'react'

interface Props {
  url: string
  onClose: () => void
}

/**
 * 内置预览面板：agent 启动本机 dev server / 页面后，用 iframe 在右侧直接打开。
 * 只接受本机地址（服务端 PreviewUrl 工具已校验 localhost）。
 */
export function PreviewPanel({ url, onClose }: Props) {
  const [nonce, setNonce] = useState(0)

  return (
    <div className="preview-panel">
      <div className="preview-bar">
        <span className="preview-title">预览</span>
        <input
          className="preview-url"
          value={url}
          readOnly
          onFocus={e => e.target.select()}
        />
        <button className="preview-btn" title="刷新" onClick={() => setNonce(n => n + 1)}>
          ↻
        </button>
        <button className="preview-btn" title="新标签页打开" onClick={() => window.open(url, '_blank')}>
          ↗
        </button>
        <button className="preview-btn" title="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      <iframe
        key={nonce}
        data-key={nonce}
        className="preview-frame"
        src={url}
        title="预览"
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
    </div>
  )
}
