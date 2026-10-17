import type {
  AgentEvent,
  AgentEventListener,
  AgentExecutor,
  AgentRunResult,
  ChatMessage,
  ChatModel,
  ChatParams,
  ChatUsage,
  DecisionProvider,
  DecodingProvider,
  ExecutionContext,
  ModelSelector,
  StopGuard,
  ToolCall,
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
   * Optional fast decision layer (e.g. the System One advisor). When present it
   * runs first and its model/tools/decoding win; `selectModel`/`decoding` are
   * the fallback when the decision layer declines.
   */
  decide?: DecisionProvider;
  /**
   * Stream tokens when the model supports it (default: `true` when
   * `model.stream` exists). Streamed chunks arrive as `text_delta` events.
   */
  stream?: boolean;
  /**
   * Optional guard consulted when the model stops calling tools, before the run
   * is reported `completed`: return a message to keep going (see `StopGuard`).
   */
  stopGuard?: StopGuard;
  onEvent?: AgentEventListener;
}

/**
 * The tool calls of the last assistant turn that still have no result — exactly
 * the shape a paused run leaves behind. Exported so a host can tell whether a
 * stored conversation is waiting to be resumed.
 */
export function unresolvedToolCalls(messages: ChatMessage[]): ToolCall[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role === "tool") continue;
    if (message.role !== "assistant" || !message.toolCalls?.length) return [];
    const answered = new Set(
      messages
        .slice(i + 1)
        .filter((m) => m.role === "tool")
        .map((m) => m.toolCallId),
    );
    return message.toolCalls.filter((call) => !answered.has(call.id));
  }
  return [];
}

/**
 * A minimal tool-calling agent loop: ask the model for one step, execute any
 * tool calls through the executor, feed the results back, repeat. Provider- and
 * transport-agnostic — it only knows `ChatModel` and `AgentExecutor`.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const messages = [...options.messages];
  const maxSteps = options.maxSteps ?? 8;
  const emit = (event: AgentEvent): void => options.onEvent?.(event);

  /**
   * Execute one batch of tool calls. Returns `true` when a call **paused** the
   * run: the blocked call gets no tool result (it never ran) and the loop stops,
   * so resuming re-executes exactly that call instead of the model being told a
   * failure happened.
   */
  const executeBatch = async (
    calls: ToolCall[],
    step: number,
    byName: Map<string, ToolSpec>,
    context: ExecutionContext,
  ): Promise<boolean> => {
    for (const call of calls) {
      const spec = byName.get(call.name);
      emit({ type: "tool_call", call, spec: spec ?? { name: call.name, inputSchema: {} }, step });

      const result = spec
        ? await options.executor.execute(call, spec, context)
        : { ok: false, error: `unknown tool: ${call.name}` };
      if (result.suspension) {
        emit({
          type: "suspended",
          call,
          suspensionId: result.suspension.id,
          question: result.suspension.question,
          step,
        });
        return true;
      }
      emit({ type: "tool_result", call, result, step });

      messages.push({
        role: "tool",
        content: stringify(result.output ?? result.error ?? ""),
        toolCallId: call.id,
        name: call.name,
        isError: !result.ok,
      });
    }
    return false;
  };

  // A seed whose last assistant turn still has unanswered tool calls is a
  // *resumed* run: those calls run before the model is asked anything new (the
  // "re-execute the step you resumed into" contract `langgraph` documents). A
  // partial batch resumes correctly too, since only the unanswered calls re-run.
  const pending = unresolvedToolCalls(messages);
  if (pending.length > 0) {
    const byName = new Map(options.tools.map((spec) => [spec.name, spec]));
    if (await executeBatch(pending, 0, byName, {})) {
      return { messages, steps: 0, stopReason: "suspended" };
    }
  }

  for (let step = 0; step < maxSteps; step += 1) {
    // Fast decision layer first (System One), then the slower router, then the
    // loop's defaults. A decision's tools replace the full tool set for this
    // step, which is how intent steering narrows what the model can call.
    const decision = options.decide
      ? await options.decide({ step, messages, tools: options.tools })
      : undefined;
    const selectedModel =
      decision?.model ??
      (options.selectModel
        ? await options.selectModel({ step, messages, tools: options.tools })
        : undefined);
    const activeModel = selectedModel ?? options.model;
    if (selectedModel) emit({ type: "model_selected", model: activeModel.name, step });

    const activeTools = decision?.tools ?? options.tools;
    const toolsByName = new Map(activeTools.map((spec) => [spec.name, spec]));

    const decoded =
      decision?.decoding ??
      (options.decoding
        ? await options.decoding({ step, messages, tools: activeTools })
        : undefined);
    const params = decoded ? { ...options.params, ...decoded } : options.params;
    if (decoded) emit({ type: "decoding_applied", params: params ?? {}, step });
    if (decision) {
      emit({
        type: "decision_applied",
        model: decision.model?.name,
        tools: decision.tools?.map((spec) => spec.name),
        rationale: decision.rationale,
        step,
      });
    }

    const streamStep = options.stream === false ? undefined : activeModel.stream;
    let streamed = false;
    const chat = streamStep
      ? await streamStep.call(activeModel, messages, activeTools, params ?? {}, (text) => {
          streamed = true;
          emit({ type: "text_delta", text, step });
        })
      : await activeModel.step(messages, activeTools, params);
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
    const perCallUsage =
      chat.usage && chat.toolCalls.length > 0
        ? {
            inputTokens:
              chat.usage.inputTokens !== undefined
                ? Math.round(chat.usage.inputTokens / chat.toolCalls.length)
                : undefined,
            outputTokens:
              chat.usage.outputTokens !== undefined
                ? Math.round(chat.usage.outputTokens / chat.toolCalls.length)
                : undefined,
          }
        : undefined;

    if (chat.toolCalls.length === 0) {
      if (chat.text) messages.push({ role: "assistant", content: chat.text });
      // The model thinks it is done. A host may disagree: `stopGuard` is how a
      // mode keeps the run going while its own board still holds open work.
      const keepGoing = await options.stopGuard?.({ step, messages });
      if (keepGoing) {
        emit({ type: "guard", message: keepGoing, step });
        messages.push({ role: "user", content: keepGoing });
        continue;
      }
      return { messages, steps: step + 1, stopReason: "completed" };
    }

    messages.push({ role: "assistant", content: chat.text ?? "", toolCalls: chat.toolCalls });

    // Execute the whole step's tool calls inside one graph root, so they form a
    // single per-turn DAG rather than one disconnected root per call.
    const runToolCalls = (): Promise<boolean> =>
      executeBatch(chat.toolCalls, step, toolsByName, {
        model: activeModel.name,
        cost: perCallCost !== undefined ? { amount: perCallCost, currency: "USD" } : undefined,
        usage: perCallUsage,
      });
    const suspended = options.executor.runTurn
      ? await options.executor.runTurn(`agent_turn_${step}`, runToolCalls)
      : await runToolCalls();
    if (suspended) return { messages, steps: step + 1, stopReason: "suspended" };

    // Post-step guardrail: let the executor inject a steering message based on
    // what it observed (e.g. execution-graph failure signals).
    const guard = await options.executor.review?.({ step });
    if (guard) {
      emit({ type: "guard", message: guard, step });
      messages.push({ role: "user", content: guard });
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
