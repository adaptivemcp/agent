# Orchestrator agent

**What it is.** One agent assigns work to others — agents, skills, tool calls —
and assembles the result. The orchestrator's job is _decomposition, assignment,
and synthesis_; the actual work happens in the children.

**When it is the right one.** When the work is bigger than one context window, or
when the parts are genuinely independent (research three competitors; migrate N
modules), or when different parts need different tools/permissions.

## Components

### Delegation as a tool

- **Purpose.** The child is invoked the same way as any other capability, so the
  model can decide to delegate using the machinery it already understands.
- **Contract (sketch).**

  ```ts
  // shape of opencode's `task` tool parameters
  { description: string;   // short label, 3-5 words
    prompt: string;        // the actual task
    agent?: string;        // which sub-agent
    background?: boolean } // async, notify me later
  ```

- **Reference.** `opencode/packages/opencode/src/tool/task.ts` (parameters,
  foreground default, background mode), `task.txt` (the model-facing description).
  `smolagents` exposes sub-agents the same way (`managed_agents` become callable
  tools).
- **Failure mode prevented.** Delegation that needs a special syntax the model
  will not reliably use; and a "sub-agent" that is really just a long prompt.

### Sub-agent session isolation

- **Purpose.** The child gets its **own** session and context, so it cannot
  corrupt the parent's history and its transcript does not have to come back.
- **Contract (sketch).** `spawn(agent, prompt) → childSessionId`; the parent
  receives a _result_, not the child's full message list, plus a way to send more
  context mid-flight.
- **Reference.** `opencode/tool/task.ts` — it drives `SessionPrompt` with a
  derived session id, and supports "additional context sent to the running
  background task".
- **Failure mode prevented.** A child that pollutes the parent's context, or a
  parent that must ingest every child's entire transcript to know what happened.

### Derived permissions

- **Purpose.** A child must not have _more_ authority than its parent, and usually
  has less.
- **Contract (sketch).** `deriveSubagentPermissions(parentPolicy) → childPolicy`,
  narrowing only.
- **Reference.** `opencode/packages/opencode/src/agent/subagent-permissions.ts`
  (used from the `task` tool) and the agent `mode: "subagent" | "primary" | "all"`
  distinction — a subagent is not directly selectable by the user.
- **Failure mode prevented.** Privilege escalation by delegation: the parent
  declines to run a tool itself, then asks a child to run it.

### Foreground vs background

- **Purpose.** Independent work should not block; dependent work should.
- **Contract (sketch).** `background: true` → return immediately, notify on
  completion, accept follow-up context.
- **Reference.** `opencode/tool/task.ts` — the background instructions to the
  parent are unusually explicit and worth copying: _"DO NOT sleep, poll for
  progress, ask the task for status, or duplicate this task's work — avoid working
  with the same files or topics it is using."_
- **Failure mode prevented.** The parent polling a child (token burn), or both
  editing the same file because nobody said "don't".

### Shared task list

- **Purpose.** One place that answers "what is assigned, to whom, and what is
  blocked on what" — the orchestrator's working memory.
- **Contract (sketch).**

  ```ts
  type Task = {
    id: string;
    title: string;
    description: string;
    status: "pending" | "in_progress" | "completed" | "failed" | "blocked";
    assignee?: string;
    parent_id?: string;
    dependencies: string[]; // blocked until these finish
    result?: string;
    notes: string[];
  };
  ```

- **Reference.** `agno/libs/agno/agno/team/task.py` (`Task`, `TaskList`,
  dependencies) with `agno/libs/agno/agno/team/_task_tools.py` exposing it to the
  leader as tools.
- **Failure mode prevented.** Delegation as a one-shot prompt with no shared state:
  nothing to re-plan against, no dependency ordering, no way to see what is stuck.

### Orchestration modes

- **Purpose.** Name the coordination patterns, instead of hoping the model picks a
  sensible one.
- **Contract (sketch).** the taxonomy found in the wild:

  | Mode         | What the leader does                                                        |
  | ------------ | --------------------------------------------------------------------------- |
  | `coordinate` | default supervisor: picks members, crafts tasks, **synthesises** the answer |
  | `route`      | sends to one specialist and returns its answer **directly**                 |
  | `broadcast`  | same task to every member (parallel or sequential)                          |
  | `tasks`      | decomposes into a shared task list and loops until all are done             |

