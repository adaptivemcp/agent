import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { runRepl } from "./repl.js";
import type { ChatModel, ChatStep, DecisionProvider, ToolSpec } from "./types.js";

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

const NOOP_EXECUTOR = { execute: async () => ({ ok: true, output: {} }) } as never;

const DECISION_MODEL = new ScriptedModel("gpt-4o-mini");
const DEPLOY_TOOL: ToolSpec = { name: "deploy_service", description: "Deploy a service" };

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
});
