import chalk from 'chalk'
import { logEvent } from 'src/services/analytics/index.js'
import {
  getLatestVersion,
  type InstallStatus,
  installGlobalPackage,
} from 'src/utils/autoUpdater.js'
import { regenerateCompletionCache } from 'src/utils/completionCache.js'
import {
  getGlobalConfig,
  type InstallMethod,
  saveGlobalConfig,
} from 'src/utils/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getDoctorDiagnostic } from 'src/utils/doctorDiagnostic.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import {
  installOrUpdateLimkenionPackage,
  localInstallationExists,
} from 'src/utils/localInstaller.js'
import {
  installLatest as installLatestNative,
  removeInstalledSymlink,
} from 'src/utils/nativeInstaller/index.js'
import { getPackageManager } from 'src/utils/nativeInstaller/packageManagers.js'
import { writeToStdout } from 'src/utils/process.js'
import { gte } from 'src/utils/semver.js'
import { getInitialSettings } from 'src/utils/settings/settings.js'

export async function update() {
  logEvent('limkenion_update_check', {})
  writeToStdout(`当前版本：${MACRO.VERSION}\n`)

  const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest'
  writeToStdout(`正在检查 ${channel} 版本的更新…\n`)

  logForDebugging('update: 开始检查更新')

  // 运行诊断以检测潜在问题
  logForDebugging('update: 正在运行诊断')
  const diagnostic = await getDoctorDiagnostic()
  logForDebugging(`update: 安装类型: ${diagnostic.installationType}`)
  logForDebugging(
    `update: 配置安装方式: ${diagnostic.configInstallMethod}`,
  )

  // 检查是否存在多个安装版本
  if (diagnostic.multipleInstallations.length > 1) {
    writeToStdout('\n')
    writeToStdout(chalk.yellow('警告：发现多个安装版本') + '\n')
    for (const install of diagnostic.multipleInstallations) {
      const current =
        diagnostic.installationType === install.type
          ? '（当前运行中）'
          : ''
      writeToStdout(`- ${install.type} 位于 ${install.path}${current}\n`)
    }
  }

  // 如有警告则显示
  if (diagnostic.warnings.length > 0) {
    writeToStdout('\n')
    for (const warning of diagnostic.warnings) {
      logForDebugging(`update: 检测到警告: ${warning.issue}`)

      // 不要跳过 PATH 警告——它们始终与用户相关
      // 用户需要知道 'which limkenion' 指向了别处
      logForDebugging(`update: 正在显示警告: ${warning.issue}`)

      writeToStdout(chalk.yellow(`警告：${warning.issue}\n`))

      writeToStdout(chalk.bold(`修复：${warning.fix}\n`))
    }
  }

  // 如果 installMethod 未设置则更新配置（但包管理器安装跳过此操作）
  const config = getGlobalConfig()
  if (
    !config.installMethod &&
    diagnostic.installationType !== 'package-manager'
  ) {
    writeToStdout('\n')
    writeToStdout('正在更新配置以记录安装方式…\n')
    let detectedMethod: 'local' | 'native' | 'global' | 'unknown' = 'unknown'

    // 把诊断得到的安装类型映射为配置里的安装方式
    switch (diagnostic.installationType) {
      case 'npm-local':
        detectedMethod = 'local'
        break
      case 'native':
        detectedMethod = 'native'
        break
      case 'npm-global':
        detectedMethod = 'global'
        break
      default:
        detectedMethod = 'unknown'
    }

    saveGlobalConfig(current => ({
      ...current,
      installMethod: detectedMethod,
    }))
    writeToStdout(`已设置安装方式：${detectedMethod}\n`)
  }

  // 检查是否运行在开发版构建
  if (diagnostic.installationType === 'development') {
    writeToStdout('\n')
    writeToStdout(
      chalk.yellow('警告：无法更新开发版构建') + '\n',
    )
    await gracefulShutdown(1)
  }

  // 检查是否由包管理器管理
  if (diagnostic.installationType === 'package-manager') {
    const packageManager = await getPackageManager()
    writeToStdout('\n')

    if (packageManager === 'homebrew') {
      writeToStdout('Limkenion 由 Homebrew 管理。\n')
      const latest = await getLatestVersion(channel)
      if (latest && !gte(MACRO.VERSION, latest)) {
        writeToStdout(`发现可用更新：${MACRO.VERSION} → ${latest}\n`)
        writeToStdout('\n')
        writeToStdout('如需更新，请运行：\n')
        writeToStdout(chalk.bold('  brew upgrade limkenion') + '\n')
      } else {
        writeToStdout('Limkenion 已是最新版本！\n')
      }
    } else if (packageManager === 'winget') {
      writeToStdout('Limkenion 由 winget 管理。\n')
      const latest = await getLatestVersion(channel)
      if (latest && !gte(MACRO.VERSION, latest)) {
        writeToStdout(`发现可用更新：${MACRO.VERSION} → ${latest}\n`)
        writeToStdout('\n')
        writeToStdout('如需更新，请运行：\n')
        writeToStdout(
          chalk.bold('  winget upgrade Limkenion.Limkenion') + '\n',
        )
      } else {
        writeToStdout('Limkenion 已是最新版本！\n')
      }
    } else if (packageManager === 'apk') {
      writeToStdout('Limkenion 由 apk 管理。\n')
      const latest = await getLatestVersion(channel)
      if (latest && !gte(MACRO.VERSION, latest)) {
        writeToStdout(`发现可用更新：${MACRO.VERSION} → ${latest}\n`)
        writeToStdout('\n')
        writeToStdout('如需更新，请运行：\n')
        writeToStdout(chalk.bold('  apk upgrade limkenion') + '\n')
      } else {
        writeToStdout('Limkenion 已是最新版本！\n')
      }
    } else {
      // pacman、deb 和 rpm 没有统一的具体命令，因为各有多种前端
      // （pacman: yay/paru/makepkg，deb: apt/apt-get/aptitude/nala，
      //  rpm: dnf/yum/zypper）
      writeToStdout('Limkenion 由包管理器管理。\n')
      writeToStdout('请使用你的包管理器进行更新。\n')
    }

    await gracefulShutdown(0)
  }

  // 检查配置与实际安装是否一致（包管理器安装跳过此检查）
  if (
    config.installMethod &&
    diagnostic.configInstallMethod !== 'not set' &&
    diagnostic.installationType !== 'package-manager'
  ) {
    const runningType = diagnostic.installationType
    const configExpects = diagnostic.configInstallMethod

    // 映射安装类型，用于比较
    const typeMapping: Record<string, string> = {
      'npm-local': 'local',
      'npm-global': 'global',
      native: 'native',
      development: 'development',
      unknown: 'unknown',
    }

    const normalizedRunningType = typeMapping[runningType] || runningType

    if (
      normalizedRunningType !== configExpects &&
      configExpects !== 'unknown'
    ) {
      writeToStdout('\n')
      writeToStdout(chalk.yellow('警告：配置与实际安装不一致') + '\n')
      writeToStdout(`配置期望：${configExpects} 安装\n`)
      writeToStdout(`当前运行：${runningType}\n`)
      writeToStdout(
        chalk.yellow(
          `正在更新你当前使用的 ${runningType} 安装`,
        ) + '\n',
      )

      // 更新配置以匹配实际安装
      saveGlobalConfig(current => ({
        ...current,
        installMethod: normalizedRunningType as InstallMethod,
      }))
      writeToStdout(
        `配置已更新以反映当前安装方式：${normalizedRunningType}\n`,
      )
    }
  }

  // 优先处理原生安装方式的更新
  if (diagnostic.installationType === 'native') {
    logForDebugging(
      'update: 检测到原生安装，使用原生更新器',
    )
    try {
      const result = await installLatestNative(channel, true)

      // 优雅处理锁竞争
      if (result.lockFailed) {
        const pidInfo = result.lockHolderPid
          ? ` (PID ${result.lockHolderPid})`
          : ''
        writeToStdout(
          chalk.yellow(
            `另一个 Limkenion 进程${pidInfo}正在运行。请稍后再试。`,
          ) + '\n',
        )
        await gracefulShutdown(0)
      }

      if (!result.latestVersion) {
        process.stderr.write('检查更新失败\n')
        await gracefulShutdown(1)
      }

      if (result.latestVersion === MACRO.VERSION) {
        writeToStdout(
          chalk.green(`Limkenion 已是最新版本（${MACRO.VERSION}）`) + '\n',
        )
      } else {
        writeToStdout(
          chalk.green(
            `已成功从 ${MACRO.VERSION} 更新到版本 ${result.latestVersion}`,
          ) + '\n',
        )
        await regenerateCompletionCache()
      }
      await gracefulShutdown(0)
    } catch (error) {
      process.stderr.write('错误：原生更新安装失败\n')
      process.stderr.write(String(error) + '\n')
      process.stderr.write('可运行 "limkenion doctor" 进行诊断\n')
      await gracefulShutdown(1)
    }
  }

  // 回退到现有的 JS/npm 更新逻辑
  // 由于不使用原生安装，移除原生安装器的符号链接
  // 但仅当用户尚未迁移到原生安装时
  if (config.installMethod !== 'native') {
    await removeInstalledSymlink()
  }

  logForDebugging('update: 正在从 npm registry 检查最新版本')
  logForDebugging(`update: 包 URL: ${MACRO.PACKAGE_URL}`)
  const npmTag = channel === 'stable' ? 'stable' : 'latest'
  const npmCommand = `npm view ${MACRO.PACKAGE_URL}@${npmTag} version`
  logForDebugging(`update: 正在运行: ${npmCommand}`)
  const latestVersion = await getLatestVersion(channel)
  logForDebugging(
    `update: npm 上的最新版本: ${latestVersion || 'FAILED'}`,
  )

  if (!latestVersion) {
    logForDebugging('update: 无法从 npm registry 获取最新版本')
    process.stderr.write(chalk.red('检查更新失败') + '\n')
    process.stderr.write('无法从 npm 源获取最新版本\n')
    process.stderr.write('\n')
    process.stderr.write('可能的原因：\n')
    process.stderr.write('  • 网络连接问题\n')
    process.stderr.write('  • npm 源不可达\n')
    process.stderr.write('  • 公司代理/防火墙阻止了 npm 访问\n')
    if (MACRO.PACKAGE_URL && !MACRO.PACKAGE_URL.startsWith('@limkenion')) {
      process.stderr.write(
        '  • 内部/开发版构建未发布到 npm\n',
      )
    }
    process.stderr.write('\n')
    process.stderr.write('可以尝试：\n')
    process.stderr.write('  • 检查你的网络连接\n')
    process.stderr.write('  • 使用 --debug 参数获取更多详情\n')
    const packageName =
      MACRO.PACKAGE_URL ||
      ('@limkenion-ai/limkenion')
    process.stderr.write(
      `  • 手动检查：npm view ${packageName} version\n`,
    )

    process.stderr.write('  • 检查是否需要登录：npm whoami\n')
    await gracefulShutdown(1)
  }

  // 检查版本是否完全一致，包括任何构建元数据（如 SHA）
  if (latestVersion === MACRO.VERSION) {
    writeToStdout(
      chalk.green(`Limkenion 已是最新版本（${MACRO.VERSION}）`) + '\n',
    )
    await gracefulShutdown(0)
  }

  writeToStdout(
    `发现新版本：${latestVersion}（当前：${MACRO.VERSION}）\n`,
  )
  writeToStdout('正在安装更新…\n')

  // 根据实际运行环境确定更新方式
  let useLocalUpdate = false
  let updateMethodName = ''

  switch (diagnostic.installationType) {
    case 'npm-local':
      useLocalUpdate = true
      updateMethodName = 'local'
      break
    case 'npm-global':
      useLocalUpdate = false
      updateMethodName = 'global'
      break
    case 'unknown': {
      // 无法确定安装类型时，回退到文件检测
      const isLocal = await localInstallationExists()
      useLocalUpdate = isLocal
      updateMethodName = isLocal ? 'local' : 'global'
      writeToStdout(
        chalk.yellow('警告：无法确定安装类型') + '\n',
      )
      writeToStdout(
        `将根据文件检测尝试${updateMethodName}更新…\n`,
      )
      break
    }
    default:
      process.stderr.write(
        `错误：无法更新 ${diagnostic.installationType} 安装\n`,
      )
      await gracefulShutdown(1)
  }

  writeToStdout(`正在使用 ${updateMethodName} 安装方式更新…\n`)

  logForDebugging(`update: 已确定的更新方式: ${updateMethodName}`)
  logForDebugging(`update: useLocalUpdate: ${useLocalUpdate}`)

  let status: InstallStatus

  if (useLocalUpdate) {
    logForDebugging(
      'update: 调用 installOrUpdateLimkenionPackage() 进行本地更新',
    )
    status = await installOrUpdateLimkenionPackage(channel)
  } else {
    logForDebugging('update: 调用 installGlobalPackage() 进行全局更新')
    status = await installGlobalPackage()
  }

  logForDebugging(`update: 安装状态: ${status}`)

  switch (status) {
    case 'success':
      writeToStdout(
        chalk.green(
          `已成功从 ${MACRO.VERSION} 更新到版本 ${latestVersion}`,
        ) + '\n',
      )
      await regenerateCompletionCache()
      break
    case 'no_permissions':
      process.stderr.write(
        '错误：权限不足，无法安装更新\n',
      )
      if (useLocalUpdate) {
        process.stderr.write('可尝试手动更新：\n')
        process.stderr.write(
          `  cd ~/.limkenion/local && npm update ${MACRO.PACKAGE_URL}\n`,
        )
      } else {
        process.stderr.write('可尝试使用 sudo 运行或修复 npm 权限\n')
        process.stderr.write(
          '或考虑使用原生安装方式：limkenion install\n',
        )
      }
      await gracefulShutdown(1)
      break
    case 'install_failed':
      process.stderr.write('错误：安装更新失败\n')
      if (useLocalUpdate) {
        process.stderr.write('可尝试手动更新：\n')
        process.stderr.write(
          `  cd ~/.limkenion/local && npm update ${MACRO.PACKAGE_URL}\n`,
        )
      } else {
        process.stderr.write(
          '可考虑使用原生安装方式：limkenion install\n',
        )
      }
      await gracefulShutdown(1)
      break
    case 'in_progress':
      process.stderr.write(
        '错误：另一个实例正在进行更新\n',
      )
      process.stderr.write('请稍后重试\n')
      await gracefulShutdown(1)
      break
  }
  await gracefulShutdown(0)
}
