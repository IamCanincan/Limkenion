/**
 * CLI ↔ web 的共享契约（钩子事件名、权限模式名等）。
 *
 * 数据来自 `web/server/data/cli-contract.json`，由 CLI 侧的
 * `scripts/gen-shared-contract.mjs` 用 TypeScript AST 从 CLI 源码提取后生成，
 * 提交在仓库里。web 端从这里取**全量**名单，自己只声明子集。
 *
 * 为什么不放一份硬编码的副本：两端各写一份必然漂移 —— CLI 加了事件/改了模式名，
 * web 毫不知情，要么继续显示旧名，要么把用户按新名写的配置判成无效。
 *
 * 这个模块只依赖 node:fs，谁都能 import，不会成环。
 */
import { readFileSync } from 'node:fs'

const CONTRACT_PATH = new URL('./data/cli-contract.json', import.meta.url)

function loadContract() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'))
  } catch (err) {
    // 契约是 web 判断"这个名字合法吗"的依据。读不到就闭眼放行，
    // 会把用户配错的钩子事件当成"web 不支持"糊弄过去 —— 那正是要消灭的 silent failure。
    throw new Error(
      '读不到 CLI 共享契约 web/server/data/cli-contract.json。\n' +
        '  在仓库根执行：node scripts/gen-shared-contract.mjs\n' +
        `  原始错误：${String(err)}`,
    )
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.hookEvents)) {
    throw new Error(
      `CLI 共享契约格式不对（version=${parsed?.version}）。重新生成：` +
        'node scripts/gen-shared-contract.mjs',
    )
  }
  return parsed
}

const contract = loadContract()

/** CLI 定义的全部钩子事件名。 */
export const ALL_HOOK_EVENTS = contract.hookEvents

/** CLI 定义的全部（对外）权限模式名。 */
export const ALL_PERMISSION_MODES = contract.permissionModes ?? []

export const CONTRACT_GENERATED_AT = contract.generatedAt

/**
 * 校验 web 自己声明的子集确实在契约内。
 *
 * 这是这套机制的价值所在：CLI 侧一改名，web 启动就能发现，
 * 而不是等用户报"我配的钩子没反应"。
 *
 * @param {string} what 用途说明（进告警文案）
 * @param {string[]} declared web 端声明的名字
 * @param {string[]} fromContract 契约里的全量名单
 * @returns {string[]} 不在契约里的那些（正常情况下应为空）
 */
export function unknownAgainstContract(what, declared, fromContract) {
  const set = new Set(fromContract)
  return declared.filter(n => !set.has(n))
}
