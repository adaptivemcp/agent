import { AdaptiveRuntime } from "@adaptivemcp/runtime";
import { GraphTrackingMiddleware, ThinClient, type ToolHandler } from "@adaptivemcp/thin-client";
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
  RiskLevel,
  ToolDecoding,
  ToolRecord,
} from "@adaptivemcp/spec";
import type {
  AgentExecutor,
  ChatParams,
  DecodingProvider,
  ExecutionContext,
  ModelSelector,
  ToolCall,
  ToolExecutionResult,
  ToolSpec,
} from "./types.js";
import type { ModelCatalog } from "./models/catalog.js";
import type { McpToolResult } from "./mcp/toolset.js";

/** Performs the raw MCP tool call (transport lives behind this seam). */
export type ToolInvoker = (toolName: string, input: unknown, serverName?: string) => Promise<McpToolResult>;

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
  /** Where to write the derived `tools-metadata.yaml` view. */
  yamlPath?: string;
  approvalPolicy?: ApprovalPolicy;
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
  private readonly onExecuted?: (observation: ExecutionObservation) => void;
  private readonly warnedSignals = new Set<string>();
  private readonly serverBudgets = new Map<string, number>();
  private lastDecoding?: ToolDecoding;

  constructor(options: AgentRuntimeOptions) {
    this.invoke = options.invoke;
    this.approver = options.requestApproval ?? (() => true);
    this.onExecuted = options.onExecuted;
    this.adaptive = new AdaptiveRuntime({
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
    });
  }

  /** Replace the approval prompt (e.g. wire it to the REPL's y/n prompt). */
  setRequestApproval(requestApproval: (toolName: string) => boolean | Promise<boolean>): void {
    this.approver = requestApproval;
  }

  /** Execute one tool call through approval → middleware → retry → telemetry → view. */
  async execute(call: ToolCall, spec: ToolSpec, context?: ExecutionContext): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    let recorded: McpToolResult = { ok: true };

    const handler: ToolHandler = async (input) => {
      const result = await this.invoke(spec.name, input, spec.serverName);
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
      return { ok: false, error: `blocked (${outcome.decision})`, decision: outcome.decision };
    }

    const durationMs = Date.now() - startedAt;
    this.adaptive.observeCompleted({
      toolName: spec.name,
      serverName: spec.serverName,
      durationMs,
      status: recorded.ok ? "completed" : "failed",
      model: context?.model,
      cost: context?.cost,
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

    return { ok: recorded.ok, error: recorded.error, output: recorded.output, decision: outcome.decision };
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
  seedToolAnnotations(specs: ToolSpec[]): void {
    for (const spec of specs) {
      const risk = riskFromAnnotations(spec.annotations);
      if (!risk) continue;
      if (this.adaptive.memory.getTool(spec.name, spec.serverName)?.annotation.risk) continue;
      this.adaptive.memory.setAnnotation({ toolName: spec.name, serverName: spec.serverName, risk });
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
      const risk =
        (tool.annotation?.risk as RiskLevel | undefined) ?? (requireApproval ? "high" : undefined);

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
      const retry = this.retryPolicyFor(record.toolName, record.serverName);
      if (retry?.enabled && retry.maxAttempts > 1) flags.push(`retry x${retry.maxAttempts}`);
      const model = record.recommendations.find((rec) => rec.type === "model")?.payload as
        | { model?: string }
        | undefined;
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
   */
  review(): string | undefined {
    const fresh = this.graphSignals().filter((signal) => !this.warnedSignals.has(signal));
    if (fresh.length === 0) return undefined;
    for (const signal of fresh) this.warnedSignals.add(signal);
    return `Execution-graph warning: ${fresh.join("; ")}. Consider a different approach or stopping.`;
  }

  /** The learned retry policy for a tool, if the store has a workflow recommendation. */
  private retryPolicyFor(toolName: string, serverName?: string): RetryPolicy | undefined {
    const payload = this.adaptive.memory
      .getTool(toolName, serverName)
      ?.recommendations.find(
        (rec) => rec.type === "workflow" && rec.payload != null && typeof rec.payload === "object" && "retry" in rec.payload,
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
      (record) => `  ${record.toolName}: ${record.stats.invocations} calls, $${record.stats.totalCost.toFixed(6)}`,
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

  close(): void {
    this.adaptive.close();
  }
}

/** Map a resolved decoding recommendation onto the loop's `ChatParams`. */
function toChatParams(recommendation: DecodingRecommendation): ChatParams | undefined {
  const { resolved } = recommendation;
  const params: ChatParams = {};
  if (resolved.temperature !== undefined) params.temperature = resolved.temperature;
  if (resolved.topP !== undefined) params.topP = resolved.topP;
  if (resolved.topK !== undefined) params.topK = resolved.topK;
  if (resolved.minP !== undefined) params.minP = resolved.minP;
  if (resolved.presencePenalty !== undefined) params.presencePenalty = resolved.presencePenalty;
  if (resolved.frequencyPenalty !== undefined) params.frequencyPenalty = resolved.frequencyPenalty;
  if (resolved.repetitionPenalty !== undefined) params.repetitionPenalty = resolved.repetitionPenalty;
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
