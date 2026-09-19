/**
 * bus.mjs 广播 / 单发韧性测试。
 *
 * 背景：send() 里 `ws.send(JSON.stringify(msg))` 原先没有任何 try/catch。
 * 对一个「readyState 检查通过、但 send 时 socket 已死」的客户端，ws.send 会
 * 同步抛错，打断整个 broadcast 的 for 循环 —— 其余客户端收不到这条消息，
 * 异常还会冒进调用方（例如 runTurn 的 emit → broadcast）。
 *
 * 这里断言：单个客户端发送失败不影响其他客户端，且死客户端会被移出注册表；
 * send 对 null / 未 OPEN / 发送抛错 都安全返回 false。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addClient, clientCount, send, broadcast } from '../server/bus.mjs'

/** 造一个最小 ws 替身：记录收到的消息、可按需抛错；on() 存下事件处理器以便清理。 */
function makeWs({ readyState = 1, send = () => {} } = {}) {
  const handlers = {}
  return {
    readyState,
    OPEN: 1,
    send,
    on(ev, cb) {
      handlers[ev] = cb
      return this
    },
    _fire(ev) {
      handlers[ev]?.()
    },
  }
}

test('广播：单个客户端发送失败不影响其他客户端，且死客户端被移出', () => {
  const received = []
  const good = makeWs({ send: m => received.push(m) })
  const dead = makeWs({ send: () => { throw new Error('socket 已死') } })
  const before = clientCount()

  addClient(good)
  addClient(dead)

  // 不抛异常、且 good 收到了完整消息
  assert.doesNotThrow(() => broadcast({ type: 'notice', text: 'hi' }))
  assert.deepStrictEqual(received, [JSON.stringify({ type: 'notice', text: 'hi' })])
  // 死客户端被移出，注册表只剩 good（不受其他测试预存连接影响）
  assert.strictEqual(clientCount(), before + 1, '死客户端应被移出，只剩 good')

  // 清理，避免污染其他测试（走真实的 close 处理器）
  good._fire('close')
  assert.strictEqual(clientCount(), before)
})

test('send：null / 未 OPEN / 发送抛错 都安全返回 false', () => {
  assert.strictEqual(send(null, { a: 1 }), false, 'null 客户端应直接返回 false')

  const closed = makeWs({ readyState: 3 })
  assert.strictEqual(send(closed, { a: 1 }), false, '未 OPEN 的客户端应返回 false')

  const thrower = makeWs({ send: () => { throw new Error('x') } })
  const before = clientCount()
  addClient(thrower)
  assert.strictEqual(send(thrower, { a: 1 }), false, '发送抛错应返回 false')
  assert.strictEqual(clientCount(), before, '发送抛错的客户端应被移出注册表')
})
