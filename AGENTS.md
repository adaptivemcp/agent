# AGENTS.md — Adaptive MCP Agent

This repo is the **product implementation** of Adaptive MCP: a provider-agnostic,
MCP-native agent that owns both the LLM completion and the tool execution, so the
`@adaptivemcp/*` libraries finally have a real host generating real telemetry.

It is a **consumer** of the sibling `adaptive-mcp` monorepo, not a fork. Use every
Adaptive MCP library; never reimplement the learning loop here.

## Relationship to `adaptive-mcp`

- Libraries are consumed from **npm** (`@adaptivemcp/*`, published at 0.4.x and
  up). No sibling checkout or `link:` is needed to build or test this repo.
- **Keep the pinned `@adaptivemcp/*` versions current** when a library changes:
  publish it from `../adaptive-mcp`, then bump the ranges here.
- Do not modify `../adaptive-mcp` from here. If a library needs a change, do it in
  that repo, publish, then bump the dependency here.
- No first-class `adaptiveTool`/`adaptiveSkill`/`adaptiveIntent`/`adaptiveWorkflow`.
  MCP standardizes capabilities; Adaptive MCP learns behavior.

## Requirements

- **Node 22+** (Node 26 recommended; `node:sqlite` without a flag).
- **pnpm 11+** (pinned `pnpm@11.15.1`).

## Commands

```bash
pnpm install
pnpm build         # tsc -> dist/
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest (offline; scripted model + in-memory toolset)
pnpm lint          # eslint
pnpm format        # prettier --write (see the caveat below)
pnpm demo          # offline vertical slice: loop -> telemetry -> derived view
pnpm dev           # interactive REPL (streaming, multi-turn)
pnpm dev -- --prompt "..." --server "fs=npx ..."   # one-shot
pnpm dev -- --compress --history /tmp/agent-history.json --session dev
pnpm dev -- --config agent.yaml   # options from a file (flags override it)
pnpm dev -- --help # CLI (tsx)
pnpm release:prepare minor      # release, phase 1: version + notes + gates + build (no OTP)
pnpm release:publish --otp CODE # release, phase 2: publish + commit + tag + notes (fast)
```

**Releasing is two phases, because they need different things.**
`pnpm release:prepare <patch|minor|major>` is the slow, OTP-free half: it refuses
a dirty tree, refuses a version already on the registry, derives the release notes
from the commits since the last tag, runs the gates, builds, bumps `package.json`,
and stores the pending release in `.release/state.json`.
`pnpm release:publish --otp <CODE>` is the fast half and the **only** step that
needs the second factor — so the code cannot expire while tests run. It publishes,
commits the bump, tags with those notes (`git tag -F`, so `tag.gpgSign` cannot
open an editor), and opens a GitHub Release. Nobody writes release prose by hand,
and `publish` refuses a tree that changed beyond `package.json`.

**Config file.** `--config <file>` (YAML or JSON) holds the "how to run it"
options (`servers`, `model`, `db`/`yaml`, `session`, `maxSteps`, `system1*`, …),
so a repeatable run is one flag. Flags override the file, the file overrides the
defaults; unknown keys and wrong types are errors. `src/agent-config.ts` loads
and validates it; `parseFlags`/`resolveArgs` (`src/cli-args.ts`) do the layering.
Per-run choices (`--prompt`, `--interactive`, `--list-tools`, `--help`,
`--version`) are not configurable. `--server` also accepts a JSON object for
per-server `cwd`/`env` and for HTTP MCP servers.

By default `pnpm dev` targets a local `llama-server`
(`${AI_BASE_URL:-http://127.0.0.1:9931/v1}`, key `$AI_API_KEY`/`$LLAMA_API_KEY`)
and the sibling `adaptive-mcp` example MCP server; `AI_*` flags/env override both.

**Gate denials are visible to scripts.** `ToolExecutionResult.executed === false`
means the _gate_ blocked the call, as opposed to the tool running and failing; a
one-shot run that blocked at least one call exits `4` (`ExitCode.ApprovalDenied`).
`decision` alone cannot tell the two apart — an **approved** confirmation also
carries `decision: "require_confirmation"`.

**Definition of done:** `pnpm build` + `pnpm typecheck` + `pnpm test` + `pnpm lint`
all green.

