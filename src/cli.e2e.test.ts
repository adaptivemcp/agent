import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { StubModelServer, offeredTools } from "./testing/openai-stub.js";

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

  it("denies a high-risk tool with no approver, and says so instead of running it", async () => {
    model = new StubModelServer({
      toolName: "fixture_fixture_deploy",
      toolInput: { target: "prod" },
    });
    const baseUrl = await model.start();

    const run = await runCli([
      "--prompt",
      "deploy to prod",
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
      "cli-e2e-3",
      "--max-steps",
      "3",
    ]);

    // The tool was offered (the gate, not the tool list, is what stops it)…
    expect(run.stdout).toContain("fixture_fixture_deploy");
    // …and the model was told it was denied, rather than the tool having run.
    const second = model.requests[1];
    expect(second?.messages.some((message) => message.role === "tool")).toBe(true);
    expect(JSON.stringify(second?.messages)).toContain("no approver is configured");
    expect(JSON.stringify(second?.messages)).not.toContain("deployed: prod");
    // A script must be able to tell: the run is a denial, not a success.
    expect(run.code).toBe(4);
  }, 30_000);

  it("runs the same tool when the host opts in with --yes", async () => {
    model = new StubModelServer({
      toolName: "fixture_fixture_deploy",
      toolInput: { target: "prod" },
    });
    const baseUrl = await model.start();

    const run = await runCli([
      "--prompt",
      "deploy to prod",
      "--yes",
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
      "cli-e2e-4",
      "--max-steps",
      "3",
    ]);

    expect(run.code).toBe(0);
    expect(JSON.stringify(model.requests[1]?.messages)).toContain("deployed: prod");
  }, 30_000);

  it("gives a named agent only the tools its skill allows", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "agent-e2e-skills-"));
    mkdirSync(join(skillsDir, "reviewer"));
    writeFileSync(
      join(skillsDir, "reviewer", "SKILL.md"),
      "---\nname: reviewer\ndescription: Reads only\ntools:\n  - fixture_echo\n---\n\nReview, then report.\n",
    );
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
              toolInput: { description: "review", prompt: "review it", agent: "reviewer" },
            };
      },
    });
    const baseUrl = await model.start();

    const run = await runCli([
      "--prompt",
      "delegate a review",
      "--task",
      "--skills",
      skillsDir,
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
      "cli-e2e-5",
      "--max-steps",
      "3",
    ]);

    expect(run.code).toBe(0);
    const childRequest = model.requests.find((request) =>
      request.messages.some(
        (message) => message.role === "system" && (message.content ?? "").includes("sub-agent"),
      ),
    );
    // The child was offered exactly the intersection: the echo tool, and not the
    // destructive one, the delegation tool, or the skill reader.
    expect(offeredTools(childRequest!)).toEqual(["fixture_fixture_echo"]);
    rmSync(skillsDir, { recursive: true, force: true });
  }, 30_000);
});
