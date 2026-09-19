/**
 * 进程级崩溃兜底回归测试。
 *
 * 验证 installCrashGuard() 真的能让「未捕获的 Promise 拒绝 / 同步异常」
 * 不再杀死进程（否则整个本地服务会因为我方任何一处 bug 而下线）。
 *
 * 做法：fork 一个子进程，它注册兜底后分别制造两类未捕获异常。
 *   - 若兜底失效：子进程会很快以非 0 退出 → 测试失败。
 *   - 若兜底生效：子进程活到 200ms 打印 ALIVE 并 exit(0) → 测试通过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const childScript = join(here, '_fixtures', 'crash-guard-child.mjs')

test('全局崩溃兜底：未捕获的拒绝与异常不再杀死进程', async () => {
  const { log, code, signal } = await new Promise((resolve, reject) => {
    const child = fork(childScript, [], { silent: true })
    let log = ''
    child.stdout.on('data', d => { log += d.toString() })
    child.stderr.on('data', d => { log += d.toString() })

    // 400ms 还没退出 → 说明兜底肯定失效不了（兜底若失效早退出了）；主动回收。
    const watchdog = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ log, code: 'TIMEOUT', signal: 'SIGTERM' })
    }, 400)

    child.on('exit', (exitCode, exitSignal) => {
      clearTimeout(watchdog)
      resolve({ log, code: exitCode, signal: exitSignal })
    })
    child.on('error', reject)
  })

  // 兜底生效：子进程要么主动干净退出（打印了 ALIVE），要么被我们看门狗回收。
  // 兜底失效：会以非 0 码退出（Node 对未捕获异常的默认行为）。
  const survived = log.includes('ALIVE')
  assert.ok(survived, `进程应能存活到打印 ALIVE（实际输出：\n${log}）`)
  // 兜底生效时子进程自己 exit(0)；被看门狗杀掉（code='TIMEOUT'）也算没被打死。
  assert.ok(
    code === 0 || code === 'TIMEOUT',
    `进程不应因未捕获异常而异常退出（code=${code} signal=${signal}）`,
  )
})

test('未安装兜底时，子进程会因未捕获异常而死（反向校验测试本身有效）', async () => {
  // 用「故意不装兜底」的子进程，确认上面的测试是「真能抓到回归」，而不是永远绿。
  const unguarded = join(here, '_fixtures', 'crash-guard-unguarded-child.mjs')
  const { log, code } = await new Promise((resolve, reject) => {
    const child = fork(unguarded, [], { silent: true })
    let log = ''
    child.stdout.on('data', d => { log += d.toString() })
    child.stderr.on('data', d => { log += d.toString() })
    const wd = setTimeout(() => { child.kill('SIGTERM'); resolve({ log, code: 'TIMEOUT' }) }, 400)
    child.on('exit', (c) => { clearTimeout(wd); resolve({ log, code: c }) })
    child.on('error', reject)
  })
  // 没兜底 + 未捕获拒绝 → 进程应以非 0 退出，且不会打印 ALIVE。
  assert.notStrictEqual(code, 0, '未安装兜底时进程应当因未捕获异常而退出')
  assert.ok(!log.includes('ALIVE'), '未安装兜底时进程不应存活到打印 ALIVE')
})
