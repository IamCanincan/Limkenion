# limkenion-ai

DeepSeek 模型接入层。只做一件事：把 DeepSeek 的流式 HTTP 接口翻译成带类型的异步事件流。

## 安装

```bash
npm install limkenion-ai
```

## 使用

```ts
import { readApiKey, resolveModel, streamChat } from "limkenion-ai";

const events = streamChat({
	model: resolveModel("deepseek-flash"),
	apiKey: readApiKey(),
	messages: [{ role: "user", content: "用一句话解释什么是闭包" }],
});

for await (const event of events) {
	if (event.type === "text") process.stdout.write(event.delta);
	if (event.type === "error") console.error(event.message);
}
```

## 环境变量

| 变量 | 作用 |
|------|------|
| `DEEPSEEK_API_KEY` | API Key，必填 |
| `DEEPSEEK_BASE_URL` | 覆盖接口地址，默认 `https://api.deepseek.com` |
| `LIMKENION_MODEL` | 覆盖默认模型 id，默认 `deepseek-flash` |

## 设计说明

- **零运行时依赖**：使用全局 `fetch` 与手写 SSE 解析，不引入 `openai` 等 SDK。
- **工具参数在内部拼接**：工具调用参数分片到达，本包按 `index` 拼接完整后才发出
  `tool_call` 事件，调用方不需要处理分片。
- **模型 id 不设白名单**：`resolveModel` 接受任意 id，未知 id 按保守上限处理。DeepSeek
  会调整型号命名，硬编码白名单会让 CLI 在对方改名当天失效。
- **不含策略**：重试、会话持久化、工具执行都在上层，本包只负责传输与解析。

## 事件流

`streamChat` 产出的事件保证以 `done` 或 `error` 结尾：

```ts
type ChatEvent =
	| { type: "reasoning"; delta: string }   // 思维链增量
	| { type: "text"; delta: string }        // 正文增量
	| { type: "tool_call"; call: ToolCall }  // 一条参数完整的工具调用
	| { type: "done"; reason: string; usage: Usage | null }
	| { type: "error"; message: string };
```

## 许可证

MIT
