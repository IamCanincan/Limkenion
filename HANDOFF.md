# Limkenion 交接文档

> **新 agent 从这里开始。** 最后更新：2026-09-18
> 本文**下半部分**是 2026-09-16 源码树重建的**历史记录**（已完成，仅留档）。

---

## 一、接力怎么接

**自动注入的（每次会话启动就加载，先读它）**
- `.workbuddy-ai/memory/MEMORY.md` —— 用户要求、硬约束、环境要点、DeepSeek 实测事实、
  当前进度、关键陷阱。**这份是精简过的，能完整注入。**

**按需读的**
- `.workbuddy-ai/memory/MEMORY-details.md` —— 端点清单、命令级处置、模型改名映射、功能对比
- `.workbuddy-ai/memory/2026-09-17.md` —— 逐轮流水（做了什么、踩了什么坑、为什么这么定）
- 本文下半部分 —— 源码树重建历史（已完结）

**为什么要分这么多文件**：`MEMORY.md` 是自动注入的，**超过注入上限会被截断，接力就断了**。
2026-09-18 它曾涨到 36KB 被截断过，已拆分瘦身。**往里加内容前先想清楚该放哪一份。**

---

## 二、现在的状态

**能用。** 开新终端 → `limkenion` → `/login` 粘贴 DeepSeek key → 就能干活。

- 构建：`node scripts/build-cli.mjs` → `dist/cli.mjs`，**0 错误**
- 冒烟：`limkenion -p "只回复两个字：收到" --no-session-persistence` → 返回「收到」
- 模型：`deepseek-flash`（默认/快）、`deepseek-v4-pro`（强），两个
- 协议：只走 OpenAI 兼容端点（`https://api.deepseek.com`），**不接 上游 协议**（用户拍板）
- 无云、无账号、无网站

**去痕迹工程已完成的部分**：品牌词 0 命中、云服务命令停用 7 个、模型表收敛为 2 个、
定价表删除、6 个迁移函数删除、2 个死模块（共 837 行）删除、**170 处自有服务 URL 删除**、
模型相关函数改名 66 处。

---

## 三、下一步做什么（按优先级）

1. **删 URL 留下的空壳**：12 个 `const *_URL = ''`、约 20 处 `<Link url="" />`、
   几处悬空的 `Learn more: `。
   ⚠️ `<Link>` 在 react-compiler 产物里，**动手前先确认不在 `$[N]` memo 区块内**。
2. **剩余约 980 处零散模型名**（注释、字符串、变量名）。改名用 `\b` 边界，别误伤 `octopus`。
3. **两处待用户拍板的行为变更**（我没动）：`utils/context.ts` 的上下文窗口默认值 200K
   （DeepSeek 官方 1M）、最大输出上限 64K（官方 384K）。
4. **功能缺口**（用户还没定做不做）：
   - `/effort` 是空操作，且没有"关闭思考"的入口；真正生效的是 `/model low|medium|high`
   - 图片输入被适配器静默丢弃（`deepseek-flash` 官方支持 Vision）
   - 没有本地定时任务

---

## 四、每轮必须做的

```bash
node scripts/build-cli.mjs          # 必须 0 错误
export LIMKENION_GIT_BASH_PATH='C:\Users\20653\.workbuddy-ai\binaries\PortableGit\versions\1.2.0\usr\bin\bash.exe'
export DEEPSEEK_API_KEY=<用户自己输入的 key>
limkenion -p "只回复两个字：收到" --no-session-persistence   # 必须返回「收到」
export APPDATA='C:\Users\20653\AppData\Roaming'
npm install -g .                    # 必须带 APPDATA，否则装错地方
git commit                          # 不 push、不动 git config
```

**冒烟不是可选项**：esbuild 不做类型检查，删模块/改数据表后的错误只有跑起来才看得见
（这个坑踩过三次）。

---

## 五、别碰的东西

