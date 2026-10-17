import { describe, it, expect } from "vitest";
import { MemoryStore } from "@adaptivemcp/memory";
import type { Store, Task } from "@adaptivemcp/spec";
import {
  CREATE_TASK_TOOL,
  LIST_TASKS_TOOL,
  UPDATE_TASK_TOOL,
  TASK_STATUSES,
  taskView,
  tasksPrompt,
  tasksToolset,
  type TaskView,
} from "./tasks.js";
import type { McpToolResult, Toolset } from "./mcp/toolset.js";

const SESSION = "s1";

/** The real store, in memory: dependency ordering is the store's read, not ours. */
function newStore(): MemoryStore {
  return new MemoryStore({ path: ":memory:" });
}

function toolset(store: Store | (() => Store | undefined), session = SESSION): Toolset {
  return tasksToolset({
    store: typeof store === "function" ? store : () => store,
    session,
  });
}

async function call(ts: Toolset, name: string, input: unknown = {}): Promise<McpToolResult> {
  return ts.callTool(name, input);
}

/** Call expecting success, and hand back the output typed as the tool promises. */
async function ok<T>(ts: Toolset, name: string, input: unknown = {}): Promise<T> {
  const result = await call(ts, name, input);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);
  return result.output as T;
}

/** Call expecting a refusal, and hand back what it said. */
async function fail(ts: Toolset, name: string, input: unknown = {}): Promise<string> {
  const result = await call(ts, name, input);
  expect(result.ok).toBe(false);
  return result.error ?? "";
}

interface CreateOut {
  task: TaskView;
  unknownDependencies?: string[];
  note?: string;
}

interface ListOut {
  count: number;
  tasks: TaskView[];
  note?: string;
}

interface UpdateOut {
  task: TaskView;
  unmetDependencies?: string[];
  unblocked?: TaskView[];
  note?: string;
}

