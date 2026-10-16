import { AdaptiveRuntime } from "@adaptivemcp/runtime";
import {
  envelopeClassifier,
  GraphTrackingMiddleware,
  ThinClient,
  type ToolHandler,
} from "@adaptivemcp/thin-client";
import { computeMetricDrift } from "@adaptivemcp/evaluation";
import { GraphAnalyzer } from "@adaptivemcp/graph-analysis";
import type { MemoryStore } from "@adaptivemcp/memory";
import type { RetryPolicy } from "@adaptivemcp/orchestration";
import type { Middleware } from "@adaptivemcp/middleware";
import type { ApprovalPolicy } from "@adaptivemcp/approval";
import {
  DecodingAdvisor,
  DecodingAnalyzer,
  DecodingResolver,
  toDecodingRecommendation,
  type BudgetPolicy,
  type DecodingProfileId,
  type ModelOption,
} from "@adaptivemcp/routing";
import type {
  Annotation,
  DecodingRecommendation,
  ModelCapabilities,
  ResolvedDecodingSettings,
  RiskLevel,
  Store,
  ToolDecoding,
  ToolRecord,
} from "@adaptivemcp/spec";
import type {
  AgentDecision,
  AgentExecutor,
  ChatParams,
  DecisionProvider,
  DecodingProvider,
  ExecutionContext,
  ModelSelector,
  ToolCall,
  ToolExecutionResult,
  ToolSpec,
} from "./types.js";
import type { ModelCatalog } from "./models/catalog.js";
import type { McpToolResult, ToolCallContext } from "./mcp/toolset.js";
import { AI_SDK_CAPABILITIES } from "./provider/ai-sdk.js";
import { localSystemOneBackend, type DecisionBackend } from "./decision/systemone.js";
import { TieredSystemOneBackend } from "./decision/tiered.js";
import {
  SystemOneAdvisor,
  type DecisionToolInfo,
  type SystemOneDecision,
} from "./decision/advisor.js";

/** Performs the raw MCP tool call (transport lives behind this seam). */
export type ToolInvoker = (
  toolName: string,
  input: unknown,
  serverName?: string,
  context?: ToolCallContext,
) => Promise<McpToolResult>;

/** A finished tool execution, surfaced for cross-client reporting. */
export interface ExecutionObservation {
  toolName: string;
  serverName?: string;
  status: "completed" | "failed";
  durationMs: number;
  model?: string;
  cost?: { amount: number; currency?: string };
}

/** One tool's server-published policy (subset of the tools-metadata view). */
export interface ServerToolPolicy {
  name: string;
  annotation?: {
    risk?: string;
    owner?: string;
    tags?: string[];
    description?: string;
    require_approval?: boolean;
    budget?: { limit: number; currency: string };
  };
  recommendations?: Array<{ type: string; payload?: unknown; rationale?: string }>;
}

/** The server-published `dev.adaptivemcp/tools-metadata` document. */
export interface ServerToolsMetadata {
  tools?: ServerToolPolicy[];
}

export interface AgentRuntimeOptions {
  /** SQLite path for the store. Defaults to in-memory. */
  dbPath?: string;
  /**
   * Use an existing store instead of opening one (`dbPath` is then ignored).
   * This is how a delegated child shares its parent's memory: same tools, same
   * learned state, different session — so the child's calls land in the same
   * graph rather than a throwaway store.
   */
  store?: Store;
  /** Where to write the derived `tools-metadata.yaml` view. */
  yamlPath?: string;
  approvalPolicy?: ApprovalPolicy;
  /**
   * Approve a `require_confirmation` tool. **When omitted, confirmations are
   * denied** (fail closed): a host opts in to auto-approval explicitly (the CLI
   * does so via `--yes`). Defaulting to approve silently ran tools a policy had
   * flagged for a human.
   */
  requestApproval?: (toolName: string) => boolean | Promise<boolean>;
  middleware?: Middleware[];
  sessionId?: string;
  workflowId?: string;
  /** Performs the actual MCP call. */
  invoke: ToolInvoker;
  /**
   * Candidate models for Adaptive MCP routing. Pass
   * `ModelCatalog.routingOptions()` so `model` recommendations reference the
   * models the agent can actually run.
   */
  routerModels?: ModelOption[];
  /** Per-tool / per-server cost budgets for the router. */
  routerBudget?: BudgetPolicy;
  /** Minimum invocations before the router trusts observed stats. */
  routerMinInvocations?: number;
  /** Called after each tool execution (e.g. to report to a governing server). */
  onExecuted?: (observation: ExecutionObservation) => void;
}

