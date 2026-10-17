import type { ModelCapabilities } from "@adaptivemcp/spec";
import { AI_SDK_CAPABILITIES } from "./provider/ai-sdk.js";
import type { ModelCatalog } from "./models/catalog.js";
import type { AgentRuntime } from "./runtime.js";
import type { ApprovalHost } from "./repl.js";
import type { System1Selection } from "./cli-args.js";
import type {
  AgentExecutor,
  ChatModel,
  DecisionProvider,
  DecodingProvider,
  ModelSelector,
  Steerer,
  StopGuard,
  ToolSpec,
} from "./types.js";

/**
 * The run inputs every renderer shares. The one-shot CLI, the interactive
 * REPL, and (eventually) the deferred full-screen TUI all consume this one
 * assembly — see `buildRunConfig`. Keeping the rules here (pinned models
 * suppress per-tool routing, the System One layer sits in front of the router)
 * means a new renderer cannot re-derive them differently.
 */
export interface RunConfig {
  model: ChatModel;
  tools: ToolSpec[];
  executor: AgentExecutor & Partial<ApprovalHost>;
  system: string;
  maxSteps: number;
  decoding: DecodingProvider;
  /** The model capabilities `decoding` was derived from (for hooks/reports). */
  capabilities: ModelCapabilities;
  selectModel?: ModelSelector;
  decide?: DecisionProvider;
  stream: boolean;
  /**
   * Optional guard consulted when the model wants to stop (the `tasks`
   * orchestration mode uses it to finish a plan before the run ends).
   */
  stopGuard?: StopGuard;
  /**
   * Optional pre-step hook — the planning pass injects a fresh plan through it
   * (see `Steerer`).
   */
  steer?: Steerer;
}

export interface RunConfigInput {
  /** Parsed CLI options the assembly needs; kept narrow on purpose. */
  args: { maxSteps?: number; noStream?: boolean; system1Model?: string };
  /** The model to run: the pinned one, or the catalog default. */
  model: ChatModel;
  /** True when `--model` selected `model` explicitly. */
  pinned: boolean;
  tools: ToolSpec[];
  runtime: AgentRuntime;
  catalog: ModelCatalog;
  /** Base system prompt (server inventory included); renderers may extend it. */
  system: string;
  /**
   * Resolved System One selection (`{}` = the local Ollama tier, a list = the
   * failover chain). Omit to disable the decision layer.
   */
  system1?: System1Selection;
  /** Stop guard for the run's orchestration mode (see `RunConfig.stopGuard`). */
  stopGuard?: StopGuard;
  /** Pre-step hook for the run's planning pass (see `RunConfig.steer`). */
  steer?: Steerer;
}

/** Assemble the shared run inputs once, for any renderer to consume. */
export function buildRunConfig(input: RunConfigInput): RunConfig {
  const { args, model, pinned, tools, runtime, catalog, system, system1 } = input;
  const capabilities = model.capabilities ?? AI_SDK_CAPABILITIES;
  return {
    model,
    tools,
    executor: runtime,
    system,
    maxSteps: args.maxSteps ?? 8,
    decoding: runtime.decodingProvider(capabilities),
    capabilities,
    // A pinned `--model` is an explicit choice; learned per-tool routing must
    // not silently override it.
    selectModel: pinned ? undefined : runtime.modelProvider(catalog),
    // Fast System-1 decision layer in front of the router (opt-in). The tier
    // selection was resolved (and validated) before any server spawned.
    decide: system1
      ? runtime.systemOneProvider(catalog, { model: args.system1Model, ...system1 })
      : undefined,
    stream: !args.noStream,
    stopGuard: input.stopGuard,
    steer: input.steer,
  };
}
