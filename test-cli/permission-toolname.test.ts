/**
 * 权限规则的工具名归一化测试 —— 安全关键路径的"重命名兼容"回归。
 *
 * 2026-09-18 发现：本 fork 把 EnterPlanMode→PlanEnter / ExitPlanMode→PlanExit 改名，
 * 但权限规则的解析器 normalizeLegacyToolName 用的是**自己的一份**古老别名表，
 * 没有收 EnterPlanMode/ExitPlanMode —— 于是用户 settings.json 里写旧名
 * `EnterPlanMode` 的权限规则静默不匹配已改名为 PlanEnter 的工具
 *（与第 11 轮 HooksSchema 旧名被拒是同一类"双端解析、兼容层漏一端"的坑）。
 *
 * 这里直接钉住：旧名规则必须解析成新名、且能端到端命中运行时工具。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  permissionRuleValueFromString,
  normalizeLegacyToolName,
} from '../utils/permissions/permissionRuleParser.js'
import {
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from '../utils/permissions/permissions.js'
import { SETTING_SOURCES } from '../utils/settings/constants.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'

function ctx(rules: { allow?: string[]; deny?: string[] }) {
  const src = SETTING_SOURCES[0] as string
  return {
    alwaysAllowRules: { [src]: rules.allow ?? [] },
    alwaysDenyRules: { [src]: rules.deny ?? [] },
  } as unknown as Parameters<typeof getDenyRuleForTool>[0]
}

describe('normalizeLegacyToolName — 重命名契约（EnterPlanMode/ExitPlanMode）', () => {
  it('旧名 EnterPlanMode → 新名 PlanEnter', () => {
    assert.equal(normalizeLegacyToolName('EnterPlanMode'), 'PlanEnter')
  })
  it('旧名 ExitPlanMode → 新名 PlanExit', () => {
    assert.equal(normalizeLegacyToolName('ExitPlanMode'), 'PlanExit')
  })
  it('新名原样保留（不会变成别的）', () => {
    assert.equal(normalizeLegacyToolName('PlanEnter'), 'PlanEnter')
    assert.equal(normalizeLegacyToolName('PlanExit'), 'PlanExit')
  })
  it('古老别名 Task→Agent 仍生效（无回归）', () => {
    assert.equal(normalizeLegacyToolName('Task'), AGENT_TOOL_NAME)
  })
})

describe('permissionRuleValueFromString — 旧名规则解析成新名', () => {
  it('整工具旧名 EnterPlanMode → { toolName: PlanEnter }', () => {
    assert.deepEqual(permissionRuleValueFromString('EnterPlanMode'), {
      toolName: 'PlanEnter',
    })
  })
  it('整工具旧名 ExitPlanMode → { toolName: PlanExit }', () => {
    assert.deepEqual(permissionRuleValueFromString('ExitPlanMode'), {
      toolName: 'PlanExit',
    })
  })
  it('旧名 + 内容规则也归一化：EnterPlanMode(git:*) → PlanEnter + git:*', () => {
    assert.deepEqual(permissionRuleValueFromString('EnterPlanMode(git:*)'), {
      toolName: 'PlanEnter',
      ruleContent: 'git:*',
    })
  })
  it('新名 PlanEnter 原样通过', () => {
    assert.deepEqual(permissionRuleValueFromString('PlanEnter'), {
      toolName: 'PlanEnter',
    })
  })
})

describe('端到端：旧名权限规则命中运行时改名后的工具', () => {
  it('deny 规则写旧名 EnterPlanMode → 实际拒绝 PlanEnter 工具', () => {
    const rule = getDenyRuleForTool(ctx({ deny: ['EnterPlanMode'] }), {
      name: 'PlanEnter',
    })
    assert.ok(rule, '旧名 deny 规则应匹配已改名的 PlanEnter 工具')
    assert.equal(rule!.ruleValue.toolName, 'PlanEnter')
  })
  it('allow 规则写旧名 ExitPlanMode → 实际放行 PlanExit 工具', () => {
    const rule = toolAlwaysAllowedRule(ctx({ allow: ['ExitPlanMode'] }), {
      name: 'PlanExit',
    })
    assert.ok(rule, '旧名 allow 规则应匹配已改名的 PlanExit 工具')
  })
  it('新名规则同样命中（正向不退化）', () => {
    const rule = getDenyRuleForTool(ctx({ deny: ['PlanEnter'] }), {
      name: 'PlanEnter',
    })
    assert.ok(rule, '新名 deny 规则应匹配 PlanEnter 工具')
  })
})
