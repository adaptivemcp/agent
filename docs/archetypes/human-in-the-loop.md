# Human-in-the-loop agent

**What it is.** The agent does the work but stops before the consequential parts
and asks a human. Not "may I?" for everything — for the narrow set of actions
where a wrong move is unrecoverable: pay, delete, send, deploy, publish.

**When it is the right one.** Whenever an action is irreversible or
money-shaped. This is the archetype where _getting it right_ matters more than
orchestration cleverness, because the failure is a real-world one.

## The distinction that matters

There are two mechanisms here, and they are not variants of each other:

|                             | **In-line gate**               | **Suspend / resume**                  |
| --------------------------- | ------------------------------ | ------------------------------------- |
| When the human answers      | while the process is running   | anytime — minutes or days later       |
| Where the question is shown | the terminal running the agent | any client that can resume the run    |
| If the process dies         | the run is lost                | the run continues from the checkpoint |
| Needs durable state         | no                             | **yes**                               |
| Reference                   | `@adaptivemcp/approval`'s gate | `langgraph`'s `interrupt` / `Command` |

Most agents (including ours today) have only the first. The second is what makes
"approve a payment tomorrow" possible.

## Components

### Decision model

- **Purpose.** Turn "what is this call?" into one of three verdicts, from a policy
  the model cannot edit.
- **Contract (sketch).**

  ```ts
  type Decision = "allow" | "deny" | "require_confirmation";
  ```

- **Reference.** `@adaptivemcp/approval`'s `ApprovalGate` (deny → risk annotation
  → learned failure rate → allow); `agno`'s tool-level `requires_confirmation`.
- **Failure mode prevented.** A gate with no explicit "ask" state, so anything
  ambiguous defaults to _allow_.

### Approval granularity

- **Purpose.** What exactly is the human approving? Approving once must not
  approve every future variant.
- **Contract (sketch).** approve a _normalised_ action, not raw argv.
- **Reference.** `opencode/packages/opencode/src/permission/arity.ts` — the
  grantable unit is the "human-understandable command" (`git checkout main` →
  `git checkout`), computed from a command-arity table.
- **Failure mode prevented.** A prompt _"run `git checkout main`?"_ that is
  silently satisfied by a later `git checkout evil-branch`; and approval fatigue
  from asking per exact argument.

### The gate at the execution seam

- **Purpose.** Ask _before_ the effect, at the one place nothing can bypass.
- **Contract (sketch).** `gate(call) → Decision`, consulted inside
  `AgentRuntime.execute`.
- **Reference.** ours: `ApprovalGate` + `AgentRuntime.setRequestApproval` (the
  REPL prompts `approve <tool>? (y/N)`), with `--yes` for non-interactive runs.
- **Failure mode prevented.** A "confirmation" implemented in one call path and
  forgotten in another.

### Pause / resume primitive

- **Purpose.** Stop the run, persist _where_ it stopped, hand the question to a
  human, and continue with their answer — possibly much later.
- **Contract (sketch).**

  ```ts
  // inside the step that needs consent:
  const answer = interrupt({ question, schema }); // throws a resumable signal
  // client, later:
  resume(threadId, answer); // continues from the checkpoint
  ```

- **Reference.** `langgraph/libs/langgraph/langgraph/types.py` —
  `interrupt(value, response_schema)` raises a resumable exception, the client
  resumes with `Command(resume=…)`, the feature **requires a checkpointer**, and
  the node **re-executes** on resume (so re-entry must be safe).
- **Failure mode prevented.** Approval that only works while a terminal is open;
  a crashed run losing the work that led up to the question.

### The human-review primitive set

- **Purpose.** Approving an _action_ is only one shape of human involvement.
- **Contract (sketch).** the primitives seen in `agno`'s `HumanReview`:

  | Primitive                                                          | Question it asks             |
  | ------------------------------------------------------------------ | ---------------------------- |
  | `requires_confirmation` + `confirmation_message` + `on_reject`     | may I do this?               |
  | `requires_user_input` + `user_input_message` + `user_input_schema` | I need a value I do not have |
  | `requires_output_review` + `output_review_message`                 | is this result acceptable?   |
  | `requires_iteration_review` + `iteration_review_message`           | do I keep iterating?         |
  | `hitl_max_retries`, `hitl_timeout`, `on_timeout`, `on_error`       | what if nobody answers?      |

