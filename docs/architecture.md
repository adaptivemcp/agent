# Architecture

## Principles

1. **The agent is the host.** It owns the LLM completion *and* the tool execution,
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
│  InMemoryToolset              │  extension/routing/orchestration  │
│  AggregateToolset             │  approval/thin-client/middleware  │
│                               │  graph-analysis                   │
└───────────────────────────────┴──────────────────────────────────┘
```

`AiSdkModel` also implements `ChatModel.stream`, so the CLI/REPL render tokens as
they arrive (as `text_delta` events). `step` is the non-streaming path; both
return the same `ChatStep`, so tool handling is identical either way.

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

## Package mapping

| Package | Role in the agent |
| --- | --- |
| `@adaptivemcp/spec` | Shared types; `DecodingProfile`, `ModelCapabilities`, `Store` |
| `@adaptivemcp/memory` | SQLite store (`MemoryStore`), execution-node graph |
| `@adaptivemcp/telemetry` | Records tool executions (`TelemetryRecorder`) |
| `@adaptivemcp/evaluation` | Insights + recommendations (`Evaluator`) |
| `@adaptivemcp/routing` | Model/budget (`Router`) and decoding (`DecodingAdvisor`/`DecodingResolver`) |
| `@adaptivemcp/orchestration` | Retry/workflow recommendations (`Orchestrator`) |
| `@adaptivemcp/approval` | `ApprovalGate` (allow/deny/require_confirmation) |
| `@adaptivemcp/thin-client` | Execution loop + `GraphTrackingMiddleware` + OAuth middleware |
| `@adaptivemcp/middleware` | `MiddlewareChain` + `Compressor` |
| `@adaptivemcp/graph-analysis` | Critical path, cascades, anti-patterns, forecasting |
| `@adaptivemcp/extension` | Derived `tools-metadata` view + MCP resources |
| `@adaptivemcp/runtime` | `AdaptiveRuntime` batteries-included wiring |

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
buys: a recommendation that a provider-hosted runner could not apply.

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
2. Interactive REPL **done** (`src/repl.ts`, streaming, multi-turn); a
   full-screen TUI (opencode-inspired) over the same library core is next.
3. **Done:** per-turn workflow DAGs — `AgentRuntime.runTurn` groups a step's tool
   calls under one `agent_turn_<n>` root.
4. **Done:** model catalog with OpenAI-compatible + Anthropic + Google
   integrations and learned per-tool routing (`AgentRuntime.modelProvider`);
   token streaming in `AiSdkModel.stream`.
5. Publish the library as a consumable package.
