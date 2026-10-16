# Sequential agent

**What it is.** A fixed _pipeline_: agent/skill/tool steps run in order, each
consuming the previous one's output (`designer → builder → marketer`). The
sequence is authored, not improvised; the model's freedom is inside each step,
not in choosing what comes next.

**When it is the right one.** When the shape of the work is known and repeating
it correctly matters more than flexing it — a release checklist, a content
pipeline, a data-refresh job.

## Components

### Step model

- **Purpose.** One unit of work, named, with a declared input and output, so the
  pipeline can be inspected (and resumed) step by step.
- **Contract (sketch).**

  ```ts
  type Step = {
    name: string;
    kind: "agent" | "tool" | "transform";
    input: unknown;
    output?: unknown;
    status: "pending" | "running" | "done" | "failed" | "skipped";
  };
  ```

- **Reference.** `agno/libs/agno/agno/workflow/steps.py` (`Steps`), `step.py`
  (174 KB of step kinds and their runners), `types.py` (`StepOutput`, `StepType`).
- **Failure mode prevented.** Work that only exists as a message transcript, so
  nothing can tell you _which step_ is slow, wrong, or skippable.

### State passing / handoff

- **Purpose.** What step _N_ produces must be what step _N+1_ is told, explicitly
  — not "whatever is in the conversation".
- **Contract (sketch).** a typed session state threaded through steps; each step
  reads fields it needs and writes fields it owns.
- **Reference.** `langgraph` — a typed `State` (e.g. `TypedDict`) plus reducers,
  with `StateGraph` nodes reading/writing named channels; `agno`'s
  `WorkflowSession` / `WorkflowRunOutput`.
- **Failure mode prevented.** A pipeline that works only because the model
  happens to remember; run it twice with a different model and step 3 gets the
  wrong input.

### Control flow

- **Purpose.** The non-linear bits: branch, loop/iterate, fan out in parallel,
  and route to a specialist.
- **Contract (sketch).** `condition(pred, then, else)` · `loop(body, until)` ·
  `parallel(steps[])` · `router(classify → step)`.
- **Reference.** `agno/libs/agno/agno/workflow/` — `condition.py`, `loop.py`,
  `parallel.py`, `router.py`, `cel.py` (expressions), `decorators.py`.
  `langgraph` — edges + `Send` for fan-out.
- **Failure mode prevented.** Re-implementing branching as prose in a prompt;
  serialising work that is embarrassingly parallel.

### Checkpoints between steps

- **Purpose.** Resume a half-finished pipeline instead of re-running (and
  re-charging for) the completed steps.
- **Contract (sketch).** persist `{ pipeline, stepIndex, state }` after each step;
  resume from `stepIndex`.
- **Reference.** `langgraph`'s checkpointer (`thread_id`) is exactly this; `agno`
  records step outputs in its session storage.
- **Failure mode prevented.** A 12-step pipeline failing at step 11 and starting
  from zero — or, worse, side effects repeating (`send email`, `charge card`).

### Failure policy per step

- **Purpose.** Decide, per step, what a failure means: retry, skip, abort the
  pipeline, or run a compensating action.
- **Contract (sketch).** `onError: "retry" | "skip" | "abort" | { compensate }`.
- **Reference.** `agno`'s HITL/error fields (`on_error`, `hitl_max_retries`,
  `on_timeout` in `workflow/utils/hitl.py`) and `agno`'s retry helpers.
- **Failure mode prevented.** All-or-nothing failures, and pipelines that
  half-apply their effects with nobody deciding that was acceptable.

## Our coverage

| Component                                           | Status | Evidence                                                                                              |
| --------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| Step model (executable)                             | ❌     | no pipeline definition anywhere in `src/`                                                             |
| State passing / handoff                             | ❌     | each run is a single conversation                                                                     |
| Control flow (condition / loop / parallel / router) | ❌     | —                                                                                                     |
| Checkpoints between steps                           | ❌     | we persist _events_, not resumable step state                                                         |
| Failure policy per step                             | 🟡     | retry-ish behaviour exists in `@adaptivemcp/orchestration` (tool-call retries), not per pipeline step |
| Observational graph                                 | ✅     | `AgentRuntime.runTurn` groups a step's calls under `agent_turn_<n>`; `graphView()`, `execution_nodes` |

Two adjacent things we _do_ have, and neither is a pipeline:

- **`@adaptivemcp/orchestration`** composes _tool calls_ (retries, sequencing
  policy) — not agent steps.
- **`learnedProcedure()`** surfaces a **repeated tool sequence** learned from
  telemetry. It is a _recommendation_, not an executable pipeline: we notice the
  pattern but cannot re-run it.

That last one is the interesting asymmetry: we can **observe** a sequence
(the execution graph) and even **recommend** it, but we cannot **define** or
**replay** one.

## Gap

1. **A step/pipeline definition** the host can execute and persist — and, because
   we already record the execution graph, the natural move is to make what we
   observe _round-trippable_ into a definition (observe → promote → replay).
2. **Typed state handoff** between steps, so a pipeline does not depend on
   conversation memory.
3. **Per-step failure policy**, so one bad step does not silently half-apply.

Sequencing is also the archetype where [delegation](orchestrator-agent.md) and
[pause/resume](human-in-the-loop.md) meet: a step may be a sub-agent, and a step
may need approval before it runs.
