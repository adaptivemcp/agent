# Agent archetypes

A neutral catalogue of the **components** that agentic systems are built from,
gathered by reading six open-source agent codebases, plus an honest inventory of
which of them `@adaptivemcp/agent` has today.

It is deliberately **descriptive, not prescriptive**: each file names the
components an archetype needs, the contract shape each one implies, the reference
implementation to learn from, and the failure mode it prevents. Decisions (what
_we_ will build, and where a component belongs — agent or library) are not made
here; they belong in ADRs and issues.

## The five archetypes

The names are the ones used in the source discussion; each is a _usage_, not a
separate architecture — real systems combine them.

| Archetype                   | The job it does                                                                | File                                             |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| **Tool agent**              | Connects to apps over MCP and takes actions on the user's behalf.              | [`tool-agent.md`](tool-agent.md)                 |
| **Skills agent**            | Taught a procedure once; repeats it on demand.                                 | [`skills-agent.md`](skills-agent.md)             |
| **Sequential agent**        | Runs agent/skill/tool steps in order (designer → builder → marketer).          | [`sequential-agent.md`](sequential-agent.md)     |
| **Human-in-the-loop agent** | Does the work but waits for approval before acting (payments, deletes, sends). | [`human-in-the-loop.md`](human-in-the-loop.md)   |
| **Orchestrator agent**      | Assigns tasks to other agents/skills/tools and combines the results.           | [`orchestrator-agent.md`](orchestrator-agent.md) |

Components that every archetype draws on (tool registry, MCP client, memory,
durable state, guardrails, telemetry, config) are catalogued once in
[`components.md`](components.md).

Each archetype file follows the same shape:

1. **What it is** — when this usage is the right one.
2. **Components** — purpose · contract sketch · which reference proves it · the
   failure mode it prevents.
3. **Our coverage** — present / partial / absent, with file-level evidence.
4. **Gap** — the smallest thing missing, stated neutrally.

## Coverage at a glance

`✅` present · `🟡` partial · `❌` absent. Evidence is in the per-archetype files.

| Component                                                        | Our status |
| ---------------------------------------------------------------- | ---------- |
| Tool registry (schema, hints, provenance)                        | ✅         |
| MCP client / transport / namespacing                             | ✅         |
| Single execution seam (gate · middleware · telemetry)            | ✅         |
| Result classification (ok / error / policy denial)               | ✅         |
| Model seam (one owned completion call, streaming)                | ✅         |
| Model routing + decoding policy from learned stats               | ✅         |
| Server-governed policy as a floor                                | ✅         |
| Approval gate (allow / deny / require_confirmation)              | ✅         |
| Audit trail + telemetry + derived view                           | ✅         |
| Configuration (flags + config file)                              | ✅         |
| Durable state (store, session, history)                          | 🟡         |
| **Pause/resume primitive** (`interrupt` / `resume`)              | ✅         |
| **Sub-agent delegation** (isolated session, derived permissions) | ✅         |
| **Shared task list** (+ orchestration modes)                     | ❌         |
| **Skills** (SKILL.md, progressive disclosure, supply chain)      | 🟡         |
| **Pipeline / step model** (conditions, loops, parallel, routing) | ❌         |
| **Planning passes + typed memory steps**                         | ❌         |

## Gap backlog

Filed as the **Agent archetypes** milestone (#35–#40), one per row, so they can
be triaged in the tracker. The catalogue stays neutral: each is a _missing
component_, not a commitment.

| #   | Gap                                                                         | Issue | Depends on                     | Rough size | Status                                                                                                                                            |
| --- | --------------------------------------------------------------------------- | ----- | ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pause/resume primitive (`interrupt`/`resume` over durable state)            | #35   | durable state (🟡)             | small      | **done** — `--pause`/`--resume`, verified end to end (#46)                                                                                        |
| 2   | Sub-agent delegation (isolated session, derived permissions, fg/bg, notify) | #36   | 1 (for suspension of children) | medium     | **done** — `task` tool, isolation, fg/bg, named agents that narrow tools (#52); a child that needs approval still denies until pause/resume lands |
| 3   | Shared task list + orchestration modes                                      | #37   | 2                              | medium     | not started                                                                                                                                       |
| 4   | Skills: `SKILL.md` discovery, progressive disclosure, supply chain          | #38   | —                              | medium     | **mostly done** — loader + `--skills`; supply chain (fetch/cache/version) open                                                                    |
| 5   | Pipeline / step model (conditions, loops, parallel, fan-out)                | #39   | 3 (task list)                  | large      | not started                                                                                                                                       |
| 6   | Planning passes + typed memory steps (task/action/plan records)             | #40   | —                              | small      | not started                                                                                                                                       |

## Where each reference contributed

| Reference         | What it is                       | What we took from it                                                                                           |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `opencode`        | Mature coding-agent host         | Tool registry + provenance, MCP catalog, permission arity model, `task` sub-agent tool.                        |
| `agno`            | Full agent platform              | `TeamMode` taxonomy, `Task`/`TaskList`, tool `requires_confirmation` + hints, the `HumanReview` primitive set. |
| `langgraph`       | Durable stateful orchestration   | `interrupt`/`Command` resume contract, checkpointer (`thread_id`), graph + `Send` fan-out.                     |
| `smolagents`      | Code-first agent library         | Typed `AgentMemory` steps, `planning_interval`, `managed_agents`.                                              |
| `llama.cpp`       | Inference server w/ MCP + skills | `skills/<name>/SKILL.md` layout and progressive disclosure.                                                    |
| `trl`, `OpenRLHF` | Post-training tooling            | Not archetype components; telemetry/experience-record patterns only.                                           |

## A note on authenticity

Every claim in these files is grounded in a file in a reference clone (paths are
cited) or in `src` (paths cited). The contract sketches are _sketches_ —
shape, not API — and are marked as such so nobody mistakes them for a decision.
