import { EXIT_PLAN_MODE_TOOL_NAME } from '../ExitPlanModeTool/constants.js'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

export const DESCRIPTION =
  '向用户提出多选问题，以收集信息、澄清歧义、了解偏好、做出决策或提供选择。'

export const PREVIEW_FEATURE_PROMPT = {
  markdown: `
预览功能：
当呈现实物产物、且用户需要直观比较时，可在选项上使用可选的 \`preview\` 字段：
- UI 布局或组件的 ASCII 模型
- 展示不同实现的代码片段
- 图表变体
- 配置示例

预览内容将作为 markdown 渲染在等宽盒子中。支持带换行的多行文本。当任一选项带有预览时，UI 会切换到左右布局：左侧为垂直选项列表，右侧为预览。对于仅凭标签和描述就足够的简单偏好问题，不要使用预览功能。注意：预览仅支持单选问题（不支持多选）。
`,
  html: `
预览功能：
当呈现实物产物、且用户需要直观比较时，可在选项上使用可选的 \`preview\` 字段：
- UI 布局或组件的 HTML 模型
- 展示不同实现的格式化代码片段
- 视觉比较或图表

预览内容必须是自包含的 HTML 片段（没有 <html>/<body> 包装，没有 <script> 或 <style> 标签——请改用内联 style 属性）。对于仅凭标签和描述就足够的简单偏好问题，不要使用预览功能。注意：预览仅支持单选问题（不支持多选）。
`,
} as const

export const ASK_USER_QUESTION_TOOL_PROMPT = `当你需要在执行过程中向用户提问时使用此工具。这允许你：
1. 收集用户偏好或需求
2. 澄清模糊的指令
3. 在推进工作时就实现选择获取决策
4. 就接下来走哪个方向为用户提供选择。

使用说明：
- 用户始终可以选择“其他”来提供自定义文本输入
- 使用 multiSelect: true 允许为一个问题选择多个答案
- 如果你推荐某个特定选项，请把它放在列表中的第一位，并在标签末尾加上“（推荐）”

计划模式说明：在计划模式下，应在最终确定计划之前使用此工具来澄清需求或在不同方案之间做选择。不要使用此工具来问“我的计划准备好了吗？”或“我应该继续吗？”——计划审批请使用 ${EXIT_PLAN_MODE_TOOL_NAME}。重要：不要在问题里引用“计划”（例如“你对这个计划有什么反馈吗？”、“这个计划看起来如何？”），因为在调用 ${EXIT_PLAN_MODE_TOOL_NAME} 之前，用户在 UI 中还看不到计划。如果需要计划审批，请改用 ${EXIT_PLAN_MODE_TOOL_NAME}。
`
