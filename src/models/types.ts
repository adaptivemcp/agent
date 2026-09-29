import type { ModelCapabilities } from "@adaptivemcp/spec";
import type { ModelPricing } from "../types.js";

/** The provider families the agent can talk to. */
export type ModelProviderKind = "openai-compatible" | "anthropic" | "google";

/**
 * One model integration in the catalog. `id` is the stable handle Adaptive MCP
 * routing recommendations reference and that the CLI can pin with `--model`.
 */
export interface ModelIntegration {
  id: string;
  provider: ModelProviderKind;
  /** Provider-specific model id, e.g. `Qwen/Qwen3-8B` or `claude-sonnet-4-5`. */
  model: string;
  /** Human label for `/models`; defaults to `id`. */
  label?: string;
  /** Overrides the provider default (required for self-hosted endpoints). */
  baseURL?: string;
  /**
   * Env var(s) holding the API key. An entry is only considered *available*
   * when at least one is set (or when this is omitted, meaning no key needed).
   */
  apiKeyEnv?: string | string[];
  /** Router cost weight (1 = baseline). Default 1. */
  costWeight?: number;
  /** Router latency weight (1 = baseline, lower = faster). Default 1. */
  latencyWeight?: number;
  /** Decoding knobs the backend exposes; defaults per provider. */
  capabilities?: ModelCapabilities;
  /** USD per 1M tokens; enables real cost accounting for this model. */
  pricing?: ModelPricing;
  /** Marks the fallback when routing has no learned opinion. */
  default?: boolean;
}

/** Shape of an optional catalog file (`--models` / `$AGENT_MODELS`). */
export interface ModelCatalogFile {
  models?: ModelIntegration[];
  default?: string;
}
