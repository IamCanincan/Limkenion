import { z } from 'zod/v4'

/**
 * 也接受数字字符串字面量（如 "30"、"-5"、"3.14"）的数值。
 *
 * 工具输入是模型生成的 JSON。模型偶尔会引用数字——`"head_limit":"30"`
 * 而非 `"head_limit":30`——而 z.number() 会以类型错误拒绝它。
 * z.coerce.number() 是错误的修复方式：它通过 JS Number() 转换接受像 ""
 * 或 null 这样的值，掩盖缺陷而非暴露它们。
 *
 * 只有匹配 /^-?\d+(\.\d+)?$/ 的有效十进制数字字面量字符串才会被强制转换。
 * 其余全部透传，并由内层 schema 拒绝。
 *
 * z.preprocess 在 API schema 中发出 {"type":"number"}，因此模型仍被告知
 * 这是数值——字符串容错是客户端侧不可见的强制转换，而不是对外宣称的输入形状。
 *
 * .optional()/.default() 要放在内层 schema 内部，而不是链式追加在后面：
 * 把它们链到 ZodPipe 上会把 z.output<> 在 Zod v4 中加宽为 unknown。
 *
 *   semanticNumber()                              → number
 *   semanticNumber(z.number().optional())         → number | undefined
 *   semanticNumber(z.number().default(0))         → number
 */
export function semanticNumber<T extends z.ZodType>(
  inner: T = z.number() as unknown as T,
) {
  return z.preprocess((v: unknown) => {
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return v
  }, inner)
}
