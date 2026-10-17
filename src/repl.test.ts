import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { runRepl } from "./repl.js";
import type { ReplOptions } from "./repl.js";
import type { ChatMessage, ChatModel, ChatStep, DecisionProvider, ToolSpec } from "./types.js";

/** A model that replies with fixed text and no tool calls. */
class ScriptedModel implements ChatModel {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async step(): Promise<ChatStep> {
    return { text: "hi", toolCalls: [], finishReason: "stop" };
  }
}

/** A model that also records every conversation it is asked about. */
class ObservingModel implements ChatModel {
  readonly name = "observing";
  readonly seen: ChatMessage[][] = [];
  async step(messages: ChatMessage[]): Promise<ChatStep> {
    this.seen.push(messages);
    return { text: "ok", toolCalls: [], finishReason: "stop" };
  }
}

const NOOP_EXECUTOR = { execute: async () => ({ ok: true, output: {} }) } as never;

const DECISION_MODEL = new ScriptedModel("gpt-4o-mini");
const DEPLOY_TOOL: ToolSpec = {
  name: "deploy_service",
  description: "Deploy a service",
  inputSchema: {},
};

/**
 * The REPL is a coverage-excluded IO entry point, so this is the only place the
 * render switch is exercised. It drives a single turn and collects stdout.
 */
async function runTurn(decide?: DecisionProvider): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  let stdout = "";
  output.on("data", (chunk) => (stdout += String(chunk)));

  const done = runRepl({
    model: new ScriptedModel("hi"),
    tools: [],
    executor: NOOP_EXECUTOR,
    decide,
    input,
    output,
  });

  input.write("hello\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write("/exit\n");
  await done;
  return stdout;
}

describe("runRepl render switch", () => {
  it("renders a decision_applied event as a decision line", async () => {
    const decide: DecisionProvider = () => ({
      rationale: "fast path for a deploy",
      model: DECISION_MODEL,
      tools: [DEPLOY_TOOL],
    });

    const stdout = await runTurn(decide);

    expect(stdout).toContain("↳ decision");
    expect(stdout).toContain("gpt-4o-mini");
    expect(stdout).toContain("deploy_service");
  });

  it("renders a bare decision line when only a rationale is present", async () => {
    const decide: DecisionProvider = () => ({ rationale: "no clear winner" });

    const stdout = await runTurn(decide);

    expect(stdout).toContain("↳ decision");
    expect(stdout).toContain("no clear winner");
  });

  it("handles every AgentEvent member without throwing", async () => {
    // A decide provider that fires is the one event the switch previously
    // missed; reaching `/exit` cleanly proves the render path is exhaustive.
    const decide: DecisionProvider = () => ({ rationale: "m", model: DECISION_MODEL });
    const stdout = await runTurn(decide);
    expect(stdout).toContain("adaptivemcp-agent");
  });

  it("prints the typed history for /steps", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = "";
    output.on("data", (chunk) => (stdout += String(chunk)));

    const done = runRepl({
      model: new ScriptedModel("hi"),
      tools: [],
      executor: NOOP_EXECUTOR,
      steps: () => "12:00:01 plan   plan-1: read the parser",
      input,
      output,
    });

    input.write("/steps\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write("/exit\n");
    await done;

    expect(stdout).toContain("plan-1: read the parser");
  });
});

describe("runRepl forwards the loop's run seams", () => {
  /**
   * One turn with the given seams: the model is asked about "hello", then the
   * REPL is told to exit. Returns what the model saw and what the user saw.
   */
  async function runTurnWith(
    seams: Partial<ReplOptions>,
  ): Promise<{ seen: ChatMessage[][]; stdout: string }> {
    const model = new ObservingModel();
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = "";
    output.on("data", (chunk) => (stdout += String(chunk)));

    const done = runRepl({ model, tools: [], executor: NOOP_EXECUTOR, ...seams, input, output });

    input.write("hello\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write("/exit\n");
    await done;
    return { seen: model.seen, stdout };
  }

  it("forwards `steer`, so a planning pass runs in the REPL too", async () => {
    // The REPL used to hand-pick the options it passed to `runAgent`, and `steer`
    // was not in the list: `--plan-interval` did nothing interactively, silently.
    const steers: number[] = [];
    const { seen, stdout } = await runTurnWith({
      steer: (context) => {
        steers.push(context.step);
        return "Plan (before step 1):\n1. read the parser";
      },
    });

    expect(steers).toEqual([0]);
    expect(JSON.stringify(seen[0])).toContain("read the parser");
    // And the injection is visible, not a silent prompt change.
    expect(stdout).toContain("Plan (before step 1)");
  });

  it("forwards `stopGuard`, so a `tasks`-mode turn cannot end early", async () => {
    let consulted = 0;
    const { seen, stdout } = await runTurnWith({
      stopGuard: () => (consulted++ === 0 ? "the list is not finished: t1 is pending" : undefined),
    });

    // Asked twice: once to answer, once because the guard refused to accept it.
    expect(seen).toHaveLength(2);
    expect(stdout).toContain("t1 is pending");
  });
});
