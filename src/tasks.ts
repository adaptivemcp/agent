/**
 * The shared task list: the `tasks` tools.
 *
 * ADR-004 puts the *record* in `spec` and the *policy* in the host. `Task` and
 * `TaskStatus` fix what a task looks like and `memory` persists it; deciding what
 * to plan, who does it and when it is finished is ours. This module is that
 * policy — the three tools a leader needs to keep a list the whole run can see:
 *
 * - `tasks_create` — write down intended work, with the ids it depends on;
 * - `tasks_list` — read the list back, or only what is *ready* to start;
 * - `tasks_update` — move a task along: assign it, finish it, fail it, drop it.
 *
 * The list lives in the store, so a paused or interrupted run keeps its plan and
 * a resumed run reads the same list. `readyTasks` is the dependency read that
 * says what may start next: a dependency that is not `completed` — including an
 * id that matches no task at all, so a typo — **blocks** rather than unblocks.
 *
 * Transitions are deliberately not policed. A host that can suspend a run needs
 * `cancelled`, and real work does not follow a strict order, so a rule that
 * refused, say, completing a task before its dependency would block a model on
 * something it cannot see. The tools *report* the consequences instead: a create
 * that named an unknown dependency, an update that leaves a dependency unmet, a
 * completion that unblocked something. Telemetry already records what happened;
 * this is where the run says what it *intends*, in the same store.
 */
import type { Store, Task, TaskPatch, TaskStatus } from "@adaptivemcp/spec";
import type { McpToolResult, Toolset } from "./mcp/toolset.js";
import type { ToolSpec } from "./types.js";

/** Tool names; the aggregate namespaces them `tasks_create`, `tasks_list`, `tasks_update`. */
export const CREATE_TASK_TOOL = "create";
export const LIST_TASKS_TOOL = "list";
export const UPDATE_TASK_TOOL = "update";

const SERVER_NAME = "tasks";

/** Every status `spec` defines, in lifecycle order (used to validate input). */
export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

/** How many tasks a single session may hold, so a list cannot grow without bound. */
const MAX_TASKS = 100;

/**
 * The system-prompt paragraph for `--tasks`: what the list is for, and the order
 * to use it in. Kept next to the tools so the two cannot drift.
 */
export function tasksPrompt(): string {
  return [
    "You keep a shared, persisted task list with the `tasks_*` tools. For any work that spans more than",
    "a couple of steps, write down what you intend before doing it, mark a task `in_progress` when you",
    "start, record its `result` when it is done, and read `tasks_list` with `ready: true` when you need",
    "the next thing to do. Ordering is yours to express through `dependsOn`. The list lives in the run's",
    "store, not in this conversation, so a resumed run reads the same plan.",
  ].join(" ");
}

/**
 * A task as it reads back to the model: the id to reference, the state that
 * matters, and nothing else. `sessionId`/`kind`/`createdAt` are ours, not its.
 */
export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  assignee?: string;
  dependencies?: string[];
  parentId?: string;
  result?: string;
  notes?: string;
  updatedAt?: string;
}

/** Narrow a stored task to the view, dropping absent fields rather than nulling them. */
export function taskView(task: Task): TaskView {
  const view: TaskView = { id: task.id, title: task.title, status: task.status };
  if (task.assignee) view.assignee = task.assignee;
  if (task.dependencies.length > 0) view.dependencies = task.dependencies;
  if (task.parentId) view.parentId = task.parentId;
  if (task.result) view.result = task.result;
  if (task.notes) view.notes = task.notes;
  if (task.updatedAt) view.updatedAt = task.updatedAt;
  return view;
}

export interface TasksOptions {
  /**
   * The store that owns the list — the same store the runtime records telemetry
   * in, so a delegated child (which shares it) sees the parent's list. Read at
   * call time: the runtime that opens the store is built *after* the tool list
   * the model sees, the same reason delegation reads its tool list lazily.
   */
  store: () => Store | undefined;
  /** The session whose list these tools read and write. */
  session: string;
}

/**
 * Expose the shared task list as ordinary tools, so keeping the plan takes the
 * normal path: the approval gate, telemetry, and the execution graph all see it
 * like any other call.
 */
