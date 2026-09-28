/**
 * @adaptivemcp/agent — the Adaptive MCP agent.
 *
 * A provider-agnostic, MCP-native agent that closes the adaptation loop by
 * owning both the LLM completion (so decoding/routing recommendations apply)
 * and the tool execution (so telemetry, evaluation, approval, memory, and the
 * derived view all learn from real usage).
 */

export { runAgent, type RunAgentOptions } from "./agent/loop.js";
export { AgentRuntime, type AgentRuntimeOptions, type ToolInvoker } from "./runtime.js";
export {
  AggregateToolset,
  InMemoryToolset,
  sanitize,
  type InMemoryTool,
  type McpToolResult,
  type Toolset,
} from "./mcp/toolset.js";
export { StdioToolset, type StdioToolsetOptions } from "./mcp/stdio.js";
export { AiSdkModel, createAiSdkModel, type AiSdkProviderConfig } from "./provider/ai-sdk.js";
export { ScriptedModel, type ScriptedTurn, type ScriptedToolCall } from "./provider/scripted.js";
export { parseServer, parseServers, providerConfigFromEnv, type AgentConfig } from "./config.js";
export type {
  AgentEvent,
  AgentEventListener,
  AgentExecutor,
  AgentRunResult,
  ChatMessage,
  ChatModel,
  ChatParams,
  ChatStep,
  ChatUsage,
  DecodingProvider,
  DecodingRequest,
  ToolCall,
  ToolExecutionResult,
  ToolSpec,
} from "./types.js";
