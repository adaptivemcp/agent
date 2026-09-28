# AGENTS.md — Adaptive MCP Agent

This repo is the **product implementation** of Adaptive MCP: a provider-agnostic,
MCP-native agent that owns both the LLM completion and the tool execution, so the
`@adaptivemcp/*` libraries finally have a real host generating real telemetry.

It is a **consumer** of the sibling `adaptive-mcp` monorepo, not a fork. Use every
Adaptive MCP library; never reimplement the learning loop here.

## Relationship to `adaptive-mcp`

- Libraries are consumed via `link:` to `../adaptive-mcp/packages/*`.
- **Build the library first** after a clean checkout: from `../adaptive-mcp` run
  `pnpm -r run build` (the linked packages resolve to their `dist/`).
- Do not modify `../adaptive-mcp` from here. If a library needs a change, do it in
  that repo, rebuild, and keep this repo a consumer.
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
pnpm format        # prettier --write
pnpm demo          # offline vertical slice: loop -> telemetry -> derived view
pnpm dev           # interactive REPL (streaming, multi-turn)
pnpm dev -- --prompt "..." --server "fs=npx ..."   # one-shot
pnpm dev -- --help # CLI (tsx)
```

By default `pnpm dev` targets a local `llama-server`
(`${AI_BASE_URL:-http://127.0.0.1:8079/v1}`, key `$AI_API_KEY`/`$LLAMA_API_KEY`)
and the sibling `adaptive-mcp` example MCP server; `AI_*` flags/env override both.

**Definition of done:** `pnpm build` + `pnpm typecheck` + `pnpm test` + `pnpm lint`
all green.

## Architecture (seams)

The agent is three seams plus a loop (`src/`):

| Seam | Interface | Implementations |
| --- | --- | --- |
| Model | `ChatModel` (`src/types.ts`) | `AiSdkModel` (Vercel AI SDK, OpenAI-compatible; `step` + token streaming), `ScriptedModel` (tests/demo) |
| Transport | `Toolset` (`src/mcp/toolset.ts`) | `StdioToolset` (official MCP SDK, stdio), `InMemoryToolset` (tests/demo), `AggregateToolset` (namespaced multi-server) |
| Execution | `AgentExecutor` (`src/types.ts`) | `AgentRuntime` (`src/runtime.ts`) |

`runAgent` (`src/agent/loop.ts`) is the tool-calling loop: ask the model for one
step, execute any tool calls through the executor, append the results, repeat
until no tool calls or `maxSteps`.

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

- Interactive REPL (`src/repl.ts`) + one-shot CLI, both streaming; a full-screen
  TUI is next.
- Decoding recommendations are applied per step via `decodingProvider`; routing
  recommendations are surfaced but not yet auto-applied.
- Execution-graph nodes are rooted per top-level tool call within a session; a
  per-turn workflow DAG is future work.
- See `README.md` and `docs/architecture.md` for the full picture and roadmap.