**Type-checking covers the tests.** `pnpm typecheck` runs two configs: the build
config (`tsconfig.json`, which excludes `**/*.test.ts` so `pnpm build` never emits
them) and `tsconfig.test.json`, which includes them. Until the second config
existed, **30 type errors sat in the suite unnoticed** — vitest transpiles without
checking, so only a runtime failure would ever have revealed them.

**Trap when editing a tsconfig:** a malformed one makes `tsc -p` ignore it and
compile the whole tree in place (no `outDir`), emitting `.js` beside every source
file — and those then shadow the `.ts` modules in vitest's module resolution. If
tests suddenly fail with `exports is not defined`, look for emitted files under
`src/` and delete them.

**The CLI has an end-to-end test.** `src/cli.e2e.test.ts` spawns the real entry
point against two local fixtures — `src/testing/openai-stub.ts` (an
OpenAI-compatible endpoint) and `src/testing/mcp-server.ts` (a stdio MCP server) —
so flags, catalog, MCP transport, loop, runtime and renderer are exercised
together with no network. `tsconfig.json` excludes `src/testing/**`, so no fixture
is ever built or published; the tests run them through `tsx`.

**Formatting caveat.** `pnpm format` rewrites files you did not touch — the tree
predates the current prettier's output for TS argument wrapping and for markdown
(`*` bullets, `*emphasis*`), and **no prettier version in the declared range is
clean** (#49). So run prettier on the files a change already touches, never as a
blanket sweep: a blanket run buries the real change in cosmetic churn. CI does not
check formatting, so nothing will catch it for you.

**Coverage gate.** `pnpm test:coverage` enforces ratcheted v8 thresholds
(`vitest.config.ts`); CI runs it. Type-only modules and the CLI/REPL entry points
are excluded — `src/cli.ts` runs `main()` at import time, so it is exercised by
spawning it (`src/cli.e2e.test.ts`) and `src/repl.ts` has a unit test; what the
gate measures is the library core and adapters, by import.

**CI** (`.github/workflows/ci.yml`) enforces the same on push/PR. The
`@adaptivemcp/*` dependencies come from npm (they are published, not `link:`ed),
so CI installs from the registry and needs no sibling checkout. CI runs **Node
26** (the documented recommendation), where `node:sqlite` is available without a
flag; the optional `integration-qc` job is gated on the `QC_E2E_ENABLED`
variable (the QC repo is public, so no token is needed).

## Architecture (seams)

The agent is three seams plus a loop (`src/`):

| Seam      | Interface                        | Implementations                                                                                                                                                           |
| --------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model     | `ChatModel` (`src/types.ts`)     | `AiSdkModel` (Vercel AI SDK, OpenAI-compatible; `step` + token streaming), `ScriptedModel` (tests/demo)                                                                   |
| Transport | `Toolset` (`src/mcp/toolset.ts`) | `StdioToolset` (official MCP SDK, stdio), `HttpToolset` (official MCP SDK, Streamable HTTP), `InMemoryToolset` (tests/demo), `AggregateToolset` (namespaced multi-server) |
| Execution | `AgentExecutor` (`src/types.ts`) | `AgentRuntime` (`src/runtime.ts`)                                                                                                                                         |

`runAgent` (`src/agent/loop.ts`) is the tool-calling loop: ask the model for one
step, execute any tool calls through the executor, append the results, repeat
until no tool calls or `maxSteps`. Each step's model can be chosen by
`selectModel` (Adaptive MCP routing via `AgentRuntime.modelProvider`) from the
`src/models/` catalog; `--model <id>` pins one. An optional `decide`
(`DecisionProvider`, e.g. `AgentRuntime.systemOneProvider`) runs first and may
override the step's model, tool subset, and decoding.

The model catalog (`src/models/`) is the _pool of resources_: it auto-discovers
pulled Ollama models from `GET /api/tags` (`src/models/ollama.ts`) and pools
several keys for the same provider/model (`OPENAI_API_KEY`, `OPENAI_API_KEY_2`,
…) into one `PooledChatModel` (`src/models/pool.ts`) that fails over between
them. The System One decision layer (`src/decision/`) is a separate, local,
non-chat HTTP seam — never a `ChatModel`.

**Skills** (`src/skills.ts`) are host-owned instructions, not a protocol concept
(ADR-004): a directory of `<name>/SKILL.md` files, discovered from `--skills <dir>`
(plus the `./skills` convention) and exposed to the model as an ordinary toolset
(`skillsToolset`, namespaced `skills_*`), so reading one goes through
`AgentRuntime.execute` like any MCP tool. Only `name`/`description` enter the
system prompt — progressive disclosure — and the body is fetched on demand; the
read tool is confined to the skill's own directory, and a malformed `SKILL.md` is
warned about and skipped rather than failing the run.

**Delegation** (`src/delegation.ts`) is a `task` tool, off unless `--task`: a
sub-agent that runs in its own session and returns only its result. Two rules
bound it — the child never auto-approves (delegation must not amplify authority)
and it never receives the `task` tool itself (recursion is bounded). A **named
agent** is a skill whose frontmatter declares `tools`/`deny`: `narrowTools`
intersects it with the parent's list, so a definition can only narrow, and an
unknown name fails the call rather than quietly acting as a generalist. Its
completion notifications arrive through `AgentRuntime.queueMessage`, which
`review()` drains one step at a time.

`AgentRuntime` is the bridge into Adaptive MCP. It wires `AdaptiveRuntime`
(telemetry → store → evaluation → derived view), `ThinClient` (approval gate +
retry + middleware), and `GraphTrackingMiddleware`, and exposes:

- `execute(call, spec)` — the only path a tool call should take (records telemetry,
  runs the gate, applies middleware, updates the view);
- `runAdaptation()` — `router.routeAll()` + `orchestrator.planAll()`;
- `evaluateWorkflows()` — cross-session/workflow learning;
- `toolsMetadata(mime?)` — the derived `tools-metadata` view;
- `suggestDecoding(tool, capabilities, { intent })` — advisory decoding profile.
- `decodingProvider(capabilities, { tool, intent })` — a `DecodingProvider` for
  `runAgent` that applies the strongest learned decoding profile to each step.
- `suggestModel(tool, { server })` — the `Router`'s learned model id for a tool.
- `modelProvider(catalog, { tool, server })` — a `ModelSelector` for `runAgent`
  that routes each step to the learned model (or the catalog default).
- `systemOneProvider(catalog, { model, backend, backends })` — a
  `DecisionProvider` for `runAgent` backed by a fast System One model. One cheap
  call decides model + tool intent + decoding from the learned metadata; it
  declines (falling back to `modelProvider`) when the backend fails or is not
  confident. Two backends are wired behind the same `DecisionBackend` seam: the
  local Ollama one (`/v1/systemone`, `tev1:0.8b` by default) and a remote
  OpenAI-compatible one (`OpenAiSystemOneBackend`, tier 1) that prompts any
  `/chat/completions` endpoint. The CLI selects a tier with
  `--system1-backend ollama|openai` (`$SYSTEM1_BACKEND`, default `ollama`; the
  `openai` tier needs `--system1-model`/`$SYSTEM1_MODEL` and fails fast as
  config/exit 3 without it); a **comma list** (`--system1-backend
ollama,openai`, or the same via `$SYSTEM1_BACKEND`) resolves to `backends` —
  the tiered chain below — with invalid selectors failing as usage/exit 2, and
  in a list `--system1-model` naming the `openai` element while the `ollama`
  element keeps its local default. Pass `backend` to inject one (or a test
  double), or `backends: [...]` to compose a tiered one
  (`TieredSystemOneBackend`): ordered
  by `tier` (local first), failover **on errors only** (low confidence declines
  in the advisor instead), one shared `timeoutMs` budget split across tiers so
  failover can never double latency, and **one fallback per decision call** (at
  most two backends — construction throws on more). `onFallback` reports a
  tier that failed and was retried; `onError` still means every tier failed.
  `lastDecisionSummary()` (REPL `/decision`) attributes the tier that answered,
  e.g. `backend openai:… (fell back from ollama:…)`. The opt-in live check is
  `pnpm test:system1` (`SYSTEM1_LIVE=1`, skipped when the backend is absent).
- `seedToolAnnotations(specs, { defaultRisk })` — seed static risk from standard
  MCP tool annotations (falling back to a local `defaultRisk` for servers that
  ship none) so the gate can prompt before learning. Server `initialize`
  instructions are read via `StdioToolset.instructions()` and surfaced to the
  model as clearly-labelled untrusted data.
- `applyServerMetadata(doc, {server})` / `serverPolicySummary()` — read and apply
  the server's `dev.adaptivemcp/tools-metadata` policy as a floor.
- `setRequestApproval(fn)` / `approvalReason(tool)` — human-in-the-loop approvals.
  **With no approver set, a `require_confirmation` tool is denied** (fail closed);
  auto-approval is an explicit opt-in (the CLI's `--yes`). A permissive default
  here once ran exactly the tools a policy had flagged for a human.
- `pauseOnApproval` option, plus `pendingSuspensions()`, `resumeSuspension(id, {
approve })`, `saveResumeState(messages)` and `resumeMessages(suspension)` —
  pause/resume. A paused call returns `executed: false` (blocked, not failed) and
  records **no** tool failure; the resume grant covers one call, and answering a
  suspension is idempotent.
- `queueMessage(text)` / `drainQueuedMessages()` — the message queue `review()`
  drains one step at a time. Delegation uses it so a background child reports its
  result without the parent polling.
- `store` option — build a runtime over an existing store instead of opening one.
  A delegated child uses it to share the parent's memory (same learned state and
  graph, different session); such a runtime does **not** close a store it was
  handed (`AdaptiveRuntime.close()` closes it unconditionally, so ownership is
  tracked here — see adaptivemcp/adaptive-mcp#51).
- `learnedContext()` / `costSummary()` / `graphView()` — feedback for the REPL.
- `decodingReport()` — per-group applied-decoding telemetry (`DecodingAnalyzer`).
- `metricDriftReport()` — recent-vs-lifetime drift per tool (`computeMetricDrift`).
- `learnedProcedure()` — a repeated tool sequence for this workflow (planning).
- `graphSignals()` / `review()` — graph-aware guardrails injected per step.
- `onExecuted` option — report observations to governing servers.
- `middleware` option — host middleware: output compression (headroom), and the
  opt-in `jobPollingMiddleware` (`--await-jobs`) that awaits a long-running
  tool's job handle via the server's `get_job_status`.

## Golden rules

1. **All tool execution goes through `AgentRuntime.execute`.** Never call a
   `Toolset` directly from the loop or CLI (that bypasses the gate, middleware,
   graph tracking, and telemetry).
2. **The model/seam stays provider-agnostic.** Adding a provider means adding a
   `ChatModel`; do not leak AI SDK types past `src/provider/ai-sdk.ts`.
3. **Keep the agent's own LLM calls owned by the agent.** This is what lets
   routing/decoding recommendations actually apply; never delegate the loop to a
   provider-hosted agent runner.
4. **Offline by default in tests.** Tests use `ScriptedModel` + `InMemoryToolset`;
   never require network or API keys.
5. **Local by default at runtime.** stdio MCP only for now; if HTTP transport is
   ever added, bind `127.0.0.1` and require auth.

## Conventions

- ESM, `"type": "module"`, `.js` extensions in relative imports, TypeScript strict
  (`noUnusedLocals`/`noUnusedParameters`/`noUncheckedIndexedAccess`).
- Avoid `any`; prefer `unknown` and narrow. ESLint flat config, Prettier (same
  rules as `adaptive-mcp`: double quotes, 100 cols, trailing commas).
- **pnpm 11 gotcha:** `pnpm.overrides` / `pnpm.onlyBuiltDependencies` in
  `package.json` are ignored. Settings live in `pnpm-workspace.yaml`
  (`allowBuilds`, `overrides`).

## Current limitations / next

- Interactive streaming REPL (`src/repl.ts`) + one-shot CLI, both streaming. A
  full-screen TUI is deferred (`priority:low`; see `docs/architecture.md`
  "Full-screen TUI: deferred").
- Decoding and model routing are applied per step (`decodingProvider`,
  `modelProvider`); model selection needs enough per-tool signal
  (`--router-min-invocations`, default 10).
- A step's tool calls share one `agent_turn_<n>` execution-graph root
  (`AgentRuntime.runTurn`); deeper per-turn action nesting is future work.
- See `README.md` and `docs/architecture.md` for the full picture and roadmap.
- `docs/archetypes/` catalogues the components behind the five agent archetypes
  (tool, skills, sequential, human-in-the-loop, orchestrator) and where this host
  stands against them — the reference for prioritising new capability. Its gap
  backlog is the `Agent archetypes` milestone.
