/**
 * Bash 盲区补偿测试：变更类 Bash 执行前的工作区快照 + rewind 整体还原。
 *
 * 覆盖：
 * 1. commandLikelyMutating —— 只读白名单 vs 写副作用（含重定向/管道/串联）
 * 2. snapshotWorkspace + restoreCheckpoints —— Bash 直接改文件后，rewind 能还原
 * 3. 还原优先级：per-file 记录（Write/Edit）不被更旧的工作区快照覆盖
 */

import { test, describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { makeWorkspace } from './helpers.mjs'

let ws
let ckpt

before(async () => {
  ws = await makeWorkspace({
    'a.txt': 'A-v1\n',
    'src/b.txt': 'B-v1\n',
  })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  ckpt = await import('../server/checkpoints.mjs')
})

after(async () => {
  await ws?.cleanup()
})

const session = () => ({ id: 's-bash-snap', messages: [] })

describe('commandLikelyMutating', () => {
  it('只读白名单 → false', () => {
    assert.equal(ckpt.commandLikelyMutating('ls -la'), false)
    assert.equal(ckpt.commandLikelyMutating('git status'), false)
    assert.equal(ckpt.commandLikelyMutating('cat a.txt'), false)
  })
  it('写副作用 → true（含重定向/管道/串联/未知命令）', () => {
    assert.equal(ckpt.commandLikelyMutating('echo hi > out.txt'), true)
    assert.equal(ckpt.commandLikelyMutating('cat a.txt | grep x'), true)
    assert.equal(ckpt.commandLikelyMutating('rm -rf tmp'), true)
    assert.equal(ckpt.commandLikelyMutating('npm run build'), true)
  })
})

describe('工作区快照 → rewind 还原', () => {
  it('Bash 直接改掉的文件，restoreCheckpoints 能整体还原', async () => {
    const s = session()
    // 模拟变更类 Bash 之前的快照
    const r = await ckpt.snapshotWorkspace(s, ws.dir)
    assert.ok(r.files >= 2, `至少应捕获 a.txt 与 src/b.txt：${r.files}`)
    // 模拟 Bash 直接改文件（不走 Write/Edit，无 per-file 检查点）
    await writeFile(join(ws.dir, 'a.txt'), 'A-CLOBBERED-BY-BASH\n', 'utf8')
    await writeFile(join(ws.dir, 'src', 'b.txt'), 'B-CLOBBERED\n', 'utf8')
    await writeFile(join(ws.dir, 'new-by-bash.txt'), 'created\n', 'utf8')
    // 回滚
    const out = await ckpt.restoreCheckpoints(s, 0)
    assert.equal(await readFile(join(ws.dir, 'a.txt'), 'utf8'), 'A-v1\n', 'a.txt 应还原')
    assert.equal(await readFile(join(ws.dir, 'src', 'b.txt'), 'utf8'), 'B-v1\n', 'b.txt 应还原')
    assert.ok(out.restored >= 2, `应报告恢复数：${JSON.stringify(out)}`)
    // 快照消费后清空：再次 restore 不重复还原
    const again = await ckpt.restoreCheckpoints(s, 0)
    assert.equal(again.restored, 0)
  })

  it('per-file 记录（Write/Edit）优先于更旧的工作区快照', async () => {
    const s = session()
    // 快照（此刻 c.txt = v1）
    await writeFile(join(ws.dir, 'c.txt'), 'C-v1\n', 'utf8')
    await ckpt.snapshotWorkspace(s, ws.dir)
    // Write 工具改动：recordCheckpoint 记下旧内容，随后写成 v2
    await ckpt.recordCheckpoint(s, join(ws.dir, 'c.txt'), 'C-v1\n')
    await writeFile(join(ws.dir, 'c.txt'), 'C-v2\n', 'utf8')
    // 回滚：per-file 记录（msgSeq 同为 0）先于 ws 快照处理，最终停在 per-file 的 prev
    await ckpt.restoreCheckpoints(s, 0)
    assert.equal(await readFile(join(ws.dir, 'c.txt'), 'utf8'), 'C-v1\n')
  })
})
