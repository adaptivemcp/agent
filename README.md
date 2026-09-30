# Adaptive MCP Agent

> **Status:** early scaffold — a working library + CLI vertical slice, not yet a
> finished product.

The product implementation of [Adaptive MCP](https://github.com/kemalelmizan/adaptive-mcp):
a provider-agnostic, MCP-native agent that **owns both the LLM completion and the
tool execution**, so every `@adaptivemcp/*` library has a real host learning from
real usage. This repository lives at <https://github.com/adaptivemcp/agent>.

It consumes all Adaptive MCP libraries — `spec`, `memory`, `telemetry`,
`evaluation`, `extension`, `runtime`, `routing`, `orchestration`, `approval`,
`thin-client`, `middleware`, `graph-analysis` — and adds only three thin seams
plus an agent loop.

## Quick start (offline)

Requires **Node 22+** and **pnpm 11+**. The sibling `adaptive-mcp` packages must be
built first (they are linked, not published):

```bash
# 1. build the libraries
cd ../adaptive-mcp && pnpm install && pnpm -r run build

# 2. this repo
cd ../agent
pnpm install
pnpm demo          # vertical slice: loop -> telemetry -> evaluation -> derived view
pnpm test          # offline: scripted model + in-memory toolset
```

`pnpm demo` runs an in-memory toolset and a scripted model (no network, no API
key), accumulates varied telemetry, then prints the derived `tools-metadata`
view, the learned decoding recommendation, and the decoding actually applied to
the next run (`AgentRuntime.decodingProvider`).

## Running it (interactive)

With the sibling `adaptive-mcp` example server built and a local
OpenAI-compatible model running, no flags are needed — `pnpm dev` starts an
interactive, streaming REPL:

```bash
pnpm dev
```

Defaults (each overridable by a flag or an `AI_*` env var):

| Setting | Default |
| --- | --- |
| Model endpoint | `http://127.0.0.1:8079/v1` (a local `llama-server`) |
| API key | `$AI_API_KEY`, else `$LLAMA_API_KEY` |
| Model id | `Qwen/Qwen3-8B` (any OpenAI-compatible id; llama.cpp ignores the field) |
| MCP server | the sibling `adaptive-mcp` example server (`examples/dist/server.js`) |

In the REPL, type a message and press Enter. Assistant text streams as it is
generated; tool calls and results print underneath. Commands: `/tools`,
`/models`, `/graph` (the per-turn execution DAG), `/metadata`, `/cost`,
`/policy`, `/drift`, `/retrieve [hash]`, `/decoding <tool>`, `/decoding-report`,
`/reset`, `/exit`.

- **Approvals.** Tools the gate marks `require_confirmation` — high-risk from the
  server's standard MCP annotations, or learned-flaky — prompt
  `approve <tool>? — <reason> (y/N)` in the REPL. `--yes` auto-approves.
- **Learned context.** Before each turn the agent injects a compact summary of
  observed tool reliability/insights into the system prompt (progressive
  disclosure of evaluation output); `--no-context` disables it.
- **Cost.** Priced models record their token cost per tool call; `/cost` shows
  the recorded totals.
- **Decoding telemetry.** The decoding applied per step is recorded on each tool
  execution (`ToolDecoding` + token usage); `/decoding-report` summarizes it by
  `(tool, profile, model)` via `DecodingAnalyzer` (`@adaptivemcp/routing`).
- **Compression.** `--compress` routes large tool output through the headroom MCP
  server (`HeadroomMiddleware`); `/retrieve` fetches the original by hash.
- **Persistence.** `--history <file>` restores and saves the conversation as
  JSON; `--session <id>` keeps the graph/stats session stable across runs.
- **Reporting.** `--report` sends each tool observation back to servers that
  expose the `report_observation` tool (the spec-legal client→server channel).
- **Server-governed policy.** Each server's `dev.adaptivemcp/tools-metadata`
  resource is read at startup and applied as a floor: static `owner`/`risk`/
  `description`, `require_approval`, and per-tool budgets (`/policy` shows what
  is in effect; `--no-server-policy` disables).
- **Guardrails & planning.** `--workflow <id>` enables cross-session
  graph/pattern learning: the learned context can include an observed tool
  procedure, and new failure-cascade/anomaly signals are injected into the
  conversation as warnings.

## Models

The agent has a **catalog of model integrations**. Adaptive MCP picks which one
serves each turn from the `Router`'s learned per-tool recommendation — the
cheapest model for fast tools, the lowest-latency one for slow tools — falling
back to a default until there is enough signal.

Built-in integrations (only those whose key is set become active):

| id | provider | default model | key |
| --- | --- | --- | --- |
| `local` | OpenAI-compatible (llama.cpp) | `Qwen/Qwen3-8B` | `LLAMA_API_KEY` / `AI_API_KEY` |
| `openai` | OpenAI-compatible | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic | `claude-3-5-haiku-latest` | `ANTHROPIC_API_KEY` |
| `google` | Google | `gemini-2.5-flash` | `GOOGLE_GENERATIVE_AI_API_KEY` |

- `--model <id>` pins one catalog model (turns adaptive selection off).
- `/models` lists the active integrations; the REPL prefixes each turn with the
  model being used, e.g. `[local]`.
- `--models <file>` (or `$AGENT_MODELS`) adds or overrides integrations:

```json
{
  "default": "local-cheap",
  "models": [
    { "id": "local-cheap", "provider": "openai-compatible", "model": "Qwen/Qwen3-8B",
      "baseURL": "http://127.0.0.1:8079/v1", "apiKeyEnv": "LLAMA_API_KEY",
      "costWeight": 1, "latencyWeight": 1, "default": true },
    { "id": "local-fast", "provider": "openai-compatible", "model": "Qwen/Qwen3-8B",
      "baseURL": "http://127.0.0.1:8079/v1", "apiKeyEnv": "LLAMA_API_KEY",
      "costWeight": 2, "latencyWeight": 0.5 }
  ]
}
```

`costWeight`/`latencyWeight` feed the Router (lower latency weight = faster).
Selection starts after `--router-min-invocations` (default 10) observations per
tool, so it needs either a few runs against a persistent `--db` or a lower
threshold for demos.

### Against your own endpoint and servers

```bash
AI_API_KEY=... AI_BASE_URL=https://api.openai.com/v1 AI_MODEL=gpt-4o-mini \
pnpm dev -- \
  --server "files=npx -y @modelcontextprotocol/server-filesystem /tmp"
```

- `--server "name=command args"` is repeatable; tool names are always namespaced
  `<server>_<tool>`.
- `--prompt "..."` runs a single turn and exits instead of starting the REPL.
- `--no-stream` disables token streaming; `-v/--verbose` prints applied decoding
  and the derived view after a one-shot run.
- `AI_BASE_URL` accepts any OpenAI-compatible endpoint (OpenAI, Ollama, llama.cpp,
  vLLM, ...).
- `--list-tools` prints discovered tools and exits; `--db`/`--yaml` persist the
  store and the derived view of the agent's own store (the MCP server keeps its
  own).

