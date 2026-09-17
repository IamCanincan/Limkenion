// Content for the limkenion-api bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import csharpLimkenionApi from './limkenion-api/csharp/limkenion-api.md'
import curlExamples from './limkenion-api/curl/examples.md'
import goLimkenionApi from './limkenion-api/go/limkenion-api.md'
import javaLimkenionApi from './limkenion-api/java/limkenion-api.md'
import phpLimkenionApi from './limkenion-api/php/limkenion-api.md'
import pythonAgentSdkPatterns from './limkenion-api/python/agent-sdk/patterns.md'
import pythonAgentSdkReadme from './limkenion-api/python/agent-sdk/README.md'
import pythonLimkenionApiBatches from './limkenion-api/python/limkenion-api/batches.md'
import pythonLimkenionApiFilesApi from './limkenion-api/python/limkenion-api/files-api.md'
import pythonLimkenionApiReadme from './limkenion-api/python/limkenion-api/README.md'
import pythonLimkenionApiStreaming from './limkenion-api/python/limkenion-api/streaming.md'
import pythonLimkenionApiToolUse from './limkenion-api/python/limkenion-api/tool-use.md'
import rubyLimkenionApi from './limkenion-api/ruby/limkenion-api.md'
import skillPrompt from './limkenion-api/SKILL.md'
import sharedErrorCodes from './limkenion-api/shared/error-codes.md'
import sharedLiveSources from './limkenion-api/shared/live-sources.md'
import sharedModels from './limkenion-api/shared/models.md'
import sharedPromptCaching from './limkenion-api/shared/prompt-caching.md'
import sharedToolUseConcepts from './limkenion-api/shared/tool-use-concepts.md'
import typescriptAgentSdkPatterns from './limkenion-api/typescript/agent-sdk/patterns.md'
import typescriptAgentSdkReadme from './limkenion-api/typescript/agent-sdk/README.md'
import typescriptLimkenionApiBatches from './limkenion-api/typescript/limkenion-api/batches.md'
import typescriptLimkenionApiFilesApi from './limkenion-api/typescript/limkenion-api/files-api.md'
import typescriptLimkenionApiReadme from './limkenion-api/typescript/limkenion-api/README.md'
import typescriptLimkenionApiStreaming from './limkenion-api/typescript/limkenion-api/streaming.md'
import typescriptLimkenionApiToolUse from './limkenion-api/typescript/limkenion-api/tool-use.md'

// @[MODEL LAUNCH]: Update the model IDs/names below. These are substituted into {{VAR}}
// placeholders in the .md files at runtime before the skill prompt is sent.
// After updating these constants, manually update the two files that still hardcode models:
//   - limkenion-api/SKILL.md (Current Models pricing table)
//   - limkenion-api/shared/models.md (full model catalog with legacy versions and alias mappings)
export const SKILL_MODEL_VARS = {
  PRO_ID: 'deepseek-v4-pro',
  PRO_NAME: 'DeepSeek V4 Pro',
  FLASH_ID: 'deepseek-flash',
  FLASH_NAME: 'DeepSeek Flash',
} satisfies Record<string, string>

export const SKILL_PROMPT: string = skillPrompt

export const SKILL_FILES: Record<string, string> = {
  'csharp/limkenion-api.md': csharpLimkenionApi,
  'curl/examples.md': curlExamples,
  'go/limkenion-api.md': goLimkenionApi,
  'java/limkenion-api.md': javaLimkenionApi,
  'php/limkenion-api.md': phpLimkenionApi,
  'python/agent-sdk/README.md': pythonAgentSdkReadme,
  'python/agent-sdk/patterns.md': pythonAgentSdkPatterns,
  'python/limkenion-api/README.md': pythonLimkenionApiReadme,
  'python/limkenion-api/batches.md': pythonLimkenionApiBatches,
  'python/limkenion-api/files-api.md': pythonLimkenionApiFilesApi,
  'python/limkenion-api/streaming.md': pythonLimkenionApiStreaming,
  'python/limkenion-api/tool-use.md': pythonLimkenionApiToolUse,
  'ruby/limkenion-api.md': rubyLimkenionApi,
  'shared/error-codes.md': sharedErrorCodes,
  'shared/live-sources.md': sharedLiveSources,
  'shared/models.md': sharedModels,
  'shared/prompt-caching.md': sharedPromptCaching,
  'shared/tool-use-concepts.md': sharedToolUseConcepts,
  'typescript/agent-sdk/README.md': typescriptAgentSdkReadme,
  'typescript/agent-sdk/patterns.md': typescriptAgentSdkPatterns,
  'typescript/limkenion-api/README.md': typescriptLimkenionApiReadme,
  'typescript/limkenion-api/batches.md': typescriptLimkenionApiBatches,
  'typescript/limkenion-api/files-api.md': typescriptLimkenionApiFilesApi,
  'typescript/limkenion-api/streaming.md': typescriptLimkenionApiStreaming,
  'typescript/limkenion-api/tool-use.md': typescriptLimkenionApiToolUse,
}
