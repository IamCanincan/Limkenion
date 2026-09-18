/**
 * 输出风格（outputStyle）—— 从「仅记录在设置里」变成真正注入系统提示。
 *
 * 设计：
 * - 内置风格用英文名做 key（default / concise / explanatory / learning），
 *   允许中文别名命中内置风格；
 * - 任何**非内置**的非空字符串一律视为「自定义风格指令」，原文注入系统提示 ——
 *   这样 /style 写什么就生效什么，不用先改代码。
 */
export const OUTPUT_STYLES = {
  default: null,
  concise:
    "回答尽量简短：直接给结论和代码，少用铺垫性语句；不主动展开背景知识，除非用户追问。",
  explanatory:
    "回答带有解释性：给出结论之外，简要说明『为什么这样做』和关键取舍；新概念出现时用一句话点明。",
  learning:
    "教学式回答：把改动拆成小步骤讲解，代码块后附简短的逐段说明；适当提示常见坑与验证方法，但不要写成长篇教程。",
}

/** 中文别名 → 内置 key。 */
const ALIASES = { 简洁: 'concise', 讲解: 'explanatory', 教学: 'learning', 学习: 'learning' }

/**
 * 把 outputStyle 设置值转成要追加到系统提示的文本；default / 空值返回空串。
 * @param {string|undefined} style
 */
export function outputStylePrompt(style) {
  if (typeof style !== 'string' || style.length === 0 || style === 'default') return ''
  const key = ALIASES[style] ?? style
  if (key === 'default') return ''
  if (OUTPUT_STYLES[key]) return `\n\n[输出风格：${key}]\n${OUTPUT_STYLES[key]}`
  // 非内置 → 自定义风格指令，原文注入（长度兜底，防呆）
  const text = style.slice(0, 2000)
  return `\n\n[输出风格要求（用户自定义）]\n${text}`
}
