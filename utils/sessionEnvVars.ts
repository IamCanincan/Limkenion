/**
 * 通过 /env 设置、会话作用域内的环境变量。
 * 仅应用于派生的子进程（通过 bash provider 环境覆盖），
 * 不作用于 REPL 进程本身。
 */
const sessionEnvVars = new Map<string, string>()

export function getSessionEnvVars(): ReadonlyMap<string, string> {
  return sessionEnvVars
}



export function clearSessionEnvVars(): void {
  sessionEnvVars.clear()
}
