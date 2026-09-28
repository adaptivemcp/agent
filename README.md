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

## Running against real MCP servers and a real model

```bash
AI_API_KEY=... AI_BASE_URL=https://api.openai.com/v1 AI_MODEL=gpt-4o-mini \
pnpm dev -- \
  --server "files=npx -y @modelcontextprotocol/server-filesystem /tmp" \
  --prompt "List the files in /tmp"
```

- `--server "name=command args"` is repeatable; tools are namespaced
  `<server>_<tool>` when more than one server is present.
- `AI_BASE_URL` accepts any OpenAI-compatible endpoint (OpenAI, Ollama, llama.cpp,
  vLLM, ...).
- `--list-tools` prints discovered tools and exits; `--db`/`--yaml` persist the
  store and the derived view.

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

- **Model seam** (`ChatModel`): `AiSdkModel` (Vercel AI SDK, OpenAI-compatible) and
  `ScriptedModel` (deterministic, for tests/demo). Each model advertises the
  decoding knobs it supports (`capabilities`); `AgentRuntime.decodingProvider(...)`
  resolves learned profiles against them and applies them to each step.
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
