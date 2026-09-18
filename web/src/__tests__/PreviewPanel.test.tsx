import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PreviewPanel } from '../components/PreviewPanel'

afterEach(cleanup)

describe('PreviewPanel', () => {
  it('渲染 iframe（src 指向本机地址）与地址栏', () => {
    render(<PreviewPanel url="http://localhost:5173/" onClose={vi.fn()} />)
    const frame = document.querySelector('iframe.preview-frame') as HTMLIFrameElement
    expect(frame).toBeTruthy()
    expect(frame.getAttribute('src')).toBe('http://localhost:5173/')
    expect((screen.getByDisplayValue('http://localhost:5173/') as HTMLInputElement)).toBeTruthy()
  })

  it('关闭按钮触发 onClose', () => {
    const onClose = vi.fn()
    render(<PreviewPanel url="http://127.0.0.1:3000" onClose={onClose} />)
    fireEvent.click(screen.getByTitle('关闭'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('刷新按钮更换 iframe key（强制重载）', () => {
    render(<PreviewPanel url="http://localhost:5173/" onClose={vi.fn()} />)
    const before = document.querySelector('iframe.preview-frame')!.getAttribute('data-key')
    fireEvent.click(screen.getByTitle('刷新'))
    const after = document.querySelector('iframe.preview-frame')!.getAttribute('data-key')
    expect(after).not.toBe(before)
  })
})
