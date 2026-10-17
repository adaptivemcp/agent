import { describe, it, expect } from "vitest";
import { MemoryStore } from "@adaptivemcp/memory";
import type { Task } from "@adaptivemcp/spec";
import {
  PlanningPass,
  actionStep,
  actionSummary,
  formatSteps,
  goalOf,
  parsePlan,
  planMessage,
  planReasoning,
  planningMessages,
  recordedLines,
} from "./steps.js";
import { AgentRuntime } from "./runtime.js";
import type { ChatMessage, ChatModel, ChatStep, ToolSpec } from "./types.js";

function newStore(): MemoryStore {
  return new MemoryStore({ path: ":memory:" });
}

/** A model that answers with a fixed text and remembers what it was asked. */
class AnsweringModel implements ChatModel {
  readonly name = "answering";
  readonly calls: ChatMessage[][] = [];

  constructor(private readonly answer: string | Error = "ok") {}

  async step(messages: ChatMessage[]): Promise<ChatStep> {
    this.calls.push(messages);
    if (this.answer instanceof Error) throw this.answer;
    return { text: this.answer, toolCalls: [], finishReason: "stop" };
  }
}

function task(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    sessionId: "s1",
    kind: "task",
    title,
    status: "completed",
    dependencies: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("action steps", () => {
  it("says what happened, in the host's words", () => {
    expect(actionSummary("read_file", { ok: true })).toBe("read_file → ok");
    expect(actionSummary("read_file", { ok: true }, 12)).toBe("read_file → ok in 12ms");
    expect(actionSummary("write_file", { ok: false, error: "permission denied" })).toBe(
      "write_file → failed: permission denied",
    );
  });

  it("keeps a gate block and a pause distinct from a failure", () => {
    // The tool never ran, so these are not evidence about the tool — the wording
    // has to make that visible in the history, not just in the exit code.
    expect(actionSummary("deploy", { ok: false, executed: false, decision: "deny" })).toBe(
      "deploy → refused by the gate (deny)",
    );
    expect(
      actionSummary("deploy", {
        ok: false,
        executed: false,
        suspension: { id: "sus-1", question: "approve deploy?" },
      }),
    ).toBe("deploy → paused for approval (sus-1)");
  });

  it("bounds an error rather than copying it", () => {
    const summary = actionSummary("flaky", { ok: false, error: "x".repeat(1000) });
    expect(summary.length).toBeLessThan(260);
    expect(summary.endsWith("…")).toBe(true);
    // One line, whatever the tool said.
    expect(actionSummary("flaky", { ok: false, error: "a\nb\nc" })).toBe("flaky → failed: a b c");
  });

  it("builds a step whose error means the tool ran and failed", () => {
    const failed = actionStep({
      sessionId: "s1",
      tool: "write_file",
      result: { ok: false, error: "boom" },
      durationMs: 7,
      correlationId: "node-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "act-1",
    });
    expect(failed).toEqual({
      id: "act-1",
      sessionId: "s1",
      kind: "action",
      summary: "write_file → failed: boom",
      toolName: "write_file",
      createdAt: "2026-01-01T00:00:00.000Z",
      error: "boom",
      durationMs: 7,
      correlationId: "node-1",
    });

    // A refusal is not a failure: no `error`, just what happened.
    const blocked = actionStep({
      sessionId: "s1",
      tool: "deploy",
      result: { ok: false, executed: false, decision: "deny" },
      id: "act-2",
    });
    expect(blocked.error).toBeUndefined();
    expect(blocked.summary).toBe("deploy → refused by the gate (deny)");
    expect(blocked.durationMs).toBeUndefined();
  });
});

describe("reading a session's history back", () => {
  it("returns tasks, actions and plans as one ordered, typed sequence", () => {
    const store = newStore();
    store.recordTask(task("t1", "write the parser", { status: "in_progress" }));
    store.recordStep({
      id: "act-1",
      sessionId: "s1",
      kind: "action",
      summary: "read_file → ok in 3ms",
      toolName: "read_file",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    store.recordStep({
      id: "plan-1",
      sessionId: "s1",
      kind: "plan",
      steps: ["read the file", "report back"],
      createdAt: "2026-01-01T00:00:02.000Z",
    });

    // This is the acceptance criterion in one assertion: three kinds, one query,
    // in the order they happened, each still distinguishable.
    expect(store.getSteps("s1").map((step) => step.kind)).toEqual(["task", "action", "plan"]);

    expect(recordedLines(store.getSteps("s1"))).toEqual([
      "- task t1 [in_progress] write the parser",
      "- read_file → ok in 3ms",
      "- plan: read the file; report back",
    ]);
    store.close();
  });

  it("keeps a task's assignee and result in the line", () => {
    expect(
      recordedLines([
        task("t2", "audit", { assignee: "reviewer", result: "clean", status: "completed" }),
      ]),
    ).toEqual(["- task t2 [completed] audit (reviewer) → clean"]);
  });

  it("reads only the tail of a long history", () => {    const records = Array.from({ length: 60 }, (_, index) => ({
      id: `act-${index}`,
      sessionId: "s1",
      kind: "action" as const,
      summary: `call ${index}`,
      toolName: "t",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    const lines = recordedLines(records);
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe("- call 20");
    expect(lines.at(-1)).toBe("- call 59");
  });

  it("renders the same history for a human, one kind per column", () => {
    expect(
      formatSteps([
        task("t1", "write the parser", { status: "in_progress" }),
        {
          id: "act-1",
          sessionId: "s1",
          kind: "action",
          summary: "read_file → ok in 3ms",
          toolName: "read_file",
          createdAt: "2026-01-01T12:00:01.000Z",
        },
        {
          id: "plan-1",
          sessionId: "s1",
          kind: "plan",
          steps: ["read the file", "report back"],
          createdAt: "2026-01-01T12:00:02.000Z",
        },
      ]),
    ).toBe(
      [
        "00:00:00 task   t1 [in_progress] write the parser",
        "12:00:01 action read_file → ok in 3ms",
        "12:00:02 plan   plan-1: read the file; report back",
      ].join("\n"),
    );
    expect(formatSteps([])).toBe("(nothing recorded yet)");
  });
});

describe("the planning prompt", () => {
  it("carries the goal and what was recorded", () => {
    const messages = planningMessages("fix the parser", ["- task t1 [pending] write it"]);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("planning pass");
    expect(messages[1]?.content).toContain("Goal: fix the parser");
    expect(messages[1]?.content).toContain("Recorded so far (oldest first):");
    expect(messages[1]?.content).toContain("- task t1 [pending] write it");
  });

  it("says so when there is nothing to go on, and when there is no goal", () => {
    const messages = planningMessages("", []);
    expect(messages[1]?.content).toContain("Goal: (not stated)");
    expect(messages[1]?.content).toContain("Nothing has been recorded yet.");
  });

  it("takes the goal from the run's first user turn", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "the actual goal" },
      { role: "assistant", content: "working" },
      { role: "user", content: "an injected steer" },
    ];
    expect(goalOf(messages)).toBe("the actual goal");
    expect(goalOf([{ role: "system", content: "no user turn" }])).toBe("");
  });
});

describe("reading a plan out of a model's answer", () => {
  it("reads the JSON the prompt asks for", () => {
    expect(parsePlan('{"steps":["one","two"],"reasoning":"why"}')).toEqual({
      steps: ["one", "two"],
      reasoning: "why",
    });
  });

  it("reads through a fence, and through a sentence around it", () => {
    expect(parsePlan('```json\n{"steps":["fenced"]}\n```')).toEqual({ steps: ["fenced"] });
    expect(parsePlan('Sure!\n{"steps":["embedded"],"reasoning":"why"}\nHope that helps.')).toEqual({
      steps: ["embedded"],
      reasoning: "why",
    });
  });

  it("accepts a plain list when the model ignores the format", () => {
    expect(parsePlan("- read the parser\n- fix it\n").steps).toEqual(["read the parser", "fix it"]);
    expect(parsePlan("1. first\n2) second").steps).toEqual(["first", "second"]);
    // A JSON object without usable steps is still better read as prose than dropped.
    expect(parsePlan('{"steps":[]}')).toEqual({ steps: ['{"steps":[]}'] });
  });

  it("comes back empty rather than inventing a plan", () => {
    expect(parsePlan("   \n  ")).toEqual({ steps: [] });
  });

  it("formats a plan for injection, numbered and attributed", () => {
    const message = planMessage(
      {
        id: "plan-2",
        sessionId: "s1",
        kind: "plan",
        steps: ["read", "fix"],
        reasoning: "a re-plan at step 2",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      1,
    );
    expect(message).toBe(
      [
        "Plan (asked before step 2 — a re-plan at step 2):",
        "1. read",
        "2. fix",
        "Work to this plan, and re-plan if what you learn changes it.",
      ].join("\n"),
    );
  });

  it("says why the plan was produced", () => {
    expect(planReasoning(0, [])).toBe("the initial plan");
    expect(planReasoning(2, [])).toBe("a re-plan at step 2");
    const failed = actionStep({
      sessionId: "s1",
      tool: "write_file",
      result: { ok: false, error: "boom" },
      id: "act-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(planReasoning(1, [failed])).toBe("a re-plan at step 1, after write_file failed");
    // A *later* successful call is what the run last did, so it does not count as
    // "after a failure" — only the last action is asked.
    const ok = actionStep({
      sessionId: "s1",
      tool: "read_file",
      result: { ok: true },
      id: "act-2",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(planReasoning(1, [failed, ok])).toBe("a re-plan at step 1");
  });
});

describe("the planning pass", () => {
  const goal = [{ role: "user" as const, content: "fix the parser" }];

  it("plans before the first step, records the plan, and injects it", async () => {
    const store = newStore();
    const model = new AnsweringModel('{"steps":["read the parser","fix it"]}');
    const pass = new PlanningPass({
      model,
      store: () => store,
      session: "s1",
      interval: 3,
    });

    const injected = await pass.steer({ step: 0, messages: goal });

    expect(model.calls).toHaveLength(1);
    const steps = store.getSteps("s1", { kind: "plan" });
    expect(steps).toEqual([
      {
        id: "plan-1",
        sessionId: "s1",
        kind: "plan",
        steps: ["read the parser", "fix it"],
        reasoning: "the initial plan",
        createdAt: expect.any(String),
      },
    ]);
    expect(injected).toContain("1. read the parser");
    expect(injected).toContain("2. fix it");
    store.close();
  });

  it("re-plans on the interval only, and reads the recorded state", async () => {
    const store = newStore();
    const model = new AnsweringModel('{"steps":["again"]}');
    const pass = new PlanningPass({ model, store: () => store, session: "s1", interval: 2 });

    store.recordTask(task("t1", "write the parser", { status: "pending" }));

    // Off-interval steps cost nothing.
    expect(await pass.steer({ step: 1, messages: goal })).toBeUndefined();
    expect(model.calls).toHaveLength(0);

    // On-interval, the prompt carries what was *recorded* — the whole point of an
    // interval: it reads the record, not the conversation.
    const injected = await pass.steer({ step: 2, messages: goal });
    expect(injected).toContain("a re-plan at step 2");
    const prompt = model.calls[0]?.map((message) => message.content).join("\n") ?? "";
    expect(prompt).toContain("- task t1 [pending] write the parser");
    expect(store.getSteps("s1", { kind: "plan" })).toHaveLength(1);
    store.close();
  });

  it("numbers plans without colliding with one already recorded", async () => {
    const store = newStore();
    store.recordStep({
      id: "plan-1",
      sessionId: "s1",
      kind: "plan",
      steps: ["from an earlier run"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const pass = new PlanningPass({
      model: new AnsweringModel('{"steps":["next"]}'),
      store: () => store,
      session: "s1",
      interval: 1,
    });

    await pass.steer({ step: 0, messages: goal });

    expect(store.getSteps("s1", { kind: "plan" }).map((step) => step.id)).toEqual([
      "plan-1",
      "plan-2",
    ]);
    store.close();
  });

  it("does nothing without a store to record in", async () => {
    const model = new AnsweringModel('{"steps":["x"]}');
    const pass = new PlanningPass({
      model,
      store: () => undefined,
      session: "s1",
      interval: 1,
    });

    expect(await pass.steer({ step: 0, messages: goal })).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  it("is off for an interval below one", async () => {
    const store = newStore();
    const model = new AnsweringModel('{"steps":["x"]}');
    const pass = new PlanningPass({ model, store: () => store, session: "s1", interval: 0 });

    expect(await pass.steer({ step: 0, messages: goal })).toBeUndefined();
    expect(model.calls).toHaveLength(0);
    store.close();
  });

  it("reports a model failure and lets the step proceed unplanned", async () => {
    const store = newStore();
    const errors: unknown[] = [];
    const pass = new PlanningPass({
      model: new AnsweringModel(new Error("backend down")),
      store: () => store,
      session: "s1",
      interval: 1,
      onError: (error) => errors.push(error),
    });

    expect(await pass.steer({ step: 0, messages: goal })).toBeUndefined();
    expect((errors[0] as Error).message).toBe("backend down");
    expect(store.getSteps("s1")).toEqual([]);
    store.close();
  });

  it("reports an unusable answer rather than recording an empty plan", async () => {
    const store = newStore();
    const errors: unknown[] = [];
    const pass = new PlanningPass({
      model: new AnsweringModel("   "),
      store: () => store,
      session: "s1",
      interval: 1,
      onError: (error) => errors.push(error),
    });

    expect(await pass.steer({ step: 0, messages: goal })).toBeUndefined();
    expect((errors[0] as Error).message).toContain("no usable steps");
    expect(store.getSteps("s1")).toEqual([]);
    store.close();
  });
});

describe("the runtime records actions", () => {
  const spec: ToolSpec = { name: "read_file", inputSchema: {} };

  it("writes one step per call, with the outcome the caller saw", async () => {
    const store = newStore();
    const runtime = new AgentRuntime({
      store,
      sessionId: "s1",
      requestApproval: () => true,
      invoke: async (_name, input) => ({ ok: true, output: { echoed: input } }),
    });

    await runtime.execute({ id: "c1", name: "read_file", input: { path: "a" } }, spec);

    const steps = store.getSteps("s1", { kind: "action" });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: "action",
      toolName: "read_file",
      sessionId: "s1",
    });
    expect((steps[0] as { summary: string }).summary).toMatch(/^read_file → ok in \d+ms$/);
    runtime.close();
  });

  it("records a failure as an error step", async () => {
    const store = newStore();
    const runtime = new AgentRuntime({
      store,
      sessionId: "s1",
      requestApproval: () => true,
      invoke: async () => ({ ok: false, error: "disk full" }),
    });

    await runtime.execute({ id: "c1", name: "read_file", input: {} }, spec);

    const step = store.getSteps("s1", { kind: "action" })[0];
    expect(step).toMatchObject({ summary: "read_file → failed: disk full", error: "disk full" });
    runtime.close();
  });

  it("records a gate block as an attempt, without calling it a failure", async () => {
    const store = newStore();
    const runtime = new AgentRuntime({
      store,
      sessionId: "s1",
      // No approver: a confirmation is denied (fail closed).
      invoke: async () => ({ ok: true, output: "ran" }),
    });
    runtime.seedToolAnnotations([spec], { defaultRisk: "high" });

    const result = await runtime.execute({ id: "c1", name: "read_file", input: {} }, spec);

    expect(result.executed).toBe(false);
    const step = store.getSteps("s1", { kind: "action" })[0];
    expect(step).toMatchObject({ toolName: "read_file" });
    expect((step as { summary: string }).summary).toContain("refused by the gate");
    // Not a tool failure: the learned reliability signal must not see one.
    expect((step as { error?: string }).error).toBeUndefined();
    runtime.close();
  });

  it("records a paused call the same way", async () => {
    const store = newStore();
    const runtime = new AgentRuntime({
      store,
      sessionId: "s1",
      pauseOnApproval: true,
      invoke: async () => ({ ok: true, output: "ran" }),
    });
    runtime.seedToolAnnotations([spec], { defaultRisk: "high" });

    const result = await runtime.execute({ id: "c1", name: "read_file", input: {} }, spec);

    expect(result.suspension).toBeDefined();
    const step = store.getSteps("s1", { kind: "action" })[0];
    expect((step as { summary: string }).summary).toContain("paused for approval");
    expect((step as { error?: string }).error).toBeUndefined();
    runtime.close();
  });

  it("skips recording on a store that cannot hold steps", async () => {
    // A store from before typed steps existed, or a host's own store: the call
    // must run exactly as it did, with the step simply not recorded.
    const store = newStore();
    (store as { recordStep?: unknown }).recordStep = undefined;
    const runtime = new AgentRuntime({
      store,
      sessionId: "s1",
      requestApproval: () => true,
      invoke: async () => ({ ok: true, output: "ran" }),
    });

    const result = await runtime.execute({ id: "c1", name: "read_file", input: {} }, spec);

    expect(result.ok).toBe(true);
    expect(store.getSteps("s1")).toEqual([]);
    runtime.close();
  });
});
