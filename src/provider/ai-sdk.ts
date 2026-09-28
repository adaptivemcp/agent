import { generateText, dynamicTool, jsonSchema, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ChatMessage, ChatModel, ChatParams, ChatStep, ToolCall, ToolSpec } from "../types.js";

export interface AiSdkProviderConfig {
  /** Model id, e.g. `gpt-4o-mini`, or a local model served over an OpenAI-compatible API. */
  model?: string;
  /** Base URL for an OpenAI-compatible endpoint (OpenAI, Ollama, llama.cpp, vLLM, ...). */
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

/**
 * Provider-agnostic `ChatModel` backed by the Vercel AI SDK. Any OpenAI-compatible
 * endpoint works; swapping in another provider means swapping `createOpenAI` for
 * that provider's factory (the rest of the agent is unchanged).
 */
export class AiSdkModel implements ChatModel {
  readonly name: string;

  constructor(private readonly model: LanguageModel, modelId: string) {
    this.name = modelId;
  }

  async step(messages: ChatMessage[], tools: ToolSpec[], params: ChatParams = {}): Promise<ChatStep> {
    const aiTools: ToolSet = {};
    for (const spec of tools) {
      aiTools[spec.name] = dynamicTool({
        description: spec.description ?? spec.name,
        inputSchema: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
      });
    }

    const result = await generateText({
      model: this.model,
      messages: toAiSdkMessages(messages),
      tools: aiTools,
      // One step at a time: the agent loop owns tool execution (via the Adaptive
      // MCP executor), not the SDK.
      stopWhen: stepCountIs(1),
      temperature: params.temperature,
      topP: params.topP,
      maxOutputTokens: params.maxOutputTokens,
    });

    const toolCalls: ToolCall[] = result.toolCalls.map((call) => ({
      id: call.toolCallId,
      name: call.toolName,
      input: call.input,
    }));

    return {
      text: result.text || undefined,
      toolCalls,
      finishReason: result.finishReason,
      usage: {
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      },
    };
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
  return new AiSdkModel(provider(modelId), modelId);
}

function toAiSdkMessages(messages: ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
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
  return out;
}
