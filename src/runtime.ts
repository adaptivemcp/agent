import { AdaptiveRuntime } from "@adaptivemcp/runtime";
import { GraphTrackingMiddleware, ThinClient, type ToolHandler } from "@adaptivemcp/thin-client";
import type { Middleware } from "@adaptivemcp/middleware";
import type { ApprovalPolicy } from "@adaptivemcp/approval";
import {
  DecodingAdvisor,
  DecodingResolver,
  toDecodingRecommendation,
  type DecodingProfileId,
} from "@adaptivemcp/routing";
import type { DecodingRecommendation, ModelCapabilities, ToolRecord } from "@adaptivemcp/spec";
import type { AgentExecutor, ChatParams, DecodingProvider, ToolCall, ToolExecutionResult, ToolSpec } from "./types.js";
import type { McpToolResult } from "./mcp/toolset.js";

/** Performs the raw MCP tool call (transport lives behind this seam). */
export type ToolInvoker = (toolName: string, input: unknown, serverName?: string) => Promise<McpToolResult>;

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

  constructor(options: AgentRuntimeOptions) {
    this.invoke = options.invoke;
    this.adaptive = new AdaptiveRuntime({
      dbPath: options.dbPath,
      yamlPath: options.yamlPath,
      middleware: options.middleware,
      enableGraph: true,
    });
    this.graphTracking = new GraphTrackingMiddleware(this.adaptive.memory, {
      sessionId: options.sessionId,
      workflowId: options.workflowId,
    });
    this.thinClient = new ThinClient({
      memory: this.adaptive.memory,
      gate: this.adaptive.approval,
      requestApproval: options.requestApproval ?? (() => true),
      middleware: options.middleware ?? [],
      graphTracking: this.graphTracking,
    });
  }

  /** Execute one tool call through approval → middleware → retry → telemetry → view. */
  async execute(call: ToolCall, spec: ToolSpec): Promise<ToolExecutionResult> {
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
      output: recorded.output,
      error: recorded.error ? { message: recorded.error } : undefined,
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
      return recommendation ? toChatParams(recommendation) : undefined;
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
