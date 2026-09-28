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
│ CLI / (future TUI)                                                │
│   parses args, builds toolsets + model, calls runAgent            │
├──────────────────────────────────────────────────────────────────┤
│ runAgent loop (src/agent/loop.ts)                                 │
│   model.step → tool calls → executor.execute → feed results back   │
├───────────────────────────────┬──────────────────────────────────┤
│ ChatModel seam                │ AgentExecutor seam                │
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
  calls don't corrupt each other's parent/child stacks. Today each top-level call
  becomes its own graph root within the session; a single per-turn DAG is future
  work.
- `AgentRuntime.evaluateWorkflows()` runs the cross-session/workflow learning pass.

## Decoding

`AgentRuntime.suggestDecoding(tool, capabilities, { server, intent })` runs
`DecodingAdvisor` (profile selection from observed failure rate + caller intent)
through `DecodingResolver` (table-driven, backend-specific knobs) and returns a
`DecodingRecommendation` with `confidence` + `reasons`. It is advisory; the host
decides whether/when to apply it. Because the agent owns its completion call, it
*can* apply `resolved` params on the next model step — that wiring is the next
step.

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

1. Apply decoding recommendations to the next model step (close the loop).
2. TUI (opencode-inspired) over the same library core.
3. Per-turn workflow DAGs (parent/child across tool calls in one turn).
4. More providers via the AI SDK; streaming.
5. Publish the library as a consumable package.
