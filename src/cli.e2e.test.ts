import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { StubModelServer } from "./testing/openai-stub.js";

/**
 * The CLI entry point end to end, offline.
 *
 * `src/cli.ts` is a process entry point — it runs `main()` at import time, so a
 * unit test cannot import it — and it was excluded from coverage on the grounds
 * that it is "exercised via the CLI/REPL and the integration tests". Nothing
 * actually spawned it, so its ordering and wiring were unverified. This does
 * spawn it, against two local fixtures (an OpenAI-compatible stub and a stdio MCP
 * server), so a whole run happens with no network.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
// tsx's real JS entry, not the `.bin` shim: the shim is a shell script, so
// `node <shim>` fails (`SyntaxError: missing ) after argument list`).
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const MCP_FIXTURE = join(root, "src", "testing", "mcp-server.ts");

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real CLI as a child process, the way a user would. */
function runCli(args: string[]): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, "src/cli.ts", ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The JSON `--server` form, so a test can set per-server env (the fixture's delay). */
function serverSpec(env: Record<string, string> = {}): string {
  return JSON.stringify({
    name: "fixture",
    command: process.execPath,
    args: [TSX, MCP_FIXTURE],
    env,
  });
}

let model: StubModelServer | undefined;

afterEach(async () => {
  await model?.stop();
  model = undefined;
});

describe("cli, end to end and offline", () => {
  it("runs a whole turn: flags → MCP tool → model → rendered answer", async () => {
    model = new StubModelServer({
      toolName: "fixture_fixture_echo", // namespaced by the aggregate, as the model sees it
      toolInput: { text: "hi" },
      finalText: "echoed hi",
    });
    const baseUrl = await model.start();

    const run = await runCli([
      "--prompt",
      "echo hi",
      "--server",
      serverSpec(),
      "--base-url",
      baseUrl,
      "--api-key",
      "test-key",
      "--no-ollama",
      "--no-stream",
      "--db",
      ":memory:",
      "--session",
      "cli-e2e-1",
      "--max-steps",
      "3",
    ]);

    expect(run.stderr).not.toContain("error:");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("fixture_fixture_echo"); // the call was rendered
    expect(run.stdout).toContain("echoed hi"); // and so was the answer
    expect(run.stdout).toContain("stop=completed");
    // Two model calls: choose the tool, then answer with its result.
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.messages.some((message) => message.role === "tool")).toBe(false);
    expect(model.requests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
  }, 30_000);

  it("keeps a background child working after the parent's turn ends", async () => {
    model = new StubModelServer({
      respond: (request) => {
        const isChild = request.messages.some(
          (message) => message.role === "system" && (message.content ?? "").includes("sub-agent"),
        );
        const answered = request.messages.some((message) => message.role === "tool");
        if (isChild) {
          return answered
            ? { text: "child finished" }
            : { toolName: "fixture_fixture_echo", toolInput: { text: "child" } };
        }
        return answered
          ? { text: "parent finished" }
          : {
              toolName: "delegate_task",
              toolInput: { description: "echo", prompt: "echo child", background: true },
            };
      },
    });
    const baseUrl = await model.start();

    const run = await runCli([
      "--prompt",
      "delegate the echo",
      "--task", // exposes the `task` tool
      "--server",
      // The child's tool call is slow, so the child necessarily outlives the
      // parent's last step — which is where the shared store used to be closed.
      serverSpec({ FIXTURE_DELAY_MS: "700" }),
      "--base-url",
      baseUrl,
      "--api-key",
      "test-key",
      "--no-ollama",
      "--no-stream",
      "--db",
      ":memory:",
      "--session",
      "cli-e2e-2",
      "--max-steps",
      "3",
    ]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("parent finished");
    // The child completed on the shared store rather than dying with it.
    expect(run.stdout).toContain("[delegated]");
    expect(run.stdout).toContain("Status: completed");
    expect(run.stdout).not.toContain("database is not open");
    // And the report arrived *after* the parent stopped, which is the ordering
    // the fix is about.
    expect(run.stdout.indexOf("[delegated]")).toBeGreaterThan(run.stdout.indexOf("stop=completed"));
  }, 30_000);
});
