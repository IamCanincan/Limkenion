/**
 * 供子命令处理器使用的 CLI 退出辅助函数。
 *
 * 把在 `limkenion mcp *` / `limkenion plugin *` 各处理器中复制了约 60 次的
 * 4-5 行“打印 + 屏蔽 lint + 退出”代码块收敛到一起。
 * `: never` 返回类型让 TypeScript 能在调用点收窄控制流，而无需末尾的 `return`。
 */
/* eslint-disable custom-rules/no-process-exit -- 集中的 CLI 退出点 */

// `return undefined as never`（而不是退出后的 throw）——测试会 spy
// process.exit 并让它返回。调用点写 `return cliError(...)` 时，其后的代码
// 在 mock 下不会解引用被收窄掉的值。
// cliError 使用 console.error（测试 spy console.error）；cliOk 使用
// process.stdout.write（测试 spy process.stdout.write —— Bun 的 console.log
// 不会经过被 spy 的 process.stdout.write）。

/** 将错误消息写入 stderr（如有），并以退出码 1 退出。 */
export function cliError(msg?: string): never {
  // biome-ignore lint/suspicious/noConsole: 集中的 CLI 错误输出
  if (msg) console.error(msg)
  process.exit(1)
  return undefined as never
}

/** 将消息写入 stdout（如有），并以退出码 0 退出。 */
export function cliOk(msg?: string): never {
  if (msg) process.stdout.write(msg + '\n')
  process.exit(0)
  return undefined as never
}
