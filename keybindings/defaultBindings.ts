import { feature } from 'bun:bundle'
import { satisfies } from 'src/utils/semver.js'
import { isRunningWithBun } from '../utils/bundledMode.js'
import { getPlatform } from '../utils/platform.js'
import type { KeybindingBlock } from './types.js'

/**
 * 与 Limkenion 当前行为一致的默认键位绑定。
 * 这些会先加载，随后由用户的 keybindings.json 覆盖。
 */

// 按平台区分的图片粘贴快捷键：
// - Windows：alt+v（ctrl+v 是系统粘贴）
// - 其他平台：ctrl+v
const IMAGE_PASTE_KEY = getPlatform() === 'windows' ? 'alt+v' : 'ctrl+v'

// 仅含修饰键的组合键（如 shift+tab）在未启用 VT 模式的 Windows Terminal 上可能失效
// 参见：https://github.com/microsoft/terminal/issues/879#issuecomment-618801651
// Node 在 24.2.0 / 22.17.0 中启用了 VT 模式：https://github.com/nodejs/node/pull/58358
// Bun 在 1.2.23 中启用了 VT 模式：https://github.com/oven-sh/bun/pull/21161
const SUPPORTS_TERMINAL_VT_MODE =
  getPlatform() !== 'windows' ||
  (isRunningWithBun()
    ? satisfies(process.versions.bun, '>=1.2.23')
    : satisfies(process.versions.node, '>=22.17.0 <23.0.0 || >=24.2.0'))

