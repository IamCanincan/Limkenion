import { feature } from 'bun:bundle';

// 修复 corepack 自动锁定版本的问题，它会把 yarnpkg 添加进用户的 package.json
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// 在 CCR 环境中为子进程设置最大堆大小（容器有 16GB 内存）
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level, custom-rules/safe-env-boolean-check
if (process.env.LIMKENION_REMOTE === 'true') {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  const existing = process.env.NODE_OPTIONS || '';
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192';
}

// Harness-science 的 L0 消融基线。内联在此处（而非 init.ts），因为
// BashTool/AgentTool/PowerShellTool 会在 import 时把 DISABLE_BACKGROUND_TASKS
// 捕获进模块级常量 —— 那时 init() 已经执行得太晚。feature() 分支
// 会在外部构建中通过 DCE 移除整个代码块。
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (feature('ABLATION_BASELINE') && process.env.LIMKENION_ABLATION_BASELINE) {
  for (const k of ['LIMKENION_SIMPLE', 'LIMKENION_DISABLE_THINKING', 'DISABLE_INTERLEAVED_THINKING', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'LIMKENION_DISABLE_AUTO_MEMORY', 'LIMKENION_DISABLE_BACKGROUND_TASKS']) {
    // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
    process.env[k] ??= '1';
  }
}

/**
 * 引导入口 —— 在加载完整 CLI 之前先检查特殊标识。
 * 所有导入均为动态导入，以尽量减小快速路径下的模块求值开销。
 * --version 的快速路径在本文件之外无需任何导入。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 快速路径 --version/-v：无需加载任何模块
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION 在构建时内联
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${MACRO.VERSION} (Limkenion)`);
    return;
  }

  // 对所有其它路径，加载启动性能分析器
  const {
    profileCheckpoint
  } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // 快速路径 --dump-system-prompt：输出渲染后的系统提示词后退出。
  // 供提示词敏感性评估使用，用于在特定提交下提取系统提示词。
  // 仅限内部：通过 feature 标识在产品外部构建中剔除。
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      getMainLoopModel
    } = await import('../utils/model/model.js');
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 && args[modelIdx + 1] || getMainLoopModel();
    const {
      getSystemPrompt
    } = await import('../constants/prompts.js');
    const prompt = await getSystemPrompt([], model);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(prompt.join('\n'));
    return;
  }
  if (process.argv[2] === '--limkenion-in-chrome-mcp') {
    profileCheckpoint('cli_limkenion_in_chrome_mcp_path');
    const {
      runLimkenionInChromeMcpServer
    } = await import('../utils/limkenionInChrome/mcpServer.js');
    await runLimkenionInChromeMcpServer();
    return;
  } else if (process.argv[2] === '--chrome-native-host') {
    profileCheckpoint('cli_chrome_native_host_path');
    const {
      runChromeNativeHost
    } = await import('../utils/limkenionInChrome/chromeNativeHost.js');
    await runChromeNativeHost();
    return;
  } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path');
    const {
      runComputerUseMcpServer
    } = await import('../utils/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  // 快速路径 `--daemon-worker=<kind>`（内部机制 —— 由 supervisor 启动）。
  // 必须放在 daemon 子命令检查之前：每个 worker 都会启动，因此对性能敏感。
  // 这一层不调用 enableConfigs()，也没有分析 sink —— worker 保持精简。
  // 如果某个 worker 类型需要配置/鉴权（assistant 就需要），
  // 会在其 run() 函数内部自行调用。
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const {
      runDaemonWorker
    } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(args[1]);
    return;
  }

  // 快速路径 `limkenion remote-control`（同时兼容旧命令 `limkenion remote` / `limkenion sync` / `limkenion bridge`）：
  // 把本地机器作为桥接环境对外提供服务。

  // 快速路径 `limkenion daemon [subcommand]`：常驻 supervisor。
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      initSinks
    } = await import('../utils/sinks.js');
    initSinks();
    const {
      daemonFastMain
    } = await import('../daemon/backgroundDaemon.js');
    await daemonFastMain(args.slice(1));
    return;
  }

  // 快速路径 `limkenion ps|logs|attach|kill` 以及 `--bg`/`--background`。
  // 针对 ~/.limkenion/sessions/ 注册表的会话管理。标识
  // 字面量已内联，因此仅在实际分发时才会加载 bg.js。
  if (feature('BG_SESSIONS') && (args[0] === 'ps' || args[0] === 'logs' || args[0] === 'attach' || args[0] === 'kill' || args.includes('--bg') || args.includes('--background'))) {
    profileCheckpoint('cli_bg_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const bg = await import('../cli/bg.js');
    switch (args[0]) {
      case 'ps':
        await bg.psHandler(args.slice(1));
        break;
      case 'logs':
        await bg.logsHandler(args[1]);
        break;
      case 'attach':
        await bg.attachHandler(args[1]);
        break;
      case 'kill':
        await bg.killHandler(args[1]);
        break;
      default:
        await bg.handleBgFlag(args);
    }
    return;
  }

  // 快速路径：用于模板作业命令。
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    profileCheckpoint('cli_templates_path');
    const {
      templatesMain
    } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args);
    // 使用 process.exit（而非 return）—— mountFleetView 的 Ink TUI 可能会留下
    // 阻止自然退出的事件循环句柄。
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0);
  }

  // 快速路径 `limkenion environment-runner`：无头 BYOC 运行器。
  // feature() 必须保持内联，以便在构建时进行死代码消除。
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path');
    const {
      environmentRunnerMain
    } = await import('../environment-runner/main.js');
    await environmentRunnerMain(args.slice(1));
    return;
  }

  // 快速路径 `limkenion self-hosted-runner`：无头自托管运行器，
  // 面向 SelfHostedRunnerWorkerService API（注册 + 轮询；轮询即
  // 心跳）。feature() 必须保持内联，以便在构建时进行死代码消除。
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path');
    const {
      selfHostedRunnerMain
    } = await import('../self-hosted-runner/main.js');
    await selfHostedRunnerMain(args.slice(1));
    return;
  }

  // 快速路径 --worktree --tmux：在加载完整 CLI 之前先 exec 进 tmux
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (hasTmuxFlag && (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      isWorktreeModeEnabled
    } = await import('../utils/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const {
        execIntoTmuxWorktree
      } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      // 如果未被处理（例如出错），则回退到正常 CLI
      if (result.error) {
        const {
          exitWithError
        } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  // 将常见的更新标识拼写错误重定向到 update 子命令
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // --bare：尽早设置 SIMPLE，以便门控在模块求值 / commander 选项构建期间即生效
  // （而不仅仅是在 action 处理器内部）。
  if (args.includes('--bare')) {
    process.env.LIMKENION_SIMPLE = '1';
  }

  // 未检测到特殊标识，加载并运行完整 CLI
  const {
    startCapturingEarlyInput
  } = await import('../utils/earlyInput.js');
  startCapturingEarlyInput();
  profileCheckpoint('cli_before_main_import');
  const {
    main: cliMain
  } = await import('../main.js');
  profileCheckpoint('cli_after_main_import');
  // 绝不吞掉错误：上面的 `void main()` 不处理 rejections，因此
  // 这里若是空的 catch 就会复现最初的"exit 0 且零输出"的 bug。
  // 打印它并返回非零退出码，确保任何失败都清晰可见。
  await cliMain().catch(err => {
    process.stderr.write(
      `[Limkenion] 致命错误: ${err && err.stack ? err.stack : String(err)}\n`,
    )
    process.exit(1)
  })
  profileCheckpoint('cli_after_main_complete');
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main();