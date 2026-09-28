/**
 * Core, provider-agnostic agent types.
 *
 * The agent loop talks to a `ChatModel` and an `AgentExecutor`; nothing here
 * depends on a specific LLM SDK or MCP transport. The AI SDK and the official
 * MCP SDK live behind those two seams.
 */

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

export interface ChatParams {
  temperature?: number;
  topP?: number;
  topK?: number;
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
  step(messages: ChatMessage[], tools: ToolSpec[], params?: ChatParams): Promise<ChatStep>;
}

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
  | { type: "tool_call"; call: ToolCall; spec: ToolSpec; step: number }
  | { type: "tool_result"; call: ToolCall; result: ToolExecutionResult; step: number };

export type AgentEventListener = (event: AgentEvent) => void;
