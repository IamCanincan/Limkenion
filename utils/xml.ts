/**
 * 转义 XML/HTML 特殊字符，以便安全地插值到元素文本内容（标签之间）。
 * 当不受信任的字符串（进程 stdout、用户输入、外部数据）进入
 * `<tag>${here}</tag>` 时使用。
 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 用于插值到双引号或单引号属性值中的转义：`<tag attr="${here}">`。
 * 除了 &amp; &lt; &gt; 之外，还会转义引号。
 */
export function escapeXmlAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