/** Configuration for the System One decision layer (`systemOneProvider`). */
export interface SystemOneProviderOptions {
  /** Ollama root URL. Defaults to `$OLLAMA_BASE_URL`, else localhost. */
  baseURL?: string;
  /** System One model. Defaults to `$SYSTEM1_MODEL`, else `tev1:0.8b`. */
  model?: string;
  /** Ignore answers below this confidence (default 0.5). */
  minConfidence?: number;
  /** Abort the decision call after this long (default 8000ms). */
  timeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Backend id for observability; defaults to `ollama:<model>`. */
  backendId?: string;
  /**
   * Provide a ready-made decision backend instead of the built-in local Ollama
   * one. This is the seam for the remote tier (`OpenAiSystemOneBackend`) or a
   * test double; when set, `baseURL`/`model`/`env` above are ignored (the
   * backend already carries its own connection settings) and only
   * `minConfidence`/`timeoutMs`/`onError` still apply.
   */
  backend?: DecisionBackend;
  /**
   * Compose several decision backends into one tiered backend
   * (`TieredSystemOneBackend`): tried in `tier` order (local first, remote
   * second), falling through to the next tier **only on errors** — a
   * low-confidence verdict is still the advisor's call to decline, never a
   * fallback trigger. The attempts share `timeoutMs` as one total budget
   * (default 8000ms), so failover cannot double decision latency, and the
   * chain is capped at **one fallback per decision call**: at most two
   * backends (construction throws on more).
   *
   * Takes precedence over `backend` when both are set. `lastDecisionSummary()`
   * then attributes the verdict to the tier that actually answered.
   */
  backends?: DecisionBackend[];
  /**
   * Called when a tier fails **and the next tier's attempt starts** — i.e. a
   * recovered fallback. Distinct from `onError`, which means every tier failed
   * and the provider declined; use this to count fallbacks.
   */
  onFallback?: (error: unknown, from: DecisionBackend, to: DecisionBackend) => void;
  /** Called when the decision backend fails (the provider then declines). */
  onError?: (error: unknown) => void;
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/**
 * A risk level read out of a server-published policy document. The document is
 * untrusted input, so an unrecognised value is ignored rather than stored.
 */
function asRiskLevel(value: unknown): RiskLevel | undefined {
  return typeof value === "string" && value in RISK_ORDER ? (value as RiskLevel) : undefined;
}

/** The higher of two risk levels; absent and unknown values simply lose. */
function maxRisk(...levels: Array<RiskLevel | undefined>): RiskLevel | undefined {
  return levels.reduce<RiskLevel | undefined>(
    (best, level) =>
      level !== undefined && (best === undefined || RISK_ORDER[level] > RISK_ORDER[best])
        ? level
        : best,
    undefined,
  );
}

/**
 * The agent's bridge into the Adaptive MCP adaptation loop.
 *
 * It owns an `AdaptiveRuntime` (telemetry → store → evaluation → derived view),
 * a `ThinClient` execution loop (approval gate + retry + middleware), and
 * execution-graph tracking, and exposes them as one `AgentExecutor`. This is the
 * class that makes all the `@adaptivemcp/*` libraries live inside the product.
 */
export class AgentRuntime implements AgentExecutor {
  readonly adaptive: AdaptiveRuntime;
  readonly graphTracking: GraphTrackingMiddleware;
  private readonly thinClient: ThinClient;
  private readonly resolver = new DecodingResolver();
  private readonly invoke: ToolInvoker;
  private approver: (toolName: string) => boolean | Promise<boolean>;
  /** Whether a host set an approver, so a denial can say why it happened. */
  private approverConfigured: boolean;
  /** Whether this runtime opened the store, and must therefore close it. */
  private readonly ownsStore: boolean;
  private readonly onExecuted?: (observation: ExecutionObservation) => void;
  private readonly warnedSignals = new Set<string>();
  /** Messages for the running turn's next step (see `queueMessage`). */
  private readonly pendingMessages: string[] = [];
  private readonly serverBudgets = new Map<string, number>();
  private lastDecoding?: ToolDecoding;
  private lastSystemOne?: SystemOneDecision;
  /** Which backend produced `lastSystemOne` (tier attribution, for `/decision`). */
  private lastSystemOneBackend?: string;

