import type { ToolSpec } from "../types.js";

export interface McpToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

/**
 * The tool seam. A toolset exposes tools to the agent and executes calls.
 * Implemented by the stdio MCP client (`StdioToolset`) and by an in-memory
 * toolset used in tests and the offline demo.
 */
export interface Toolset {
  readonly serverName: string;
  listTools(): Promise<ToolSpec[]>;
  callTool(name: string, input: unknown): Promise<McpToolResult>;
  close(): Promise<void>;
}

export interface InMemoryTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  handler: (input: unknown) => unknown | Promise<unknown>;
}

/** An in-process toolset: no transport, for tests and the offline demo. */
export class InMemoryToolset implements Toolset {
  constructor(
    readonly serverName: string,
    private readonly tools: InMemoryTool[],
  ) {}

  async listTools(): Promise<ToolSpec[]> {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      serverName: this.serverName,
      annotations: tool.annotations,
    }));
  }

  async callTool(name: string, input: unknown): Promise<McpToolResult> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) return { ok: false, error: `unknown tool: ${name}` };
    try {
      return { ok: true, output: await tool.handler(input) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

/**
 * Combine several toolsets into one flat tool list. Tool names are namespaced as
 * `<server>_<tool>` when `namespaced` (default) to avoid collisions across
 * servers, mirroring how hosts expose multiple MCP servers to a model.
 */
export class AggregateToolset implements Toolset {
  readonly serverName = "aggregate";
  private route = new Map<string, { toolset: Toolset; originalName: string }>();

  constructor(
    private readonly toolsets: Toolset[],
    private readonly namespaced = true,
  ) {}

  async listTools(): Promise<ToolSpec[]> {
    const specs: ToolSpec[] = [];
    this.route.clear();
    for (const toolset of this.toolsets) {
      for (const spec of await toolset.listTools()) {
        const name = this.namespaced ? `${sanitize(toolset.serverName)}_${sanitize(spec.name)}` : spec.name;
        this.route.set(name, { toolset, originalName: spec.name });
        specs.push({ ...spec, name, serverName: toolset.serverName });
      }
    }
    return specs;
  }

  async callTool(name: string, input: unknown): Promise<McpToolResult> {
    const entry = this.route.get(name);
    if (!entry) return { ok: false, error: `unknown tool: ${name}` };
    return entry.toolset.callTool(entry.originalName, input);
  }

  async close(): Promise<void> {
    await Promise.all(this.toolsets.map((toolset) => toolset.close()));
  }
}

/** Model tool names must be simple identifiers; MCP names may contain `.`/`-`. */
export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
