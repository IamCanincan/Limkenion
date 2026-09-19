// 故意不安装兜底，制造未捕获拒绝。
// 用来反向校验 crash-guard 测试「真的能抓到回归」，而不是永远绿。
// 在 Node 15+ 默认行为下，未捕获的 Promise 拒绝会让进程以非 0 退出，
// 因此本进程不会活到打印 ALIVE。
Promise.reject(new Error('unguarded'))

setTimeout(() => {
  console.log('ALIVE')
  process.exit(0)
}, 200)
