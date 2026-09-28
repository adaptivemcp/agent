import type {
  AgentEvent,
  AgentEventListener,
  AgentExecutor,
  AgentRunResult,
  ChatMessage,
  ChatModel,
  ChatParams,
  DecodingProvider,
  ToolSpec,
} from "../types.js";

export interface RunAgentOptions {
  model: ChatModel;
  tools: ToolSpec[];
  executor: AgentExecutor;
  /** Seed conversation. A system prompt is usually the first message. */
  messages: ChatMessage[];
  maxSteps?: number;
  params?: ChatParams;
  /**
   * Optional per-step decoding overrides (e.g. from
   * `AgentRuntime.decodingProvider`). Merged over `params` for each completion,
   * and reported as a `decoding_applied` event.
   */
  decoding?: DecodingProvider;
  onEvent?: AgentEventListener;
}

/**
 * A minimal tool-calling agent loop: ask the model for one step, execute any
 * tool calls through the executor, feed the results back, repeat. Provider- and
 * transport-agnostic — it only knows `ChatModel` and `AgentExecutor`.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const messages = [...options.messages];
  const toolsByName = new Map(options.tools.map((spec) => [spec.name, spec]));
  const maxSteps = options.maxSteps ?? 8;
  const emit = (event: AgentEvent): void => options.onEvent?.(event);

  for (let step = 0; step < maxSteps; step += 1) {
    const decoded = options.decoding
      ? await options.decoding({ step, messages, tools: options.tools })
      : undefined;
    const params = decoded ? { ...options.params, ...decoded } : options.params;
    if (decoded) emit({ type: "decoding_applied", params: params ?? {}, step });

    const chat = await options.model.step(messages, options.tools, params);
    if (chat.text) emit({ type: "assistant_text", text: chat.text, step });

    if (chat.toolCalls.length === 0) {
      if (chat.text) messages.push({ role: "assistant", content: chat.text });
      return { messages, steps: step + 1, stopReason: "completed" };
    }

    messages.push({ role: "assistant", content: chat.text ?? "", toolCalls: chat.toolCalls });

    for (const call of chat.toolCalls) {
      const spec = toolsByName.get(call.name);
      emit({ type: "tool_call", call, spec: spec ?? { name: call.name, inputSchema: {} }, step });

      const result = spec
        ? await options.executor.execute(call, spec)
        : { ok: false, error: `unknown tool: ${call.name}` };
      emit({ type: "tool_result", call, result, step });

      messages.push({
        role: "tool",
        content: stringify(result.output ?? result.error ?? ""),
        toolCallId: call.id,
        name: call.name,
        isError: !result.ok,
      });
    }
  }

  return { messages, steps: maxSteps, stopReason: "max_steps" };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