## Architecture

```text
LLM provider (AI SDK)  ── owns completion ──►  routing / decoding recommendations
      ▲
      │ messages                    AgentRuntime (Adaptive MCP)
runAgent loop (plan → tools) ──► ThinClient (approval + retry + middleware
      │                                          + execution graph)
      ▼
Toolset (stdio MCP / in-memory) ──► tools from one or many servers
      │
      ▼
TelemetryRecorder → MemoryStore → Evaluator / GraphAnalyzer → ExtensionController
                                   → tools-metadata view (YAML/JSON)
```

- **Model seam** (`ChatModel`): `AiSdkModel` (Vercel AI SDK, OpenAI-compatible,
  `step` + `stream`) and `ScriptedModel` (deterministic, for tests/demo). Each
  model advertises the decoding knobs it supports (`capabilities`);
  `AgentRuntime.decodingProvider(...)` resolves learned profiles against them and
  applies them to each step. `stream()` powers the REPL's token streaming.
- **Transport seam** (`Toolset`): `StdioToolset` (official MCP SDK), `InMemoryToolset`,
  and `AggregateToolset` for multiple servers.
- **Execution seam** (`AgentExecutor`): `AgentRuntime`, which wires
  `AdaptiveRuntime` + `ThinClient` + `GraphTrackingMiddleware`.

See [`docs/architecture.md`](./docs/architecture.md) and [`AGENTS.md`](./AGENTS.md).

## Security

- stdio MCP only today; local by default. If HTTP transport is added, bind
  `127.0.0.1` and require auth.
- Dependency overrides in `pnpm-workspace.yaml` pin patched transitive versions
  pulled by the MCP SDK (see the
  [Adaptive MCP README](https://github.com/kemalelmizan/adaptive-mcp#security)).
  Run `pnpm audit --prod` before releases.

## License

MIT. Copyright (c) 2026 Kemal Elmizan.