// 按平台区分的模式切换快捷键：
// - 未启用 VT 模式的 Windows：meta+m（shift+tab 无法可靠工作）
// - 其他平台：shift+tab
const MODE_CYCLE_KEY = SUPPORTS_TERMINAL_VT_MODE ? 'shift+tab' : 'meta+m'

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: 'Global',
    bindings: {
      // ctrl+c 和 ctrl+d 使用特殊的基于时间的双击处理。
      // 它们确实在此定义，以便解析器能找到它们，但
      // 用户无法重新绑定它们 —— reservedShortcuts.ts 中的校验
      // 会在用户尝试覆盖这些按键时显示错误。
      'ctrl+c': 'app:interrupt',
      'ctrl+d': 'app:exit',
      'ctrl+l': 'app:redraw',
      'ctrl+t': 'app:toggleTodos',
      'ctrl+o': 'app:toggleTranscript',
      ...(feature('KAIROS') || feature('KAIROS_BRIEF')
        ? { 'ctrl+shift+b': 'app:toggleBrief' as const }
        : {}),
      'ctrl+shift+o': 'app:toggleTeammatePreview',
      'ctrl+r': 'history:search',
      // 文件导航。cmd+ 绑定只在 kitty 协议终端上触发；
      // ctrl+shift 是可移植的降级方案。
      ...(feature('QUICK_SEARCH')
        ? {
            'ctrl+shift+f': 'app:globalSearch' as const,
            'cmd+shift+f': 'app:globalSearch' as const,
            'ctrl+shift+p': 'app:quickOpen' as const,
            'cmd+shift+p': 'app:quickOpen' as const,
          }
        : {}),
      ...(feature('TERMINAL_PANEL') ? { 'meta+j': 'app:toggleTerminal' } : {}),
    },
  },
  {
    context: 'Chat',
    bindings: {
      escape: 'chat:cancel',
      // ctrl+x 组合键前缀可避免遮蔽 readline 编辑键（ctrl+a/b/e/f/...）。
      'ctrl+x ctrl+k': 'chat:killAgents',
      [MODE_CYCLE_KEY]: 'chat:cycleMode',
      'meta+p': 'chat:modelPicker',
      'meta+o': 'chat:fastMode',
      'meta+t': 'chat:thinkingToggle',
      enter: 'chat:submit',
      up: 'history:previous',
      down: 'history:next',
      // 编辑快捷键（在此定义，迁移进行中）
      // 撤销有两个绑定以支持不同的终端行为：
      // - ctrl+_ 用于传统终端（发送 \x1f 控制字符）
      // - ctrl+shift+- 用于 Kitty 协议（发送带修饰键的物理按键）
      'ctrl+_': 'chat:undo',
      'ctrl+shift+-': 'chat:undo',
      // ctrl+x ctrl+e 是 readline 原生的 edit-and-execute-command 绑定。
      'ctrl+x ctrl+e': 'chat:externalEditor',
      'ctrl+g': 'chat:externalEditor',
      'ctrl+s': 'chat:stash',
      // 图片粘贴快捷键（平台相关的按键已在上面定义）
      [IMAGE_PASTE_KEY]: 'chat:imagePaste',
      ...(feature('MESSAGE_ACTIONS')
        ? { 'shift+up': 'chat:messageActions' as const }
        : {}),
      // 语音激活（按住说话）。注册它是为了让 getShortcutDisplay
      // 能直接找到，而不触发降级路径的分析日志。要重新绑定，
      // 添加一条 voice:pushToTalk 条目（靠后者胜出）；要禁用，使用 /voice
      // —— 用 null 解绑 space 会撞上 useKeybinding.ts 中已存在的陷阱：
      // 'unbound' 会吞掉事件（导致空格无法输入）。
      ...(feature('VOICE_MODE') ? { space: 'voice:pushToTalk' } : {}),
    },
  },
  {
    context: 'Autocomplete',
    bindings: {
      tab: 'autocomplete:accept',
      escape: 'autocomplete:dismiss',
      up: 'autocomplete:previous',
      down: 'autocomplete:next',
    },
  },
  {
    context: 'Settings',
    bindings: {
      // 设置菜单仅用 escape 关闭（不用 'n'）
      escape: 'confirm:no',
      // 配置面板列表导航（复用 Select 的动作）
      up: 'select:previous',
      down: 'select:next',
      k: 'select:previous',
      j: 'select:next',
      'ctrl+p': 'select:previous',
      'ctrl+n': 'select:next',
      // 切换/激活选中的设置（仅 space —— enter 保存并关闭）
      space: 'select:accept',
      // 保存并关闭配置面板
      enter: 'settings:close',
      // 进入搜索模式
      '/': 'settings:search',
      // 重试加载用量数据（仅在出错时激活）
      r: 'settings:retry',
    },
  },
  {
    context: 'Confirmation',
    bindings: {
      y: 'confirm:yes',
      n: 'confirm:no',
      enter: 'confirm:yes',
      escape: 'confirm:no',
      // 带列表的对话框的导航
      up: 'confirm:previous',
      down: 'confirm:next',
      tab: 'confirm:nextField',
      space: 'confirm:toggle',
      // 循环切换模式（用于文件权限对话框和 teams 对话框）
      'shift+tab': 'confirm:cycleMode',
      // 在权限对话框中切换权限说明的显示
      'ctrl+e': 'confirm:toggleExplanation',
      // 切换权限调试信息
      'ctrl+d': 'permission:toggleDebug',
    },
  },
  {
    context: 'Tabs',
    bindings: {
      // Tab 循环导航
      tab: 'tabs:next',
      'shift+tab': 'tabs:previous',
      right: 'tabs:next',
      left: 'tabs:previous',
    },
  },
  {
    context: 'Transcript',
    bindings: {
      'ctrl+e': 'transcript:toggleShowAll',
      'ctrl+c': 'transcript:exit',
      escape: 'transcript:exit',
      // q —— 分页器惯例（less、tmux 复制模式）。Transcript 是一个
      // 无提示词的模态阅读视图，因此 q 作为普通字符没有归属者。
      q: 'transcript:exit',
    },
  },
  {
    context: 'HistorySearch',
    bindings: {
      'ctrl+r': 'historySearch:next',
      escape: 'historySearch:accept',
      tab: 'historySearch:accept',
      'ctrl+c': 'historySearch:cancel',
      enter: 'historySearch:execute',
    },
  },
  {
    context: 'Task',
    bindings: {
      // 将前台运行的任务转入后台（bash 命令、agent）
      // 在 tmux 中，用户必须按两次 ctrl+b（转义 tmux 前缀）
      'ctrl+b': 'task:background',
    },
  },
  {
    context: 'ThemePicker',
    bindings: {
      'ctrl+t': 'theme:toggleSyntaxHighlighting',
    },
  },
  {
    context: 'Scroll',
    bindings: {
      pageup: 'scroll:pageUp',
      pagedown: 'scroll:pageDown',
      wheelup: 'scroll:lineUp',
      wheeldown: 'scroll:lineDown',
      'ctrl+home': 'scroll:top',
      'ctrl+end': 'scroll:bottom',
      // 选区复制。ctrl+shift+c 是标准的终端复制。
      // cmd+c 只在使用 kitty 键盘协议的终端
      //（kitty/WezTerm/ghostty/iTerm2）上触发，因为只有那里
      // super 修饰键才能真正到达 pty —— 其他环境下无效。
      // Esc 清除选区和上下文相关的 ctrl+c 通过裸
      // useInput 处理，以便它们能有条件地传播。
      'ctrl+shift+c': 'selection:copy',
      'cmd+c': 'selection:copy',
    },
  },
  {
    context: 'Help',
    bindings: {
      escape: 'help:dismiss',
    },
  },
  // 附件导航（选择对话框中的图片附件）
  {
    context: 'Attachments',
    bindings: {
      right: 'attachments:next',
      left: 'attachments:previous',
      backspace: 'attachments:remove',
      delete: 'attachments:remove',
      down: 'attachments:exit',
      escape: 'attachments:exit',
    },
  },
  // 页脚指示器导航（tasks、teams、diff、loop）
  {
    context: 'Footer',
    bindings: {
      up: 'footer:up',
      'ctrl+p': 'footer:up',
      down: 'footer:down',
      'ctrl+n': 'footer:down',
      right: 'footer:next',
      left: 'footer:previous',
      enter: 'footer:openSelected',
      escape: 'footer:clearSelection',
    },
  },
  // 消息选择器（回退对话框）导航
  {
    context: 'MessageSelector',
    bindings: {
      up: 'messageSelector:up',
      down: 'messageSelector:down',
      k: 'messageSelector:up',
      j: 'messageSelector:down',
      'ctrl+p': 'messageSelector:up',
      'ctrl+n': 'messageSelector:down',
      'ctrl+up': 'messageSelector:top',
      'shift+up': 'messageSelector:top',
      'meta+up': 'messageSelector:top',
      'shift+k': 'messageSelector:top',
      'ctrl+down': 'messageSelector:bottom',
      'shift+down': 'messageSelector:bottom',
      'meta+down': 'messageSelector:bottom',
      'shift+j': 'messageSelector:bottom',
      enter: 'messageSelector:select',
    },
  },
  // 光标激活期间 PromptInput 已卸载 —— 无按键冲突。
  ...(feature('MESSAGE_ACTIONS')
    ? [
        {
          context: 'MessageActions' as const,
          bindings: {
            up: 'messageActions:prev' as const,
            down: 'messageActions:next' as const,
            k: 'messageActions:prev' as const,
            j: 'messageActions:next' as const,
            // meta 在 macOS 上等于 cmd；kitty 键盘协议下则是 super —— 两者都绑定。
            'meta+up': 'messageActions:top' as const,
            'meta+down': 'messageActions:bottom' as const,
            'super+up': 'messageActions:top' as const,
            'super+down': 'messageActions:bottom' as const,
            // 存在鼠标选区时，shift+方向键会扩展选区（ScrollKeybindingHandler:573）——
            // 正确的分层交互：esc 先清除选区，然后 shift+↑ 才跳转。
            'shift+up': 'messageActions:prevUser' as const,
            'shift+down': 'messageActions:nextUser' as const,
            escape: 'messageActions:escape' as const,
            'ctrl+c': 'messageActions:ctrlc' as const,
            // 与 MESSAGE_ACTIONS 保持一致。不直接导入 —— 那会把 React/ink 拉进这个配置模块。
            enter: 'messageActions:enter' as const,
            c: 'messageActions:c' as const,
            p: 'messageActions:p' as const,
          },
        },
      ]
    : []),
  // Diff 对话框导航
  {
    context: 'DiffDialog',
    bindings: {
      escape: 'diff:dismiss',
      left: 'diff:previousSource',
      right: 'diff:nextSource',
      up: 'diff:previousFile',
      down: 'diff:nextFile',
      enter: 'diff:viewDetails',
      // 注意：diff:back 在详情模式下由左方向键处理
    },
  },
  // 模型选择器的 effort 循环切换（仅 ant 可用）
  {
    context: 'ModelPicker',
    bindings: {
      left: 'modelPicker:decreaseEffort',
      right: 'modelPicker:increaseEffort',
    },
  },
  // Select 组件导航（被 /model、/resume、权限提示等使用）
  {
    context: 'Select',
    bindings: {
      up: 'select:previous',
      down: 'select:next',
      j: 'select:next',
      k: 'select:previous',
      'ctrl+n': 'select:next',
      'ctrl+p': 'select:previous',
      enter: 'select:accept',
      escape: 'select:cancel',
    },
  },
  // 插件对话框动作（管理、浏览、发现插件）
  // 导航（select:*）使用上面的 Select 上下文
  {
    context: 'Plugin',
    bindings: {
      space: 'plugin:toggle',
      i: 'plugin:install',
    },
  },
]
