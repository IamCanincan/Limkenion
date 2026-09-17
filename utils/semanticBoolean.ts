import { z } from 'zod/v4'

/**
 * 也接受字符串字面量 "true"/"false" 的布尔值。
 *
 * 工具输入是模型生成的 JSON。模型偶尔会引用布尔值——`"replace_all":"false"`
 * 而非 `"replace_all":false`——而 z.boolean() 会以类型错误拒绝它。
 * z.coerce.boolean() 是错误的修复方式：它使用 JS 真值判断，所以
 * "false" → true。
 *
 * z.preprocess 在 API schema 中发出 {"type":"boolean"}，因此模型仍被告知
 * 这是布尔值——字符串容错是客户端侧不可见的强制转换，而不是对外宣称的
 * 输入形状。
 *
 * .optional()/.default() 要放在内层 schema 内部，而不是链式追加在后面：
 * 把它们链到 ZodPipe 上会把 z.output<> 在 Zod v4 中加宽为 unknown。
 *
 *   semanticBoolean()                              → boolean
 *   semanticBoolean(z.boolean().optional())        → boolean | undefined
 *   semanticBoolean(z.boolean().default(false))    → boolean
 */
export function semanticBoolean<T extends z.ZodType>(
  inner: T = z.boolean() as unknown as T,
) {
  return z.preprocess(
    (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v),
    inner,
  )
}
