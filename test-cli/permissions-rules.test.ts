/**
 * 权限规则匹配测试——这是安全关键路径：
 * `Bash(git:*)` 语法、整工具匹配 vs 内容匹配、Agent(type) 拒绝语法。
 * 全部用合成 context（不读真实设置文件），只钉"规则怎么解释"这件事。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getDenyRules,
  getDenyRuleForTool,
  getAskRuleForTool,
  getDenyRuleForAgent,
  filterDeniedAgents,
  getRuleByContentsForToolName,
} from '../utils/permissions/permissions.js'
import type { ToolPermissionContext } from '../utils/permissions/permissions.js'
import { SETTING_SOURCES } from '../utils/settings/constants.js'

function makeContext(rules: {
  deny?: string[]
  ask?: string[]
  allow?: string[]
}): ToolPermissionContext {
  // 规则挂在 'userSettings' 来源上（PERMISSION_RULE_SOURCES = SETTING_SOURCES + cliArg/command/session）
  const src = SETTING_SOURCES[0] as string
  return {
    alwaysDenyRules: { [src]: rules.deny ?? [] },
    alwaysAskRules: { [src]: rules.ask ?? [] },
    alwaysAllowRules: { [src]: rules.allow ?? [] },
  } as unknown as ToolPermissionContext
}

const tool = (name: string) => ({ name, mcpInfo: undefined })

describe('权限规则匹配', () => {
  it('整工具 deny：`Bash` 规则匹配 Bash 工具', () => {
    const ctx = makeContext({ deny: ['Bash'] })
    const rule = getDenyRuleForTool(ctx, tool('Bash'))
    assert.ok(rule)
    assert.equal(rule!.ruleValue.toolName, 'Bash')
  })

  it('内容规则不整工具匹配：`Bash(git:*)` 不等于整个 Bash 被拒', () => {
    const ctx = makeContext({ deny: ['Bash(git:*)'] })
    assert.equal(getDenyRuleForTool(ctx, tool('Bash')), null)
    // 但内容表里能查到
    const contents = getRuleByContentsForToolName(ctx, 'Bash', 'deny')
    assert.ok(contents.has('git:*'))
  })

  it('工具名匹配是大小写敏感的（`bash(git:*)` 不作用于 Bash 工具）', () => {
    // 实测契约：toolMatchesRule 用严格相等。settings.json 里必须写
    // 正确大小写的工具名——这既是对现状的钉桩，也是给用户的隐式提示。
    const ctx = makeContext({ deny: ['bash(git:*)'] })
    const contents = getRuleByContentsForToolName(ctx, 'Bash', 'deny')
    assert.equal(contents.has('git:*'), false)
  })

  it('deny 与 ask 分桶互不串扰', () => {
    const ctx = makeContext({ deny: ['Bash'], ask: ['WebFetch'] })
    assert.ok(getDenyRuleForTool(ctx, tool('Bash')))
    assert.equal(getAskRuleForTool(ctx, tool('Bash')), null)
    assert.ok(getAskRuleForTool(ctx, tool('WebFetch')))
    assert.equal(getDenyRuleForTool(ctx, tool('WebFetch')), null)
  })

  it('无关工具不受影响；MCP 工具走 mcpInfo 命名空间（`mcp__server__tool` 名直配）', () => {
    const ctx = makeContext({ deny: ['Read', 'mcp__stub__echo'] })
    assert.equal(getDenyRuleForTool(ctx, tool('Write')), null)
    assert.ok(getDenyRuleForTool(ctx, tool('mcp__stub__echo')))
  })

  it('Agent(type) 拒绝语法：getDenyRuleForAgent / filterDeniedAgents', () => {
    const ctx = makeContext({ deny: ['Agent(Explore)'] })
    assert.ok(getDenyRuleForAgent(ctx, 'Agent', 'Explore'))
    assert.equal(getDenyRuleForAgent(ctx, 'Agent', 'Plan'), null)
    const agents = [{ agentType: 'Explore' }, { agentType: 'Plan' }]
    assert.deepEqual(filterDeniedAgents(agents, ctx, 'Agent'), [{ agentType: 'Plan' }])
  })

  it('getDenyRules：来源为空的桶安全跳过，规则字符串被解析成结构', () => {
    const ctx = makeContext({ deny: ['Bash(prefix:*)'] })
    const rules = getDenyRules(ctx)
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.ruleBehavior, 'deny')
    assert.equal(rules[0]!.source, SETTING_SOURCES[0])
    assert.equal(rules[0]!.ruleValue.ruleContent, 'prefix:*')
  })
})