- **`D:\下载\agent\新建 文本文档.txt`** —— 用户选择自己处理那个 key，不要动、不要复制
- **密钥一律不要写进仓库或记忆文件**
- `scripts/build-cli.mjs` 的 `BRAND_TOKENS` 清洗名单 —— **故意保留**，它就是用来抹掉品牌词的
- 承重的"半坏残留"（看着像死的，其实是活的）：`constants/oauth.ts`、`utils/model/bedrock.ts`、
  `services/mcp/oauthPort.ts`、`stubs/bedrock-sdk.ts`、`commands/oauth-refresh/index.js`
- `.workbuddy-ai/i18n/COMMENT_I18N_PLAN.md` 的**第 69–120 行是术语表**，别删
- `/web` 是**本地** Web UI 服务器（`http://localhost:${port}`），跟 limkenion.ai 无关，必须保留

---

# 附：Limkenion CLI 源码树重建 — 记录


> 最后更新：2026-09-16，WorkBuddy AI
> 状态：**打包已打通（0 错误）**

> **现状补充（2026-09-17 复核，commit dd8eb9c）**
>
> - 本文提到的"缺失 174/175 个模块"**已全部补齐**；恢复脚本仍在
>   `scripts/restore-missing-files.mjs`，可重跑。
> - 仓库**现已是 git 仓库**（分支 `master`）。下文若出现"无 git / 无 package.json"之类的表述，
>   均指重建前的状态，以现状为准。
> - 构建复核：`node scripts/build-cli.mjs` → `dist/cli.mjs`（27MB），**0 错误**。
> - 品牌洁净度复核：产物中已无任何上游品牌字样（`CC` / `上游兼容` / `内部代号` 命中数均为 **0**）。
>   唯一的例外是 `scripts/build-cli.mjs` 里的 `BRAND_TOKENS` 清洗名单 —— 那是**故意保留**的，
>   它本身就是用来把上游品牌 token 从产物中抹掉的机制，删掉它反而会留下痕迹。
> - 源码侧已无品牌字样，仅 `scripts/build-cli.mjs` 的 `BRAND_TOKENS` 清洗名单保留这些 token
>   （**故意保留**，它就是用来从产物里抹掉它们的）。
> - 旧的注释中文化计划文档已移出仓库根 → `.workbuddy-ai/i18n/COMMENT_I18N_PLAN.md`（不进 git）。

---

## 一、结论

CLI 从"完全无法构建"恢复为**可打包**、**可启动**。

```
esbuild 错误：2558 → 0
产物：dist/cli.mjs（26M）
```

---

## 二、做了什么

### 来源
`D:/下载/agent/upstream-ref-impl`（MIT，github.com/NanmiCoder/upstream-ref-impl）是**同一份代码的另一个改名版本**：
`limkenion` ↔ 上游旧代号。实测 `Tool.ts` 792 行仅差 14 行，全部是改名。

### 步骤
1. **备份** → `Limkenion_backup_2026-09-16-2141.tar.gz`（8.2M）
2. **补 174 个缺失文件** → `scripts/restore-missing-files.mjs`（自动改名，可重跑）
3. **补工程配置** → `package.json` / `tsconfig.json` / `.gitignore`
4. **Bun 兼容桩** → `bun-bundle-stub.ts`
5. **装依赖** → 68 + 后补 AWS/Azure/OTel，共约 520 个包
6. **私有包 stub** → `stubs/` 9 个
7. **补 workflows / buddy / upstreamproxy 等连锁缺失**
8. **修 `cli/print.ts` 源码损坏**
9. **补旧版文件缺失的导出符号**

### 六个关键 esbuild flag（缺一个都过不去）
| flag | 解决什么 |
|---|---|
| `--alias:bun:bundle=./bun-bundle-stub.ts` | 183 文件 import Bun 专属 `feature()` |
| `--tsconfig=./tsconfig.json` | `src/*`→`./*` + 私有包 stub 映射 |
| `--loader:.md=text` | skills import `.md` 文档 |
| `--loader:.js=tsx` | 若干 `.js` 实为 TS/JSX |
| `--target=node22` | 降级 `using` 声明 |
| `--banner:js` 注入 `createRequire` | CJS 依赖在 ESM 里 `require()` 会抛 |

**已固化到 `scripts/build-cli.mjs`**，直接跑：
```bash
node scripts/build-cli.mjs      # 或 npm run build:cli
```

---

