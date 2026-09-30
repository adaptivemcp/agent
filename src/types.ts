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
  /** Standard MCP tool annotations (`destructiveHint`, `readOnlyHint`, ...). */
  annotations?: Record<string, unknown>;
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

/** USD pricing per 1M tokens, used to turn token usage into a recorded cost. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
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
  /** Per-1M-token pricing, when known; lets the loop record real cost. */
  readonly pricing?: ModelPricing;
  step(messages: ChatMessage[], tools: ToolSpec[], params?: ChatParams): Promise<ChatStep>;
  /**
   * Optional token streaming. When present, `runAgent` uses it (unless
   * `stream: false`) and reports each chunk as a `text_delta` event. It must
   * resolve to the same `ChatStep` `step()` would have returned, so the loop's
   * tool handling is identical either way.
   */
  stream?(
    messages: ChatMessage[],
    tools: ToolSpec[],
    params: ChatParams,
    onTextDelta: (text: string) => void,
  ): Promise<ChatStep>;
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

/** Context handed to a `ModelSelector` before each completion. */
export interface ModelSelectionRequest {
  step: number;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

/**
 * Chooses which `ChatModel` handles the next completion (e.g. an Adaptive MCP
 * routing recommendation per tool). Returning `undefined` keeps the loop's
 * default model.
 */
export type ModelSelector = (
  request: ModelSelectionRequest,
) => ChatModel | undefined | Promise<ChatModel | undefined>;

/**
 * A whole-turn decision from a fast decision layer (e.g. the System One
 * advisor): which model, which tools, and which decoding to use for this step.
 * Any omitted field falls back to the loop's default (`model` / `selectModel`,
 * `tools`, `params` / `decoding`).
 */
export interface AgentDecision {
  model?: ChatModel;
  tools?: ToolSpec[];
  decoding?: ChatParams;
  /** Short explanation, surfaced on the `decision_applied` event. */
  rationale?: string;
}

/**
 * Supplies a per-step decision (model, tools, decoding) before each completion.
 * Returning `undefined` means "no opinion"; the loop falls back to `selectModel`
 * / `decoding` / its defaults.
 */
export type DecisionProvider = (
  request: ModelSelectionRequest,
) => AgentDecision | undefined | Promise<AgentDecision | undefined>;

export interface ToolExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** The approval decision, when the call went through the gate. */
  decision?: string;
}

/** The execution seam: routes one tool call through the Adaptive MCP loop. */
export interface ExecutionContext {
  /** The model that produced this tool call. */
  model?: string;
  /** The tool call's share of the step's model cost. */
  cost?: { amount: number; currency?: string };
  /** The tool call's share of the step's token usage. */
  usage?: ChatUsage;
}

export interface AgentExecutor {
  execute(call: ToolCall, spec: ToolSpec, context?: ExecutionContext): Promise<ToolExecutionResult>;
  /**
   * Optional: run one model step's batch of tool calls inside a single
   * execution-graph root, so a turn with several calls forms one DAG instead of
   * one disconnected root per call. Implemented by `AgentRuntime`.
   */
  runTurn?<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Optional post-step review (e.g. graph-aware guardrails). Return a message to
   * steer the next step, or `undefined` to continue unchanged.
   */
  review?(context: { step: number }): string | undefined | Promise<string | undefined>;
}

export interface AgentRunResult {
  messages: ChatMessage[];
  steps: number;
  stopReason: "completed" | "max_steps";
}

export type AgentEvent =
  | { type: "text_delta"; text: string; step: number }
  | { type: "assistant_text"; text: string; step: number }
  | { type: "model_selected"; model: string; step: number }
  | {
      type: "usage";
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      cost?: number;
      step: number;
    }
  | { type: "decoding_applied"; params: ChatParams; step: number }
  | {
      type: "decision_applied";
      model?: string;
      tools?: string[];
      rationale?: string;
      step: number;
    }
  | { type: "guard"; message: string; step: number }
  | { type: "tool_call"; call: ToolCall; spec: ToolSpec; step: number }
  | { type: "tool_result"; call: ToolCall; result: ToolExecutionResult; step: number };

export type AgentEventListener = (event: AgentEvent) => void;
