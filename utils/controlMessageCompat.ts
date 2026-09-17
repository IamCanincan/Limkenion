/**
 * 将入站控制消息（control_request、control_response）中的 camelCase
 * `requestId` 规范化为 snake_case `request_id`。
 *
 * 较旧的 iOS 应用构建因缺少 Swift CodingKeys 映射而发送 `requestId`。
 * 没有这个垫片，replBridge.ts 中的 isSDKControlRequest 会拒绝该消息
 * （它检查 `'request_id' in value`），structuredIO.ts 会把
 * `message.response.request_id` 读取为 undefined——两者都会静默丢弃消息。
 *
 * 若 `request_id` 和 `requestId` 同时存在，snake_case 优先。
 * 原地修改该对象。
 */
export function normalizeControlMessageKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  const record = obj as Record<string, unknown>
  if ('requestId' in record && !('request_id' in record)) {
    record.request_id = record.requestId
    delete record.requestId
  }
  if (
    'response' in record &&
    record.response !== null &&
    typeof record.response === 'object'
  ) {
    const response = record.response as Record<string, unknown>
    if ('requestId' in response && !('request_id' in response)) {
      response.request_id = response.requestId
      delete response.requestId
    }
  }
  return obj
}