- **Reference.** `agno/libs/agno/agno/team/mode.py` (`TeamMode`).
- **Failure mode prevented.** A supervisor that routes to a specialist _and_ then
  re-writes its answer (losing fidelity), or that runs a broadcast when the whole
  point was one specialist.

### Aggregation, budget, and the child's result contract

- **Purpose.** Combine N results into one answer, while keeping cost and
  concurrency bounded.
- **Contract (sketch).** each child returns `{ summary, artifacts, status, cost }`;
  the orchestrator owns a total budget and a concurrency cap.
- **Reference.** `agno`'s `broadcast` (concurrent vs sequential) and response
  synthesis; `opencode`'s background-job model for not blocking.
- **Failure mode prevented.** Unbounded fan-out (N agents × unbounded turns),
  and an orchestrator that cannot report what its children actually did.

## Our coverage

| Component                            | Status | Evidence                                                                                                                                                                                                               |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delegation tool                      | ✅     | `delegation.ts`: a `task` tool with `description`/`prompt`/`agent`/`background`, exposed under `--task`                                                                                                                |
| Sub-agent session isolation          | ✅     | the child gets its own `<parent>/task[-<agent>]-<n>` session and returns a result, never its transcript                                                                                                                |
| Derived permissions                  | ✅     | a child never auto-approves, never gets `task`, and a named agent's `tools`/`deny` is intersected with the parent's (`narrowTools`) — narrowing only, by construction                                                  |
| Foreground / background              | ✅     | foreground blocks; background returns immediately and reports once via `queueMessage` (bounded concurrency)                                                                                                            |
| Shared task list                     | ✅     | `tasks.ts`: `tasks_create`/`tasks_list`/`tasks_update` under `--tasks`, over the `spec` `Task` that `memory` persists; `readyTasks` does the ordering, and an unknown dependency id blocks rather than unblocks        |
| Orchestration modes                  | ✅     | `modes.ts`: `--mode coordinate\|route\|broadcast\|tasks`, each implying the tools it needs and adding its paragraph to the prompt; `tasks` also passes a stop guard to the loop, so a run cannot end with an open list |
| Typed memory steps / planning        | ✅     | `steps.ts`: an `ActionStep` per attempted call, and a `--plan-interval` planning pass that records a `PlanStep` from the recorded state and injects it for the next step; `/steps` reads one merged history back       |
| Aggregation / budget across children | 🟡     | a child's store, gate and per-call budgets are shared; no total budget or fan-out cap across children                                                                                                                  |
| Learned cross-tool sequences         | 🟡     | `learnedProcedure()` _notices_ a repeated sequence; it cannot delegate itself                                                                                                                                          |

What we have beyond that is **observation** of orchestration-shaped behaviour: the
execution graph (`agent_turn_<n>`) records a step's tool calls as a DAG — and a
delegated child's calls land in the same store under their own session, so the
tree is visible in the graph rather than lost.

## Gap

Nothing in this archetype is missing now: all three pieces are in place.

1. **Delegation** — a `task`-shaped tool, an isolated child session, derived
   (narrowed) permissions, and a foreground/background contract with notification.
   **Done** (`delegation.ts`, #36 + #52): the tool, the isolated session, the
   foreground/background contract, the anti-escalation rule, and named agents — a
   skill whose frontmatter declares `tools`/`deny` is an agent definition, and the
   child gets the intersection of its parent's tools and that policy.
2. **A shared task list** — the `Task`/`TaskList` model with dependencies.
   **Done** (`src/tasks.ts`, #37): `tasks_create`/`tasks_list`/`tasks_update` under
   `--tasks`, over the `spec` `Task` that `memory` persists, with the dependency
   read (`readyTasks`) deciding what may start.
3. **Named orchestration modes** — **Done** (`src/modes.ts`, #37):
   `--mode coordinate|route|broadcast|tasks`, each implying the toolset it rests on
   and adding its paragraph to the system prompt. `tasks` goes furthest and passes
   a **stop guard** to the loop, so a run cannot end while the list still holds work
   that is neither completed, failed nor cancelled: the mode enforces what the
   others merely ask for.

What remains is depth, not capability — the two 🟡 rows above. A child that hits a
`require_confirmation` call still **denies** it rather than suspending (a child must
not amplify authority, and a suspension belongs to the run a human is watching;
agent #46 solved that for the parent), and aggregation is per-call rather than
budgeted across children.
