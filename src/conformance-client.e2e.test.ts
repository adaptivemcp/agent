import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/**
 * The conformance adapter, against a local stateless MCP server.
 *
 * `@modelcontextprotocol/conformance client` runs a scripted server and appends its URL to
 * our adapter's argv. This reproduces exactly that contract offline, so the adapter cannot
 * silently stop working between conformance runs (which need the network).
 */
const root = fileURLToPath(new URL("..", import.meta.url));

function echoServer(): McpServer {
  const server = new McpServer({ name: "http-test", version: "0.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo text", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  return server;
}

/** A stateless Streamable HTTP server: a fresh instance per request, per the SDK. */
async function startServer(): Promise<{ url: string; server: Server }> {
  const http = createServer((req, res) => {
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
      const server = echoServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      void server.connect(transport).then(() => transport.handleRequest(req, res, body));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, server: http };
}

describe("conformance client adapter", () => {
  let running: Server | undefined;

  afterEach(async () => {
    if (!running) return;
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  });

  it("connects to the URL the harness passes and lists its tools", async () => {
    const { url, server } = await startServer();
    running = server;

    // Asynchronous on purpose: `spawnSync` would block this process's event loop, and the
    // server it needs to reach lives in that same loop.
    const child = spawn(process.execPath, [join(root, "scripts", "conformance-client.mjs"), url], {
      cwd: root,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });

    expect(code, stderr).toBe(0);
    // `--list-tools` output: one tab-separated row per discovered tool.
    expect(stdout).toContain("echo");
  }, 60_000);

  it("calls a tool when --call asks the scripted model for one", async () => {
    const { url, server } = await startServer();
    running = server;

    const child = spawn(
      process.execPath,
      [join(root, "scripts", "conformance-client.mjs"), "--call", url],
      {
        cwd: root,
        // The local server's tool is `echo`, namespaced by the configured server name.
        env: { ...process.env, CONFORMANCE_TOOL: "conformance_echo" },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });

    expect(code, stderr).toBe(0);
    // The tool ran through the ordinary path and its result came back to the model.
    expect(stdout).toContain("conformance_echo");
    expect(stdout).toContain("stop=completed");
  }, 60_000);

  it("exits with a usage error when the harness passes no URL", () => {
    const run = spawnSync(process.execPath, [join(root, "scripts", "conformance-client.mjs")], {
      cwd: root,
      encoding: "utf8",
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no server URL");
  });
});
