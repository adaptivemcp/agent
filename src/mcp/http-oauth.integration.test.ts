import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ApprovalGate } from "@adaptivemcp/approval";
import { MemoryStore } from "@adaptivemcp/memory";
import { InMemoryOAuthTokenStore, OAuthMiddleware, ThinClient } from "@adaptivemcp/thin-client";
import { z } from "zod";
import { HttpToolset } from "./http.js";

/**
 * End-to-end OAuth over Streamable HTTP: a real HTTP server that *requires* an
 * `Authorization` header, the `OAuthMiddleware` resolving a token, and the
 * `HttpToolset` putting it on the wire.
 *
 * Two properties are asserted, and they are the reason this test exists:
 *
 *  1. the middleware's resolved token reaches the server (before this, the
 *     middleware wrote `PlannedCall.credentials` and nothing read them);
 *  2. after the server rejects a revoked-but-unexpired token with 401, the
 *     middleware refreshes and the *next* call carries the new token.
 */
describe("HTTP + OAuth end-to-end", () => {
  let http: Server;
  let url: string;
  let tokenUrl: string;
  /** `Authorization` header of each request that reached `/mcp`. */
  const seen: string[] = [];

  const store = new InMemoryOAuthTokenStore();
  const config = {
    clientId: "agent-client",
    clientSecret: "s3cret",
    authUrl: "https://auth.invalid/authorize",
    tokenUrl: "", // bound in beforeAll, once the port is known
    redirectUri: "http://127.0.0.1/cb",
    scopes: ["read"],
  };

  beforeAll(async () => {
    http = createServer((req, res) => {
      if (req.url === "/token" && req.method === "POST") {
        // Minimal OAuth refresh endpoint: returns a new access token.
        void collect(req).then(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: "fresh-token",
              refresh_token: "refresh-2",
              expires_in: 3600,
              token_type: "Bearer",
            }),
          );
        });
        return;
      }

      const authorization = req.headers.authorization;
      if (typeof authorization === "string") seen.push(authorization);

      if (authorization !== "Bearer fresh-token") {
        // Stale or missing token: the signal the OAuth middleware keys off.
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      void handleMcp(req, res);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/mcp`;
    tokenUrl = `http://127.0.0.1:${port}/token`;
    config.tokenUrl = tokenUrl;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it("sends the resolved token, then a refreshed one after a 401", async () => {
    // A token that has *not* expired (so no proactive refresh) but has been
    // revoked server-side: the only way to learn is the 401.
    await store.setToken("http", {
      accessToken: "stale-token",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
      tokenType: "Bearer",
    });

    const memory = new MemoryStore({ path: ":memory:" });
    try {
      const middleware = new OAuthMiddleware(store, { http: config }, ["http"]);
      const client = new ThinClient({
        memory,
        gate: new ApprovalGate({ memory }),
        middleware: [middleware],
      });
      const toolset = new HttpToolset("http", { serverName: "http", url });

      const runOnce = async (): Promise<{ ok: boolean; error?: string; output?: unknown }> => {
        let outcome = { ok: false as boolean, error: "not run" as string | undefined };
        const res = await client.run(
          "echo",
          async (input, context) => toolset.callTool("echo", input, context),
          { text: "hello" },
          (ok, error, output) => {
            outcome = { ok, error, output };
          },
          "http",
        );
        expect(res.executed).toBe(true);
        return outcome;
      };

      // 1. The stale token is put on the wire and rejected.
      const first = await runOnce();
      expect(first.ok).toBe(false);
      expect(first.error).toContain("401");
      expect(seen).toEqual(["Bearer stale-token"]);

      // The 401 made the middleware refresh against the local token endpoint.
      expect((await store.getToken("http"))?.accessToken).toBe("fresh-token");

      // 2. The refreshed token is used, without reconnecting by hand.
      const second = await runOnce();
      expect(second.ok).toBe(true);
      expect(JSON.stringify(second.output)).toContain("hello");
      // Every request after the rejection carries the new token; the stale one
      // is never used again. (A call is several HTTP requests: initialize,
      // initialized, tools/call.)
      expect(seen[0]).toBe("Bearer stale-token");
      expect(seen.slice(1).length).toBeGreaterThan(0);
      expect(new Set(seen.slice(1))).toEqual(new Set(["Bearer fresh-token"]));

      await toolset.close();
    } finally {
      memory.close();
    }
  });
});

/** Read a request body once; resolves with the raw text. */
function collect(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Stateless MCP echo server (fresh instance per request, per the SDK). */
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const text = await collect(req);
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  const server = new McpServer({ name: "oauth-test", version: "0.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo text", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error: unknown) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(String(error));
    }
  }
}
