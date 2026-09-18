/**
 * 守护进程权限响应信封（daemon/backgroundDaemon.ts 的 buildPermissionControlResponse）
 * 形状守住测试。
 *
 * 这是安全关键契约：信封写回给 spawn 的子进程（--print --input-format stream-json），
 * 子进程在 cli/structuredIO.ts 按 message.response.{subtype,request_id,response.behavior}
 * 解析，对应 entrypoints/sdk/controlSchemas.ts 的 SDKControlResponseSchema。
 * 信封形状一旦不对，attach 客户端允许/拒绝的应答会被子进程静默忽略 → 工具卡到超时自动拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPermissionControlResponse } from '../daemon/backgroundDaemon.js'

test('buildPermissionControlResponse — 形状与子进程 SDKControlResponseSchema 契约一致', () => {
  const allow = JSON.parse(buildPermissionControlResponse('req-1', 'allow'))
  assert.equal(allow.type, 'control_response')
  assert.equal(allow.response.subtype, 'success')
  assert.equal(allow.response.request_id, 'req-1')
  assert.equal(allow.response.response.behavior, 'allow')
  assert.ok(
    !('message' in allow.response.response),
    'allow 不带 message 时不应出现 message 字段（避免子进程解析到 undefined 误判）',
  )

  const deny = JSON.parse(buildPermissionControlResponse('req-2', 'deny', '太危险'))
  assert.equal(deny.type, 'control_response')
  assert.equal(deny.response.subtype, 'success')
  assert.equal(deny.response.request_id, 'req-2')
  assert.equal(deny.response.response.behavior, 'deny')
  assert.equal(deny.response.response.message, '太危险')
})

test('buildPermissionControlResponse — 拒绝带空 message 时不写 message 字段', () => {
  const deny = JSON.parse(buildPermissionControlResponse('req-3', 'deny', ''))
  assert.equal(deny.response.response.behavior, 'deny')
  assert.ok(
    !('message' in deny.response.response),
    'deny 配空 message 不应写出 message 字段（与 allow 不带 message 同款契约）',
  )
})
