import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@adaptivemcp/memory";
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

  it("keeps a task list the model wrote down in the store the run was given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-e2e-tasks-"));
    const db = join(dir, "agent.db");
    model = new StubModelServer({
      respond: (request) => {
        const answered = request.messages.some((message) => message.role === "tool");
        return answered
          ? { text: "planned" }
          : {
              toolName: "tasks_create",
              toolInput: { title: "write the parser", dependsOn: [] },
            };
      },
    });
    const baseUrl = await model.start();

    const run = await runCli([
      "--prompt",
      "plan the work",
      "--tasks",
      "--server",
      serverSpec(),
      "--base-url",
      baseUrl,
      "--api-key",
      "test-key",
      "--no-ollama",
      "--no-stream",
      "--db",
      db,
      "--session",
      "cli-e2e-tasks",
      "--max-steps",
      "3",
    ]);

    expect(run.code).toBe(0);
    // The flag reached the tool list the model saw, and the call ran.
    expect(offeredTools(model.requests[0]!)).toContain("tasks_create");
    expect(run.stdout).toContain("tasks_create");
    // The result carried the task's id back, so the tool found a real store.
    expect(JSON.stringify(model.requests[1]?.messages)).toContain("t1");

    // And the list outlived the process: the task is in the database the run was
    // given, readable through the same store the agent itself uses.
    const store = new MemoryStore({ path: db });
    const tasks = store.getTasks?.("cli-e2e-tasks") ?? [];
    store.close();
    expect(tasks.map((task) => ({ id: task.id, title: task.title, status: task.status }))).toEqual([
      { id: "t1", title: "write the parser", status: "pending" },
    ]);

    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("keeps a `tasks`-mode run going until its list is finished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-e2e-mode-"));
    const db = join(dir, "agent.db");
    model = new StubModelServer({
      respond: (request) => {
        // Turn index = how many assistant turns have happened so far.
        const turn = request.messages.filter((message) => message.role === "assistant").length;
        if (turn === 0) {
          return { toolName: "tasks_create", toolInput: { title: "write the parser" } };
        }
        if (turn === 1) return { text: "all done" }; // tries to stop with t1 still open
        if (turn === 2) {
          return {
            toolName: "tasks_update",
            toolInput: { id: "t1", status: "completed", result: "parser written" },
          };
        }
        return { text: "parser written, nothing left open" };
      },
    });
    const baseUrl = await model.start();

    const run = await runCli([
      "--prompt",
      "write the parser",
      "--mode",
      "tasks", // implies --task and --tasks
      "--server",
      serverSpec(),
      "--base-url",
      baseUrl,
      "--api-key",
      "test-key",
      "--no-ollama",
      "--no-stream",
      "--db",
      db,
      "--session",
      "cli-e2e-mode",
      "--max-steps",
      "6",
    ]);

    // The mode implied both toolsets, without either flag on the command line.
    const offered = offeredTools(model.requests[0]!);
    expect(offered).toContain("tasks_create");
    expect(offered).toContain("delegate_task");

    // The "all done" turn was refused: the stop guard sent the run back to work,
    // and the run only completed once the list was empty.
    expect(run.stdout).toContain("still holds work");
    expect(run.stdout).toContain("parser written, nothing left open");
    expect(run.stdout).toContain("stop=completed");
    expect(run.stdout).toContain("steps=4");

    const store = new MemoryStore({ path: db });
    const tasks = store.getTasks?.("cli-e2e-mode") ?? [];
    store.close();
    expect(tasks.map((task) => ({ id: task.id, status: task.status, result: task.result }))).toEqual([
      { id: "t1", status: "completed", result: "parser written" },
    ]);

    rmSync(dir, { recursive: true, force: true });
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

  it("plans on an interval, from the recorded state rather than the conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-e2e-plan-"));
    const db = join(dir, "agent.db");
    const plan = JSON.stringify({ steps: ["echo something", "report back"], reasoning: "initial" });
    model = new StubModelServer({
      respond: (request) => {
        const isPlanning = request.messages.some(
          (message) =>
            message.role === "system" && (message.content ?? "").includes("planning pass"),
        );
        if (isPlanning) return { text: plan };
        const answered = request.messages.some((message) => message.role === "tool");
        return answered
          ? { text: "all steps done" }
          : { toolName: "fixture_fixture_echo", toolInput: { text: "hi" } };
      },
    });
    const baseUrl = await model.start();

    const run = await runCli([
      "--prompt",
      "echo something",
      "--plan-interval",
      "1",
      "--server",
      serverSpec(),
      "--base-url",
      baseUrl,
      "--api-key",
      "test-key",
      "--no-ollama",
      "--no-stream",
      "--db",
      db,
      "--session",
      "cli-e2e-plan",
      "--max-steps",
      "4",
    ]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("stop=completed");
    // The plan reached the model as a turn it could act on.
    expect(run.stdout).toContain("Plan (asked before step 1");

    const planningRequests = model.requests.filter((request) =>
      request.messages.some(
        (message) => message.role === "system" && (message.content ?? "").includes("planning pass"),
      ),
    );
    // Planned before the first step, then again before the second (interval 1).
    expect(planningRequests).toHaveLength(2);
    // The second pass reads the *record*, not the transcript: the tool call is in
    // the recorded state even though the planning prompt is not the conversation.
    expect(JSON.stringify(planningRequests[1]?.messages)).toContain("fixture_fixture_echo → ok");

    // And the history reads back typed and in order: plan, the work, the re-plan.
    const store = new MemoryStore({ path: db });
    const history = store.getSteps?.("cli-e2e-plan") ?? [];
    store.close();
    expect(history.map((step) => step.kind)).toEqual(["plan", "action", "plan"]);

    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("wires the child runner for a mode that implies delegation", async () => {
    // `--mode route` implies `--task`, so the tool list has `delegate_task`. The
    // runner behind it has to be wired from the same decision, or the tool the
    // mode exposed can only answer "delegation is not wired yet".
    model = new StubModelServer({
      respond: (request) => {
        const isChild = request.messages.some(
          (message) => message.role === "system" && (message.content ?? "").includes("sub-agent"),
        );
        if (isChild) return { text: "the specialist answered" };
        const answered = request.messages.some((message) => message.role === "tool");
        return answered
          ? { text: "routed" }
          : {
              toolName: "delegate_task",
              toolInput: { description: "route it", prompt: "answer this" },
            };
      },
    });
    const baseUrl = await model.start();

    const run = await runCli([
      "--prompt",
      "who should answer this?",
      "--mode",
      "route",
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
      "cli-e2e-mode-route",
      "--max-steps",
      "3",
    ]);

    expect(run.code).toBe(0);
    // The child really ran: its answer is in the parent's history.
    expect(run.stdout).toContain("the specialist answered");
    expect(run.stdout).not.toContain("delegation is not wired yet");
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

  it("pauses a high-risk call, then resumes the run that stopped on it", async () => {
    // A file-backed store on purpose: a paused run has to outlive the process
    // that paused it, which is the whole point of the feature.
    const dir = mkdtempSync(join(tmpdir(), "agent-e2e-pause-"));
    const db = join(dir, "agent.db");
    const session = "cli-e2e-pause";
    model = new StubModelServer({
      toolName: "fixture_fixture_deploy",
      toolInput: { target: "prod" },
      finalText: "deployed to prod",
    });
    const baseUrl = await model.start();
    const common = [
      "--server",
      serverSpec(),
      "--base-url",
      baseUrl,
      "--api-key",
      "test-key",
      "--no-ollama",
      "--no-stream",
      "--db",
      db,
      "--session",
      session,
      "--max-steps",
      "3",
    ];

    const paused = await runCli(["--prompt", "deploy to prod", "--pause", ...common]);

    // Exit 5: nothing failed, the run is waiting.
    expect(paused.code).toBe(5);
    expect(paused.stdout).toContain("[paused]");
    const id = /--resume (sus-[0-9a-f-]+)/.exec(paused.stdout)?.[1];
    expect(id).toBeTruthy();

    // The paused run is listed for the session — and listing needs no MCP server.
    const listed = await runCli(["--suspensions", "--db", db, "--session", session]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(id!);

    const resumed = await runCli(["--resume", id!, ...common]);

    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("[resume]");
    expect(resumed.stdout).toContain("deployed to prod");

    // Answered once: a replay of the same id is refused rather than re-run.
    const replay = await runCli(["--resume", id!, ...common]);
    expect(replay.code).not.toBe(0);
    expect(replay.stdout + replay.stderr).toContain("no resumable paused run");

    rmSync(dir, { recursive: true, force: true });
  }, 90_000);
});