- **Reference.** `agno/libs/agno/agno/workflow/utils/hitl.py` (the
  `LEGACY_HITL_KEYS` list is, in effect, a checklist of what HITL means).
- **Failure mode prevented.** Only ever asking "yes/no" — so the agent cannot ask
  for a missing parameter, cannot hand back a draft, and has no policy for a
  question nobody answers.

### Audit trail

- **Purpose.** Who approved what, when, and on what evidence.
- **Contract (sketch).** append-only record: `{ action, decision, actor, at, why }`.
- **Reference.** ours (`audit.jsonl` in QC; the agent's event stream), `agno`'s
  session records.
- **Failure mode prevented.** An approval with no trace, which is worse than no
  approval the moment money is involved.

## Our coverage

| Component                                                | Status | Evidence                                                                                                                                       |
| -------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision model (3 verdicts)                              | ✅     | `@adaptivemcp/approval` `ApprovalGate.gate()`                                                                                                  |
| Gate at the execution seam                               | ✅     | consulted in `AgentRuntime.execute`                                                                                                            |
| Interactive approval prompt                              | ✅     | `setRequestApproval` in `src/repl.ts`; `--yes` bypass                                                                                          |
| Server-governed floor (a server can raise the gate)      | ✅     | `applyServerMetadata`, `serverPolicySummary`                                                                                                   |
| Learned failure rate → require_confirmation              | ✅     | `ApprovalGate` consumes tool failure rate                                                                                                      |
| Audit trail                                              | ✅     | execution events / telemetry                                                                                                                   |
| Approval granularity (normalised action)                 | ❌     | verdicts are per tool call, not per normalised command                                                                                         |
| **Pause / resume**                                       | ✅     | `--pause` records a suspension and exits `5`; `--resume <id>` continues the saved conversation, so the blocked call runs — verified end to end |
| User-input / output-review / iteration-review primitives | ❌     | only yes/no                                                                                                                                    |
| Timeouts & retry policy for an unanswered question       | ❌     | the prompt blocks forever                                                                                                                      |
| Out-of-band approval (answer from another process)       | ❌     | the answer must come from the same terminal                                                                                                    |

`src/agent/loop.ts` and `src/types.ts` now carry the primitive
(`ToolExecutionResult.suspension`, `stopReason: "suspended"`,
`unresolvedToolCalls`); the suspension _record_ and its storage are decided in
ADR-004 in the
[adaptive-mcp repo](https://github.com/kemalelmizan/adaptive-mcp/blob/main/docs/adr/004-archetype-component-ownership.md),
and the agent half that uses them is blocked on those packages being published
(#46).

## Gap

The **decision** layer is in good shape — policy, seeding, floor, learning, audit.
What is missing is everything around _when and where_ the human answers:

1. **Pause/resume over durable state** (the `interrupt`/`resume` contract). This is
   the single most valuable missing primitive across all five archetypes: it turns
   approval from "a prompt in this terminal" into a real workflow, and it is the
   prerequisite for approving a child task in the
   [orchestrator](orchestrator-agent.md) archetype. **In progress:** the loop half
   shipped (#45), the record + storage are decided and implemented in
   `adaptive-mcp` (ADR-004), and the host half is written on
   `feat/pause-resume-host` pending the release that publishes them (#46).
2. **The rest of the human-review set** — asking for a missing value, reviewing an
   output, and an explicit timeout policy instead of blocking forever.
3. **Normalised approval targets** (opencode's arity idea) so one approval does
   not cover every future variant of the same command.

Note the dependency direction: (1) needs durable, _resumable_ state
([components.md § 7](components.md#7-durable-state) — we are 🟡 there), so it is
worth deciding those two together rather than in sequence.