export function tasksToolset(options: TasksOptions): Toolset {
  const { store: openStore, session } = options;

  /** This run has no store at all, so there is nowhere to keep a list. */
  const noStore = (): McpToolResult => ({
    ok: false,
    error: "this run has no store to keep a shared task list in",
  });

  /** The store must implement the task methods; a store that cannot, says so. */
  const missing = (what: string): McpToolResult => ({
    ok: false,
    error: `this session's store does not support the shared task list (no ${what})`,
  });

  /** Read this session's tasks, when the store can. */
  const tasksOf = (store: Store): Task[] => store.getTasks?.(session) ?? [];

  /** The tasks that may start now: pending, every dependency completed. */
  const readyOf = (store: Store): Task[] => store.readyTasks?.(session) ?? [];

  /** A readable id: `t1`, `t2`, … skipping anything already taken. */
  const nextId = (store: Store): string => {
    const taken = new Set(tasksOf(store).map((task) => task.id));
    for (let n = taken.size + 1; ; n += 1) {
      const candidate = `t${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  };

  /** Tasks that named `id` as a dependency and are now ready to start. */
  const unblockedBy = (store: Store, id: string): TaskView[] => {
    const ready = new Set(readyOf(store).map((task) => task.id));
    return tasksOf(store)
      .filter((task) => task.dependencies.includes(id) && ready.has(task.id))
      .map(taskView);
  };

  /** The dependencies of a task that are not completed yet (a typo counts). */
  const unmetDependencies = (store: Store, task: Task): string[] => {
    const byId = new Map(tasksOf(store).map((known) => [known.id, known]));
    return task.dependencies.filter((id) => byId.get(id)?.status !== "completed");
  };

  return {
    serverName: SERVER_NAME,

    async listTools(): Promise<ToolSpec[]> {
      return [
        {
          name: CREATE_TASK_TOOL,
          description: CREATE_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "What the task is, in one line." },
              description: {
                type: "string",
                description: "Anything the task needs that the title cannot carry.",
              },
              assignee: {
                type: "string",
                description:
                  "Who is doing it: a specialist name, a role, or a person. Free-form; " +
                  "the agent acts on it by delegating with that name.",
              },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description:
                  "Ids of tasks that must be completed before this one can start. An id " +
                  "that names no task blocks it, so a typo is visible rather than skipped.",
              },
              parentId: {
                type: "string",
                description: "Groups this task under a parent task (a sub-task).",
              },
            },
            required: ["title"],
          },
          serverName: SERVER_NAME,
        },
        {
          name: LIST_TASKS_TOOL,
          description: LIST_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              status: { type: "string", enum: [...TASK_STATUSES], description: "Only this status." },
              assignee: { type: "string", description: "Only this assignee." },
              ready: {
                type: "boolean",
                description:
                  "Only the tasks that may start now: pending, with every dependency completed.",
              },
            },
          },
          serverName: SERVER_NAME,
        },
        {
          name: UPDATE_TASK_TOOL,
          description: UPDATE_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "The task id, as returned by the other tools." },
              status: {
                type: "string",
                enum: [...TASK_STATUSES],
                description:
                  "in_progress when starting, completed when done, failed when it did not " +
                  "work, cancelled when it is no longer wanted, blocked when it waits on " +
                  "something outside this list.",
              },
              assignee: { type: "string", description: "Who is doing it now." },
              result: { type: "string", description: "What the task produced, once it is done." },
              notes: { type: "string", description: "Anything worth recording on the task." },
            },
            required: ["id"],
          },
          serverName: SERVER_NAME,
        },
      ];
    },

    async callTool(name, input): Promise<McpToolResult> {
      switch (name) {
        case CREATE_TASK_TOOL:
          return createTask(input);
        case LIST_TASKS_TOOL:
          return listTasks(input);
        case UPDATE_TASK_TOOL:
          return updateTask(input);
        default:
          return { ok: false, error: `unknown tool: ${name}` };
      }
    },

    async close(): Promise<void> {
      // Nothing to release: the list is persisted by the store, not held here.
    },
  };

  /** Create a task, warn about any dependency id that names nothing. */
  function createTask(input: unknown): McpToolResult {
    const parsed = readCreate(input);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    const store = openStore();
    if (!store) return noStore();
    if (!store.recordTask) return missing("recordTask");

    const existing = tasksOf(store);
    if (existing.length >= MAX_TASKS) {
      return { ok: false, error: `this session already has ${MAX_TASKS} tasks; finish or cancel some first` };
    }

    const task: Task = {
      id: nextId(store),
      sessionId: session,
      kind: "task",
      title: parsed.title,
      status: "pending",
      dependencies: parsed.dependsOn ?? [],
      createdAt: new Date().toISOString(),
    };
    if (parsed.description) task.description = parsed.description;
    if (parsed.assignee) task.assignee = parsed.assignee;
    if (parsed.parentId) task.parentId = parsed.parentId;

    const recorded = store.recordTask(task);
    const known = new Set(existing.map((knownTask) => knownTask.id));
    const unknown = recorded.dependencies.filter((id) => !known.has(id));

    return {
      ok: true,
      output: {
        task: taskView(recorded),
        ...(unknown.length > 0 ? { unknownDependencies: unknown } : {}),
        ...(unknown.length > 0
          ? {
              note:
                `no task has the id(s) ${unknown.join(", ")}: this task will stay blocked until ` +
                "one does (fix the id with a new task, or update this one).",
            }
          : {}),
      },
    };
  }

  /** Read the list back, filtered. */
  function listTasks(input: unknown): McpToolResult {
    const parsed = readList(input);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    const store = openStore();
    if (!store) return noStore();

    let tasks: Task[];
    if (parsed.ready) {
      if (!store.readyTasks) return missing("readyTasks");
      tasks = readyOf(store);
      if (parsed.status) tasks = tasks.filter((task) => task.status === parsed.status);
      if (parsed.assignee) tasks = tasks.filter((task) => task.assignee === parsed.assignee);
    } else {
      if (!store.getTasks) return missing("getTasks");
      tasks = store.getTasks(session, {
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.assignee ? { assignee: parsed.assignee } : {}),
      });
    }

    return {
      ok: true,
      output: {
        count: tasks.length,
        tasks: tasks.map(taskView),
        ...(parsed.ready ? { note: "these may start now; the rest wait on a dependency" } : {}),
      },
    };
  }

  /** Move a task along, and report what that left blocked or unblocked. */
  function updateTask(input: unknown): McpToolResult {
    const parsed = readUpdate(input);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    const store = openStore();
    if (!store) return noStore();
    if (!store.updateTask) return missing("updateTask");

    const updated = store.updateTask(parsed.id, parsed.patch);
    if (!updated) {
      const ids = tasksOf(store).map((task) => task.id);
      return {
        ok: false,
        error:
          `no task ${parsed.id} in this session` +
          (ids.length > 0 ? `; known ids: ${ids.join(", ")}` : " (the list is empty)"),
      };
    }

    // Completing (or reopening) a task changes what may start next, so say so:
    // a plan that keeps moving is the whole point of ordering it.
    const unmet = updated.status === "completed" ? [] : unmetDependencies(store, updated);
    const unblocked = updated.status === "completed" ? unblockedBy(store, updated.id) : [];

    return {
      ok: true,
      output: {
        task: taskView(updated),
        ...(unmet.length > 0 ? { unmetDependencies: unmet } : {}),
        ...(unmet.length > 0
          ? { note: `${updated.id} was updated, but it still depends on ${unmet.join(", ")}` }
          : {}),
        ...(unblocked.length > 0 ? { unblocked } : {}),
      },
    };
  }
}

const CREATE_DESCRIPTION = [
  "Write down a piece of work in the shared task list, so the plan outlives this conversation and a",
  "resumed run reads the same list. Use it before starting work you cannot finish in one step.",
  "`dependsOn` names the ids of tasks that must complete first; a task whose dependency is not",
  "completed — or that names an id no task has — stays blocked, so a typo is visible instead of",
  "silently skipped. Returns the new task's id, which `dependsOn` and `tasks_update` use.",
].join(" ");

const LIST_DESCRIPTION = [
  "Read the shared task list for this session back.",
  "Pass `ready: true` for the tasks that may start now (pending, every dependency completed) — that is",
  "the read to use when picking up the next piece of work. Filter by `status` or `assignee` to narrow",
  "an otherwise long list.",
].join(" ");

const UPDATE_DESCRIPTION = [
  "Move a task along: assign it, start it, complete it with a `result`, fail it, cancel it, or mark it",
  "blocked. Pass the `id` from `tasks_create` or `tasks_list`.",
  "Transitions are not enforced — the list records what you decided — but the result tells you what",
  "the update left unfinished: a dependency that is not completed yet, or the tasks it just unblocked.",
].join(" ");

type Parsed<T> = T | { error: string };

/** `tasks_create` input. */
function readCreate(input: unknown): Parsed<{
  title: string;
  description?: string;
  assignee?: string;
  dependsOn?: string[];
  parentId?: string;
}> {
  const object = asObject(input);
  if (typeof object === "string") return { error: object };

  const title = readText(object.title, "title");
  if (typeof title !== "string") return title;
  const description = readOptionalText(object.description, "description");
  if (description !== undefined && typeof description !== "string") return description;
  const assignee = readOptionalText(object.assignee, "assignee");
  if (assignee !== undefined && typeof assignee !== "string") return assignee;
  const parentId = readOptionalText(object.parentId, "parentId");
  if (parentId !== undefined && typeof parentId !== "string") return parentId;

  let dependsOn: string[] | undefined;
  if (object.dependsOn !== undefined) {
    if (!Array.isArray(object.dependsOn)) return { error: "dependsOn must be an array of task ids" };
    const ids: string[] = [];
    for (const entry of object.dependsOn) {
      const id = readText(entry, "dependsOn entry");
      if (typeof id !== "string") return id;
      ids.push(id);
    }
    dependsOn = ids;
  }

  return {
    title,
    ...(description ? { description } : {}),
    ...(assignee ? { assignee } : {}),
    ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

/** `tasks_list` input. */
function readList(input: unknown): Parsed<{ status?: TaskStatus; assignee?: string; ready: boolean }> {
  const object = asObject(input ?? {});
  if (typeof object === "string") return { error: object };

  let status: TaskStatus | undefined;
  if (object.status !== undefined) {
    if (typeof object.status !== "string" || !isStatus(object.status)) {
      return { error: `status must be one of ${TASK_STATUSES.join(", ")}` };
    }
    status = object.status;
  }

  const assignee = readOptionalText(object.assignee, "assignee");
  if (assignee !== undefined && typeof assignee !== "string") return assignee;

  if (object.ready !== undefined && typeof object.ready !== "boolean") {
    return { error: "ready must be true or false" };
  }

  return {
    ready: object.ready === true,
    ...(status ? { status } : {}),
    ...(assignee ? { assignee } : {}),
  };
}

/** `tasks_update` input; at least one field to change is required. */
function readUpdate(input: unknown): Parsed<{ id: string; patch: TaskPatch }> {
  const object = asObject(input);
  if (typeof object === "string") return { error: object };

  const id = readText(object.id, "id");
  if (typeof id !== "string") return id;

  const patch: TaskPatch = {};
  if (object.status !== undefined) {
    if (typeof object.status !== "string" || !isStatus(object.status)) {
      return { error: `status must be one of ${TASK_STATUSES.join(", ")}` };
    }
    patch.status = object.status;
  }
  for (const field of ["assignee", "result", "notes"] as const) {
    const value = readOptionalText(object[field], field);
    if (value === undefined) continue;
    if (typeof value !== "string") return value;
    patch[field] = value;
  }

  if (Object.keys(patch).length === 0) {
    return { error: "nothing to update: pass at least one of status, assignee, result, notes" };
  }
  return { id, patch };
}

/** Is this string one of the statuses `spec` defines? */
function isStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

/** `unknown` → object, or the message saying why it is not one. */
function asObject(input: unknown): Record<string, unknown> | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "input must be an object";
  }
  return input as Record<string, unknown>;
}

/** A required non-empty string (trimmed), or the message saying why it is not one. */
function readText(value: unknown, field: string): string | { error: string } {
  if (typeof value !== "string") return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { error: `${field} must not be empty` };
  return trimmed;
}

/** An optional string: absent is fine, present must be a non-empty string. */
function readOptionalText(value: unknown, field: string): string | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  return readText(value, field);
}
