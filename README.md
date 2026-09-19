# Limkenion Web

Limkenion 现在是一个 **纯 Web 项目**：界面与引擎全部在 [`web/`](./web) 内，
自带 DeepSeek/mock 引擎、会话存储、工具执行、钩子与定时任务，不依赖任何 CLI 进程。

## 快速开始

```bash
cd web
npm install
npm run dev        # Vite 开发服务器
npm run serve      # 单独启动后端（node server/index.mjs）
```

## 常用脚本（均在 web/ 下）

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | Vite 开发服务器 |
| `npm run build` | 前端构建 |
| `npm run serve` | 启动后端 |
| `npm test` | 单元测试（299 条） |
| `npm run test:e2e` | 端到端测试（需 DEEPSEEK_API_KEY） |
| `npm run typecheck` | 前端 + 服务端 tsc 检查（应保持 0 错误） |

## 关于 CLI

CLI（上游 CLI 原型 fork）已于 2026-09-18 停止维护并从工作树移除，
其源码分支 **`archive/cli`** 已于 2026-09-19 一并删除（本地与远程均已移除）。
`web/server/data/cli-contract.json`、`commands-manifest.json` 是当时留下的
契约快照数据，web 端仅作为数据消费，仍然有效。
