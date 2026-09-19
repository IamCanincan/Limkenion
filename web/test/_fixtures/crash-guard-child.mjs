// 崩溃兜底测试用的子进程：注册兜底后，分别制造「未捕获的 Promise 拒绝」
// 和「未捕获的同步异常」。若兜底失效，进程会在 50ms 前后异常退出；
// 若兜底生效，进程活到 200ms 打印 ALIVE 并干净退出 0。
import { installCrashGuard } from '../../server/crashGuard.mjs'

installCrashGuard()

// ① 未捕获的 Promise 拒绝
Promise.reject(new Error('boom-rejection'))

// ② 未捕获的同步异常
setTimeout(() => {
  throw new Error('boom-exception')
}, 50)

// 兜底生效的话，进程应当活到这一刻
setTimeout(() => {
  console.log('ALIVE')
  process.exit(0)
}, 200)
