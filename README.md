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

`pnpm test` stays offline (nothing leaves the machine): besides the scripted
model and in-memory toolset it runs an in-process Streamable HTTP MCP server
end-to-end, including the OAuth flow (static-header and refreshed-token auth).
A separate **real-server** integration test drives
the sibling [QueryCleaner/QC](../../qc) MCP server over stdio (it needs QC's
`uv` venv); run it with `pnpm test:integration` (it is skipped unless
`QC_MCP_INTEGRATION=1`). CI runs it in the optional `integration-qc` job, which
is enabled by setting the repository variable `QC_E2E_ENABLED=true` and the
`QC_REPO_TOKEN` secret (read access to the private QC repo).

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

| Setting        | Default                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| Model endpoint | `http://127.0.0.1:9931/v1` (a local `llama-server`)                     |
| API key        | `$AI_API_KEY`, else `$LLAMA_API_KEY`                                    |
| Model id       | `Qwen/Qwen3-8B` (any OpenAI-compatible id; llama.cpp ignores the field) |
| MCP server     | the sibling `adaptive-mcp` example server (`examples/dist/server.js`)   |

In the REPL, type a message and press Enter. Assistant text streams as it is
generated; tool calls and results print underneath. Commands: `/tools`,
`/models`, `/graph` (the per-turn execution DAG), `/metadata`, `/cost`,
`/policy`, `/drift`, `/retrieve [hash]`, `/decoding <tool>`, `/decoding-report`,
`/decision` (the last System One decision), `/reset`, `/exit`.

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

| id               | provider                      | default model             | key                            |
| ---------------- | ----------------------------- | ------------------------- | ------------------------------ |
| `local`          | OpenAI-compatible (llama.cpp) | `Qwen/Qwen3-8B`           | `LLAMA_API_KEY` / `AI_API_KEY` |
| `openai`         | OpenAI-compatible             | `gpt-4o-mini`             | `OPENAI_API_KEY`               |
| `anthropic`      | Anthropic                     | `claude-3-5-haiku-latest` | `ANTHROPIC_API_KEY`            |
| `google`         | Google                        | `gemini-2.5-flash`        | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `ollama-<model>` | Ollama (auto-discovered)      | each pulled model         | none (local)                   |

- **Ollama (auto-discovered).** On startup the agent queries a running Ollama
  server's `GET /api/tags` (default `http://127.0.0.1:11434`, override with
  `$OLLAMA_BASE_URL`) and registers each pulled model as an integration
  (`ollama-qwen3-5-4b`, `ollama-tev1-0-8b`, …). Discovery is best-effort: if the
  server is down the catalog simply starts without those entries. `--no-ollama`
  disables it.
- **Key pooling.** Several keys for the same provider/model (e.g.
  `OPENAI_API_KEY`, `OPENAI_API_KEY_2`, `OPENAI_API_KEY_3`) become a _key pool_:
  one catalog entry whose `ChatModel` is a `PooledChatModel` that round-robins
  across the keys and fails over to the next one, cooling a key down, when a call
  throws (rate limit, auth, transient error). `$NAME` and `$NAME_2…` are pooled;
  _alternative_ env names (e.g. `AI_API_KEY` vs `LLAMA_API_KEY`) are not — the
  first set one wins. `/models` shows `(N keys pooled)`.
- `--model <id>` pins one catalog model (turns adaptive selection off).
- `/models` lists the active integrations; the REPL prefixes each turn with the
  model being used, e.g. `[local]`.
- `--models <file>` (or `$AGENT_MODELS`) adds or overrides integrations:

