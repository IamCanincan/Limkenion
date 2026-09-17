export const LSP_TOOL_NAME = 'LSP' as const

export const DESCRIPTION = `与语言服务器协议（LSP）服务器交互，获取代码智能功能。

支持的操作:
- goToDefinition: 查找符号定义的位置
- findReferences: 查找符号的所有引用
- hover: 获取悬停信息（文档、类型信息）
- documentSymbol: 获取文档中的所有符号（函数、类、变量）
- workspaceSymbol: 在整个工作区中搜索符号
- goToImplementation: 查找接口或抽象方法的实现
- prepareCallHierarchy: 获取某个位置处的调用层级项（函数/方法）
- incomingCalls: 查找所有调用某位置处函数的函数/方法
- outgoingCalls: 查找某位置处函数所调用的所有函数/方法

所有操作都需要:
- filePath: 要操作的文件
- line: 行号（1 起始，与编辑器显示一致）
- character: 字符偏移（1 起始，与编辑器显示一致）

注意: 必须为相应的文件类型配置 LSP 服务器。若没有可用的服务器，将返回错误。`
