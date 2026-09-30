/**
 * @adaptivemcp/agent — the Adaptive MCP agent.
 *
 * A provider-agnostic, MCP-native agent that closes the adaptation loop by
 * owning both the LLM completion (so decoding/routing recommendations apply)
 * and the tool execution (so telemetry, evaluation, approval, memory, and the
 * derived view all learn from real usage).
 */

export { runAgent, type RunAgentOptions } from "./agent/loop.js";
export { runRepl, type ReplOptions, type ApprovalHost } from "./repl.js";
export {
  AgentRuntime,
  type AgentRuntimeOptions,
  type ExecutionObservation,
  type ServerToolPolicy,
  type ServerToolsMetadata,
  type SystemOneProviderOptions,
  type ToolInvoker,
} from "./runtime.js";
export {
  AggregateToolset,
  InMemoryToolset,
  sanitize,
  type InMemoryTool,
  type McpToolResult,
  type Toolset,
} from "./mcp/toolset.js";
export { StdioToolset, type StdioToolsetOptions } from "./mcp/stdio.js";
export { AiSdkModel, createAiSdkModel, AI_SDK_CAPABILITIES, type AiSdkProviderConfig } from "./provider/ai-sdk.js";
export { ScriptedModel, type ScriptedTurn, type ScriptedToolCall } from "./provider/scripted.js";
export {
  ModelCatalog,
  loadCatalog,
  builtinIntegrations,
  type ModelCatalogFile,
  type ModelIntegration,
  type ModelProviderKind,
} from "./models/catalog.js";
export { PooledChatModel, type PooledModelOptions } from "./models/pool.js";
export { apiKeyFor, apiKeyCount, apiKeysFor, createChatModel } from "./models/factory.js";
export {
  discoverOllamaIntegrations,
  ollamaId,
  OLLAMA_DEFAULTS,
  type OllamaDiscoveryOptions,
  type OllamaTag,
} from "./models/ollama.js";
export {
  SystemOneClient,
  OllamaSystemOneBackend,
  SYSTEM_ONE_DEFAULT_BASE_URL,
  SYSTEM_ONE_DEFAULT_MODEL,
  type DecisionBackend,
  type SystemOneAnswer,
  type SystemOneChoiceAnswer,
  type SystemOneChoiceQuestion,
  type SystemOneClientOptions,
  type SystemOneNoulAnswer,
  type SystemOneNoulQuestion,
  type SystemOneQuestion,
  type SystemOneResponse,
  type SystemOneScoreAnswer,
  type SystemOneScoreQuestion,
  type SystemOneUsage,
} from "./decision/systemone.js";
export {
  SystemOneAdvisor,
  type DecisionModelInfo,
  type DecisionToolInfo,
  type SystemOneAdvisorInput,
  type SystemOneAdvisorOptions,
  type SystemOneDecision,
} from "./decision/advisor.js";
export {
  parseServer,
  parseServers,
  providerConfigFromEnv,
  exampleServerOptions,
  LOCAL_PROVIDER_DEFAULTS,
  type AgentConfig,
} from "./config.js";
export type {
  AgentDecision,
  AgentEvent,
  AgentEventListener,
  AgentExecutor,
  AgentRunResult,
  ChatMessage,
  ChatModel,
  ChatParams,
  ChatStep,
  ChatUsage,
  DecisionProvider,
  DecodingProvider,
  DecodingRequest,
  ExecutionContext,
  ModelPricing,
  ModelSelectionRequest,
  ModelSelector,
  ToolCall,
  ToolExecutionResult,
  ToolSpec,
} from "./types.js";
