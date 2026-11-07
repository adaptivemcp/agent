import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { HttpToolset } from "./http.js";

/** A stateless echo MCP server, behind a bearer check. */
function echoServer(): McpServer {
  const server = new McpServer({ name: "refresh-test", version: "0.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo text", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  return server;
}

/**
 * A 401 must become a refresh + retry, not a dead session.
 *
 * The transport is connected once; a token expiring mid-run arrives as `401` on whatever
 * request happens to be next (here, `initialize`). Refreshing inside `fetch` keeps the
 * connection state intact — reconnecting would lose the session id — so this test asserts
 * both the successful tool list and that the refresh happened exactly once.
 */
describe("HttpToolset (refresh on 401)", () => {
  let http: Server | undefined;
  let refreshCalls = 0;
  const accepted = new Set<string>();

  afterEach(async () => {
    if (!http) return;
    await new Promise<void>((resolve) => http?.close(() => resolve()));
    http = undefined;
    refreshCalls = 0;
    accepted.clear();
  });

  async function start(initialBearer: string): Promise<string> {
    accepted.add(initialBearer);
    http = createServer((request, response) => {
      const authorization = request.headers.authorization ?? "";
      if (!accepted.has(authorization.replace(/^Bearer /, ""))) {
        // Parse the body first so the client is not answered mid-upload.
        request.resume();
        response.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="mcp"',
        });
        response.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = undefined;
        }
        const server = echoServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        response.on("close", () => {
          void transport.close();
          void server.close();
        });
        void server.connect(transport).then(() => transport.handleRequest(request, response, body));
      });
    });
    await new Promise<void>((resolve) => http?.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    return `http://127.0.0.1:${port}/mcp`;
  }

  it("refreshes once and retries the request that got the 401", async () => {
    const url = await start("fresh-token");
    // `header` must reflect the refresh, or every later request re-sends the stale token
    // and refreshes again — which is exactly what a naive double does.
    let current = "Bearer stale-token";
    const toolset = new HttpToolset("remote", {
      serverName: "remote",
      url,
      auth: {
        header: () => current,
        refresh: async () => {
          refreshCalls += 1;
          current = "Bearer fresh-token";
          return current;
        },
      },
    });

    try {
      const tools = await toolset.listTools();
      expect(tools.map((tool) => tool.name)).toContain("echo");
      expect(refreshCalls).toBe(1);
    } finally {
      await toolset.close();
    }
  }, 30_000);

  it("gives up after one refresh instead of looping on a bad token", async () => {
    // The server only accepts a token the refresh never produces: the retry 401s too.
    const url = await start("unreachable-token");
    const toolset = new HttpToolset("remote", {
      serverName: "remote",
      url,
      auth: {
        header: () => "Bearer stale-token",
        refresh: async () => {
          refreshCalls += 1;
          return "Bearer still-wrong";
        },
      },
    });

    try {
      await expect(toolset.listTools()).rejects.toThrow();
      expect(refreshCalls).toBe(1);
    } finally {
      await toolset.close();
    }
  }, 30_000);
});
