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
import type { DecodingRecommendation, ModelCapabilities } from "@adaptivemcp/spec";
import type { AgentExecutor, ToolCall, ToolExecutionResult, ToolSpec } from "./types.js";
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

  close(): void {
    this.adaptive.close();
  }
}