  constructor(options: AgentRuntimeOptions) {
    this.invoke = options.invoke;
    this.approver = options.requestApproval ?? (() => false);
    this.approverConfigured = options.requestApproval !== undefined;
    this.ownsStore = options.store === undefined;
    this.onExecuted = options.onExecuted;
    this.adaptive = new AdaptiveRuntime({
      store: options.store,
      dbPath: options.dbPath,
      yamlPath: options.yamlPath,
      middleware: options.middleware,
      enableGraph: true,
      routerModels: options.routerModels,
      routerBudget: options.routerBudget,
      routerMinInvocations: options.routerMinInvocations,
    });
    this.graphTracking = new GraphTrackingMiddleware(this.adaptive.memory, {
      sessionId: options.sessionId,
      workflowId: options.workflowId,
    });
    this.thinClient = new ThinClient({
      memory: this.adaptive.memory,
      gate: this.adaptive.approval,
      requestApproval: (toolName) => this.approver(toolName),
      middleware: options.middleware ?? [],
      graphTracking: this.graphTracking,
      // Real servers often signal logical failures in-band (a JSON envelope with
      // `status: "error"`) rather than via MCP `isError`. Classify those as
      // failures so learned failure rates are not corrupted by false successes.
      classifyResult: envelopeClassifier(),
    });
  }

  /** Replace the approval prompt (e.g. wire it to the REPL's y/n prompt). */
  setRequestApproval(requestApproval: (toolName: string) => boolean | Promise<boolean>): void {
    this.approver = requestApproval;
    this.approverConfigured = true;
  }

  /** Execute one tool call through approval → middleware → retry → telemetry → view. */
  async execute(
    call: ToolCall,
    spec: ToolSpec,
    context?: ExecutionContext,
  ): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    let recorded: McpToolResult = { ok: true };

    const handler: ToolHandler = async (input, context) => {
      // `context` carries middleware-resolved credentials (OAuth); forwards them
      // so the transport can put them on the wire.
      const result = await this.invoke(spec.name, input, spec.serverName, context);
      recorded = result;
      return { ok: result.ok, error: result.error, output: result.output };
    };

    const outcome = await this.thinClient.run(
      spec.name,
      handler,
      call.input,
      (ok, error, output) => {
        recorded = { ok, error, output };
      },
      spec.serverName,
    );

    if (!outcome.executed) {
      // Say *why* when the denial came from nobody being asked: otherwise
      // "blocked (require_confirmation)" reads as the user having declined.
      const reason =
        outcome.decision === "require_confirmation" && !this.approverConfigured
          ? " — no approver is configured, so it is denied; confirm interactively or opt in to auto-approval"
          : "";
      return {
        ok: false,
        error: `blocked (${outcome.decision})${reason}`,
        decision: outcome.decision,
      };
    }

    const durationMs = Date.now() - startedAt;
    this.adaptive.observeCompleted({
      toolName: spec.name,
      serverName: spec.serverName,
      durationMs,
      status: recorded.ok ? "completed" : "failed",
      model: context?.model,
      cost: context?.cost,
      attempts: outcome.attempts,
      decoding: this.lastDecoding,
      usage: context?.usage,
      output: recorded.output,
      error: recorded.error ? { message: recorded.error } : undefined,
    });

    this.onExecuted?.({
      toolName: spec.name,
      serverName: spec.serverName,
      status: recorded.ok ? "completed" : "failed",
      durationMs,
      model: context?.model,
      cost: context?.cost,
    });

    return {
      ok: recorded.ok,
      error: recorded.error,
      output: recorded.output,
      decision: outcome.decision,
    };
  }

