// package.json 中 "browser" 字段的间接点。当 bun 以 --target browser
// 构建 browser-sdk.js 时，本文件会被替换为 crypto.browser.ts——从而避免
// Bun 内联一个约 500KB 的 crypto-browserify polyfill（否则会为
// `import ... from 'crypto'` 内联）。Node/bun 构建则原样使用本文件。
//
// 注意：`export { randomUUID } from 'crypto'`（再导出语法）在 bun-internal
// 的字节码编译下会出错——生成的字节码显示了 import，但绑定未连接
// （ReferenceError: randomUUID is not defined）。下面的先导入再导出的显式
// 写法能产生正确的活绑定。参见 PR #20957/#21178 上的 integration-tests-ant-native 失败。
import { randomUUID } from 'crypto'
export { randomUUID }
