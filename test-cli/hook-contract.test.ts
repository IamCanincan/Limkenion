/**
 * 钩子事件契约守卫：entrypoints/sdk/coreTypes.ts 的 HOOK_EVENTS 是
 * 对外契约的名字清单（CLI 发给钩子子进程的 hook_event_name、用户
 * settings.json 的键、web 契约 JSON 的来源）。改名/加名必须过这里。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HOOK_EVENTS } from '../entrypoints/sdk/coreTypes.js'
import { HOOK_EVENT_ALIASES, canonicalHookEvent } from '../shared/naming.js'

describe('钩子事件契约（HOOK_EVENTS）', () => {
  it('共 27 种事件，无重复', () => {
    assert.equal(HOOK_EVENTS.length, 27)
    assert.equal(new Set(HOOK_EVENTS).size, 27)
  })

  it('全部是连字符小写格式（对象-动作）', () => {
    for (const name of HOOK_EVENTS) {
      assert.match(name, /^[a-z]+(-[a-z]+)*$/, `事件名 ${name} 不符合连字符小写契约`)
    }
  })

  it('不含任何 CC 旧名', () => {
    const legacy = Object.keys(HOOK_EVENT_ALIASES)
    for (const name of HOOK_EVENTS) {
      assert.equal(legacy.includes(name), false, `HOOK_EVENTS 里混进了旧名 ${name}`)
    }
  })

  it('所有别名映射的新名都在 HOOK_EVENTS 里（别名不能指向不存在的事件）', () => {
    for (const [oldName, newName] of Object.entries(HOOK_EVENT_ALIASES)) {
      assert.ok(
        (HOOK_EVENTS as readonly string[]).includes(newName),
        `别名 ${oldName} → ${newName}，但 ${newName} 不在 HOOK_EVENTS 里`,
      )
    }
  })

  it('canonicalHookEvent 对全部 27 个新名是恒等映射', () => {
    for (const name of HOOK_EVENTS) {
      assert.equal(canonicalHookEvent(name), name)
    }
  })

  it('关键事件在位（web 端接线依赖它们）', () => {
    for (const required of [
      'tool-before',
      'tool-after',
      'tool-failed',
      'prompt-submit',
      'session-open',
      'session-close',
      'turn-end',
      'agent-end',
    ]) {
      assert.ok((HOOK_EVENTS as readonly string[]).includes(required), `缺少 ${required}`)
    }
  })
})
