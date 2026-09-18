/**
 * 后台会话守护进程的纯逻辑测试：SDK 消息渲染。
 * （TCP/token/生命周期部分依赖真实端口与子进程，归 smoke 测；这里钉住
 *  attach 客户端与 logs 的渲染行为——那是用户直接看到的界面。）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderSdkMessage } from '../daemon/backgroundDaemon.js'

describe('daemon renderSdkMessage', () => {
  it('system/init → 连接信息行', () => {
    const out = renderSdkMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'abc-123',
      model: 'deepseek-flash',
    })
    assert.ok(out!.includes('abc-123'))
    assert.ok(out!.includes('deepseek-flash'))
  })

  it('assistant：文本与 tool_use 混合，thinking 块不渲染', () => {
    const out = renderSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '内部推理内容不应出现' },
          { type: 'text', text: '你好\n' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } },
        ],
      },
    })
    assert.ok(out!.includes('你好'))
    assert.ok(out!.includes('Bash('))
    assert.ok(out!.includes('git status'))
    assert.ok(!out!.includes('内部推理'))
  })

  it('assistant：只有 thinking → null（不出现在 attach 界面）', () => {
    const out = renderSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '...' }] },
    })
    assert.equal(out, null)
  })

  it('user 流里的 tool_result 错误要显式报出', () => {
    const out = renderSdkMessage({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom: file not found' },
        ],
      },
    })
    assert.ok(out!.includes('工具报错'))
    assert.ok(out!.includes('boom'))
  })

  it('user 流里正常工具结果 → null（不刷屏）', () => {
    const out = renderSdkMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }],
      },
    })
    assert.equal(out, null)
  })

  it('result：轮数/耗时摘要 + 结果文本截断', () => {
    const longText = 'x'.repeat(600)
    const out = renderSdkMessage({
      type: 'result',
      subtype: 'success',
      num_turns: 3,
      duration_ms: 1234,
      result: longText,
    })
    assert.ok(out!.includes('轮数 3'))
    assert.ok(out!.includes('1.2s'))
    // 400 字符 + 省略号
    assert.ok(out!.includes('…'))
    assert.ok(out!.length < longText.length)
  })

  it('未知消息类型 → null', () => {
    assert.equal(renderSdkMessage({ type: 'keep_alive' }), null)
    assert.equal(renderSdkMessage({ type: 'control_request', request_id: 'x', request: { subtype: 'interrupt' } }), null)
  })
})
