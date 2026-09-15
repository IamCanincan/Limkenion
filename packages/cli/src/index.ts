/**
 * limkenion 公共导出。
 *
 * CLI 本体就是这一层的使用者；把入口与配置一起导出，方便别人把同一套行为嵌进
 * 自己的脚本，而不必重新拼装 Agent。
 */

export { runCli } from "./cli.ts";
export {
	AGENT_DIR_ENV,
	APP_NAME,
	CONFIG_DIR_NAME,
	configDirName,
	encodeCwd,
	ensureSessionDir,
	getAgentDir,
	getSessionDir,
	getSessionsDir,
	getSettingsPath,
	SESSION_DIR_ENV,
	VERSION,
} from "./config.ts";
export {
	type ApiCredential,
	type ApiKeySource,
	CREDENTIAL_PROVIDER,
	type CredentialStore,
	clearApiKey,
	getCredentialsPath,
	maskKey,
	promptSecret,
	readCredentials,
	readStoredApiKey,
	resolveApiKey,
	storeApiKey,
} from "./credentials.ts";
export { createRenderer, type RenderOptions } from "./render.ts";
export { type ReplOptions, startRepl } from "./repl.ts";
export { Session, type SessionHeader } from "./session.ts";
export { type AppSettings, readSettings } from "./settings.ts";
export {
	type CredentialsResponse,
	type DirCreateResponse,
	type DirEntry,
	type DirListResponse,
	type ErrorResponse,
	emptyTurn,
	type FileResponse,
	type ModelOption,
	type PendingTurn,
	type SessionSummary,
	type StateResponse,
	type ToolCard,
	type WebEvent,
} from "./web/protocol.ts";
export { RunRegistry, type SetSessionCwdResult } from "./web/registry.ts";
export { Run, type RunOptions } from "./web/runs.ts";
export {
	isRequestAllowed,
	readFilePreview,
	startWebServer,
	type WebServerHandle,
	type WebServerOptions,
} from "./web/server.ts";
