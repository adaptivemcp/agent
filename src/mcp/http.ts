import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
  /**
   * A credential that can change mid-session. `header` is read per request; a `401`
   * triggers one `refresh()` and one retry, so a token that expired during a long run is
   * replaced without reconnecting the transport.
   */
  /**
   * How to answer a server's `elicitation/create` request. Opt-in: with no value the client
   * does not advertise the capability at all, so a server cannot ask a host that has no way
   * to answer. `defaults` accepts with the schema's own defaults (SEP-1034); `decline`
   * refuses explicitly.
   */
  elicitation?: "defaults" | "decline";
  auth?: {
    header: () => string;
    refresh?: () => Promise<string>;
    /** Re-authorize with more scopes when the server demands a step-up. */
    escalate?: (scopes: string[]) => Promise<string>;
  };
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
      fetch: async (input, init) => this.authorizedFetch(input, init),
    });
    const client = new Client(
      { name: "adaptivemcp-agent", version: "0.0.1" },
      {
        capabilities: {
          extensions: { [TOOLS_METADATA_EXTENSION]: {} },
          ...(this.options.elicitation
            ? { elicitation: { form: { applyDefaults: this.options.elicitation === "defaults" } } }
            : {}),
        },
      },
    );
    if (this.options.elicitation) {
      const mode = this.options.elicitation;
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        if (mode === "decline") return { action: "decline" };
        // `mode: "url"` elicitation has no form to fill; declining is the only honest answer.
        const params = request.params as { mode?: string; requestedSchema?: unknown };
        if (params.mode === "url") return { action: "decline" };
        return { action: "accept", content: schemaDefaults(params.requestedSchema) };
      });
    }
    await client.connect(transport);
    this.client = client;
    return client;
  }

  /**
   * Send one request, then retry once with a refreshed token if the server answers 401.
   *
   * Retrying inside `fetch` keeps the MCP SDK's connection state intact — a re-`connect`
   * would lose the session id, and a 401 on `initialize` has no session to recover.
   * `input` is cloned per attempt because a `Request` body can only be consumed once.
   */
  private async authorizedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const send = (refreshed?: string): Promise<Response> => {
      const target = input instanceof Request ? input.clone() : input;
      // Read the live credential per request: after a refresh, `header()` already returns
      // the new value, so only the retry needs the explicit override.
      const authorization = refreshed ?? this.options.auth?.header();
      return fetch(target, withAuthorization(init, this.credentials, authorization));
    };
    const response = await send();
    const auth = this.options.auth;
    if (!auth) return response;

    // A 403 that names required scopes is a step-up, not a refusal: re-authorize with the
    // scopes it asks for and retry once. This is the only way a token minted with a
    // narrower grant can reach a protected operation mid-session.
    if (response.status === 403 && auth.escalate) {
      const scopes = insufficientScopes(response.headers.get("www-authenticate") ?? "");
      if (scopes.length > 0) {
        await response.body?.cancel().catch(() => {});
        try {
          return await send(await auth.escalate(scopes));
        } catch {
          return response;
        }
      }
    }

    if (response.status !== 401 || !auth.refresh) return response;
    // Drain the body so the connection can be reused for the retry.
    await response.body?.cancel().catch(() => {});
    let authorization: string;
    try {
      authorization = await auth.refresh();
    } catch {
      return response;
    }
    return send(authorization);
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

/**
 * Pre-fill an elicitation response from the schema's `default` values (SEP-1034).
 *
 * Only declared defaults are included — the client never invents a value, and a field with
 * no default stays omitted so the user (or the server) is still the authority on it.
 */
export function schemaDefaults(schema: unknown): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  const properties = (schema as { properties?: Record<string, { default?: unknown }> } | undefined)
    ?.properties;
  if (!properties) return content;
  for (const [name, field] of Object.entries(properties)) {
    if (field && typeof field === "object" && "default" in field) content[name] = field.default;
  }
  return content;
}

/** `Bearer error="insufficient_scope", scope="a b"` → `["a", "b"]`. */
function insufficientScopes(header: string): string[] {
  if (!/error="?insufficient_scope"?/i.test(header)) return [];
  const scope = /scope="([^"]*)"/i.exec(header)?.[1] ?? "";
  return scope.split(/\s+/).filter(Boolean);
}

/**
 * Overlay the resolved credentials, or an explicit refreshed header, on a request init.
 * Precedence: refreshed header > per-call credentials > static headers.
 */
function withAuthorization(
  init: RequestInit | undefined,
  credentials?: Record<string, unknown>,
  refreshed?: string,
): RequestInit {
  const authorization =
    refreshed ?? (typeof credentials?.authorization === "string" ? credentials.authorization : undefined);
  if (!authorization) return init ?? {};
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
