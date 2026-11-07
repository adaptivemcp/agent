#!/usr/bin/env node
/**
 * Client-side conformance harness adapter.
 *
 * `@modelcontextprotocol/conformance client` starts a scripted MCP server and appends its
 * URL as the last argument to this command, so this script's only job is to run the agent
 * CLI against that URL and exit with its status.
 *
 * The agent connects and lists tools, then stops: no model is called, because the
 * scenarios under test are about the MCP handshake and discovery, not about what a model
 * does with the answer. `--base-url`/`--api-key` only satisfy catalog resolution with a
 * stub that is never contacted.
 *
 *   npx @modelcontextprotocol/conformance client \
 *     --command "node scripts/conformance-client.mjs" --scenario initialize
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * A one-scenario OpenAI-compatible stub: ask for the harness's tool once, then answer.
 *
 * The `tools_call` scenario expects the client to *call* a tool, and the agent only calls
 * one when a model asks it to. This stands in for the model — no network, no inference —
 * so the scenario measures the client's MCP behaviour rather than anybody's GPU.
 */
function startStub(toolName, toolInput, finalText) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      const messages = parsed.messages ?? [];
      requests.push(messages);
      const alreadyCalled = messages.some((message) => message.role === "tool");
      const message = alreadyCalled
        ? { role: "assistant", content: finalText }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: toolName, arguments: JSON.stringify(toolInput) },
              },
            ],
          };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-conformance",
          object: "chat.completion",
          created: 0,
          model: parsed.model ?? "stub",
          choices: [
            {
              index: 0,
              message,
              finish_reason: alreadyCalled ? "stop" : "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const url = args.filter((arg) => arg.startsWith("http")).at(-1);

if (!url) {
  console.error("[conformance-client] no server URL argument was passed by the harness");
  process.exit(2);
}

// tsx's real entry, not the `.bin` shim: the shim is a shell script, so `node <shim>` fails.
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
// `--auth` opts the client into OAuth discovery and completes the redirect headlessly
// (`authorize: "fetch"`), which is what the `auth/*` scenarios measure.
const wantsAuth = args.includes("--auth");
const spec = JSON.stringify(
  wantsAuth
    ? { name: "conformance", url, oauth: { authorize: "fetch" } }
    : { name: "conformance", url },
);

// `--call` makes the adapter exercise the tool path: a stub model asks for the harness's
// tool once. Without it the adapter only connects and lists tools (the `initialize` shape).
const wantsToolCall = args.includes("--call");
const toolName = process.env.CONFORMANCE_TOOL ?? "conformance_add_numbers";
const stub = wantsToolCall
  ? await startStub(toolName, { a: 2, b: 3, text: "hi" }, "5")
  : { url: "http://127.0.0.1:1/v1", close: () => {} };

const cliArgs = wantsToolCall
  ? ["--prompt", "What is 2 + 3? Use the tool.", "--yes", "--max-steps", "3"]
  : ["--list-tools"];

const argv = [
  tsx,
  "src/cli.ts",
  ...cliArgs,
  "--server",
  spec,
  "--base-url",
  stub.url,
  "--api-key",
  "conformance",
  "--no-ollama",
  "--no-stream",
  "--db",
  ":memory:",
  "--session",
  "conformance",
];

// Asynchronous: `spawnSync` would block this process's event loop, and in `--call` mode the
// scripted model this process serves lives on that loop. The child would then wait forever
// for a model that cannot answer — the exact hang the harness reports as a client timeout.
const child = spawn(process.execPath, argv, { cwd: root, stdio: "inherit" });
const status = await new Promise((resolve) => child.on("close", (code) => resolve(code)));

stub.close();
process.exit(status ?? 1);
