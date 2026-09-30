import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { ModelCapabilities } from "@adaptivemcp/spec";
import { AiSdkModel, AI_SDK_CAPABILITIES } from "../provider/ai-sdk.js";
import type { ChatModel } from "../types.js";
import { PooledChatModel } from "./pool.js";
import type { ModelIntegration, ModelProviderKind } from "./types.js";

const ANTHROPIC_CAPABILITIES: ModelCapabilities = {
  supports: { temperature: true, topP: true, topK: true },
};

const GOOGLE_CAPABILITIES: ModelCapabilities = {
  supports: { temperature: true, topP: true, topK: true },
};

/** Env var names to check for an integration's key. */
function apiKeyEnvNames(integration: ModelIntegration): string[] {
  if (integration.apiKeyEnv === undefined) return [];
  return Array.isArray(integration.apiKeyEnv) ? integration.apiKeyEnv : [integration.apiKeyEnv];
}

/**
 * Every configured key for an integration, in pool order. An integration's
 * `apiKeyEnv` may name several *alternative* vars (the first set one wins);
 * once a name matches, numbered siblings of that same name (`<NAME>_2`,
 * `<NAME>_3`, ...) are treated as extra keys in the pool, so several keys for
 * the same provider/model become interchangeable resources rather than
 * conflicting aliases.
 */
export function apiKeysFor(
  integration: ModelIntegration,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  for (const name of apiKeyEnvNames(integration)) {
    const primary = env[name];
    if (!primary) continue;
    const keys = [primary];
    for (let index = 2; ; index += 1) {
      const value = env[`${name}_${index}`];
      if (!value) break;
      keys.push(value);
    }
    return keys;
  }
  return [];
}

/** The number of pooled keys configured for an integration (0 when it needs none). */
export function apiKeyCount(
  integration: ModelIntegration,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return apiKeysFor(integration, env).length;
}

/** The first configured key for an integration, if any. */
export function apiKeyFor(
  integration: ModelIntegration,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return apiKeysFor(integration, env)[0];
}

/**
 * Whether an integration can be used: either it needs no key, or one of its
 * `apiKeyEnv` vars is set. The catalog filters on this so routing never picks a
 * model that would fail to authenticate.
 */
export function isAvailable(
  integration: ModelIntegration,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return apiKeyEnvNames(integration).length === 0 || apiKeyFor(integration, env) !== undefined;
}

function defaultCapabilities(provider: ModelProviderKind): ModelCapabilities {
  switch (provider) {
    case "anthropic":
      return ANTHROPIC_CAPABILITIES;
    case "google":
      return GOOGLE_CAPABILITIES;
    default:
      return AI_SDK_CAPABILITIES;
  }
}

function buildLanguageModel(integration: ModelIntegration, apiKey?: string): LanguageModel {
  switch (integration.provider) {
    case "openai-compatible":
      // Chat Completions, not the Responses API: local/OpenAI-compatible servers
      // implement the former.
      return createOpenAI({ baseURL: integration.baseURL, apiKey }).chat(integration.model);
    case "anthropic":
      return createAnthropic({ baseURL: integration.baseURL, apiKey })(integration.model);
    case "google":
      return createGoogleGenerativeAI({ baseURL: integration.baseURL, apiKey })(integration.model);
  }
}

/** Build a `ChatModel` for one catalog integration. */
export function createChatModel(
  integration: ModelIntegration,
  env: NodeJS.ProcessEnv = process.env,
): ChatModel {
  const capabilities = integration.capabilities ?? defaultCapabilities(integration.provider);
  const build = (apiKey?: string): ChatModel =>
    new AiSdkModel(
      buildLanguageModel(integration, apiKey),
      integration.id,
      capabilities,
      integration.pricing,
    );

  const keys = apiKeysFor(integration, env);
  // One key (or none) is the common case; several become a key pool that fails
  // over between resources of the same model.
  if (keys.length <= 1) return build(keys[0]);
  return new PooledChatModel(keys.map((key) => build(key)), integration.id);
}