## 三、还没做的 / 已知限制

### 0. 运行时已无上游专有调用（openai provider 下）
设 `LIMKENION_API_PROVIDER=openai` 后，三条路径全部走 DeepSeek：

| 路径 | 走向 |
|---|---|
| 主对话 | `queryModel` → openai 分支 |
| 小模型辅助（命名/摘要/日期解析…） | `queryHaiku` → `queryModelWithoutStreaming` → `queryModel`（同一分支） |
| key 验证 | `verifyApiKey` → 新增 openai 分支（原来直接调上游 SDK，是最后残留） |

**ant 内部死分支已全部移除**（2026-09-17）：上游把 `USER_TYPE` 烘焙成
`"external"` 字面量，留下 88 处 `"external" === 'ant'` 恒假比较 + 280 处
`process.env.USER_TYPE === 'ant'` 判定，全部按死代码清除（188 文件，
净删 ~2200 行，`scripts/codemod-remove-ant-branches.mjs` 可复跑）。
残留的 `if (true)` 守卫条款语义正确，保留。

⚠️ `queryHaiku` 用 `getSmallFastModel()`，必须设 `LIMKENION_SMALL_FAST_MODEL`
（start-cli.bat 已设），否则会拿 haiku 模型名去请求 DeepSeek 而 404。

**仍未摆脱的两层**：代码层仍 import `@limkenion-ai/sdk`（20+ 文件，多为类型引用）；
架构层仍是上游产品的架子（工具集/命令体系/消息语义）——这个不是换 SDK 能解决的。

### 1. reg.exe 崩溃已修复（但完整验证仍需真实终端）
~~CLI 启动后调用 reg.exe → spawn EPERM 崩溃。~~ **已修复。**

`main.tsx:16` 顶层无条件 `startMdmRawRead()`，Windows 上派生 `reg.exe`；
原实现无错误处理，execFile 抛出即崩溃。这其实**不只是沙箱问题**——
企业组策略禁用 reg.exe、注册表服务异常、容器环境都会触发。

已在 `utils/settings/mdm/rawRead.ts` 的 win32 分支加 try/catch，
失败时降级为「读不到 MDM 设置」，CLI 继续启动。
修复前：`spawn EPERM` 崩溃；修复后：exit 0，能执行到 `run()`。

**仍需真实终端验证**：本沙箱非 TTY（`stdout.isTTY` 为假），
`main.tsx:770` 的 `isNonInteractive = ... || !process.stdout.isTTY`
会判定为非交互模式并静默退出（exit 0、0 输出），这是正常行为不是故障。
请在真实终端跑 `node dist/cli.mjs` 确认 REPL 界面。
也可以直接双击仓库根目录的 **`start-cli.bat`** —— 它会自动检测 node
（PATH 中没有则回退到 `D:\nodejs\node.exe`）、首次运行自动构建、
结束后暂停显示退出码。支持传参：`start-cli.bat -p "hello"`。

⚠️ `.bat` 文件名必须保持 ASCII（故命名为 `start-cli.bat` 而非中文名），
Windows 上中文文件名的 .bat 会因代码页错位而乱码/无法执行。

### 2. 私有包是空壳（功能永久缺失）
这些上游内部包装不到，upstream-ref-impl 也没有，只能 stub：
`computer-use-mcp` / `computer-use-input` / `computer-use-swift` /
`vertex-sdk` / `foundry-sdk` / `bedrock-sdk` / `sandbox-runtime` /
`mcpb` / `modifiers-napi`。
→ 电脑操作（computer-use）、Vertex/Foundry/Bedrock 接入**不可用**。

### 3. 版本混用 —— 类型层面不健康（重要）
补进来的 174 个文件来自**较新的** upstream-ref-impl，原有 270 个文件是旧版。

**当前状态**：
- `esbuild` 打包：**0 错误** ✅（产物可用）
- `tsc --noEmit`：**2049 个错误** ❌（TS2614=641 / TS2339=542 / TS2307=232，涉 591 文件）

这两个数字不矛盾：esbuild 只做转译+打包，不做类型检查。
`--loader:.js=tsx` 让打包器能解析，但真实的类型不一致依然存在。

