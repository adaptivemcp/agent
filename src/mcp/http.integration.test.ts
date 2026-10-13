import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { HttpToolset } from "./http.js";

/** A stateless echo MCP server (a fresh instance per request, per the SDK). */
function createEchoServer(): McpServer {
  const server = new McpServer({ name: "http-test", version: "0.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo text", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  return server;
}

/**
 * In-process Streamable HTTP round trip: a real MCP server on `127.0.0.1`, the
 * `HttpToolset` client on the other end. No external services, so it runs with
 * the normal suite.
 */
describe("HttpToolset (streamable HTTP)", () => {
  let http: Server;
  let url: string;

  beforeAll(async () => {
    http = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = undefined;
        }
        // Stateless: a fresh server + transport per request.
        const server = createEchoServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        void (async () => {
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        })().catch((error: unknown) => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(String(error));
          }
        });
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it("lists and calls a tool over HTTP", async () => {
    const toolset = new HttpToolset("http", { serverName: "http", url });
    const specs = await toolset.listTools();
    expect(specs.map((spec) => spec.name)).toContain("echo");

    const result = await toolset.callTool("echo", { text: "hi" });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).toContain("hi");

    await toolset.close();
  });
});
