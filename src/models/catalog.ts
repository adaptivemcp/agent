import { readFileSync } from "node:fs";
import type { ModelOption } from "@adaptivemcp/routing";
import { LOCAL_PROVIDER_DEFAULTS } from "../config.js";
import type { ChatModel } from "../types.js";
import { createChatModel, isAvailable } from "./factory.js";
import type { ModelCatalogFile, ModelIntegration } from "./types.js";

export type { ModelCatalogFile, ModelIntegration, ModelProviderKind } from "./types.js";

/**
 * Built-in integrations. Only the ones whose key is present (or that need none)
 * survive into a `ModelCatalog`, so a default install with just the local
 * `llama-server` yields one usable model and no failing entries. Every field is
 * overridable from a catalog file (`--models` / `$AGENT_MODELS`).
 */
export function builtinIntegrations(env: NodeJS.ProcessEnv = process.env): ModelIntegration[] {
  return [
    {
      id: "local",
      label: "Local llama.cpp",
      provider: "openai-compatible",
      baseURL: env.AI_BASE_URL ?? LOCAL_PROVIDER_DEFAULTS.baseURL,
      model: env.AI_MODEL ?? LOCAL_PROVIDER_DEFAULTS.model,
      apiKeyEnv: ["AI_API_KEY", LOCAL_PROVIDER_DEFAULTS.apiKeyEnv],
      costWeight: 1,
      latencyWeight: 1,
      default: true,
    },
    {
      id: "openai",
      label: "OpenAI (compatible)",
      provider: "openai-compatible",
      baseURL: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: env.OPENAI_MODEL ?? "gpt-4o-mini",
      apiKeyEnv: "OPENAI_API_KEY",
      costWeight: 4,
      latencyWeight: 0.6,
    },
    {
      id: "anthropic",
      label: "Anthropic Claude",
      provider: "anthropic",
      model: env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      costWeight: 4,
      latencyWeight: 0.7,
    },
    {
      id: "google",
      label: "Google Gemini",
      provider: "google",
      model: env.GOOGLE_MODEL ?? "gemini-2.0-flash",
      apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
      costWeight: 3,
      latencyWeight: 0.8,
    },
  ];
}

/**
 * The agent's list of model integrations. Holds only *available* models (keys
 * present or none required), lazily builds a `ChatModel` per id, and exposes the
 * `ModelOption[]` Adaptive MCP's `Router` selects between.
 */
export class ModelCatalog {
  private readonly integrations: ModelIntegration[];
  private readonly cache = new Map<string, ChatModel>();
  private readonly env: NodeJS.ProcessEnv;
  readonly defaultId: string;

  constructor(integrations: ModelIntegration[], env: NodeJS.ProcessEnv = process.env, defaultId?: string) {
    this.env = env;
    this.integrations = integrations.filter((integration) => isAvailable(integration, env));
    if (this.integrations.length === 0) {
      throw new Error(
        "model catalog has no available models: set an API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, " +
          "GOOGLE_GENERATIVE_AI_API_KEY) or LLAMA_API_KEY for the local server",
      );
    }
    const flagged = this.integrations.find((integration) => integration.default)?.id;
    this.defaultId = defaultId ?? flagged ?? this.integrations[0]!.id;
    if (!this.has(this.defaultId)) {
      throw new Error(`model catalog default "${this.defaultId}" is not an available model`);
    }
  }

  list(): ModelIntegration[] {
    return [...this.integrations];
  }

  has(id: string): boolean {
    return this.integrations.some((integration) => integration.id === id);
  }

  /** The `ChatModel` for an id (built once), or `undefined` if unknown/absent. */
  get(id: string): ChatModel | undefined {
    if (!this.has(id)) return undefined;
    let model = this.cache.get(id);
    if (!model) {
      const integration = this.integrations.find((candidate) => candidate.id === id)!;
      model = createChatModel(integration, this.env);
      this.cache.set(id, model);
    }
    return model;
  }

  defaultModel(): ChatModel {
    return this.get(this.defaultId)!;
  }

  /** Candidate models for `Router`, in catalog order. */
  routingOptions(): ModelOption[] {
    return this.integrations.map((integration) => ({
      id: integration.id,
      costWeight: integration.costWeight ?? 1,
      latencyWeight: integration.latencyWeight ?? 1,
    }));
  }

  /** Human-readable list for the REPL's `/models` command. */
  describe(): string {
    return this.integrations
      .map((integration) => {
        const marker = integration.id === this.defaultId ? " (default)" : "";
        const label = integration.label ? ` ${integration.label}` : "";
        return `  ${integration.id}${marker} — ${integration.provider}/${integration.model}${label}`;
      })
      .join("\n");
  }
}

/**
 * Load the catalog: built-in integrations, merged with an optional catalog file
 * (`--models <path>` or `$AGENT_MODELS`). File entries with a known `id` override
 * the matching built-in field-by-field; new ids are appended.
 */
export function loadCatalog(options: { file?: string; env?: NodeJS.ProcessEnv } = {}): ModelCatalog {
  const env = options.env ?? process.env;
  const integrations = builtinIntegrations(env);
  const file = options.file ?? env.AGENT_MODELS;
  let defaultId: string | undefined;

  if (file) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ModelCatalogFile;
    for (const entry of parsed.models ?? []) {
      const index = integrations.findIndex((integration) => integration.id === entry.id);
      if (index >= 0) integrations[index] = { ...integrations[index], ...entry };
      else integrations.push(entry);
    }
    defaultId = parsed.default;
  }

  return new ModelCatalog(integrations, env, defaultId);
}
