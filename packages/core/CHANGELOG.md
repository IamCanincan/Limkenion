# Changelog

从 1.0.0 起记录。

## [Unreleased]

### Changed

- **按「高效编码」重排了工具的几个取舍**（每一项省的都是**往返次数**，见 `README.md` 的「为少走弯路定的几条规则」）：
  - **`edit` 不再因为「文件被格式化器改过」要求整份重读**：每段 `oldText` 必须与当前内容逐字相同且
    唯一，这条本身就是锚点——它证明了「要改的就是模型看见的那一段」，别处变了不影响这次替换，
    只在结果里提醒一句。`write` 是整份覆盖、没有锚点，照旧要求整份指纹没变。
  - **编辑失败时报错能直接照着改**：`oldText` 找不到时按**词元重合度**给最像的三行（
    `const total = 1;` 与 `const sum = 1;` 这种「换了个名字」也能命中），出现多次时列出全部行号——
    这两种情况从前都只能靠「再 read 一次整个文件」。
  - **`read` 新增 `paths`**：一次读多个文件（最多 12 个、合计 200KB），接口 + 实现 + 测试这种固定组合
    一次读完；批量读过的文件后续都能直接 `edit`。单个文件读失败不影响其它文件。
  - **`bash` 输出超限改成保留头尾、省略中间**，只有超过上限 20 倍才终止进程。从前一超限就杀并只留头部，
    而测试失败清单与构建错误都在尾部——为了看结论得把同一条命令再跑一遍（构建类还要再等几十秒）。

## [1.0.0] - 2026-09-15

### Breaking Changes

- **项目说明文件不再读 `CLAUDE.md`**（项目侧候选与 `~/.claude/CLAUDE.md` 那个全局回退都去掉了）。
  现在候选只有 `AGENTS.override.md` → `AGENTS.md` → `CONTEXT.md`，全局层只认
  `<配置目录>/AGENTS.md`。**迁移办法**：把 `CLAUDE.md` 改名成 `AGENTS.md` 即可，内容不用动
  （同一目录里 `AGENTS.override.md` 仍能顶掉它）。
- **`ApprovalRequest` 与 `approval` 事件各多两个必填字段**：`detail`（确认卡片正文，可多行）与
  `destructive`（这次调用是否看起来不可逆）。两者都由**工具自陈**（新增的 `describeApproval` 与既有的
  `isDestructive`），审批层填好之后交给宿主——宿主只负责画出来，不必按工具名去猜入参字段。
  自己构造 `ApprovalRequest` 或自己发 `approval` 事件的宿主需要补上这两个字段；只消费它们的宿主不受影响。

这一版把工具与权限两层重写了一遍。**工具的安全姿态从「按工具名查表」
改成「工具自己按入参自陈」**，因此导出面、类型与模块路径都有改动。

- **工具契约换成 `defineTool()`**：`AgentTool` 不再是一个「四个字段的对象就能满足」的接口，而是
  `defineTool()` 补全默认值之后的**完全体**。新增 `alwaysReadOnly` / `isReadOnly(input)` /
  `isConcurrencySafe(input)` / `isDestructive(input)` / `maxResultBytes` / `validate(input)` /
  `summarize(input)` / `pathOf(input)`。
  **`alwaysReadOnly` 与 `isReadOnly` 是两件事**：前者是静态能力（这个工具**有没有可能**改动东西），
  后者是这一次调用的实情。`bash` 既跑 `ls` 又跑 `rm`，所以后者为真、前者为假。审批档位问的是前者——
  `ask` 档的语义是「动手之前让我看一眼」，跑任何命令都该问；而 `read` 这类工具怎么调都不动手，
  任何档位都不必问。声明 `alwaysReadOnly: true` 蕴涵「所有入参都只读」，不必再写 `isReadOnly`。
  默认值一律 fail-closed：**不声明 `alwaysReadOnly`/`isReadOnly` 的工具按会写处理，不声明
  `isConcurrencySafe` 的按不可并发处理**，自陈函数抛异常时也回落到这个答案。自己造工具的宿主必须
  改走 `defineTool()`。
