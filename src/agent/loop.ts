import type {
  AgentEvent,
  AgentEventListener,
  AgentExecutor,
  AgentRunResult,
  ChatMessage,
  ChatModel,
  ChatParams,
  ChatUsage,
  DecodingProvider,
  ModelSelector,
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
  /**
   * Optional per-step model choice (e.g. an Adaptive MCP routing
   * recommendation). Falls back to `model` when it returns `undefined`.
   */
  selectModel?: ModelSelector;
  /**
   * Stream tokens when the model supports it (default: `true` when
   * `model.stream` exists). Streamed chunks arrive as `text_delta` events.
   */
  stream?: boolean;
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
    const selectedModel = options.selectModel
      ? await options.selectModel({ step, messages, tools: options.tools })
      : undefined;
    const activeModel = selectedModel ?? options.model;
    if (selectedModel) emit({ type: "model_selected", model: activeModel.name, step });

    const decoded = options.decoding
      ? await options.decoding({ step, messages, tools: options.tools })
      : undefined;
    const params = decoded ? { ...options.params, ...decoded } : options.params;
    if (decoded) emit({ type: "decoding_applied", params: params ?? {}, step });

    const streamStep = options.stream === false ? undefined : activeModel.stream;
    let streamed = false;
    const chat = streamStep
      ? await streamStep.call(activeModel, messages, options.tools, params ?? {}, (text) => {
          streamed = true;
          emit({ type: "text_delta", text, step });
        })
      : await activeModel.step(messages, options.tools, params);
    // With streaming the text already reached the listener as `text_delta`
    // events, so only emit the whole-message event on the non-streaming path.
    if (chat.text && !streamed) emit({ type: "assistant_text", text: chat.text, step });

    // Cost accounting: price this step's tokens (when the model is priced) and
    // split the step cost across its tool calls.
    const cost = costOf(activeModel, chat.usage);
    if (chat.usage || cost !== undefined) {
      emit({
        type: "usage",
        model: activeModel.name,
        inputTokens: chat.usage?.inputTokens,
        outputTokens: chat.usage?.outputTokens,
        cost,
        step,
      });
    }
    const perCallCost =
      cost !== undefined && chat.toolCalls.length > 0 ? cost / chat.toolCalls.length : undefined;

    if (chat.toolCalls.length === 0) {
      if (chat.text) messages.push({ role: "assistant", content: chat.text });
      return { messages, steps: step + 1, stopReason: "completed" };
    }

    messages.push({ role: "assistant", content: chat.text ?? "", toolCalls: chat.toolCalls });

    // Execute the whole step's tool calls inside one graph root, so they form a
    // single per-turn DAG rather than one disconnected root per call.
    const runToolCalls = async (): Promise<void> => {
      for (const call of chat.toolCalls) {
        const spec = toolsByName.get(call.name);
        emit({ type: "tool_call", call, spec: spec ?? { name: call.name, inputSchema: {} }, step });

        const result = spec
          ? await options.executor.execute(call, spec, {
              model: activeModel.name,
              cost: perCallCost !== undefined ? { amount: perCallCost, currency: "USD" } : undefined,
            })
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
    };
    if (options.executor.runTurn) {
      await options.executor.runTurn(`agent_turn_${step}`, runToolCalls);
    } else {
      await runToolCalls();
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

/** Price a step's token usage in USD, or `undefined` when unpriced/no usage. */
function costOf(model: ChatModel, usage: ChatUsage | undefined): number | undefined {
  if (!model.pricing || !usage) return undefined;
  const input = (usage.inputTokens ?? 0) * (model.pricing.inputPerMTok / 1_000_000);
  const output = (usage.outputTokens ?? 0) * (model.pricing.outputPerMTok / 1_000_000);
  const total = input + output;
  return total > 0 ? Number(total.toFixed(6)) : undefined;
}
