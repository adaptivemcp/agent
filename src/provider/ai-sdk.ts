import { generateText, streamText, dynamicTool, jsonSchema, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelCapabilities } from "@adaptivemcp/spec";
import type { ChatMessage, ChatModel, ChatParams, ChatStep, ModelPricing, ToolCall, ToolSpec } from "../types.js";

/**
 * The knobs this adapter can actually forward to `generateText`/`streamText`.
 * `DecodingResolver` targets this set, so a recommended profile only ever
 * contains parameters the adapter can transmit (e.g. `minP`/`repetitionPenalty`
 * are not AI SDK call settings and are therefore not advertised).
 */
export const AI_SDK_CAPABILITIES: ModelCapabilities = {
  supports: {
    temperature: true,
    topP: true,
    topK: true,
    presencePenalty: true,
    frequencyPenalty: true,
  },
};

export interface AiSdkProviderConfig {
  /** Model id, e.g. `gpt-4o-mini`, or a local model served over an OpenAI-compatible API. */
  model?: string;
  /** Base URL for an OpenAI-compatible endpoint (OpenAI, Ollama, llama.cpp, vLLM, ...). */
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /**
   * Decoding knobs this adapter should advertise. Defaults to
   * `AI_SDK_CAPABILITIES`; override to narrow it (e.g. an endpoint that rejects
   * `topK`).
   */
  capabilities?: ModelCapabilities;
  /** Per-1M-token pricing, forwarded to the `AiSdkModel` for cost accounting. */
  pricing?: ModelPricing;
}

/**
 * Provider-agnostic `ChatModel` backed by the Vercel AI SDK. Any OpenAI-compatible
 * endpoint works; swapping in another provider means swapping `createOpenAI` for
 * that provider's factory (the rest of the agent is unchanged).
 */
export class AiSdkModel implements ChatModel {
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  readonly pricing?: ModelPricing;

  constructor(
    private readonly model: LanguageModel,
    modelId: string,
    capabilities: ModelCapabilities = AI_SDK_CAPABILITIES,
    pricing?: ModelPricing,
  ) {
    this.name = modelId;
    this.capabilities = capabilities;
    this.pricing = pricing;
  }

  async step(messages: ChatMessage[], tools: ToolSpec[], params: ChatParams = {}): Promise<ChatStep> {
    const prompt = toAiSdkPrompt(messages);
    const result = await generateText({
      model: this.model,
      instructions: prompt.instructions,
      messages: prompt.messages,
      tools: buildAiTools(tools),
      // One step at a time: the agent loop owns tool execution (via the Adaptive
      // MCP executor), not the SDK.
      stopWhen: stepCountIs(1),
      ...knobSettings(params),
    });

    return toChatStep(result.text, result.toolCalls, result.finishReason, result.usage);
  }

  async stream(
    messages: ChatMessage[],
    tools: ToolSpec[],
    params: ChatParams = {},
    onTextDelta: (text: string) => void,
  ): Promise<ChatStep> {
    const prompt = toAiSdkPrompt(messages);
    const result = streamText({
      model: this.model,
      instructions: prompt.instructions,
      messages: prompt.messages,
      tools: buildAiTools(tools),
      stopWhen: stepCountIs(1),
      ...knobSettings(params),
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") onTextDelta(part.text);
    }

    const [text, toolCalls, finishReason, usage] = await Promise.all([
      result.text,
      result.toolCalls,
      result.finishReason,
      result.usage,
    ]);
    return toChatStep(text, toolCalls, finishReason, usage);
  }
}

/** Build an `AiSdkModel` from an OpenAI-compatible provider config. */
export function createAiSdkModel(config: AiSdkProviderConfig = {}): AiSdkModel {
  const provider = createOpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    headers: config.headers,
  });
  const modelId = config.model ?? "gpt-4o-mini";
  // Use the Chat Completions model, not the provider's default Responses API:
  // OpenAI-compatible local servers (llama.cpp, Ollama, vLLM) implement the
  // former.
  return new AiSdkModel(provider.chat(modelId), modelId, config.capabilities, config.pricing);
}

/** Translate decoding `ChatParams` into AI SDK call settings. */
function knobSettings(params: ChatParams): {
  temperature: number | undefined;
  topP: number | undefined;
  topK: number | undefined;
  presencePenalty: number | undefined;
  frequencyPenalty: number | undefined;
  maxOutputTokens: number | undefined;
} {
  return {
    temperature: params.temperature,
    topP: params.topP,
    topK: params.topK,
    presencePenalty: params.presencePenalty,
    frequencyPenalty: params.frequencyPenalty,
    maxOutputTokens: params.maxOutputTokens,
  };
}

function buildAiTools(tools: ToolSpec[]): ToolSet {
  const aiTools: ToolSet = {};
  for (const spec of tools) {
    aiTools[spec.name] = dynamicTool({
      description: spec.description ?? spec.name,
      inputSchema: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
    });
  }
  return aiTools;
}

interface AiSdkToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

function toChatStep(
  text: string,
  toolCalls: ReadonlyArray<AiSdkToolCall>,
  finishReason: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): ChatStep {
  const calls: ToolCall[] = toolCalls.map((call) => ({
    id: call.toolCallId,
    name: call.toolName,
    input: call.input,
  }));
  return {
    text: text || undefined,
    toolCalls: calls,
    finishReason,
    usage: { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens },
  };
}

/**
 * AI SDK v7 models system content through the `instructions` option rather than
 * a `system` message. Pull every system message out of the conversation and
 * join them; the rest become the `messages` array.
 */
function toAiSdkPrompt(messages: ChatMessage[]): { instructions?: string; messages: ModelMessage[] } {
  const system: string[] = [];
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const parts: Array<
        { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = [];
      if (message.content) parts.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input });
      }
      out.push({ role: "assistant", content: parts });
      continue;
    }
    out.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: message.toolCallId ?? "",
          toolName: message.name ?? "",
          output: message.isError
            ? { type: "error-text", value: message.content }
            : { type: "text", value: message.content },
        },
      ],
    });
  }
  return { instructions: system.length > 0 ? system.join("\n\n") : undefined, messages: out };
}
