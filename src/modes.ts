/**
 * Named orchestration modes: the coordination pattern as an explicit choice.
 *
 * The taxonomy comes from the archetype catalogue (`docs/archetypes/orchestrator-agent.md`,
 * after agno's `TeamMode`), and it is *host policy* — how this run coordinates —
 * not a protocol concept (ADR-004). Two things make a mode more than a label:
 *
 * 1. it **implies the tools it needs** (`task`, `tasks_*`), so choosing the
 *    pattern is one flag rather than remembering which capability it rests on;
 * 2. it contributes a paragraph to the system prompt that says what the *shape*
 *    of the work is — who answers, whether the leader rewrites, when it may stop.
 *
 * `tasks` goes one step further and installs a stop guard, so "loop until the
 * list is done" is enforced rather than merely requested.
 *
 * A run with no mode behaves exactly as it did before any of this existed.
 */
import type { Store } from "@adaptivemcp/spec";
import { openTasks } from "./tasks.js";
import type { StopGuard } from "./types.js";

export type OrchestrationMode = "coordinate" | "route" | "broadcast" | "tasks";

/** Every mode, in the order the catalogue lists them. */
export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = [
  "coordinate",
  "route",
  "broadcast",
  "tasks",
];

/** Is this a mode name? (`--mode` and the config key both validate through it.) */
export function isOrchestrationMode(value: string): value is OrchestrationMode {
  return (ORCHESTRATION_MODES as readonly string[]).includes(value);
}

/**
 * The capabilities a mode rests on, so `--mode <name>` can imply them. Every
 * mode needs delegation (that is what makes it a *coordination* pattern);
 * `tasks` additionally needs the shared list it coordinates through.
 */
export function modeTools(mode: OrchestrationMode): { task: boolean; tasks: boolean } {
  return { task: true, tasks: mode === "tasks" };
}

/** The system-prompt paragraph for a mode: the shape of the work, in its terms. */
export function modePrompt(mode: OrchestrationMode): string {
  return MODE_PROMPTS[mode];
}

/** The stop guard `tasks` mode runs with: no run ends with open work in the list. */
export function tasksStopGuard(options: {
  /** Read at call time, like the task tools: the runtime owns the store. */
  store: () => Store | undefined;
  session: string;
}): StopGuard {
  return () => {
    const store = options.store();
    if (!store) return undefined;
    const open = openTasks(store, options.session);
    if (open.length === 0) return undefined;
    return [
      `The shared task list still holds work that is neither done nor cancelled (${open.length}):`,
      ...open.map((task) => `- ${task.id} [${task.status}] ${task.title}`),
      "Take the next one `ready` to start (`tasks_list` with `ready: true`), record its `result` when it is done, and mark anything you are not going to do `cancelled` — the run continues until the list is empty.",
    ].join("\n");
  };
}

const MODE_PROMPTS: Record<OrchestrationMode, string> = {
  coordinate: [
    "You are coordinating, not doing the work alone. Break the request into the parts that are",
    "genuinely independent, delegate each one with `task` (naming a specialist with `agent` when a",
    "definition fits), and then **synthesise** one answer yourself from what came back. A child's",
    "result is evidence, not the answer: do not hand it back verbatim.",
  ].join(" "),
  route: [
    "Your job is to route, not to do the work. Pick the **single** most suitable specialist, send it",
    "the request with one `task` call (naming it with `agent` when a definition fits), and make its",
    "result your answer. Do not re-write, re-summarise or re-order what it said, and do not delegate",
    "the same request to a second specialist.",
  ].join(" "),
  broadcast: [
    "Send the **same** request to each relevant member, one `task` call per member — set",
    "`background: true` when the members are independent, so they run at the same time. Report what",
    "each one returned, attributed to its member; do not merge their answers into one of your own.",
  ].join(" "),
  tasks: [
    "You coordinate through the shared task list. Before doing work, write the plan down with",
    "`tasks_create` — one task per piece, with `dependsOn` naming what must come first — then work it",
    "in order, using `tasks_list` with `ready: true` to find the next piece and `tasks_update` to",
    "start, assign, and finish each one with a `result`. Delegate a task by naming the specialist in",
    "`assignee` and calling `task` with that name; otherwise do it yourself. The run is not over",
    "while the list has a task that is neither completed, failed nor cancelled: keep going, or mark",
    "what you are not going to do `cancelled`.",
  ].join(" "),
};