  /**
   * Run one model step's batch of tool calls under a single execution-graph
   * root, so the turn's calls form one DAG rather than one disconnected root per
   * call. `runAgent` calls this when present.
   */
  runTurn<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.graphTracking.runTurn(label, fn);
  }

  /**
   * Seed static risk from the servers' standard MCP tool annotations
   * (`destructiveHint`/`readOnlyHint`/`openWorldHint`) so the approval gate can
   * act before anything is learned — the spec projects server `risk` onto these
   * core hints. Advisory: an existing nonzero risk is never overridden.
   */
  seedToolAnnotations(specs: ToolSpec[], options: { defaultRisk?: RiskLevel } = {}): void {
    for (const spec of specs) {
      if (this.adaptive.memory.getTool(spec.name, spec.serverName)?.annotation.risk) continue;
      // Prefer the protocol's own (untrusted) annotations; fall back to a local
      // default so a server that ships none (many third-party servers) still
      // gets a conservative, host-owned seed rather than no signal at all.
      const risk = riskFromAnnotations(spec.annotations) ?? options.defaultRisk;
      if (!risk) continue;
      this.adaptive.memory.setAnnotation({
        toolName: spec.name,
        serverName: spec.serverName,
        risk,
      });
    }
  }

  /**
   * Apply a server-governed `dev.adaptivemcp/tools-metadata` document: seed the
   * store's static annotation (risk/owner/tags/description) where absent, treat
   * `require_approval` as high risk (so the gate requires confirmation), and
   * remember per-tool budgets. Server policy is a floor — an existing (human or
   * learned) value is never overwritten.
   */
  applyServerMetadata(
    doc: ServerToolsMetadata,
    options: { serverName?: string } = {},
  ): { annotations: number; approvals: number; budgets: number } {
    const applied = { annotations: 0, approvals: 0, budgets: 0 };
    for (const tool of doc.tools ?? []) {
      const existing = this.adaptive.memory.getTool(tool.name, options.serverName);
      const requireApproval = tool.annotation?.require_approval === true;
      const published = asRiskLevel(tool.annotation?.risk);
      // A suggestion to confirm only means something if the risk agrees, so a
      // contradictory pair (`medium` + `require_approval`) must not *lower* the
      // implied gate: hosts gate on risk, and server policy is a floor.
      const risk = requireApproval ? maxRisk(published, "high") : published;

      const patch: Annotation = { toolName: tool.name, serverName: options.serverName };
      let changed = false;
      if (risk && !existing?.annotation.risk) {
        patch.risk = risk;
        changed = true;
      }
      if (tool.annotation?.owner && !existing?.annotation.owner) {
        patch.owner = tool.annotation.owner;
        changed = true;
      }
      if (tool.annotation?.tags && !existing?.annotation.tags) {
        patch.tags = tool.annotation.tags;
        changed = true;
      }
      if (tool.annotation?.description && !existing?.annotation.description) {
        patch.description = tool.annotation.description;
        changed = true;
      }
      if (changed) {
        this.adaptive.memory.setAnnotation(patch);
        applied.annotations += 1;
      }
      if (requireApproval) applied.approvals += 1;
      if (tool.annotation?.budget) {
        this.serverBudgets.set(tool.name, tool.annotation.budget.limit);
        applied.budgets += 1;
      }
    }
    return applied;
  }

  /** The server-governed policy currently in effect (for `/policy`). */
  serverPolicySummary(): string {
    const lines: string[] = [];
    for (const record of this.adaptive.memory.allTools()) {
      const parts: string[] = [];
      if (record.annotation.owner) parts.push(`owner ${record.annotation.owner}`);
      if (record.annotation.risk) parts.push(`risk ${record.annotation.risk}`);
      if (record.annotation.tags?.length) parts.push(`tags ${record.annotation.tags.join(",")}`);
      const limit = this.serverBudgets.get(record.toolName);
      if (limit !== undefined) parts.push(`budget ${limit}`);
      if (parts.length > 0) lines.push(`  ${record.toolName}: ${parts.join(", ")}`);
    }
    return lines.length > 0 ? lines.join("\n") : "(no server policy applied)";
  }

  /** Run the heavier cross-tool passes (routing + orchestration). */
  runAdaptation(): void {
    this.adaptive.router.routeAll();
    this.adaptive.orchestrator.planAll();
  }

  /** Evaluate every workflow with graph data (session/pattern learning). */
  evaluateWorkflows(): void {
    this.adaptive.evaluator.evaluateAllWorkflows();
  }

  /** The current execution-graph session id. */
  sessionId(): string {
    return this.graphTracking.getSessionId();
  }

  /**
   * A compact text tree of this session's execution graph: each turn root
   * (`agent_turn_<n>`) with its tool calls indented beneath it. Powers the
   * REPL's `/graph` command.
   */
  graphView(): string {
    const memory = this.adaptive.memory;
    const roots = memory.getRootNodes?.(this.sessionId()) ?? [];
    if (roots.length === 0) return "(no graph yet)";
    const lines: string[] = [];
    const render = (id: string, depth: number): void => {
      const node = memory.getExecutionNode?.(id);
      if (!node) return;
      const mark = node.status === "completed" ? "✓" : node.status === "failed" ? "✗" : "…";
      const duration = node.durationMs !== undefined ? ` ${node.durationMs}ms` : "";
      lines.push(`${"  ".repeat(depth)}${mark} ${node.toolName}${duration}`);
      for (const childId of node.childrenIds) render(childId, depth + 1);
    };
    for (const root of roots) render(root.id, 0);
    return lines.join("\n");
  }

  /**
   * A compact summary of what Adaptive MCP has learned about the tools, for
   * injecting into the model's context (progressive disclosure of evaluation
   * output). Returns `""` when nothing has been observed yet.
   */
  learnedContext(options: { maxTools?: number } = {}): string {
    const records = this.adaptive.memory
      .allTools()
      .filter((record) => record.stats.invocations > 0)
      .sort((a, b) => b.stats.failureRate - a.stats.failureRate)
      .slice(0, options.maxTools ?? 8);
    if (records.length === 0) return "";

    const lines = records.map((record) => {
      const failed = Math.round(record.stats.failureRate * 100);
      const avg = Math.round(record.stats.avgDurationMs ?? 0);
      const flags: string[] = [];
      if (failed >= 20) flags.push("flaky");
      if (record.annotation.risk) flags.push(`risk ${record.annotation.risk}`);
      if (record.insights[0]) flags.push(record.insights[0].key);
      const cooccurrence = record.insights.find((insight) => insight.key === "tool_cooccurrence")
        ?.value as Array<{ tool?: string }> | undefined;
      if (cooccurrence?.[0]?.tool) flags.push(`often with ${cooccurrence[0].tool}`);
      const retry = this.retryPolicyFor(record.toolName, record.serverName);
      if (retry?.enabled && retry.maxAttempts > 1) flags.push(`retry x${retry.maxAttempts}`);
      const model = record.recommendations.find((rec) => rec.type === "model")?.payload as
        { model?: string } | undefined;
      const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      const modelHint = model?.model ? `; suggested model ${model.model}` : "";
      return `- ${record.toolName}: ${record.stats.invocations} calls, ${failed}% failed, avg ${avg}ms${suffix}${modelHint}`;
    });
    const procedure = this.learnedProcedure();
    const learned = ["Learned from observed tool usage:", ...lines];
    if (procedure) learned.push(`Observed procedure: ${procedure}`);
    return learned.join("\n");
  }

  /**
   * A repeated tool sequence Adaptive MCP has learned for this workflow, if any
   * (planning hint from graph-analysis `detectCommonPatterns`).
   */
  learnedProcedure(): string | undefined {
    const workflowId = this.graphTracking.getWorkflowId();
    if (!workflowId) return undefined;
    const analyzer = new GraphAnalyzer(this.adaptive.memory as MemoryStore);
    const patterns = analyzer.detectCommonPatterns(workflowId, 3);
    if (patterns.length === 0) return undefined;
    return [...patterns].sort((a, b) => b.frequency - a.frequency)[0]?.pattern;
  }

  /**
   * Current execution-graph warnings for this session (failure cascades and
   * anomalies), via `GraphAnalyzer`. Empty when nothing is wrong.
   */
  graphSignals(): string[] {
    const sessionId = this.sessionId();
    const analyzer = new GraphAnalyzer(this.adaptive.memory as MemoryStore);
    const signals: string[] = [];
    for (const cascade of analyzer.getFailureCascade(sessionId)) {
      signals.push(
        `failure cascade from ${cascade.rootCause.toolName} affecting ${cascade.blastRadius} node(s)`,
      );
    }
    for (const anomaly of analyzer.detectAnomalies(sessionId)) {
      signals.push(`${anomaly.type}: ${anomaly.description}`);
    }
    return signals;
  }

  /**
   * Post-step guardrail for `runAgent`: surface each new graph signal once as a
   * steering message. Returns `undefined` when there is nothing new.
   *
   * Queued messages come first: they are produced by the run itself (a delegated
   * child finishing), so they are news the model is waiting on, ahead of an
   * advisory graph warning.
   */
  review(): string | undefined {
    const queued = this.pendingMessages.shift();
    if (queued !== undefined) return queued;
    const fresh = this.graphSignals().filter((signal) => !this.warnedSignals.has(signal));
    if (fresh.length === 0) return undefined;
    for (const signal of fresh) this.warnedSignals.add(signal);
    return `Execution-graph warning: ${fresh.join("; ")}. Consider a different approach or stopping.`;
  }

  /**
   * Queue a message for the running turn's next step. Used by delegation: a
   * background child announces its result this way, so the parent learns it
   * without polling and it arrives exactly like a guardrail.
   */
  queueMessage(message: string): void {
    this.pendingMessages.push(message);
  }

  /** Take the messages that were queued but never delivered (the run ended first). */
  drainQueuedMessages(): string[] {
    return this.pendingMessages.splice(0, this.pendingMessages.length);
  }

  /** The learned retry policy for a tool, if the store has a workflow recommendation. */
  private retryPolicyFor(toolName: string, serverName?: string): RetryPolicy | undefined {
    const payload = this.adaptive.memory
      .getTool(toolName, serverName)
      ?.recommendations.find(
        (rec) =>
          rec.type === "workflow" &&
          rec.payload != null &&
          typeof rec.payload === "object" &&
          "retry" in rec.payload,
      )?.payload;
    return payload && typeof payload === "object" && "retry" in payload
      ? (payload as { retry: RetryPolicy }).retry
      : undefined;
  }

  /** A short, human-readable reason for an approval prompt on a tool. */
  approvalReason(toolName: string, options: { serverName?: string } = {}): string | undefined {
    const record = this.adaptive.memory.getTool(toolName, options.serverName);
    if (!record) return undefined;
    const parts: string[] = [];
    if (record.annotation.risk) parts.push(`risk: ${record.annotation.risk}`);
    if (record.stats.invocations > 0) {
      parts.push(
        `${Math.round(record.stats.failureRate * 100)}% fail over ${record.stats.invocations} calls`,
      );
    }
    const approval = record.recommendations.find((rec) => rec.type === "approval");
    if (approval?.rationale) parts.push(approval.rationale);
    return parts.length > 0 ? parts.join("; ") : undefined;
  }

  /** The most recent headroom compression hash, if any (for `/retrieve`). */
  lastCompressionHash(): string | undefined {
    const view = this.adaptive.middleware.contributeView() as Record<
      string,
      { hash?: string } | undefined
    >;
    return view["headroom"]?.hash;
  }

  /**
   * Pure, computed-on-read decoding report over accumulated telemetry
   * (ROADMAP 8e), grouped by (tool, profile, model, resolverVersion).
   */
  decodingReport(options: { minSamples?: number } = {}): string {
    const analyzer = new DecodingAnalyzer({ minSamples: options.minSamples ?? 5 });
    // Prefer the durable metric cells; fall back to the in-process event log.
    const cells = (this.adaptive.memory.metricCells?.() ?? []).filter(
      (cell) => cell.dimensions.decodingProfile !== undefined,
    );
    const groups =
      cells.length > 0
        ? analyzer.analyzeCells(cells)
        : analyzer.analyze(this.adaptive.telemetry.getStore().all());
    if (groups.length === 0) return "(no decoding telemetry yet)";
    return groups
      .map((group) => {
        const model = group.model ? ` @${group.model}` : "";
        const tokens =
          group.avgInputTokens || group.avgOutputTokens
            ? `, ~${group.avgInputTokens}/${group.avgOutputTokens} tok`
            : "";
        return (
          `  ${group.toolName}${model} [${group.profile} → ${group.suggestedProfile}] ` +
          `${group.invocations} calls, ${Math.round(group.failureRate * 100)}% failed, ` +
          `avg ${group.avgDurationMs}ms${tokens}`
        );
      })
      .join("\n");
  }

  /**
   * Recent-vs-lifetime drift per tool, from the durable metric cells
   * (`computeMetricDrift`). Powers the REPL's `/drift` command.
   */
  metricDriftReport(options: { minRecentInvocations?: number } = {}): string {
    const drifts = computeMetricDrift(this.adaptive.memory.metricCells?.() ?? [], options);
    if (drifts.length === 0) return "(no drift data yet)";
    return drifts
      .map((drift) => {
        const failure = `${drift.failureRateDelta >= 0 ? "+" : ""}${(drift.failureRateDelta * 100).toFixed(1)}pp`;
        const latency = `${drift.latencyDeltaMs >= 0 ? "+" : ""}${drift.latencyDeltaMs}ms`;
        return `  ${drift.toolName} [${drift.window}] ${drift.direction}: failure ${failure}, latency ${latency}`;
      })
      .join("\n");
  }

  /** Recorded cost per tool (from the store) for the `/cost` command. */
  costSummary(): string {
    const records = this.adaptive.memory
      .allTools()
      .filter((record) => record.stats.invocations > 0)
      .sort((a, b) => b.stats.totalCost - a.stats.totalCost);
    if (records.length === 0) return "(no usage yet)";
    const total = records.reduce((sum, record) => sum + record.stats.totalCost, 0);
    const calls = records.reduce((sum, record) => sum + record.stats.invocations, 0);
    const lines = records.map(
      (record) =>
        `  ${record.toolName}: ${record.stats.invocations} calls, $${record.stats.totalCost.toFixed(6)}`,
    );
    return [`total: $${total.toFixed(6)} over ${calls} tool calls`, ...lines].join("\n");
  }

  /** The derived `tools-metadata` view (YAML by default). */
  toolsMetadata(mimeType?: string): string {
    return this.adaptive.extension.resourceText(mimeType);
  }

  /**
   * Advisory decoding suggestion for the next completion involving a tool,
   * using the `DecodingAdvisor`/`DecodingResolver` pair. The agent owns its LLM
   * calls, so it can actually apply the result.
   */
  suggestDecoding(
    toolName: string,
    capabilities: ModelCapabilities,
    options: { serverName?: string; intent?: DecodingProfileId } = {},
  ): DecodingRecommendation | undefined {
    const advisor = new DecodingAdvisor({ memory: this.adaptive.memory });
    const recommendation = advisor.advise(toolName, options.serverName, options.intent);
    if (!recommendation) return undefined;
    return toDecodingRecommendation(recommendation, this.resolver, capabilities);
  }

  /**
   * Build a `DecodingProvider` for `runAgent` that closes the adaptation loop:
   * before each completion it selects a tool with a learned decoding signal and
   * applies that tool's resolved profile to the next model step. Without
   * `toolName`, it chooses the known tool with the highest observed failure
   * rate — the one most in need of deterministic decoding.
   *
   * Advisory: the host decides to opt in by passing the provider to `runAgent`.
   */
  decodingProvider(
    capabilities: ModelCapabilities,
    options: { toolName?: string; serverName?: string; intent?: DecodingProfileId } = {},
  ): DecodingProvider {
    return () => {
      const target = options.toolName
        ? { toolName: options.toolName, serverName: options.serverName }
        : this.mostSignificantTool();
      if (!target) return undefined;
      const recommendation = this.suggestDecoding(target.toolName, capabilities, {
        serverName: target.serverName,
        intent: options.intent,
      });
      // Remember what we applied so the telemetry recorded for this step's tool
      // calls carries the resolved decoding (ROADMAP 8d).
      this.lastDecoding = recommendation
        ? {
            profile: recommendation.profile.id,
            resolverVersion: recommendation.resolverVersion,
            resolved: recommendation.resolved,
          }
        : undefined;
      return recommendation ? toChatParams(recommendation) : undefined;
    };
  }

  /**
   * Build a `DecisionProvider` for `runAgent` backed by a fast, local System One
   * model (Ollama `/v1/systemone`). One cheap call turns the learned tool
   * metadata and the user's request into a model / tool-intent / decoding
   * decision, which the loop applies before the slower chat model runs. When the
   * decision layer declines (backend down, low confidence), the loop falls back
   * to `selectModel`/`decoding`, so this stays purely additive.
   *
   * Today two backends are wired behind the same seam: the local Ollama backend
   * (`tev1:0.8b` by default) and a remote OpenAI-compatible one
   * (`OpenAiSystemOneBackend`). Pass `options.backend` to inject either, or a
   * test double.
   */
  systemOneProvider(
    catalog: ModelCatalog,
    options: SystemOneProviderOptions = {},
  ): DecisionProvider {
    const env = options.env ?? process.env;
    const backend: DecisionBackend =
      options.backends !== undefined
        ? new TieredSystemOneBackend(options.backends, {
            budgetMs: options.timeoutMs,
            onFallback: options.onFallback,
          })
        : (options.backend ??
          localSystemOneBackend({
            model: options.model,
            baseURL: options.baseURL,
            id: options.backendId,
            timeoutMs: options.timeoutMs,
            fetchImpl: options.fetchImpl,
            env,
          }));
    const advisor = new SystemOneAdvisor({
      backend,
      minConfidence: options.minConfidence,
      onError: options.onError,
    });

    return async (request) => {
      const message =
        [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const decision = await advisor.decide({
        message,
        tools: this.decisionToolInfos(),
        models: catalog.list().map((integration) => ({
          id: integration.id,
          label: integration.label,
          costWeight: integration.costWeight,
          latencyWeight: integration.latencyWeight,
        })),
      });
      if (!decision) return undefined;
      this.lastSystemOne = decision;
      // Attribute the verdict to the tier that actually answered (the tiered
      // backend names the answering tier + any fallback; a plain backend is
      // just its id), so `/decision` and the summary make failover visible.
      this.lastSystemOneBackend =
        backend instanceof TieredSystemOneBackend ? backend.attribution() : backend.id;

      const model = decision.modelId ? catalog.get(decision.modelId) : undefined;
      const capabilities = (model ?? catalog.defaultModel()).capabilities ?? AI_SDK_CAPABILITIES;
      const decoded = decision.decodingProfile
        ? resolvedToChatParams(
            this.resolver.resolve({ id: decision.decodingProfile }, capabilities),
          )
        : undefined;
      const tools = decision.toolNames
        ? request.tools.filter((spec) => decision.toolNames!.includes(spec.name))
        : undefined;

      const applied: AgentDecision = { rationale: decision.rationale };
      if (model) applied.model = model;
      if (tools) applied.tools = tools;
      if (decoded) applied.decoding = decoded;
      return applied;
    };
  }

  /** A compact summary of the last System One decision (for the REPL). */
  lastDecisionSummary(): string {
    const decision = this.lastSystemOne;
    if (!decision) return "(no System One decision yet)";
    const parts = [`confidence ${decision.confidence.toFixed(2)}`];
    if (decision.modelId) parts.push(`model ${decision.modelId}`);
    if (decision.toolNames) {
      parts.push(
        decision.toolNames.length > 0 ? `tools ${decision.toolNames.join(", ")}` : "tools none",
      );
    }
    if (decision.decodingProfile) parts.push(`decoding ${decision.decodingProfile}`);
    if (this.lastSystemOneBackend) parts.push(`backend ${this.lastSystemOneBackend}`);
    return `${parts.join(", ")}\n  ${decision.rationale}`;
  }

  /** Tool metadata as a compact list for the System One decision state. */
  private decisionToolInfos(): DecisionToolInfo[] {
    return this.adaptive.memory.allTools().map((record) => ({
      toolName: record.toolName,
      serverName: record.serverName,
      description: record.annotation.description,
      risk: record.annotation.risk,
      invocations: record.stats.invocations,
      failureRate: record.stats.failureRate,
      avgDurationMs: record.stats.avgDurationMs ?? undefined,
    }));
  }

  /**
   * Adaptive MCP's recommended model id for a tool, from the `Router`'s learned
   * `model` recommendation. Re-runs the router for this tool first so the answer
   * reflects the latest stats; returns `undefined` when there is not enough
   * signal (the caller falls back to a default).
   */
  suggestModel(toolName: string, options: { serverName?: string } = {}): string | undefined {
    this.adaptive.router.routeTool(toolName, options.serverName);
    const payload = this.adaptive.memory
      .getTool(toolName, options.serverName)
      ?.recommendations.find((recommendation) => recommendation.type === "model")?.payload;
    if (payload && typeof payload === "object" && "model" in payload) {
      const model = (payload as { model?: unknown }).model;
      return typeof model === "string" ? model : undefined;
    }
    return undefined;
  }

  /**
   * Build a `ModelSelector` for `runAgent`: each step, Adaptive MCP picks the
   * model it has learned suits the governing tool (highest observed failure
   * rate, or a named tool). Returns `undefined` when nothing is learned yet, so
   * the loop keeps its default model.
   */
  modelProvider(
    catalog: ModelCatalog,
    options: { toolName?: string; serverName?: string } = {},
  ): ModelSelector {
    return () => {
      const target = options.toolName
        ? { toolName: options.toolName, serverName: options.serverName }
        : this.mostSignificantTool();
      if (!target) return undefined;
      const id = this.suggestModel(target.toolName, { serverName: target.serverName });
      return id ? catalog.get(id) : undefined;
    };
  }

  /** The known tool with the highest observed failure rate (ties keep the first). */
  private mostSignificantTool(): ToolRecord | undefined {
    let best: ToolRecord | undefined;
    for (const record of this.adaptive.memory.allTools()) {
      if (record.stats.invocations === 0) continue;
      if (!best || record.stats.failureRate > best.stats.failureRate) best = record;
    }
    return best;
  }

  /**
   * Release resources. A runtime built on a store it was handed (`store`) does
   * **not** own it: closing it would close the caller's memory — precisely what a
   * delegated child must not do to its parent (`AdaptiveRuntime.close()` closes
   * the store unconditionally, so the ownership decision has to live here).
   */
  close(): void {
    if (this.ownsStore) this.adaptive.close();
  }
}