- **权限模块搬家**：`approval.ts` 已删除，拆成 `permissions/chain.ts`（判定链与 `guardToolUse`）、
  `permissions/modes.ts`（审批档位）、`permissions/decision.ts`（结论类型）、
  `permissions/readonly-command.ts`（bash 的只读判定）；`approval-memory.ts` →
  `permissions/memory.ts`，`dangerous-command.ts` → `permissions/danger.ts`。
- **`judgeToolUse` 换签名与返回值**：从 `(mode, toolName, input, cwd, planMode?)` 改成
  `({ tool, input, mode, planMode, cwd })`，返回 `{ behavior, reason, message, outsideWorkspace }`。
  `decision` 改名 `behavior`；`cause`（字符串）换成 `reason`（可判别联合）：
  `{type:"read-only"}` / `{type:"plan"}` / `{type:"mode", mode}` / `{type:"empty-patch"}` /
  `{type:"dangerous", command}` / `{type:"outside", path}`。新增 `isRememberable(reason)` 取代调用方
  自己比对 `cause === "mode"`——那是「这条能不能被记住」唯一的判据，写成字符串比较迟早漏一处。
- **`guardToolUse` 第二个参数从工具名改成工具对象**，`GuardContext` 多一个 `emitResult`
  （发 `approval_result`；以前复用 `emit`）。
- **删除导出**：`READ_ONLY_TOOLS`、`MUTATING_TOOLS`、`toolPathOf`、`ApprovalCause`、`ApprovalVerdict`、
  `ApprovalDecision`、`PLAN_BLOCKED_TOOLS`（改为只给提示词用的字符串常量 `PLAN_BLOCKED_HINT`）、
  `SPILL_THRESHOLD_BYTES`（阈值改由每个工具自陈 `maxResultBytes`，默认值 `DEFAULT_MAX_RESULT_BYTES`
  在 `tools/contract.ts`，判断在 `results/budget.ts`）。
  `ApprovalRequest` / `ApprovalAnswer` 从 `permissions/decision.ts` 出。

### Added

- **`deliverables(input)` 与 `fileReplacement(input)`：界面要用的另外两件事也归工具自陈**。
  `deliverables` 返回「这次交付了哪几件」（`PresentFile[]`，由 `present` 声明）——界面据此在工具行下面
  铺交付物卡片，不必认 `files` 这个字段名；`fileReplacement` 返回「这次把哪个文件整份换成了什么」
  （由 `write` 声明）——确认卡片据此补一节「改动片段」，不必认 `path` / `content`。两者不声明时分别是
  `[]` 与 `null`（fail-closed：没有附加卡片，而不是画一份猜出来的）。
- **`read` 补上了 `pathOf`**：它读的就是那个文件，界面上那一行的「预览文件」入口按它来。
  `grep` / `glob` 的 `path` 是**搜索起点**（一个目录），刻意不声明——从前界面给它们一个「预览文件」
  按钮，点开预览的是一个目录。`pathOf` 的用途因此在文档里写全了：越界判定与预览入口要的是同一个答案。
- **`PresentFile` 进公共导出**：界面要按它画交付物卡片，`defineTool` 的 `deliverables` 也返回它。
- **`describeApproval(input)`：确认卡片的正文归工具自己写**（这个字段就是「给权限弹窗用的一句人话」，与发给模型的 `prompt()` 是两回事）。`bash` 给命令
  原文、`write` 摊开要写入的内容（前 12 行，并说清还有多少行没显示）、`edit` 逐处列出「原来 / 改成」；
  没声明的工具退回 `summarize`。同时 `AgentEvent` 的 `approval` 与宿主拿到的 `ApprovalRequest` 都带上
  `detail`（正文）与 `destructive`（看起来不可逆）。
  从前这两件事都住在网页前端：`render.js` 按工具名读 `command` / `content` / `edits` 拼正文，另有一份
  自己的破坏性命令正则清单。于是「哪个字段最要紧」的知识服务端与浏览器各一份——而前端 `edit` 那处读的
  还是两个**不存在**的字段名（`old_string` / `new_string`），所以确认卡片上一直是一坨 JSON，
  改了什么完全看不见。
