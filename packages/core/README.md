# limkenion-core

最小 agent 内核：一个主循环加四个系统工具。

## 安装

```bash
npm install limkenion-core
```

## 使用

```ts
import { Agent, createSystemTools, readApiKey } from "limkenion-core";

const agent = new Agent({
	apiKey: readApiKey(),
	modelId: "deepseek-flash",
	cwd: process.cwd(),
	tools: createSystemTools({ cwd: process.cwd() }),
	onEvent(event) {
		if (event.type === "text") process.stdout.write(event.delta);
		if (event.type === "tool_start") console.log(`\n[${event.name}]`);
	},
});

await agent.prompt("把 README 里的错别字改掉");
```

## 项目说明自动注入

工作目录及其上级目录里的 `AGENTS.md` 会被自动读出来，注入系统提示词：

```ts
const agent = new Agent({
	apiKey: readApiKey(),
	cwd: process.cwd(),
	tools: createSystemTools({ cwd: process.cwd() }),
	// 不传就自动发现；传 [] 表示明确不要注入；传具体内容则完全由你决定
	instructions: undefined,
	// 全局说明目录，它的 AGENTS.md 作为跨项目的个人偏好
	globalConfigDir: "~/.limkenion/agent",
});
```

项目侧按 `AGENTS.override.md` → `AGENTS.md` → `CONTEXT.md` 的顺序尝试，
**第一个有命中的文件名胜出**，且该名字沿路径向上的**所有**命中都会注入（近的在前）。
向上查找不越过 git 仓库根。单文件上限 32KB、合计 64KB，超出截断并标注。

`discoverInstructions()` 与 `buildSystemPrompt()` 也单独导出，便于自己控制注入时机。
每轮提问前会重新发现一次，所以编辑 `AGENTS.md` 后接着问就生效；内容没变时不会改动
系统消息，以免作废服务端的前缀缓存。

系统提示词里还带一段环境信息（工作目录、是否 git 仓库、平台、今天日期）。

提示词按**段落注册表**组装（`PROMPT_SECTIONS`）：
每段有名字、声明自己是 `static` 还是 `dynamic`，`resolvePromptSections()` 保证 **static 段全部排在
dynamic 段之前**。这条分界线是为了前缀缓存——日期、档位、`AGENTS.md` 都会变，把它们固定在尾部，
日常改动就只作废尾部。想自己拼一份提示词，导出这两个符号即可；`instructions` 段固定在最末
（它最贴近当前任务，让模型最后读到）。

**工具描述不写进提示词**：它只作为接口请求的 `tools[]` 字段发一次（`toToolSpec()`）。提示词里
只列工具名——同一个工具的 description 发两遍是白花钱，而模型拿到的描述来自 `tools[]`。

## 内核做什么，不做什么

`Agent` 只负责一件事：把用户输入变成「调用模型 → 执行工具 → 回灌结果」的循环，直到模型
不再要求调用工具。

明确不做的部分：

- **不做权限系统**：工具以进程权限直接执行，是否安全由使用场景决定（容器或沙箱隔离）。
- **不做会话持久化**：历史就在 `agent.messages` 里，落盘由调用方决定。
- **不做重试**：网络抖动直接以 `error` 事件上报，避免掩盖问题。
- **不做扩展机制**：需要新工具就直接实现 `AgentTool` 并传进 `tools`。
- **上下文压缩只做两件确定的事，而且不赔本才做**：先把旧工具输出裁成「头 40 行 + 说明 + 尾 12 行」
  （完整内容仍在会话文件里），再在「整段超阈值**并且**折叠区够大」时让模型写一次带输出预算的摘要；
  折叠区只有几百 token 时跳过摘要——那种时候那次调用比省下的还贵。更激进的策略（比如按重要性重排
  消息）留给调用方，内核不替它拍板。

## 系统工具

| 工具 | 作用 | 主要限制 |
|------|------|----------|
| `bash` | 执行 shell 命令 | 默认 120 秒超时，输出超 50KB 截断并终止进程 |
| `read` | 读取文本文件 | 单次最多 2000 行或 50KB，超出需用 `offset` 续读 |
| `write` | 新建或整体覆盖文件 | 自动建父目录；只适合新文件与整体重写 |
| `edit` | 精确文本替换 | 每段 `oldText` 必须在文件中唯一且互不重叠 |
| `grep` | 按正则搜文件内容 | 最多走 5000 个文件，单文件超 1MB 跳过，默认返回 100 条（上限 500） |
| `glob` | 按文件名模式找文件 | 同上遍历限制，最多 1000 条 |
| `todo_write` | 整表替换待办清单 | 最多 50 项、单项 200 字；只改会话内的清单，不碰文件 |
| `todo_read` | 读回当前待办清单 | 无 |

输出上限分两层：工具先自己截断（`bash` 默认 50KB），随后 `Agent` 在正文超过 12KB 时把**完整**
输出写进 `spillDir`，上下文里只留前 60 行与文件路径，需要细节时模型自己去 `read` / `grep`。
所以配了 `spillDir` 的调用方通常也会把工具上限调大（CLI 用的是 `SPILL_TOOL_OUTPUT_BYTES`，1MB），
内容就不再真的丢掉了；目录里只保留最近 50 份。

工具通过 `AgentTool` 接口扩展：

```ts
import type { AgentTool } from "limkenion-core";

const tool: AgentTool = {
	name: "now",
	description: "返回当前时间",
	parameters: { type: "object", properties: {} },
	async execute() {
		return { content: new Date().toISOString(), isError: false };
	},
};
```

## 事件

```ts
type AgentEvent =
	| { type: "reasoning"; delta: string }
	| { type: "text"; delta: string }
	| { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_end"; id: string; name: string; outcome: ToolOutcome }
	| { type: "approval"; tool: string; input: Record<string, unknown>; reason: string }
	| { type: "approval_result"; tool: string; approved: boolean }
	| { type: "compaction"; pruned: number; savedTokens: number; summarized: boolean; rescued?: boolean; midTurn?: true }
	| { type: "done"; turns: number; usage: Usage | null }
	| { type: "error"; message: string; code?: string; status?: number; retryable?: boolean; retryAfterMs?: number };
```

`prompt()` 只会在正常跑完时发出 `done`；接口出错或超过 `maxTurns`（默认 25）会发出
`error`，并且不会在历史里留下残缺的助理消息，因此修好问题后可以继续用同一个 `Agent`。
`error` 上的分类字段来自接口层，宿主据此决定要不要给「重试」，不必去猜中文错误文案
（轮数用尽是 `code: "max-turns"`，重试没有意义）。

上下文压缩（`compaction`）每次调用模型之前判一次：轮与轮之间会压，一轮之内跑了几十个工具
同样会压，后者带 `midTurn`。压缩只动历史，不改变工具与审批的行为。

## 许可证

MIT
