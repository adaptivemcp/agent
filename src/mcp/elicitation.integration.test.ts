import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HttpToolset, schemaDefaults } from "./http.js";

/**
 * Elicitation: a server asking the *client* for input mid-call.
 *
 * The host does not advertise the capability unless asked (`--elicitation`), because a
 * server should not ask a client that has no way to answer. When it is enabled the answer
 * is either the schema's declared defaults (SEP-1034) or an explicit decline — never an
 * invented value.
 */
function elicitingServer(onResult: (result: unknown) => void): McpServer {
  const server = new McpServer({ name: "elicitation-test", version: "0.0.0" });
  server.registerTool(
    "ask",
    { description: "Ask the client for input", inputSchema: {} },
    async () => {
      const result = await server.server.elicitInput({
        message: "Please confirm",
        requestedSchema: {
          type: "object",
          properties: {
            name: { type: "string", default: "John Doe" },
            age: { type: "integer", default: 30 },
            newsletter: { type: "boolean", default: true },
            noDefault: { type: "string" },
          },
          required: [],
        },
      });
      onResult(result);
      return { content: [{ type: "text" as const, text: "asked" }] };
    },
  );
  return server;
}

async function start(
  onResult: (result: unknown) => void,
): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  // One server and one transport for the whole test: elicitation depends on session state
  // (the server records the client's capabilities at `initialize`), so a fresh instance per
  // request would answer `Client does not support form elicitation`.
  const mcp = elicitingServer(onResult);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  const http = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      void transport.handleRequest(request, response, body);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    server: http,
    close: async () => {
      await transport.close();
      await mcp.close();
    },
  };
}

describe("elicitation", () => {
  let running: Server | undefined;

  afterEach(async () => {
    if (!running) return;
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  });

  it("accepts with the schema's declared defaults and invents nothing", async () => {
    let received: { action?: string; content?: Record<string, unknown> } | undefined;
    const server = await start((result) => {
      received = result as typeof received;
    });
    running = server.server;
    const toolset = new HttpToolset("remote", {
      serverName: "remote",
      url: server.url,
      elicitation: "defaults",
    });

    try {
      const result = await toolset.callTool("ask", {});
      expect(result.ok, JSON.stringify(result)).toBe(true);
    } finally {
      await toolset.close();
    }

    expect(received?.action).toBe("accept");
    expect(received?.content).toEqual({ name: "John Doe", age: 30, newsletter: true });
    // A field with no declared default is omitted, not guessed.
    expect(received?.content).not.toHaveProperty("noDefault");
  }, 30_000);

  it("prompts and sends the answers the person typed", async () => {
    let received: { action?: string; content?: Record<string, unknown> } | undefined;
    const server = await start((result) => {
      received = result as typeof received;
    });
    running = server.server;
    const answers = ["Ada", "41", "no", "a note"];
    const toolset = new HttpToolset("remote", {
      serverName: "remote",
      url: server.url,
      elicitation: "prompt",
      elicitationAsk: () => async () => answers.shift() ?? "",
    });

    try {
      const result = await toolset.callTool("ask", {});
      expect(result.ok, JSON.stringify(result)).toBe(true);
    } finally {
      await toolset.close();
    }

    expect(received?.action).toBe("accept");
    expect(received?.content).toEqual({
      name: "Ada",
      age: 41,
      newsletter: false,
      noDefault: "a note",
    });
  }, 30_000);

  it("declines explicitly instead of accepting", async () => {
    let received: { action?: string } | undefined;
    const server = await start((result) => {
      received = result as typeof received;
    });
    running = server.server;
    const toolset = new HttpToolset("remote", {
      serverName: "remote",
      url: server.url,
      elicitation: "decline",
    });

    try {
      const result = await toolset.callTool("ask", {});
      expect(result.ok, JSON.stringify(result)).toBe(true);
    } finally {
      await toolset.close();
    }

    expect(received?.action).toBe("decline");
  }, 30_000);

  it("extracts only declared defaults from a schema", () => {
    expect(
      schemaDefaults({
        type: "object",
        properties: {
          a: { type: "string", default: "x" },
          b: { type: "integer", default: 0 },
          c: { type: "string" },
          d: { type: "string", default: null },
        },
      }),
    ).toEqual({ a: "x", b: 0, d: null });
    expect(schemaDefaults(undefined)).toEqual({});
  });
});
