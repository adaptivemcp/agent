/**
 * Core, provider-agnostic agent types.
 *
 * The agent loop talks to a `ChatModel` and an `AgentExecutor`; nothing here
 * depends on a specific LLM SDK or MCP transport. The AI SDK and the official
 * MCP SDK live behind those two seams.
 */

import type { ModelCapabilities } from "@adaptivemcp/spec";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  /** Stable id used to correlate the call with its result. */
  id: string;
  name: string;
  input: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Assistant tool calls (present when `role === "assistant"`). */
  toolCalls?: ToolCall[];
  /** Correlates a tool result message with its call (present when `role === "tool"`). */
  toolCallId?: string;
  /** Tool name for a tool result message. */
  name?: string;
  /** Marks a tool result as an error. */
  isError?: boolean;
}

/** A tool as the model sees it (JSON Schema input, plus its origin server). */
export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  serverName?: string;
}

/**
 * Decoding parameters for one completion. Keys mirror
 * `ResolvedDecodingSettings` (from `@adaptivemcp/spec`) so a host can apply an
 * Adaptive MCP decoding recommendation directly; `maxOutputTokens` is the
 * agent's own budget knob and is never set by the advisor.
 */
export interface ChatParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
  maxOutputTokens?: number;
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatStep {
  text?: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: ChatUsage;
}

/** The provider seam. Implemented by the AI SDK adapter and a scripted model. */
export interface ChatModel {
  readonly name: string;
  /**
   * Decoding knobs this backend actually exposes (see `@adaptivemcp/spec`
   * `ModelCapabilities`). The host resolves an Adaptive MCP decoding profile
   * against this, so unsupported knobs are dropped rather than approximated.
   */
  readonly capabilities?: ModelCapabilities;
  step(messages: ChatMessage[], tools: ToolSpec[], params?: ChatParams): Promise<ChatStep>;
}

/**
 * Context handed to a `DecodingProvider` before each completion, so the host can
 * decide which learned decoding profile (if any) to apply to this step.
 */
export interface DecodingRequest {
  step: number;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

/**
 * Supplies decoding overrides for the next completion. Returning `undefined`
 * means "use the loop's static `params`". The agent owns its LLM call, so this
 * is where a `suggestDecoding()` recommendation actually gets applied.
 */
export type DecodingProvider = (
  request: DecodingRequest,
) => ChatParams | undefined | Promise<ChatParams | undefined>;

export interface ToolExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** The approval decision, when the call went through the gate. */
  decision?: string;
}

/** The execution seam: routes one tool call through the Adaptive MCP loop. */
export interface AgentExecutor {
  execute(call: ToolCall, spec: ToolSpec): Promise<ToolExecutionResult>;
}

export interface AgentRunResult {
  messages: ChatMessage[];
  steps: number;
  stopReason: "completed" | "max_steps";
}

export type AgentEvent =
  | { type: "assistant_text"; text: string; step: number }
  | { type: "decoding_applied"; params: ChatParams; step: number }
  | { type: "tool_call"; call: ToolCall; spec: ToolSpec; step: number }
  | { type: "tool_result"; call: ToolCall; result: ToolExecutionResult; step: number };

export type AgentEventListener = (event: AgentEvent) => void;
