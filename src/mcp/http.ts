import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS_METADATA_EXTENSION } from "@adaptivemcp/spec";
import type { ToolSpec } from "../types.js";
import { extractOutput } from "./stdio.js";
import type { McpToolResult, ResourceToolset, ToolCallContext } from "./toolset.js";

export interface HttpToolsetOptions {
  serverName: string;
  /** Streamable HTTP endpoint, e.g. `http://127.0.0.1:8765/mcp`. */
  url: string;
  /** Static headers sent with every request (e.g. a bearer token). */
  headers?: Record<string, string>;
}

/**
 * A real MCP client over Streamable HTTP, built on the official SDK. The mirror
 * of `StdioToolset` for remote/shared servers. Authentication is a transport
 * concern here: pass static headers, and/or run `OAuthMiddleware` — both
 * ultimately set the request `Authorization` header. Credentials resolved per
 * call are injected through a custom `fetch`, so a refreshed token is picked up
 * without reconnecting.
 */
export class HttpToolset implements ResourceToolset {
  private client: Client | undefined;
  /**
   * Credentials for the in-flight call, supplied by `callTool`. Read at request
   * time (inside `fetch`) rather than bound at connect time, so a token
   * refreshed by `OAuthMiddleware` applies immediately.
   */
  private credentials: Record<string, unknown> | undefined;

  constructor(
    readonly serverName: string,
    private readonly options: HttpToolsetOptions,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
      requestInit: this.options.headers ? { headers: this.options.headers } : undefined,
      fetch: async (input, init) => fetch(input, withAuthorization(init, this.credentials)),
    });
    const client = new Client(
      { name: "adaptivemcp-agent", version: "0.0.1" },
      { capabilities: { extensions: { [TOOLS_METADATA_EXTENSION]: {} } } },
    );
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async instructions(): Promise<string | undefined> {
    return (await this.connect()).getInstructions();
  }

  async listResources(): Promise<Array<{ uri: string; name?: string; mimeType?: string }>> {
    const { resources } = await (await this.connect()).listResources();
    return resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      mimeType: resource.mimeType,
    }));
  }

  async readResource(uri: string): Promise<string | undefined> {
    const result = await (await this.connect()).readResource({ uri });
    for (const content of result.contents) {
      if ("text" in content && typeof content.text === "string") return content.text;
    }
    return undefined;
  }

  async listTools(): Promise<ToolSpec[]> {
    const { tools } = await (await this.connect()).listTools();
    return tools.map((tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      serverName: this.serverName,
      annotations: tool.annotations as Record<string, unknown> | undefined,
    }));
  }

  async callTool(name: string, input: unknown, context?: ToolCallContext): Promise<McpToolResult> {
    // Auth first: `connect()` may perform the handshake, so the token has to be
    // in place before we ask for a client.
    if (context) this.credentials = context.credentials;
    try {
      const result = (await (
        await this.connect()
      ).callTool({
        name,
        arguments: (input ?? {}) as Record<string, unknown>,
      })) as unknown as CallToolResult;
      const output = extractOutput(result);
      if (result.isError) {
        return { ok: false, output, error: typeof output === "string" ? output : "tool returned an error" };
      }
      return { ok: true, output };
    } catch (error) {
      // Transport/HTTP failures are a failed tool result, not a throw: the
      // execution loop does not catch, and auth middleware keys off the status
      // (e.g. a 401) to refresh the token for the next attempt.
      return { ok: false, error: httpErrorMessage(error) };
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.credentials = undefined;
  }
}

/** Overlay the resolved credentials on a request init as `Authorization`. */
function withAuthorization(init: RequestInit | undefined, credentials?: Record<string, unknown>): RequestInit {
  const authorization = credentials?.authorization;
  if (typeof authorization !== "string") return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set("Authorization", authorization);
  return { ...init, headers };
}

/**
 * A human-readable error that keeps the HTTP status. The SDK's
 * `StreamableHTTPError` puts the status on `.code`, not in `.message`, and the
 * OAuth middleware recognises a 401 by looking for that number.
 */
function httpErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number" && code >= 400) return `HTTP ${code}: ${message}`;
  return message;
}
