# Architecture

## Principles

1. **The agent is the host.** It owns the LLM completion _and_ the tool execution,
   which is what lets Adaptive MCP's recommendations (routing, decoding, retry,
   approval) actually be applied and measured.
2. **Libraries do the learning.** This repo composes `@adaptivemcp/*`; it does not
   reimplement telemetry, evaluation, memory, or the view.
3. **Three thin seams + a loop.** Everything provider- or transport-specific lives
   behind one interface, so the core is testable offline and swappable.
4. **Advisory, host-enforced.** The approval gate recommends; the agent decides
   whether to prompt. Nothing is auto-enforced by a library.

## Layers

```text
┌──────────────────────────────────────────────────────────────────┐
│ CLI + REPL (future full-screen TUI)                               │
│   parses args, builds toolsets + model, drives runAgent           │
├──────────────────────────────────────────────────────────────────┤
│ runAgent loop (src/agent/loop.ts)                                 │
│   model.step/stream → tool calls → executor.execute → results      │
├───────────────────────────────┬──────────────────────────────────┤
│ ChatModel seam (step/stream)  │ AgentExecutor seam                │
│  AiSdkModel (Vercel AI SDK)   │  AgentRuntime                     │
│  ScriptedModel (tests/demo)   │    AdaptiveRuntime + ThinClient   │
│                               │    + GraphTrackingMiddleware      │
├───────────────────────────────┼──────────────────────────────────┤
│ Toolset seam                  │  @adaptivemcp/* libraries         │
│  StdioToolset (MCP SDK)       │  spec/memory/telemetry/evaluation │
│  HttpToolset (MCP SDK)        │  extension/routing/orchestration  │
│  InMemoryToolset              │  approval/thin-client/middleware  │
│  AggregateToolset             │  graph-analysis                   │
└───────────────────────────────┴──────────────────────────────────┘
```

`AiSdkModel` also implements `ChatModel.stream`, so the CLI/REPL render tokens as
they arrive (as `text_delta` events). `step` is the non-streaming path; both
return the same `ChatStep`, so tool handling is identical either way.