/** Map a resolved decoding recommendation onto the loop's `ChatParams`. */
function toChatParams(recommendation: DecodingRecommendation): ChatParams | undefined {
  return resolvedToChatParams(recommendation.resolved);
}

/** Map resolved decoding settings onto the loop's `ChatParams`. */
function resolvedToChatParams(resolved: ResolvedDecodingSettings): ChatParams | undefined {
  const params: ChatParams = {};
  if (resolved.temperature !== undefined) params.temperature = resolved.temperature;
  if (resolved.topP !== undefined) params.topP = resolved.topP;
  if (resolved.topK !== undefined) params.topK = resolved.topK;
  if (resolved.minP !== undefined) params.minP = resolved.minP;
  if (resolved.presencePenalty !== undefined) params.presencePenalty = resolved.presencePenalty;
  if (resolved.frequencyPenalty !== undefined) params.frequencyPenalty = resolved.frequencyPenalty;
  if (resolved.repetitionPenalty !== undefined)
    params.repetitionPenalty = resolved.repetitionPenalty;
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Derive static risk from standard MCP tool annotations (advisory). */
function riskFromAnnotations(
  annotations: Record<string, unknown> | undefined,
): "high" | "medium" | "low" | undefined {
  if (!annotations) return undefined;
  if (annotations.destructiveHint === true) return "high";
  if (annotations.readOnlyHint === true) return "low";
  if (annotations.openWorldHint === true) return "medium";
  return undefined;
}
