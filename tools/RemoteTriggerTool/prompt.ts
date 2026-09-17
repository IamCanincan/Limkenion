export const REMOTE_TRIGGER_TOOL_NAME = 'RemoteTrigger'

export const DESCRIPTION =
  '通过 limkenion.ai CCR API 管理计划中的远程 Limkenion 智能体（触发器）。认证在进程内完成——令牌绝不会到达 shell。'

export const PROMPT = `调用 limkenion.ai 远程触发器 API。请用它代替 curl——OAuth 令牌会在进程内自动添加，且从不暴露。

操作：
- list：GET /v1/code/triggers
- get：GET /v1/code/triggers/{trigger_id}
- create：POST /v1/code/triggers（需要请求体）
- update：POST /v1/code/triggers/{trigger_id}（需要请求体，部分更新）
- run：POST /v1/code/triggers/{trigger_id}/run

响应即来自 API 的原始 JSON。`
