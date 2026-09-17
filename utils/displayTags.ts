/**
 * 匹配任何 XML 风格的 `<tag>…</tag>` 块（小写标签名、可选属性、多行内容）。
 * 用于从显示标题中剥离系统注入的包装标签——IDE 上下文、斜杠命令标记、hook
 * 输出、任务通知、频道消息等。用一个通用模式可避免维护一个不断增长、且随
 * 新通知类型添加而跟不上的白名单。
 *
 * 仅匹配小写标签名（`[a-z][\w-]*`），使提到 JSX/HTML 组件的用户散文
 * （"修复 <Button> 布局"、`<!DOCTYPE html>`）能原样通过——那些以大写或
 * `!` 开头。带反向引用结束标签的非贪婪正文能让相邻块保持分开；未配对的
 * 尖括号（"当 x < y"）不会匹配。
 */
const XML_TAG_BLOCK_PATTERN = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

/**
 * 从文本中剥离 XML 风格标签块，用于 UI 标题（/rewind、/resume、bridge
 * 会话标题）。系统注入的上下文——IDE 元数据、hook 输出、任务通知——以标签
 * 包裹方式到达，不应作为标题出现。
 *
 * 若剥离后得到空文本，则返回原样输入（总比什么都不显示要好）。
 */
export function stripDisplayTags(text: string): string {
  const result = text.replace(XML_TAG_BLOCK_PATTERN, '').trim()
  return result || text
}

/**
 * 与 stripDisplayTags 类似，但当全部内容都是标签时返回空字符串。
 * 由 getLogDisplayTitle 用于检测纯命令提示（例如 /clear），使它们可以落到
 * 下一个标题后备；也由 extractTitleText 用于在 bridge 标题推导时跳过纯 XML
 * 消息。
 */
export function stripDisplayTagsAllowEmpty(text: string): string {
  return text.replace(XML_TAG_BLOCK_PATTERN, '').trim()
}

const IDE_CONTEXT_TAGS_PATTERN =
  /<(ide_opened_file|ide_selection)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

/**
 * 仅剥离 IDE 注入的上下文标签（ide_opened_file、ide_selection）。
 * 由 textForResubmit 使用，使 UP 箭头重新提交时能保留用户输入的内容（包括
 * 像 `<code>foo</code>` 这样的小写 HTML），同时丢弃 IDE 干扰信息。
 */
export function stripIdeContextTags(text: string): string {
  return text.replace(IDE_CONTEXT_TAGS_PATTERN, '').trim()
}