- **`bash` 的「看起来不可逆」复用内核那条危险命令启发式**（`permissions/danger.ts` 的
  `looksDangerousCommand`）：`isDestructive` 现在与审批链用的是同一个判断，界面不再另抄一份正则清单。
  它只影响界面提示，不参与判定——判定链早就在更前面用同一个启发式把这类命令升到 ask 了。
- **`APPROVAL_PREVIEW_LINES` 导出**（工具共用的输出处理里）：确认卡片一段预览最多显示多少行。
- **系统提示词改成段落注册表**：新增导出的
  `PROMPT_SECTIONS` / `resolvePromptSections()` / `PromptSection` / `PromptContext`。每段有名字、
  声明自己是 `static` 还是 `dynamic`，拼装时**保证 static 段全部排在 dynamic 段之前**——服务端按
  前缀命中上下文缓存，前面动一个字节后面全部作废，而日期、档位、`AGENTS.md` 都会变，把不变的那几段
  固定在最前面才谈得上省。这条规矩从前只活在数组的排列顺序里（改顺序时没人会想到它），现在由
  `resolvePromptSections` 的分组保证，并有测试盯着「正文里最后一个 static 段早于第一个 dynamic 段」。
  `instructions` 段固定排在 dynamic 组最末（它最贴近当前任务，让模型最后读到），这一条也有测试钉住。
- **只读工具并排跑**：`tools/orchestrate.ts` 的
  `partitionCalls()` 把**连续**的「工具自己说这次可以并发」的调用拼成一批，`runConcurrently()` 用固定
  几个工人（上限 `MAX_TOOL_CONCURRENCY = 6`）把它们跑完；会改东西的独占一批。批次按原顺序切、不重排，
  所以批内无序、批间严格有序，回灌给模型的工具结果仍是模型发出的那个顺序。测试可用的纯函数
  （`prepareCalls` / `partitionCalls` / `runConcurrently`）都已导出。
- **结果预算**（`results/budget.ts`）：`applyResultBudget()` 做三件事，顺序固定——空结果替换成
  `（<工具名> 执行完成，没有输出）`、超过工具自陈的 `maxResultBytes` 就落盘并在上下文里只留开头与
  路径、`maxResultBytes: Infinity` 是**硬退出**（永不落盘）。这三条各自对应一个真实故障：空 tool_result
  会让某些模型误判回合边界直接结束；落盘让长输出可查而信息不丢；`Infinity` 防的是读类工具
  「读文件 → 落盘 → 再读落盘文件」的原地打转。