The toolset row is not only transports: `skillsToolset` and `taskToolset` are
host-owned capabilities exposed through the same seam (see
[Host-owned capabilities](#host-owned-capabilities) below).

## Data flow of one tool call

```text
runAgent → AgentRuntime.execute(call, spec)
  → ThinClient.run(toolName, handler, input, record, serverName)
      → ApprovalGate.gate()            // allow | deny | require_confirmation
      → MiddlewareChain.runBefore()    // e.g. observe, transform input, inject auth
      → handler()                      // Toolset.callTool → MCP transport
      → MiddlewareChain.runAfter()     // e.g. compress output
      → GraphTrackingMiddleware        // execution-graph node(s)
  → AdaptiveRuntime.observeCompleted() // telemetry → store → evaluate → view sync
  → ToolExecutionResult returned to the loop
```

`AgentRuntime.execute` is the **only** sanctioned way to run a tool; bypassing it
loses the gate, middleware, graph, and telemetry.

## Host-owned capabilities

These capabilities live in the host rather than in a library, because they are
_policy about this host's environment_ rather than framework primitives
(ADR-004 in the sibling repo). Skills, delegation and the task list are exposed as
ordinary **toolsets**, so using them takes the same path as any MCP tool — approval
gate, middleware, execution graph and telemetry all apply unchanged, and none adds
a protocol concept.

| Capability       | Module              | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Skills**       | `src/skills.ts`     | `<name>/SKILL.md` instructions found under `--skills <dir>` (and a `./skills` convention). Only names and descriptions enter the system prompt; the body loads on demand through `skills_read_skill`, which cannot leave a skill's own directory. Frontmatter may also declare `tools`/`deny`, which makes the skill an **agent definition**.                                                                                                       |
| **Pause/resume** | `src/runtime.ts`    | With `--pause`, a `require_confirmation` call is recorded as a suspension and the run stops with exit `5` instead of denying it; `--resume <id>` continues the saved conversation so the blocked call simply runs. The record is `Suspension` (`@adaptivemcp/spec`), persisted by `memory`.                                                                                                                                                         |
| **Delegation**   | `src/delegation.ts` | `--task` exposes `task`: a sub-agent in its own session that returns a **result, never its transcript**. It shares the parent's store (same graph and learned state, its own session) and inherits no authority — it never auto-approves and never receives `task` itself. `agent: "<name>"` names a definition whose policy is intersected with the parent's (`narrowTools`), so it can only narrow.                                               |
| **Task list**    | `src/tasks.ts`      | `--tasks` exposes the shared list: `tasks_create` writes down intended work and the ids it `dependsOn`, `tasks_list` reads it back (or only what is _ready_), and `tasks_update` moves a task on — reporting what it left unmet or unblocked. Transitions are not policed: the record says what was decided, and the store's `readyTasks` is what orders it, treating an unknown dependency id as unfinished so a typo blocks rather than unblocks. |
| **Modes**        | `src/modes.ts`      | `--mode <name>` names the coordination pattern (`coordinate`/`route`/`broadcast`/`tasks`), implies the toolsets it rests on, and adds its paragraph to the system prompt — so the shape of the work is a choice rather than an emergent accident. `tasks` goes furthest and passes a **stop guard** to the loop.                                                                                                                                    |
| **Typed steps**  | `src/steps.ts`      | One typed history per session: an `ActionStep` for every attempted call (a gate refusal or a pause is an attempt, not a failure), and — with `--plan-interval <n>`, off by default — a **planning pass** that records a `PlanStep` asked for from the _recorded_ state and injects it for the step that follows. `/steps` renders tasks, actions and plans in order.                                                                                |

All of these are opt-in, so a host that enables none behaves exactly as it did
before. Modes and the planning pass are the entries that are not toolsets, because
each is policy about a _step_ rather than a capability the model calls:
`tasks` reaches into the loop with `RunAgentOptions.stopGuard` (`src/agent/loop.ts`)
— consulted when the model stops calling tools, so a run cannot end while its list
still has open work — and the planning pass reaches in with
`RunAgentOptions.steer`, the pre-step mirror of `review`: a message returned from
it is injected as a user turn before the step's decision and model call, which is
what makes a plan something the run _has_ rather than something it said once. The
pass reads `store.getSteps(session)` rather than the conversation, so a plan
survives a restart and costs a bounded prompt however long the run got, and a pass
that cannot plan (the model errors, or answers with nothing usable) is reported
and skipped — planning never fails a run. A delegated child never plans: the pass
reads the leader's session, and a child is not the leader. Because that call is the
run's own model call made **outside** the loop, the recorded telemetry never sees
it; `PlanningPassOptions.onCall` reports each one and the CLI aggregates it into the
run summary (`plans=… plan_tokens=… plan_ms=…`), so planning is visible rather than
free-looking (#73).
The runtime's two supporting hooks are `queueMessage`/`drainQueuedMessages` (how a
background child reports back without the parent polling) and the `store` option
(how a child shares the parent's memory; a runtime handed a store does not close
it).

## Package mapping

| Package                       | Role in the agent                                                           |
| ----------------------------- | --------------------------------------------------------------------------- |
| `@adaptivemcp/spec`           | Shared types; `DecodingProfile`, `ModelCapabilities`, `Store`               |
| `@adaptivemcp/memory`         | SQLite store (`MemoryStore`), execution-node graph                          |
| `@adaptivemcp/telemetry`      | Records tool executions (`TelemetryRecorder`)                               |
| `@adaptivemcp/evaluation`     | Insights + recommendations (`Evaluator`)                                    |
| `@adaptivemcp/routing`        | Model/budget (`Router`) and decoding (`DecodingAdvisor`/`DecodingResolver`) |
| `@adaptivemcp/orchestration`  | Retry/workflow recommendations (`Orchestrator`)                             |
| `@adaptivemcp/approval`       | `ApprovalGate` (allow/deny/require_confirmation)                            |
| `@adaptivemcp/thin-client`    | Execution loop + `GraphTrackingMiddleware` + OAuth middleware               |
| `@adaptivemcp/middleware`     | `MiddlewareChain` + `Compressor`                                            |
| `@adaptivemcp/graph-analysis` | Critical path, cascades, anti-patterns, forecasting                         |
| `@adaptivemcp/extension`      | Derived `tools-metadata` view + MCP resources                               |
| `@adaptivemcp/runtime`        | `AdaptiveRuntime` batteries-included wiring                                 |

## Sessions, workflows, graph

- Each agent process gets one `GraphTrackingMiddleware` with a stable `sessionId`
  and optional `workflowId`.
- `ThinClient` forks an async context per top-level call, so concurrent tool
  calls don't corrupt each other's parent/child stacks. `AgentRuntime.runTurn`
  groups one model step's tool calls under a single `agent_turn_<n>` root, so a
  turn forms one DAG; without it each top-level call is its own root.
- `AgentRuntime.evaluateWorkflows()` runs the cross-session/workflow learning pass.

## Decoding

`AgentRuntime.suggestDecoding(tool, capabilities, { server, intent })` runs
`DecodingAdvisor` (profile selection from observed failure rate + caller intent)
through `DecodingResolver` (table-driven, backend-specific knobs) and returns a
`DecodingRecommendation` with `confidence` + `reasons`. It is advisory; the host
decides whether/when to apply it.

`AgentRuntime.decodingProvider(capabilities, { tool, intent })` turns that into a
`DecodingProvider` the loop consumes: before each completion, `runAgent` asks the
provider for `ChatParams` overrides, merges them over any static `params`, and
passes the result to `model.step`. The provider picks the known tool with the
highest observed failure rate (or a caller-named tool) and maps the
recommendation's `resolved` knobs onto `ChatParams` — which is exactly the set
the backend advertises through `ChatModel.capabilities` (`AiSdkModel` defaults to
`OPENAI_CAPABILITIES`). Each applied step is reported as a `decoding_applied`
event, so the adaptation is observable. This is what "the agent owns its LLM call"
buys: a recommendation that a provider-hosted runner could not apply. The
resolved decoding + token usage are also recorded per tool execution
(`ToolExecutionEvent.decoding`/`usage`), and `AgentRuntime.decodingReport()`
summarizes them via `DecodingAnalyzer` — from the store's durable
`metric_cells` rollup when available, else the in-process event log (ROADMAP
8d/8e).

## Model catalog & routing

`src/models/` holds the agent's **catalog** of model integrations
(`openai-compatible`, `anthropic`, `google`), built from presets plus an optional
catalog file (`--models` / `$AGENT_MODELS`). Only integrations whose key is
present are active.

`ModelCatalog.routingOptions()` feeds the `Router` (via `AgentRuntime`'s
`routerModels`), so a tool's learned `model` recommendation references a model
the agent can actually run. `AgentRuntime.modelProvider` builds a `ModelSelector`
for `runAgent`: each step it reads the recommendation for the governing tool and
returns that `ChatModel`, falling back to the catalog default when there is not
enough signal. `runAgent` emits `model_selected`, so the choice is observable
(the REPL prefixes each turn with `[<id>]`). `--model <id>` pins one model and
disables selection.

## Feedback & guardrails

- **Approvals.** `seedToolAnnotations` maps standard MCP annotations
  (`destructiveHint`/`readOnlyHint`/`openWorldHint`) onto static risk, and the
  `ApprovalGate` combines that with learned flakiness. `AgentRuntime.setRequestApproval`
  lets the host install a prompt; the REPL asks `approve <tool>? — <reason>`.
- **Learned context.** `AgentRuntime.learnedContext()` projects the store
  (failure rate, insights, suggested model) into a short block the host injects
  into the system prompt each turn, so evaluation output reaches the model.
- **Cost.** The loop prices each step's tokens via `ChatModel.pricing`, splits it
  across the step's tool calls, and records it via `observeCompleted`, so
  routing/budget insights see real cost.
- **Context management.** Tool output can be compressed through the headroom MCP
  server via `HeadroomMiddleware` (`--compress`), with originals retrievable by
  hash (`/retrieve`); `--history` persists the conversation and `--session` keeps
  the graph/stats session stable.
- **Guardrails & planning.** After each step the loop calls `AgentExecutor.review`;
  `AgentRuntime.review` surfaces new execution-graph signals (failure cascades /
  anomalies) as a steering message (`guard` event). `learnedContext` may include a
  repeated tool procedure from graph-analysis common patterns.
- **Reporting.** `AgentRuntime`'s `onExecuted` hook lets the host report each
  observation to servers exposing `report_observation` (`--report`), closing the
  client→server loop.
- **Drift & clustering.** `AgentRuntime.metricDriftReport()` compares the latest
  hourly metric cell to the lifetime cell (`/drift`); `Evaluator.evaluateCooccurrence`
  surfaces tools that cluster in the same session, injected into the learned
  context ("often with …").
- **Server governance.** `StdioToolset`/`HttpToolset` advertise the extension
  and read `dev.adaptivemcp://tools-metadata`; `AgentRuntime.applyServerMetadata`
  applies the published annotation/`require_approval`/budget as a floor (never
  overriding a human or learned value). Two rules keep "floor" honest: a
  `require_approval` suggestion implies at least `high` risk even if the
  document pairs it with a lower one (hosts gate on risk, so a contradictory
  pair cannot lower the gate), and an unrecognised risk value from that
  untrusted document is ignored rather than stored. `/policy` shows what is in
  effect.

## Transports, resolution & robustness

- **Transports.** `StdioToolset` (local child process) and `HttpToolset`
  (Streamable HTTP, with static `headers` for a bearer token) both implement
  `ResourceToolset` (`listTools`/`callTool`/`listResources`/`readResource`/
  `instructions`). `AggregateToolset` namespaces several servers into one flat
  tool list. `--server` accepts the `name=command args` shorthand or a JSON
  object: `{"name","command","args","cwd","env"}` for stdio, or
  `{"name","transport":"http","url","headers"}` for HTTP.
- **Authentication.** Two paths, both landing on the request `Authorization`
  header: static `headers` in the server spec (a bearer/API key), or
  `OAuthMiddleware` from `@adaptivemcp/thin-client`. The middleware resolves a
  token in `beforeCall`, `ThinClient` hands the credentials to the handler as
  part of its `ToolHandlerCallContext`, and `HttpToolset` injects them through a
  custom `fetch`. A rejected token fails the call with `HTTP 401: …`, which
  triggers a refresh — the _next_ call carries the fresh token, with no manual
  reconnect. Credentials are an HTTP concept: a stdio server authenticates
  through `env` at spawn. Covered end-to-end by
  `src/mcp/http-oauth.integration.test.ts` (no external services).
- **Result classification.** Real servers often report _logical_ failures
  in-band (a JSON envelope with `status:"error"`, as an object or JSON text)
  rather than via the MCP `isError` flag. `AgentRuntime` passes
  `envelopeClassifier()` to `ThinClient.classifyResult`, so such outcomes are
  recorded as failures — and can trigger the retry policy — instead of false
  successes. See `@adaptivemcp/thin-client`.
- **Server instructions & local risk.** `StdioToolset.instructions()` reads the
  server's `initialize` instructions, which the CLI adds to the system prompt as
  clearly-labelled untrusted data. `seedToolAnnotations(specs, { defaultRisk })`
  seeds static risk from MCP annotations, falling back to `--default-risk`
  (default `medium`) for servers that ship none.
- **Long-running jobs.** `jobPollingMiddleware` (opt-in `--await-jobs`) detects a
  job handle (`job_id` plus a running status) in a tool result and polls the
  server's `get_job_status` until terminal, replacing the output (a terminal
  failure is recorded as a failure).
- **Exit codes.** The CLI uses stable codes (`src/exit-codes.ts`): `0` ok,
  `1` runtime, `2` usage/no-server, `3` provider/catalog config, `4` approval
  denied.

## System One decisions

An optional fast decision layer (`src/decision/`) in front of the chat model.
`SystemOneClient` / `OllamaSystemOneBackend` call Ollama's `/v1/systemone`;
`DecisionBackend` is the seam, with a second, remote tier —
`OpenAiSystemOneBackend` — that prompts any OpenAI-compatible
`/chat/completions` endpoint and coerces the JSON reply back into the
`SystemOneResponse` shape (injected via `systemOneProvider(catalog, { backend })`).
`systemOneProvider(catalog, { backends: [...] })` composes several backends
into a `TieredSystemOneBackend`: ordered by `tier` (local first), failover on
transport/HTTP errors only (low confidence declines in the advisor instead),
one shared `timeoutMs` budget split across tiers, and at most one fallback per
decision call; `lastDecisionSummary()` attributes the tier that answered.
`SystemOneAdvisor` turns the
learned metadata plus the request into one verdict (model / tool intent /
decoding), declining when the backend fails or confidence is low. `runAgent`
consumes it via `decide` (`DecisionProvider`); `AgentRuntime.systemOneProvider`
builds it — the CLI picks a tier with `--system1-backend ollama|openai` or a
**comma list** (`ollama,openai`, from the flag or `$SYSTEM1_BACKEND`; the
resolver in `src/cli-args.ts` maps a single tier to `backend` and a list to
`backends`, failing fast as usage/exit 2 on an invalid selector — unknown
element, duplicates, or more than two tiers — and as config/exit 3 when the
openai element has no model), and
`/decision` shows the last verdict. It is not a
`ChatModel` and never touches the chat path.

## Model catalog

`src/models/` holds the catalog: built-in integrations (openai-compatible,
anthropic, google) plus Ollama auto-discovery (`GET /api/tags` → `ollama-<slug>`;
`--no-ollama` disables). Several keys for the same provider/model (`$NAME`,
`$NAME_2`, …) pool into a `PooledChatModel` that round-robins and cools a failing
key down. `ModelCatalog.routingOptions()` feeds the `Router`, so a learned
per-tool model recommendation references a runnable model.

## Decisions (2026-09-28)

- **Library core + CLI/TUI, CLI-first.** The seams above are library exports;
  the CLI is a thin consumer.
- **Provider-agnostic via the Vercel AI SDK.** OpenAI-compatible for now; the
  `ChatModel` seam keeps providers swappable.
- **Local link to `adaptive-mcp`** during co-development; switch to published
  versions before release.
- **Build our own; borrow patterns** from opencode (sessions, provider catalog,
  tool registry, TUI-first DX) and smolagents (minimal loop, typed memory, tool
  validation) without taking their code.

## Roadmap

1. **Done:** apply decoding recommendations to the next model step
   (`AgentRuntime.decodingProvider` + the loop's `DecodingProvider` seam).
2. Interactive REPL **done** (`src/repl.ts`, streaming, multi-turn). A
   full-screen TUI (opencode-inspired) is **deferred** — see the rationale
   below; the REPL is the supported interactive surface until then.
3. **Done:** per-turn workflow DAGs — `AgentRuntime.runTurn` groups a step's tool
   calls under one `agent_turn_<n>` root.
4. **Done:** model catalog with OpenAI-compatible + Anthropic + Google
   integrations and learned per-tool routing (`AgentRuntime.modelProvider`);
   token streaming in `AiSdkModel.stream`.
5. Publish the library as a consumable package.

### Full-screen TUI: deferred (2026-10-15)

The opencode-inspired full-screen TUI (roadmap 2) is **deferred**, not dropped.
The seams a TUI would consume are already stable and tested at the loop level
(`runAgent` + the `AgentEvent` stream via `onEvent`, plus `AgentRuntime`), so the
defer is a sequencing call, not a rewrite. Rationale:

- **`priority:low`.** The REPL is the supported interactive surface; a TUI is
  incremental DX polish, not a capability gap.
- **No TUI dependency today.** The repo has no `ink`/`blessed`/etc.; adding one
  is still a decision worth making deliberately rather than as a side effect.

Both hygiene preconditions are now **met** (2026-10-15, #26):

- **The render layer is tested.** Both event renderers live in `src/render.ts`
  (`renderOneShot` for one-shot, `createReplRenderer` for the REPL) and are
  covered directly by `src/render.test.ts`; `src/cli.ts` / `src/repl.ts` no
  longer own a render switch.
- **The CLI's option assembly is shared.** `buildRunConfig`
  (`src/cli-config.ts`, tested in `cli-config.test.ts`) assembles the inputs
  every renderer consumes, so a third renderer spreads one config instead of
  re-deriving the pinned-model and System One rules.

Revisit when someone wants to own the TUI dependency choice. The event surface
is already sufficient — no new events are needed for a TUI.
