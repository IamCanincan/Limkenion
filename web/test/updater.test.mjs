/**
 * 更新器（web/launcher/updater.mjs）的回归防线。
 *
 * 这个模块有两条"错了用户完全看不出来"的保证，此前**没有任何测试**：
 * ① 版本比较必须是数值比较 —— 否则 0.10.0 会被判成小于 0.9.0，用户永远收不到更新；
 * ② 覆盖安装时必须跳过包内 Node —— 但**不能顺手把 node_modules/ 也跳过**，
 *    那是应用运行必需的依赖，跳过它等于更新后服务起不来。
 * 另外验证 fail-closed：没配更新源时不得谎报"有更新"。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, skipNodePath, checkUpdate, currentVersion, fetchLatest } from '../launcher/updater.mjs'

describe('compareSemver：必须是数值比较，不是字符串比较', () => {
  test('相等返回 0', () => {
    assert.equal(compareSemver('0.5.0', '0.5.0'), 0)
  })

  test('逐段比较 patch / minor / major', () => {
    assert.equal(compareSemver('0.5.0', '0.5.1'), -1)
    assert.equal(compareSemver('0.5.1', '0.5.0'), 1)
    assert.equal(compareSemver('0.5.0', '0.6.0'), -1)
    assert.equal(compareSemver('1.0.0', '0.9.9'), 1)
  })

  test('两位数段不能被当成字符串比（0.10.0 > 0.9.0）', () => {
    // 字符串比较下 '0.10.0' < '0.9.0'（'1' < '9'）→ 用户永远收不到更新
    assert.equal(compareSemver('0.9.0', '0.10.0'), -1)
    assert.equal(compareSemver('0.10.0', '0.9.0'), 1)
    assert.equal(compareSemver('0.2.0', '0.10.0'), -1)
  })

  test('缺段按 0 处理（0.5 与 0.5.0 等价）', () => {
    assert.equal(compareSemver('0.5', '0.5.0'), 0)
    assert.equal(compareSemver('0.5.0', '0.5'), 0)
    assert.equal(compareSemver('1', '1.0.0'), 0)
  })

  test('已知限制：预发布后缀不参与比较（只取数字段）', () => {
    // '0.5.1-beta' 的第三段 Number('1-beta') 是 NaN → 按 0 处理，等于 0.5.0。
    // 出包脚本只产出纯数字版本号，所以当前不受影响；此处固定住行为，
    // 将来若要支持预发布语义化版本，这条测试会红，提醒是有意改动。
    assert.equal(compareSemver('0.5.1-beta', '0.5.0'), 0)
  })
})

describe('skipNodePath：跳过内置 Node，但别误伤 node_modules', () => {
  test('顶层 node/ 跳过（win / linux 的内置 Node）', () => {
    assert.equal(skipNodePath(['node']), true)
    assert.equal(skipNodePath(['node', 'node.exe']), true)
    assert.equal(skipNodePath(['node', 'bin', 'node']), true)
  })

  test('.app 内的 Resources/node 跳过（macOS 内置 Node）', () => {
    assert.equal(skipNodePath(['Limkenion.app', 'Contents', 'Resources', 'node']), true)
    assert.equal(skipNodePath(['Limkenion.app', 'Contents', 'Resources', 'node', 'arm64', 'bin', 'node']), true)
  })

  test('node_modules/ 必须**不**跳过 —— 那是运行必需依赖', () => {
    // 若实现写成 `relParts[0].startsWith('node')`，这里会误判成 true，
    // 更新包里的 node_modules/ws 被丢弃 → 服务起不来。
    assert.equal(skipNodePath(['node_modules']), false)
    assert.equal(skipNodePath(['node_modules', 'ws']), false)
    assert.equal(skipNodePath(['node_modules', 'ws', 'index.js']), false)
  })

  test('正常产物路径不跳过', () => {
    assert.equal(skipNodePath(['server']), false)
    assert.equal(skipNodePath(['server', 'index.mjs']), false)
    assert.equal(skipNodePath(['dist', 'assets', 'index.js']), false)
    assert.equal(skipNodePath(['launcher.mjs']), false)
    assert.equal(skipNodePath(['version.json']), false)
    // .app 下除 Resources/node 外的内容要照常更新（入口脚本本身会被更新覆盖）
    assert.equal(skipNodePath(['Limkenion.app', 'Contents', 'MacOS', 'limkenion']), false)
    assert.equal(skipNodePath(['Limkenion.app', 'Contents', 'Resources', 'other']), false)
  })

  test('路径分段不足时不越界（.app 只给到半路）', () => {
    assert.equal(skipNodePath(['Limkenion.app']), false)
    assert.equal(skipNodePath(['Limkenion.app', 'Contents']), false)
    assert.equal(skipNodePath(['Limkenion.app', 'Contents', 'Resources']), false)
  })
})

describe('fail-closed：没配更新源时不谎报有更新', () => {
  test('未设 LIMKENION_UPDATE_URL → fetchLatest 返回 null', async () => {
    assert.equal(await fetchLatest(), null)
  })

  test('未设更新源 → checkUpdate 报 available:false 并说明原因', async () => {
    const r = await checkUpdate()
    assert.equal(r.available, false)
    assert.equal(typeof r.current, 'string')
    assert.match(r.reason, /LIMKENION_UPDATE_URL/)
  })

  test('currentVersion 从 launcher/version.json 读出真实版本', () => {
    const v = currentVersion()
    assert.match(v, /^\d+\.\d+\.\d+$/, `版本号应是 x.y.z，实际：${v}`)
    assert.notEqual(v, '0.0.0', 'version.json 存在时应能读到真实版本（读失败才会降级成 0.0.0）')
  })
})