```json
{
  "default": "local-cheap",
  "models": [
    {
      "id": "local-cheap",
      "provider": "openai-compatible",
      "model": "Qwen/Qwen3-8B",
      "baseURL": "http://127.0.0.1:9931/v1",
      "apiKeyEnv": "LLAMA_API_KEY",
      "costWeight": 1,
      "latencyWeight": 1,
      "default": true
    },
    {
      "id": "local-fast",
      "provider": "openai-compatible",
      "model": "Qwen/Qwen3-8B",
      "baseURL": "http://127.0.0.1:9931/v1",
      "apiKeyEnv": "LLAMA_API_KEY",
      "costWeight": 2,
      "latencyWeight": 0.5
    }
  ]
}
```

`costWeight`/`latencyWeight` feed the Router (lower latency weight = faster).
Selection starts after `--router-min-invocations` (default 10) observations per
tool, so it needs either a few runs against a persistent `--db` or a lower
threshold for demos.

### System One decisions (fast path)

`--system1` adds a _System-1_ decision layer in front of the router: one cheap,
local call to an Ollama System One model
([`/v1/systemone`](https://docs.ollama.com/api/systemone)) that turns the learned
Adaptive MCP metadata (tool reliability, annotations) plus the user's request
into a single JSON verdict on **which model**, **which tool** (if any), and
**which decoding profile** to use. The loop applies the verdict before the slower
chat model runs; when the decision model is down or not confident, it declines
and the Router/`--model` fallback takes over.

```bash
ollama pull tev1:0.8b          # a local System One model
pnpm dev -- --system1          # uses $SYSTEM1_MODEL, else tev1:0.8b
```

- `--system1-model <id>` selects the decision model (`$SYSTEM1_MODEL`).
- `--system1-backend <ollama|openai>` selects the tier (`$SYSTEM1_BACKEND`,
  default `ollama`): the local Ollama endpoint above, or the remote
  OpenAI-compatible tier below. The `openai` tier needs a model — pass
  `--system1-model` or set `$SYSTEM1_MODEL` (there is no guessed default, since
  a wrong hosted model name is a runtime 404); a bad tier or missing model
  fails fast with exit code 3.
- The backend URL reuses `$OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`).
- `/decision` shows the last decision (model, tools, decoding, confidence,
  rationale).

**Remote backends.** The decision layer is not tied to a local Ollama. The same
`DecisionBackend` seam has a second, remote tier: `OpenAiSystemOneBackend` posts
one prompt to any OpenAI-compatible `/chat/completions` endpoint (a hosted
`gpt-4o-mini`, a self-hosted vLLM/llama-server, or a gateway) and coerces the
JSON reply back into the `SystemOneResponse` shape, so hosts without a local
`tev1` model can still use the fast path. From the CLI:

```bash
pnpm dev -- --system1 --system1-backend openai --system1-model gpt-4o-mini
```

or inject it (or any backend) programmatically — the injected backend
overrides the built-in Ollama construction entirely:

```ts
import { OpenAiSystemOneBackend } from "@adaptivemcp/agent";

const provider = runtime.systemOneProvider(catalog, {
  backend: new OpenAiSystemOneBackend({
    model: "gpt-4o-mini", // required
    baseURL: process.env.SYSTEM1_BASE_URL, // defaults to $SYSTEM1_BASE_URL, else OpenAI
    apiKey: process.env.SYSTEM1_API_KEY, // defaults to $SYSTEM1_API_KEY, else $OPENAI_API_KEY
  }),
});
```

To exercise the remote tier against a real endpoint (opt-in, skipped when the
backend is absent so the default `pnpm test` stays offline):

```bash
SYSTEM1_LIVE=1 \
SYSTEM1_LIVE_BASE_URL=https://api.openai.com/v1 \
SYSTEM1_LIVE_API_KEY=$OPENAI_API_KEY \
SYSTEM1_LIVE_MODEL=gpt-4o-mini \
pnpm test:system1
```

**Failover across tiers.** Pass several backends and they compose into one
tiered decision backend (`TieredSystemOneBackend`) that keeps the fast path
fast:

- **Ordering by `tier`** — local first (`0`), remote second (`1`); pass them
  in any order, the tier field decides.
- **Errors only** — a tier falls through to the next on transport/HTTP errors
  (connection refused, timeout, 4xx/5xx, unparseable reply). A _low-confidence_
  verdict never triggers failover: the tier answered, and declining on
  confidence is the advisor's call.
- **One shared timeout budget** — `timeoutMs` (default 8000ms) is split across
  the tiers, so failover can never double decision latency: a hung local tier
  burns only its slice and the remote tier still gets the rest.
- **One fallback per decision call** — at most a primary plus one fallback
  (constructing with more than two backends throws); the cap is structural.
- **Attribution** — `/decision` reports which tier answered, e.g.
  `backend openai:gpt-4o-mini (fell back from ollama:tev1:0.8b)`.

```ts
import { OllamaSystemOneBackend, OpenAiSystemOneBackend } from "@adaptivemcp/agent";

const provider = runtime.systemOneProvider(catalog, {
  backends: [
    new OllamaSystemOneBackend({ model: "tev1:0.8b" }),
    new OpenAiSystemOneBackend({ model: "gpt-4o-mini" }),
  ],
  onFallback: (error, from, to) => console.warn(`failover ${from.id} → ${to.id}`),
  onError: (error) => console.error(`decision declined: ${error}`), // every tier failed
});
```

`onFallback` fires when a tier fails and the next one is actually tried;
`onError` still means the decision layer declined entirely (all tiers failed).

### Against your own endpoint and servers

```bash
AI_API_KEY=... AI_BASE_URL=https://api.openai.com/v1 AI_MODEL=gpt-4o-mini \
pnpm dev -- \
  --server "files=npx -y @modelcontextprotocol/server-filesystem /tmp"
```

- `--server "name=command args"` is repeatable; tool names are always namespaced
  `<server>_<tool>`. For a server that needs its own working directory or
  environment (e.g. QC, which resolves `qc.toml` and secrets from `cwd`), pass a
  JSON object instead:
  `--server '{"name":"qc","command":"/path/.venv/bin/qc","args":["mcp"],"cwd":"/path/project","env":{"QC_SQLITE_PATH":"/path/demo.db"}}'`.
  Remote servers use the Streamable HTTP form:
  `--server '{"name":"remote","transport":"http","url":"http://127.0.0.1:8765/mcp","headers":{"Authorization":"Bearer …"}}'`.
- `--prompt "..."` runs a single turn and exits instead of starting the REPL.
- `--no-stream` disables token streaming; `-v/--verbose` prints applied decoding
  and the derived view after a one-shot run.
- `AI_BASE_URL` accepts any OpenAI-compatible endpoint (OpenAI, Ollama, llama.cpp,
  vLLM, ...).
- `--no-ollama` skips Ollama model auto-discovery; `--system1` /
  `--system1-model <id>` / `--system1-backend <ollama|openai>` enable and
  configure the System One decision layer (see
  [System One decisions](#system-one-decisions-fast-path)).
- `--default-risk <low|medium|high|none>` sets a local fallback risk for tools
  whose server sends no MCP `annotations` (default `medium`), so the approval
  gate has a seed even for thinner third-party servers. A server's own
  annotations always win, and existing (human/learned) values are never
  overwritten. Each server's `initialize` instructions are surfaced to the model
  as clearly-labelled **untrusted** data, never as higher-priority directives.
- `--await-jobs` makes the agent poll a long-running tool's job handle to
  completion (via the server's `get_job_status`) before the loop continues, for
  asynchronous servers. `--await-jobs` is off by default.
- `--list-tools` prints discovered tools and exits; `--db`/`--yaml` persist the
  store and the derived view of the agent's own store (the MCP server keeps its
  own).
- Exit codes are stable: `0` ok, `1` runtime error, `2` usage/no-server,
  `3` provider/catalog config, `4` approval denied (`src/exit-codes.ts`).

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
