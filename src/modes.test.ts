import { describe, it, expect } from "vitest";
import { MemoryStore } from "@adaptivemcp/memory";
import type { Store, Task } from "@adaptivemcp/spec";
import {
  ORCHESTRATION_MODES,
  isOrchestrationMode,
  modePrompt,
  modeTools,
  tasksStopGuard,
} from "./modes.js";

function newStore(): MemoryStore {
  return new MemoryStore({ path: ":memory:" });
}

/** A task in the state the test cares about. */
function task(id: string, status: Task["status"], title = `task ${id}`): Task {
  return {
    id,
    sessionId: "s1",
    kind: "task",
    title,
    status,
    dependencies: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("orchestration modes", () => {
  it("knows exactly the modes the catalogue names", () => {
    expect([...ORCHESTRATION_MODES]).toEqual(["coordinate", "route", "broadcast", "tasks"]);
    for (const mode of ORCHESTRATION_MODES) expect(isOrchestrationMode(mode)).toBe(true);
    // Case matters and a near-miss is not a mode: a typo must fail as usage.
    for (const value of ["", "Coordinate", "supervisor", "task"]) {
      expect(isOrchestrationMode(value)).toBe(false);
    }
  });

  it("implies delegation for every mode, and the list for `tasks`", () => {
    expect(modeTools("coordinate")).toEqual({ task: true, tasks: false });
    expect(modeTools("route")).toEqual({ task: true, tasks: false });
    expect(modeTools("broadcast")).toEqual({ task: true, tasks: false });
    expect(modeTools("tasks")).toEqual({ task: true, tasks: true });
  });

  it("says what the shape of the work is, per mode", () => {
    expect(modePrompt("coordinate")).toContain("synthesise");
    // `route` is the anti-supervisor: one specialist, and its answer stands.
    expect(modePrompt("route")).toContain("single");
    expect(modePrompt("route")).toContain("Do not re-write");
    // `broadcast` is the same request to everyone, reported separately.
    expect(modePrompt("broadcast")).toContain("background: true");
    expect(modePrompt("broadcast")).toContain("do not merge");
    // `tasks` names the tools it expects and the rule that ends the run.
    expect(modePrompt("tasks")).toContain("tasks_create");
    expect(modePrompt("tasks")).toContain("tasks_update");
    expect(modePrompt("tasks")).toContain("cancelled");

    const prompts = ORCHESTRATION_MODES.map((mode) => modePrompt(mode));
    expect(new Set(prompts).size).toBe(prompts.length);
    for (const prompt of prompts) expect(prompt.length).toBeGreaterThan(50);
  });

  describe("the `tasks` stop guard", () => {
    it("says nothing when the run has no store", () => {
      expect(tasksStopGuard({ store: () => undefined, session: "s1" })({ step: 0, messages: [] })).toBeUndefined();
    });

    it("says nothing when nothing was planned", async () => {
      const store = newStore();
      const guard = tasksStopGuard({ store: () => store, session: "s1" });
      expect(await guard({ step: 3, messages: [] })).toBeUndefined();
      store.close();
    });

    it("holds the run open while a task is neither done nor abandoned", async () => {
      const store = newStore();
      for (const entry of [
        task("t1", "completed"),
        task("t2", "in_progress", "write the parser"),
        task("t3", "pending"),
        task("t4", "failed"),
        task("t5", "cancelled"),
      ]) {
        store.recordTask(entry);
      }
      const guard = tasksStopGuard({ store: () => store, session: "s1" });

      const message = await guard({ step: 4, messages: [] });

      // The two open tasks are named, with their state, and the way out is stated.
      expect(message).toContain("t2");
      expect(message).toContain("[in_progress]");
      expect(message).toContain("write the parser");
      expect(message).toContain("t3");
      // Terminal states do not hold the run open.
      expect(message).not.toContain("t1");
      expect(message).not.toContain("t4");
      expect(message).not.toContain("t5");
      expect(message).toContain("cancelled");

      store.close();
    });

    it("lets the run finish once every task is terminal", async () => {
      const store = newStore();
      for (const entry of [
        task("t1", "completed"),
        task("t2", "failed"),
        task("t3", "cancelled"),
      ]) {
        store.recordTask(entry);
      }
      const guard = tasksStopGuard({ store: () => store, session: "s1" });

      expect(await guard({ step: 2, messages: [] })).toBeUndefined();
      store.close();
    });

    it("reads only the session it was built for", async () => {
      const store = newStore();
      store.recordTask({ ...task("t1", "pending"), sessionId: "other" });
      const guard = tasksStopGuard({ store: () => store, session: "s1" });

      expect(await guard({ step: 1, messages: [] })).toBeUndefined();
      store.close();
    });

    it("treats a store without the task methods as an empty list", async () => {
      const bare = {} as unknown as Store;
      const guard = tasksStopGuard({ store: () => bare, session: "s1" });
      expect(await guard({ step: 1, messages: [] })).toBeUndefined();
    });
  });
});
