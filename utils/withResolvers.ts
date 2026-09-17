/**
 * Promise.withResolvers()（ES2024，Node 22+）的 polyfill。
 * package.json 声明 "engines": { "node": ">=18.0.0" }，因此无法使用原生实现。
 */
export function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