**根源**：新版 upstream-ref-impl 文件 + 旧版 Limkenion 文件的 API 对不上。
这是"只补缺失文件"方案的固有代价，装依赖解决不了。

**已实测：整份替换不划算，不做。**
曾考虑用 upstream-ref-impl 整份 `src/` 改名覆盖来换取版本一致。已在临时副本上实测：

| 方案 | esbuild | tsc（含 bun types） |
|---|---|---|
| 整份替换（upstream-ref-impl 全量，2441 文件） | 4 错误 | **2016** |
| **只补缺失文件（当前）** | **0 错误** | **1802** |

整份替换两项都略差——它会把已移除的 `bridge/buddy/voice/vim/remote/server/upstreamproxy`
带回来，而这些正是剩余 tsc 错误的大户（`bridge/` 里大量
`has no exported member 'Message'` 与 union 收窄失败）。
维持当前方案。

剩余 1802 个类型错误的性质：多为已移除功能残留 + TS 版本差异，**不影响打包产物**。

### 3b. 扩展名已修正（131 个文件）
从 upstream-ref-impl 复制时我曾把 `.ts/.tsx` 改成 `.js`（以为要匹配 import 里的 `.js`）——
**搞反了**：TS 约定是源文件 `.ts`、import 写 `.js`，由 `moduleResolution: bundler` 映射。
上游 2372 个 `.ts/.tsx` vs 仅 18 个 `.js`，Limkenion 却有 156 个 `.js`。
已批量改回：129 → `.ts`、2 → `.tsx`、25 个纯 JS 保持。
效果：`tsc` 错误 665 → 391 → 13（随后因真正开始解析而暴露出上述 2049）。

### 4. 建议装 Bun 1.3.14
项目真正依赖 Bun（`bun:bundle` + `feature()` 编译期死代码消除）。
Node 能打包，但运行时行为可能与官方构建有差异。

### 5. web 端状态：130/130 通过，但暴露了新差距
已回归验证，`cd web && node --test` → **130/130 全过**。

过程中发现：补齐 CLI 源码后，drift 测试新报出 **16 个 CLI 有、web 未镜像的工具**：
`CtxInspect / DiscoverSkills / ListPeers / Monitor / OverflowTest / PushNotification /
ReviewArtifact / SendUserFile / Snip / SubscribePR / SuggestBackgroundPR /
TerminalCapture / Tungsten / VerifyPlanExecution / WebBrowser / Workflow`

**这不是漏镜像**——这批几乎全部被 `feature()` 门控（`CONTEXT_COLLAPSE`、
`HISTORY_SNIP`、`UDS_INBOX`、`WORKFLOW_SCRIPTS`…），真实 Bun 构建会死代码消除，
默认产物里没有。是 `bun-bundle-stub.ts` 让 `feature()` 恒为 true 才被扫出来。
已在 `drift.test.mjs` 加 `FEATURE_GATED` 白名单豁免（逐条注明 flag）。

⚠️ 由此修正一个此前的结论：**"41 个工具对齐"是在 CLI 缺 175 个文件时得出的**，
基准不完整。基准补全后，实际还有 16 个 feature-gated 工具 web 端没有。

---

## 四、改名映射说明

映射明细（Limkenion ↔ 上游旧命名）已内置于 `scripts/restore-missing-files.mjs` 的令牌表中，
结构上分为四组：sdk 包名、环境变量前缀、代号大小写变体、特定文件/目录名。
按需对照该文件即可，此处不再逐条列出。

---

## 五、文件清单

```
package.json              68+ 依赖，含 build:cli / restore:missing
tsconfig.json             src/* → ./*，私有包 stub 映射
.gitignore
bun-bundle-stub.ts        Bun 兼容桩
scripts/
  restore-missing-files.mjs   从 upstream-ref-impl 补齐缺失文件（dry-run 默认）
  build-cli.mjs               构建 CLI（flag 原因见文件头注释）
stubs/                    9 个私有包桩
dist/cli.mjs              构建产物 26M
web/                      web 子项目（0.6.0，130 测试）
```

备份：`../Limkenion_backup_2026-09-16-2141.tar.gz`
