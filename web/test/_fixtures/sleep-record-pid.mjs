// 孙进程夹供 Bash 超时测试用：写下自己的 pid 到 argv[2]，然后长时间休眠。
// 用来验证「超时后 shell 的孙进程也被连根杀掉」——只杀 cmd.exe 的话，这个
// node 进程会继续活着（占着文件锁/端口），直到自己超时退出。
import { writeFileSync } from 'node:fs'

writeFileSync(process.argv[2], String(process.pid))
setTimeout(() => {}, 20_000)