- **bash 的逐命令只读判定**（`permissions/readonly-command.ts` 的 `looksReadOnlyCommand`）：
  命令必须是**单条简单命令**（不含 `;` `&` `|` `<` `>` 反引号 `$(` `\` 换行），命令头落在白名单里，
  少数命令额外禁用会写盘的开关（`find -delete` / `find -exec`），解释器只在 `--version` 这类查询开关下
  算只读，`git` 只认只读子命令。**保守优先**：白名单之外一律返回 false。
- **参数值校验前移**：工具可以自陈 `validate()`，不通过就在**审批之前**直接把消息当结果回传。
  参数本身不成立的调用不再弹确认卡片——用户点了同意，工具也只会报一个参数错误。
- **工具集的来源裁剪**：`filterToolsForSource(tools, "main" | "subagent")` 与常量表
  `SUBAGENT_DENIED_TOOLS`。以前「子代理的工具集里没有子代理工具」是靠调用方**不传** `subagents`
  实现的，是一条没人守着的约定。
- **体量这一档也归工具自陈**：`write` 的摘要带上行数（`src/a.ts（3 行）`）、`edit` 带上处数
  （`src/b.ts（1 处）`）。从前行数与「N 项 / N 件」这类信号硬编码在网页前端，加一个工具就要改一次
  那儿，而 `goal_write` / `job_start` 因为没人记得改，一直显示成一坨 JSON。

- **`done` 事件带上上下文占用**：新增可选字段 `contextTokens`——**最后一次**请求实际发出去的 prompt token 数。
  界面要显示「上下文占了窗口多少」时必须用它：`usage.promptTokens` 是本轮所有请求的累计（一轮里跑了 5 次
  模型就是 5 份之和），拿它去比窗口会算出好几倍。服务端没回报用量时这个字段缺省，界面据此隐藏而不是编 0。
- **行为契约测试**（借自 Reasonix 的 `AGENT_CORE_SIMPLIFICATION` 契约表）：把「省 token」的那些性质
  写成会失败的测试，而不是写在注释里——多一次隐式请求、多一轮摘要，界面上完全正常，只有账单知道。
  新增 `test/contracts.test.ts` 钉四件事：干净收尾**恰好一次模型请求**、一次工具调用恰好推进两步、
  **折叠区太小就不摘要**、裁剪旧工具输出时保留头尾。
- **一轮之内也会压上下文**：压缩原先只在 `prompt()` 开头跑一次，
  一次提问里连着跑几十个工具的那种长轮次中间没人管，只能等接口报「上下文超长」，再走丢历史的救援
  ——那时候用户原话已经在被丢掉的边缘了。现在**每次调用模型之前**都判一次，超阈值就照同一套规则
  处理（先裁旧工具输出，再摘要）。`compaction` 事件的 `midTurn` 字段标出这是轮内触发的，
  `describeCompaction()` 的说法也跟着点明，免得在网页上看着像别的东西触发的。
- **`firstLine()` 导出**：取一段文本的第一行，不再为了取第一行把整份文件切成行数组。会话与快照都是
  JSONL，列出会话时要把每个文件都打开看一眼——实测 4MB 的会话 `split("\n")[0]` 取一次首行 1.9ms，
  几十个会话就是上百毫秒的临时字符串。`Session.open`、跨会话搜索与密钥的管道输入都改用它。

### Changed

- **提示词里不再重复工具描述**：从前每个工具会以 `- bash：执行命令` 的形式在提示词里出现一遍，
  而它同时被 `toToolSpec()` 放进了接口请求的 `tools[]`——**同一个工具的 description 每次请求发两遍**。
  正确的做法是描述只发一次（`tools[]`），提示词里另有一段散文讲「怎么用工具」；本仓库的
  「工作方式」那 11 条正好承担了后者。现在提示词只列工具名（`可用工具（名字、参数与用法见接口的
  tools 字段）：bash、read、…`），描述由 `tools[]` 承担。
  **注意：`buildSystemPrompt()` 的正文因此变了**（导出面没变）。省下的是每个工具那段 description，
  工具越多省得越多；模型仍从 `tools[]` 拿到完整描述与参数。新增一条回归测试盯着这条：桩工具的
  description 不许出现在提示词里，它的名字要在。
- **POSIX 上也开始按 locale 的 codeset 解码子进程输出**：原来非 Windows 平台把候选编码收成只有
  `utf-8`，于是 `LANG=zh_CN.GBK` 的 Linux 上，`cat` 之类命令的输出会满屏替换字符——和早先 Windows
  中文系统上那个乱码是同一个毛病，只是这边一直没人报。现在候选按平台分两套：**Windows** 照旧按语言
  猜代码页并兜底 GBK / windows-1252；**POSIX** 只认 locale 里**明写**的 codeset（`zh_CN.GBK` →
  `gbk`，`ja_JP.eucJP` → `euc-jp`，`ru_RU.cp1251` → `windows-1251`，另含 gb18030 / big5 / shift_jis /
  euc-kr / koi8-r / iso-8859-* 等常见写法）。**刻意不按语言猜**：单字节编码永远「解得开」，只要把
  windows-1252 这类放进候选表，`en_US.UTF-8` 的机器上随便一段二进制就会被解成乱码，比替换字符更难查；
  没有 codeset 或 codeset 就是 UTF-8 时行为与以前完全一致。
  候选表抽成纯函数 `legacyEncodingCandidates(platform, env)`，`decodeProcessOutput(buffer, candidates?)`
  多一个可选参数——这样「Linux + GBK locale」这条路径终于能在任意机器上测（此前 CI 只有 Linux+UTF-8，
  开发机只有 Windows，两边都覆盖不到）。Windows 分支的候选顺手去掉了重复项。
- **压缩先算经济账，不赔本才做**（借自 Reasonix 的 `foldEconomics`）：原来只要整段上下文超阈值就发
  摘要请求，但「超阈值」和「值得摘要」是两件事——`applySummary` 会原样留下最近 6 条与用户原话，
  系统提示词（AGENTS.md 可能有几万 token）更是完全不参与折叠。折叠区只有几百 token 时，摘要那次
  调用（还得把整个历史再发一遍）比省下的还贵。新增 `foldableTokens()`：按 `applySummary` 同一套
  切法算出**真正会被换掉**的那一段，小于 `MIN_FOLD_TOKENS`（400）就跳过摘要，只做不花钱的裁剪。
- **摘要有了输出预算**（借自 Reasonix 的 `summaryOutputMaxTokens`）：`buildSummaryRequest(maxTokens)`
  把额度写进请求，`summarize()` 按折叠区的八分之一封顶（`summaryBudget()`，512–4096 token）。此前
  这条链路没有任何上限，而 DeepSeek 单次回复上限是 384k token——摘要写飞了就是几十倍的钱。额度同时
  写进提示词并点明「篇幅不够时先保未完成的事项与下一步」：接口是硬截断，那一条又恰好排在最后，
  只靠截断会把最要紧的部分切掉；真被截断时还会在正文里写明这段摘要是半截的。
- **裁剪旧工具输出时保留头尾**（借自 Reasonix 的 `prune.go` 分层裁剪）：原来整条换成一行占位，模型连
  「这是什么」都看不到，只能整段重读一遍——那等于白裁。现在保留头 `PRUNE_HEAD_LINES`（40）行与尾
  `PRUNE_TAIL_LINES`（12）行（头看结构、尾看结论：命令输出与测试结论都在尾部），中间那段换成说明并
  报出被裁掉的行数与字节数；行数太少（一整行超长 JSON）切不出有意义的头尾时，退回原来那种「整条换成
  一行」的做法。`prunePlaceholder(bytes, droppedLines?)` 的第二个参数可选，单参调用的输出与原来逐字相同。
- **内核分层重排，`Agent` 只剩门面**（对外导出面与既有行为不变）：会话状态搬到
  `session.ts`，一轮的驱动搬到 `turn.ts`，一轮配置的快照（模型、工具表、轮数上限、温度、工作目录）
  搬到 `turn-context.ts`，单次工具调用的管线（审批 → 钩子 → 超时 → 重复提醒 → 落盘）搬到
  `tool-pipeline.ts`，历史与世界状态（说明文件、系统提示词、用量校准、压缩）搬到 `context-manager.ts`。
  分层之前这四件事和主循环一起住在一个 600 行的类里。工具调用的管线顺手拉直：原先那串四层嵌套的
  `if/else` 里有一条 `outcome === null` 的分支永远走不到（每条路径都已经赋过值）。
- **每轮调模型前重建一次配置快照**：模型与工具表原先在循环外只解析一次，于是「一轮跑到一半换了模型，
  后半轮还在用旧模型」——而界面显示、提示词里写的都已经是新的了。现在轮内换模型、改档位从**下一次
  调用**起生效，一轮之内不会半新半旧。审批模式与计划模式仍按原约定每次工具调用前现读（改了立刻
  生效，方案被批准后同一批里剩下的工具也马上放行）。
- **按字节截断（`sliceByBytes`）的往回退改成二分**：原来每往前退一个字符就把近一整段前缀重新量一遍
  字节数，而且退的次数不是常数——按 50KB 截断一段中文要退三万余次，实测单次 **900ms**，整个过程还
  卡住事件循环（工具输出、评审 diff、文件预览、说明文件注入都走这里）。改成在「前缀字节数 ≤ 上限」
  这个单调条件上二分，同样的输入 **1ms**。上限非正数现在返回空串：负数原本会落进 `slice(0, 负数)`，
  把末尾几个字符留下来。
- **子进程输出的解码器按编码缓存**：Web 终端是逐块解码输出的，原先每块都新建一次 `TextDecoder`、
  每次都重新取一遍默认 locale（一次 ICU 构造）。Windows 中文系统走到 GBK 回退路径时实测从约 58µs/次
  降到 12µs/次。`fatal` 解码器在非流式调用（不传 `{ stream: true }`）里不留残余状态，跨调用复用是安全的。

- **工具按批执行而不是一律串行**。原注释写的理由是「四个系统工具里有三个会改文件」——那个理由对写工具
  成立，但把只读的也一起拖下水了：一轮里读五个文件要排五次队，而它们之间没有任何冲突。并发安全性现在
  由工具自己按入参声明，默认值是「不可并发」，所以会写的一定还是独占。
- **重复调用的提醒按原始顺序预先算好**，不在单次调用里现算：并发批里的完成顺序不定，现算会让「连续
  重复」的计数随调度抖动。
- **`tool_start` 在整批开跑之前全部发出**，界面上看到的是「这几个在同时跑」而不是「一个接一个」。
- 计划模式（严格）的提示词段落改了口径：不再说「只有 read / grep / glob 能用」，改为「只能读」——
  只读的 bash 命令现在也能用。
- **`ask` 档下的询问范围没有变**：跑任何命令（含 `ls`）仍然要确认，写文件仍然要确认。这一条在重构
  中途一度被破坏——只读判定的放行口排在了档位判定之前，于是 `ask` 档下 `echo hi` 不再问了。
  修法不是把顺序换回来，而是把「静态只读」与「这次只读」拆成两个字段（见 Breaking Changes 里的
  `alwaysReadOnly`）：`read` 这类不该问，`bash` 这类该问。新增 `job_start` / `subagent_start` 现在
  在 `ask` 档下**也会**问（从前它们不在 `MUTATING_TOOLS` 那张表里，因此不问）——更严，不会更松。

### Fixed

- **计划模式（严格）能被整个绕过**：判据原本是 `PLAN_BLOCKED_TOOLS = { write, edit, bash }` 这张名字表，
  而 `job_start`（跑任意命令）与 `subagent_start`（子代理能改文件）都不在里面——模型用它们就能在
  「批准前一个字节都别动」的档位下跑任意命令、改任意文件。现在判据是工具自陈的只读性，新加的工具
  自动受管，不必有人记得往表里补名字。
- **只读档下连 `ls` 都被拒**：`READ_ONLY_TOOLS` 是一张按**工具名**查的表，而 `bash` 无论跑 `ls` 还是
  `rm` 都算会写。现在 bash 按命令自陈只读性，只读档与计划模式下 `ls` / `cat` / `grep` / `git status`
  这类命令可以跑，会写的仍然被拒。
- **子代理的并发上限形同虚设**：`DEFAULT_FANOUT_LIMIT` 本来只管 `runSubagents` 内部那一次调度，而每个
  `subagent_start` 都自己起一次 `limit = 1` 的调度——模型在一轮里发 20 个 start 就是 20 个并发子代理。
  现在按同一张进度表卡住，超限时返回一句可操作的错误。
- **空的工具结果直接回灌给模型**：以前只有 bash 兜住了「命令没有输出」，其余工具返回空串时就真的回一条
  空结果。现在由结果预算统一兜底。
- **`read` 的结果会被落盘**：读一个 40KB 的文件会拿到「已写入某文件 + 前 60 行」，模型照着提示去读那个
  文件，而落盘文件同样只给前几十行——原地打转。read 现在声明 `maxResultBytes: Infinity`，它自己的
  50KB 截断加续读 offset 才是唯一的限制。
- **bash 的 `workdir` 不参与越界判定**：`toolPathOf` 只认 `write` / `edit` 的 `path`，于是「换个目录跑
  任意命令」是绕过工作目录边界的现成通道。bash 现在把 `workdir` 报给判定链。
- **清空历史、换模型时会丢掉用量校准**：校准记的是「那批内容在那个模型上值多少 token」，
  而 `estimateContextTokens()` 不会报出比已知真实值更小的数。清空上下文或换模型之后继续用它，
  空会话的第一轮就会被判成「该压缩了」，白花一次模型调用去摘要一段几乎没有内容的对话。
- **轮数用尽时的 `error` 事件带上 `code: "max-turns"`**：宿主据此能和接口故障区别对待——这个不是
  接口出错，重试没有意义，该做的是把任务拆小。原有的 `message` 文案不变。
- **`addUsage` 不再丢掉缓存命中数**：`cachedTokens` 也一起累加。缓存命中是最省钱的那一项，漏掉它整轮的
  命中率就算不出来——而这个比例同时是「系统提示词有没有保持稳定（服务端按前缀命中缓存）」的体检指标。
