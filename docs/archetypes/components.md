# Shared components

The components every archetype draws on. Each lists its **purpose**, a
**contract sketch** (shape, not API — do not read it as a decision), the
**reference** to learn from (with a file path), the **failure mode** it prevents,
and **our coverage**.

---

## 1. Tool registry

**Purpose.** The model can only call what is described to it, so a registry maps
each tool to the metadata the model needs (`name`, `description`, `inputSchema`)
and — separately — to the metadata _humans and policy_ need (risk, ownership,
idempotency, provenance).

**Contract (sketch).**

```ts
type ToolSpec = {
  name: string; // model-facing
  description: string;
  inputSchema: Record<string, unknown>;
  // non-model metadata, never serialized to the prompt:
  title?: string; // human-facing display name
  hints?: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean };
  provenance?: "declared" | "discovered"; // who said this tool exists
};
```

**Reference.** `agno/libs/agno/agno/tools/function.py` — the `Function` model
keeps `title` explicitly out of what the model sees ("Never sent to the model,
which reads name/description/parameters: `to_dict()` serializes an explicit
allowlist") and carries MCP behaviour hints. `opencode` keeps
declared-vs-discovered provenance in its registry (`packages/opencode/src/tool/registry.ts`).

**Failure mode prevented.** Metadata that is _useful to a human or a policy_ gets
sent to the model (prompt bloat, or worse, leaking internal names); and a tool
whose existence came from discovery is treated as if a human had declared it.

**Our coverage.** ✅ `ToolSpec` (`src/types.ts`) carries `name`,
`description`, `inputSchema`, `serverName`, and standard MCP `annotations`;
`AgentRuntime.seedToolAnnotations` seeds risk from them. We do **not** separate a
human-facing `title`, and provenance is implicit (everything is discovered from
an MCP server).

---

## 2. MCP client / transport / namespacing

**Purpose.** Connect to MCP servers, list their tools, call them, and keep the
names from colliding across servers.

**Contract (sketch).**

```ts
interface Toolset {
  listTools(): Promise<ToolSpec[]>;
  callTool(name: string, args: unknown): Promise<ToolResult>;
  close(): Promise<void>;
}
// namespacing: "<server>_<tool>" so a flat model-facing namespace stays unique
```

**Reference.** `opencode/packages/opencode/src/mcp/catalog.ts` — `toolName(client, name)`
= `sanitize(client) + "_" + sanitize(name)`, and (verified live) tools arrive at
the host as `headroom_headroom_compress`. `llama.cpp` pools server connections so
repeated spawns are avoided.

**Failure mode prevented.** Two servers exposing the same tool name silently
shadow each other; a server that dies takes the host with it.

**Our coverage.** ✅ `StdioToolset`, `HttpToolset`, `AggregateToolset`
(`src/mcp/`) with namespacing and per-server `cwd`/`env`. Server _pooling_
across runs does not exist (each run spawns fresh) — acceptable for a CLI, a gap
for a long-lived daemon.

---

## 3. Execution seam

**Purpose.** One choke point every tool call goes through, so policy, middleware
and telemetry cannot be bypassed by a code path that "just calls the tool".

**Contract (sketch).**

```ts
interface AgentExecutor {
  execute(call: ToolCall, spec: ToolSpec): Promise<ToolResult>;
  // implementations: gate → middleware chain → transport → telemetry
}
```

**Reference.** Our own `AgentRuntime.execute` is the clearest example of this
being load-bearing (`agent/AGENTS.md`: "All tool execution goes through
`AgentRuntime.execute`"). `opencode`'s tool registry plus middleware plays the
same role.

**Failure mode prevented.** A tool call that skips the approval gate, the
middleware chain, or the telemetry — measured behaviour stops matching actual
behaviour.

**Our coverage.** ✅ single seam, enforced by convention and documented as a
golden rule in `agent/AGENTS.md`.

---

## 4. Result classification

**Purpose.** Turn what a server returned into a _learned outcome_: success,
failure, or a policy denial — so reliability is learned rather than assumed.

**Contract (sketch).**

```ts
type ToolResult =
  | { ok: true; output: unknown }
  | { ok: false; error: string; code?: string; decision?: "denied" | "require_confirmation" };
```

**Reference.** Two negative examples prove how easily this goes wrong: **Opencode
reports a non-zero `shell` exit as `status: "completed"`** (we had to classify it
ourselves, see the plugin's `treatNonZeroExitAsFailure`), and **QC reports policy
denials in-band as `status: "error"`** (the agent must learn them as failures).

**Failure mode prevented.** A host that _looks_ 100% reliable because every
failure is filed as a success — the failure rate stays 0 and no recommendation
can ever form.

**Our coverage.** ✅ `ToolExecutionResult` + the classifier seam; the QC e2e test
(`src/mcp/qc-mcp.integration.test.ts`) exists specifically to pin the in-band
denial case.

---

## 5. Model seam

**Purpose.** The host owns the completion call, so routing and decoding
recommendations have somewhere to land.

**Contract (sketch).**

```ts
interface ChatModel {
  name: string;
  capabilities?: ModelCapabilities;
  step(messages: ChatMessage[], opts): Promise<ChatStep>; // toolCalls + text
}
```

**Reference.** `smolagents` (models as a pluggable seam), `opencode` (provider
catalog + per-agent model). Our `AiSdkModel` + `ModelCatalog` (`src/models/`,
`src/provider/ai-sdk.ts`).

**Failure mode prevented.** Delegating the loop to a provider-hosted runner,
where learned routing/decoding can no longer be applied (a stated golden rule:
"keep the agent's own LLM calls owned by the agent").

**Our coverage.** ✅ with token streaming, a model catalog, and learned per-tool
routing/decoding (`AgentRuntime.modelProvider` / `decodingProvider`).

---

## 6. Memory

**Purpose.** Keep what happened, in a shape that can be replayed and summarised:
not just a message array, but typed records of _tasks, actions, and plans_.

**Contract (sketch).**

```ts
type MemoryStep =
  | { kind: "task"; text: string }
  | { kind: "action"; tool: string; input: unknown; output: unknown; ok: boolean }
  | { kind: "plan"; text: string };
```

**Reference.** `smolagents/src/smolagents/memory.py` — `TaskStep`, `ActionStep`,
`PlanningStep` under one `AgentMemory`; replayable, and `planning_interval` decides
_when_ a plan step is produced.

**Failure mode prevented.** A memory that is only raw prose, so nothing can be
compiled from it, and a plan that is generated once and never revisited.

**Our coverage.** 🟡 — we persist execution **events** and a graph
(`MemoryStore`, `MetricCells`, `execution_nodes`), which is arguably richer than
typed steps, but there is no _planning_ record at all and no per-step task text.

---

## 7. Durable state

**Purpose.** Make a run resumable: stop the process, keep the state, and continue
later — including after a human answers a question.

**Contract (sketch).**

```ts
interface Checkpointer {
  save(threadId: string, state: unknown): Promise<void>;
  load(threadId: string): Promise<unknown | undefined>;
}
// a resume is: load(thread) → apply the answer → continue from the recorded step
```

**Reference.** `langgraph/libs/checkpoint` — `BaseCheckpointSaver`, state keyed by
`thread_id` in the run config; `interrupt`/resume **requires** it. `agno` has a
storage layer per backend (`libs/agno/agno/db/`: postgres, sqlite, dynamo, …).

**Failure mode prevented.** "Pause for approval" that only works while the process
is alive; a crash losing hours of work; no way to answer a question tomorrow.

**Our coverage.** 🟡 — we persist to SQLite (`--db`), key runs by `--session`, and
`--history` restores the conversation. What is missing is _resumption semantics_:
there is no recorded "we stopped at step N awaiting a decision", so a run cannot
continue where it halted.

---

## 8. Guardrails: policy, permissions, approvals

**Purpose.** Decide what the agent may do _before_ it does it, from a policy that
is inspectable and not written by the model.

**Contract (sketch).**

```ts
type Decision = "allow" | "deny" | "require_confirmation";
interface ApprovalPolicy {
  gate(call: ToolCall, ctx: { risk: Risk; failureRate: number }): Decision;
}
```

**Reference.** `opencode/packages/opencode/src/permission/arity.ts` — permissions
are matched per _"human-understandable command"_ via a command-arity table
(`git checkout main` → the grantable unit is `git checkout`), not per exact argv.

**Failure mode prevented.** A deny list that is trivially bypassed by rewording a
command; a policy the agent can edit; an approval prompt so noisy it gets
auto-approved.

**Our coverage.** ✅ `ApprovalGate` (deny → risk annotation → learned failure
rate → allow) in `@adaptivemcp/approval`, seeded from MCP annotations, plus the
server's `dev.adaptivemcp/tools-metadata` as a **floor**, and `--yes` for
non-interactive runs.

---

## 9. Telemetry / observability

**Purpose.** Record enough to learn from later, without recording what must stay
private.

**Contract (sketch).**

```ts
type ToolEvent = {
  toolName: string;
  serverName?: string;
  sessionId?: string;
  status: "started" | "completed" | "failed";
  durationMs?: number;
  cost?: number;
  outputBytes?: number;
};
```

**Reference.** `smolagents` telemetry (privacy-preserving by default);
`trl`'s `_send_telemetry` (rank-0, allowlist, bucketing) as a _negative_ lesson in
what to gate.

**Failure mode prevented.** Learning from aggregate guesses instead of events;
leaking row values/credentials into telemetry.

**Our coverage.** ✅ `TelemetryRecorder` → `MemoryStore` → `Evaluator` → derived
`tools-metadata` view; metrics, drift, cost, graph.

---

## 10. Configuration

**Purpose.** Make a setup reproducible without re-typing it, and without a
provider-specific format.

**Contract (sketch).**

```yaml
# one file; flags override it
servers: ["qc=qc mcp"]
model: gpt-4o-mini
db: .agent/agent.db
```

**Reference.** `agno`'s dotted hierarchical config; `opencode`'s `opencode.json`.

**Failure mode prevented.** A wall of flags; a config format that can only be
expressed in one tool.

**Our coverage.** ✅ `--config` (YAML or JSON, flags override), plus env vars
(`src/agent-config.ts`).