describe("task list tools", () => {
  it("exposes create, list and update under one server", async () => {
    const ts = toolset(newStore());
    const tools = await ts.listTools();

    expect(ts.serverName).toBe("tasks");
    expect(tools.map((tool) => tool.name)).toEqual([
      CREATE_TASK_TOOL,
      LIST_TASKS_TOOL,
      UPDATE_TASK_TOOL,
    ]);
    expect(tools.find((tool) => tool.name === CREATE_TASK_TOOL)?.inputSchema).toMatchObject({
      required: ["title"],
    });
    expect(tools.find((tool) => tool.name === UPDATE_TASK_TOOL)?.inputSchema).toMatchObject({
      required: ["id"],
      properties: { status: { enum: [...TASK_STATUSES] } },
    });
  });

  it("records a task as pending, in the calling session", async () => {
    const store = newStore();
    const ts = toolset(store);

    const out = await ok<CreateOut>(ts, CREATE_TASK_TOOL, {
      title: "  write the parser  ",
      description: "the wire format first",
      assignee: "spec-writer",
    });

    expect(out.task).toMatchObject({
      id: "t1",
      title: "write the parser",
      status: "pending",
      assignee: "spec-writer",
    });
    expect(store.getTask?.("t1")).toMatchObject({
      sessionId: SESSION,
      kind: "task",
      description: "the wire format first",
    });
  });

  it("numbers ids past anything already taken", async () => {
    const store = newStore();
    const ts = toolset(store);

    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "first" });
    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "second" });
    // A task recorded outside the toolset (a resumed run, another writer) must
    // not be overwritten by the next id the toolset hands out.
    store.recordTask?.({
      id: "t3",
      sessionId: SESSION,
      kind: "task",
      title: "recorded elsewhere",
      status: "pending",
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const out = await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "third" });
    expect(out.task.id).toBe("t4");
  });

  it("tells the model when a dependency names no task", async () => {
    const ts = toolset(newStore());

    const out = await ok<CreateOut>(ts, CREATE_TASK_TOOL, {
      title: "deploy",
      dependsOn: ["t1"],
    });

    expect(out.task.dependencies).toEqual(["t1"]);
    expect(out.unknownDependencies).toEqual(["t1"]);
    expect(out.note).toContain("t1");
  });

  it("lists one session's tasks, and only that session's", async () => {
    const store = newStore();
    await ok<CreateOut>(toolset(store), CREATE_TASK_TOOL, { title: "mine" });

    const other = toolset(store, "s2");
    const empty = await ok<ListOut>(other, LIST_TASKS_TOOL);
    expect(empty).toMatchObject({ count: 0, tasks: [] });

    const mine = await ok<ListOut>(toolset(store), LIST_TASKS_TOOL);
    expect(mine.count).toBe(1);
    expect(mine.tasks[0]?.title).toBe("mine");
  });

  it("keeps what can start now behind what it depends on", async () => {
    const ts = toolset(newStore());
    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "design" });
    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "build", dependsOn: ["t1"] });
    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "ship", dependsOn: ["t2"] });

    const first = await ok<ListOut>(ts, LIST_TASKS_TOOL, { ready: true });
    expect(first.tasks.map((task) => task.id)).toEqual(["t1"]);
    expect(first.note).toBeDefined();

    const done = await ok<UpdateOut>(ts, UPDATE_TASK_TOOL, { id: "t1", status: "completed" });
    expect(done.unblocked?.map((task) => task.id)).toEqual(["t2"]);

    const second = await ok<ListOut>(ts, LIST_TASKS_TOOL, { ready: true });
    expect(second.tasks.map((task) => task.id)).toEqual(["t2"]);
  });

  it("filters the list by status and assignee", async () => {
    const ts = toolset(newStore());
    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "one", assignee: "ann" });
    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "two", assignee: "bob" });
    await ok<UpdateOut>(ts, UPDATE_TASK_TOOL, { id: "t2", status: "in_progress" });

    const mine = await ok<ListOut>(ts, LIST_TASKS_TOOL, { assignee: "bob" });
    expect(mine.tasks.map((task) => task.title)).toEqual(["two"]);

    const running = await ok<ListOut>(ts, LIST_TASKS_TOOL, { status: "in_progress" });
    expect(running.tasks.map((task) => task.id)).toEqual(["t2"]);

    const ready = await ok<ListOut>(ts, LIST_TASKS_TOOL, { ready: true, assignee: "bob" });
    expect(ready.tasks).toEqual([]);
  });

  it("moves a task along: assign, start, finish with a result", async () => {
    const ts = toolset(newStore());
    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "review the patch" });

    const assigned = await ok<UpdateOut>(ts, UPDATE_TASK_TOOL, { id: "t1", assignee: "sam" });
    expect(assigned.task.assignee).toBe("sam");

    const started = await ok<UpdateOut>(ts, UPDATE_TASK_TOOL, { id: "t1", status: "in_progress" });
    expect(started.task.status).toBe("in_progress");

    const finished = await ok<UpdateOut>(ts, UPDATE_TASK_TOOL, {
      id: "t1",
      status: "completed",
      result: "two findings, both fixed",
      notes: "follow-up: add a regression test",
    });
    expect(finished.task).toMatchObject({
      status: "completed",
      result: "two findings, both fixed",
      notes: "follow-up: add a regression test",
    });
    expect(finished.task.updatedAt).toBeDefined();
  });

  it("says which dependency is still unmet", async () => {
    const ts = toolset(newStore());
    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "design" });
    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "build", dependsOn: ["t1"] });

    const jumped = await ok<UpdateOut>(ts, UPDATE_TASK_TOOL, { id: "t2", status: "in_progress" });
    expect(jumped.unmetDependencies).toEqual(["t1"]);
    expect(jumped.note).toContain("t1");
  });

  it("refuses an unknown task id, and names the ids it knows", async () => {
    const ts = toolset(newStore());
    const empty = await fail(ts, UPDATE_TASK_TOOL, { id: "t1", status: "completed" });
    expect(empty).toContain("list is empty");

    await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: "one" });
    const wrong = await fail(ts, UPDATE_TASK_TOOL, { id: "t9", status: "completed" });
    expect(wrong).toContain("t9");
    expect(wrong).toContain("known ids: t1");
  });

  it("refuses malformed input rather than guessing", async () => {
    const ts = toolset(newStore());

    expect(await fail(ts, CREATE_TASK_TOOL, "not an object")).toContain("object");
    expect(await fail(ts, CREATE_TASK_TOOL, {})).toContain("title");
    expect(await fail(ts, CREATE_TASK_TOOL, { title: "  " })).toContain("empty");
    expect(await fail(ts, CREATE_TASK_TOOL, { title: "x", dependsOn: "t1" })).toContain("array");
    expect(await fail(ts, CREATE_TASK_TOOL, { title: "x", dependsOn: [7] })).toContain("string");

    expect(await fail(ts, LIST_TASKS_TOOL, { status: "urgent" })).toContain("pending");
    expect(await fail(ts, LIST_TASKS_TOOL, { ready: "yes" })).toContain("true or false");

    expect(await fail(ts, UPDATE_TASK_TOOL, { id: "t1" })).toContain("nothing to update");
    expect(await fail(ts, UPDATE_TASK_TOOL, { id: "t1", status: "done" })).toContain("status");
    expect(await fail(ts, UPDATE_TASK_TOOL, { id: "", status: "completed" })).toContain("empty");
    expect(await fail(ts, UPDATE_TASK_TOOL, { id: "t1", result: 7 })).toContain("result");

    expect(await fail(ts, "archive", { id: "t1" })).toContain("unknown tool");
  });

  it("says so when the run has no store", async () => {
    const ts = toolset(() => undefined);
    expect(await fail(ts, CREATE_TASK_TOOL, { title: "x" })).toContain("no store");
    expect(await fail(ts, LIST_TASKS_TOOL)).toContain("no store");
    expect(await fail(ts, UPDATE_TASK_TOOL, { id: "t1", status: "completed" })).toContain("no store");
  });

  it("says so when the store cannot hold a task list", async () => {
    // `Store`'s task methods are optional: a store that predates them is valid.
    const ts = toolset({} as unknown as Store);
    expect(await fail(ts, CREATE_TASK_TOOL, { title: "x" })).toContain("does not support");
    expect(await fail(ts, LIST_TASKS_TOOL)).toContain("does not support");
    expect(await fail(ts, LIST_TASKS_TOOL, { ready: true })).toContain("does not support");
    expect(await fail(ts, UPDATE_TASK_TOOL, { id: "t1", status: "completed" })).toContain(
      "does not support",
    );
  });

  it("stops a list from growing without bound", async () => {
    const ts = toolset(newStore());
    for (let n = 0; n < 100; n += 1) {
      await ok<CreateOut>(ts, CREATE_TASK_TOOL, { title: `task ${n}` });
    }
    expect(await fail(ts, CREATE_TASK_TOOL, { title: "one too many" })).toContain("100 tasks");
  });

  it("narrows a stored task to what the model needs", () => {
    const bare: Task = {
      id: "t1",
      sessionId: SESSION,
      kind: "task",
      title: "bare",
      status: "pending",
      dependencies: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(taskView(bare)).toEqual({ id: "t1", title: "bare", status: "pending" });

    const full: Task = {
      ...bare,
      description: "with everything set",
      assignee: "ann",
      dependencies: ["t0"],
      parentId: "t0",
      result: "done",
      notes: "a note",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    expect(taskView(full)).toEqual({
      id: "t1",
      title: "bare",
      status: "pending",
      dependencies: ["t0"],
      assignee: "ann",
      parentId: "t0",
      result: "done",
      notes: "a note",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("describes the list for the system prompt", () => {
    const prompt = tasksPrompt();
    expect(prompt).toContain("tasks_list");
    expect(prompt).toContain("ready: true");
  });
});
