/**
 * 命名契约测试：shared/naming.ts 是 CLI + web 两端的单一事实源，
 * 这里的每个断言都是"改契约必须显式过这一关"的守卫。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOOK_EVENT_ALIASES,
  TOOL_NAME_ALIASES,
  canonicalHookEvent,
  canonicalToolName,
  isLegacyToolName,
} from '../shared/naming.js'

describe('shared/naming 命名契约', () => {
  it('别名映射规模符合契约（27 个钩子事件 + 2 个工具名）', () => {
    assert.equal(Object.keys(HOOK_EVENT_ALIASES).length, 27)
    assert.equal(Object.keys(TOOL_NAME_ALIASES).length, 2)
  })

  it('canonicalHookEvent：旧名 → 新名（抽查代表性映射）', () => {
    assert.equal(canonicalHookEvent('PreToolUse'), 'tool-before')
    assert.equal(canonicalHookEvent('PostToolUse'), 'tool-after')
    assert.equal(canonicalHookEvent('PostToolUseFailure'), 'tool-failed')
    assert.equal(canonicalHookEvent('UserPromptSubmit'), 'prompt-submit')
    assert.equal(canonicalHookEvent('SessionStart'), 'session-open')
    assert.equal(canonicalHookEvent('SessionEnd'), 'session-close')
    assert.equal(canonicalHookEvent('Stop'), 'turn-end')
    assert.equal(canonicalHookEvent('StopFailure'), 'turn-failed')
    assert.equal(canonicalHookEvent('SubagentStart'), 'agent-start')
    assert.equal(canonicalHookEvent('SubagentStop'), 'agent-end')
    assert.equal(canonicalHookEvent('PreCompact'), 'context-compact-before')
    assert.equal(canonicalHookEvent('PostCompact'), 'context-compact-after')
    assert.equal(canonicalHookEvent('Notification'), 'notice')
    assert.equal(canonicalHookEvent('Setup'), 'setup')
  })

  it('canonicalHookEvent：新名直通、未知值原样放行', () => {
    assert.equal(canonicalHookEvent('tool-before'), 'tool-before')
    assert.equal(canonicalHookEvent('turn-end'), 'turn-end')
    // 未知事件名不做臆测转换——交给上层校验报错
    assert.equal(canonicalHookEvent('not-an-event'), 'not-an-event')
  })

  it('canonicalToolName：EnterPlanMode/ExitPlanMode → PlanEnter/PlanExit', () => {
    assert.equal(canonicalToolName('EnterPlanMode'), 'PlanEnter')
    assert.equal(canonicalToolName('ExitPlanMode'), 'PlanExit')
    assert.equal(canonicalToolName('PlanEnter'), 'PlanEnter')
    assert.equal(canonicalToolName('PlanExit'), 'PlanExit')
    assert.equal(canonicalToolName('Bash'), 'Bash')
    assert.equal(canonicalToolName('mcp__x__y'), 'mcp__x__y')
  })

  it('isLegacyToolName：只认两个旧名', () => {
    assert.equal(isLegacyToolName('EnterPlanMode'), true)
    assert.equal(isLegacyToolName('ExitPlanMode'), true)
    assert.equal(isLegacyToolName('PlanEnter'), false)
    assert.equal(isLegacyToolName('Bash'), false)
    assert.equal(isLegacyToolName('EnterPlanModeV2'), false)
  })

  it('别名映射的值必须是合法的连字符/大驼峰新名（防手滑写出怪名）', () => {
    for (const [oldName, newName] of Object.entries(HOOK_EVENT_ALIASES)) {
      assert.match(newName, /^[a-z]+(-[a-z]+)*$/, `${oldName} → ${newName} 不是连字符小写格式`)
      assert.notEqual(oldName, newName, `${oldName} 的别名不该是 identity`)
    }
    for (const newName of Object.values(TOOL_NAME_ALIASES)) {
      assert.match(newName, /^Plan(Enter|Exit)$/, `工具别名 ${newName} 不在契约内`)
    }
  })
})
