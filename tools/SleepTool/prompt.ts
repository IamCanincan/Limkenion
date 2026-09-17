import { TICK_TAG } from '../../constants/xml.js'

export const SLEEP_TOOL_NAME = 'Sleep'

export const DESCRIPTION = '等待指定的时长'

export const SLEEP_TOOL_PROMPT = `等待指定的时长。用户可随时打断本次休息。

当用户让你休息或无事情可做、或你在等待某件事时使用。

你可能会收到 <${TICK_TAG}> 提示——这些是定期的进展询问。在休息之前，先寻找有价值的工作去做。

你可以与其他工具并发调用此工具——它不会干扰它们。

优先使用此工具而不是 \`Bash(sleep ...)\`——它不会占用 shell 进程。

每次唤醒都会消耗一次 API 调用，但提示词缓存在闲置 5 分钟后会过期——请据此权衡。`
