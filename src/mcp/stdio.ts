import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolSpec } from "../types.js";
import type { McpToolResult, Toolset } from "./toolset.js";

export interface StdioToolsetOptions {
  /** Display name for this server (used for namespacing / telemetry). */
  serverName: string;
  command: string;
  args?: string[];
  /** Extra environment variables merged over `process.env`. */
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * A real MCP client over stdio, built on the official SDK. One instance owns one
 * server connection and its lifecycle.
 */
export class StdioToolset implements Toolset {
  private client: Client | undefined;

  constructor(readonly serverName: string, private readonly options: StdioToolsetOptions) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, this.options.env);

    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args ?? [],
      env,
      cwd: this.options.cwd,
    });
    const client = new Client({ name: "adaptivemcp-agent", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async listTools(): Promise<ToolSpec[]> {
    const client = await this.connect();
    const { tools } = await client.listTools();
    return tools.map((tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      serverName: this.serverName,
    }));
  }

  async callTool(name: string, input: unknown): Promise<McpToolResult> {
    const client = await this.connect();
    // `callTool` returns a union that includes task-augmented results without
    // `content`; this client does not use tasks, so narrow to the standard shape.
    const result = (await client.callTool({
      name,
      arguments: (input ?? {}) as Record<string, unknown>,
    })) as unknown as CallToolResult;
    const output = extractOutput(result);
    if (result.isError) {
      return { ok: false, output, error: typeof output === "string" ? output : "tool returned an error" };
    }
    return { ok: true, output };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}

/** Prefer `structuredContent`; otherwise join text content parts. */
function extractOutput(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text);
  if (texts.length === 0) return undefined;
  if (texts.length === 1) return texts[0];
  return texts;
}
