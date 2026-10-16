# Tool agent

**What it is.** The agent connects to apps over MCP and takes actions on the
user's behalf: read a file, query a database, send a message, deploy a service.
The model is given a set of described tools; it chooses one, the host executes
it, the result goes back. This is the archetype every other one is built on — a
skills agent still calls tools, a sequential agent still calls tools, an
orchestrator still calls tools.

**When it is the right one.** Nearly always, as the base layer. The interesting
design questions are which tools are _visible_, who decided they exist, and what
happens when one fails.

## Components

### Tool description (the model-facing contract)

- **Purpose.** The model can only call what it can read: `name`, `description`,
  and a JSON `inputSchema`. Everything else is for humans and policy.
- **Contract (sketch).** See [components.md § 1](components.md#1-tool-registry).
- **Reference.** `agno/libs/agno/agno/tools/function.py` — a `title` for humans,
  deliberately excluded from the model payload by an explicit allowlist
  serializer.
- **Failure mode prevented.** Internal/administrative metadata leaking into the
  prompt; a description so vague the model picks the wrong tool.

### MCP client and namespacing

- **Purpose.** Spawn/connect to servers, list tools, call them, and keep names
  from colliding.
- **Contract (sketch).** See [components.md § 2](components.md#2-mcp-client--transport--namespacing).
- **Reference.** `opencode/packages/opencode/src/mcp/catalog.ts` —
  `sanitize(server) + "_" + sanitize(tool)`; live-verified output:
  `headroom_headroom_compress`.
- **Failure mode prevented.** Silent name shadowing between two servers.

### Single execution seam

- **Purpose.** One function every call goes through, so the gate, middleware and
  telemetry cannot be bypassed.
- **Contract (sketch).** See [components.md § 3](components.md#3-execution-seam).
- **Reference.** `@adaptivemcp/agent`'s own `AgentRuntime.execute`; documented as
  a golden rule in `AGENTS.md`.
- **Failure mode prevented.** Un-gated / un-measured calls.

### Result classification

- **Purpose.** Decide whether the call _succeeded_, so reliability is learned
  rather than assumed.
- **Contract (sketch).** See [components.md § 4](components.md#4-result-classification).
- **Reference.** Two cautionary cases with real bugs behind them: OpenCode's
  non-zero `shell` exit arrives as `status: "completed"`, and QC reports policy
  denials in-band as `status: "error"`.
- **Failure mode prevented.** A tool that looks flawless because every failure is
  filed as success.

### Tool annotations → risk → approval seeding

- **Purpose.** Bootstrap the guardrail from what the _server_ declared
  (`readOnlyHint`, `destructiveHint`) instead of guessing, and let the server
  raise the floor.
- **Contract (sketch).** `annotations → { risk, requireApproval }`, merged with
  local policy by _raising_ only.
- **Reference.** `agno`'s MCP hint fields; the `dev.adaptivemcp/tools-metadata`
  resource (server governs, client executes).
- **Failure mode prevented.** A destructive tool running un-gated purely because
  the client had not learned anything about it yet.

## Our coverage

| Component                                        | Status | Evidence                                                              |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------- |
| Tool description                                 | ✅     | `ToolSpec` in `src/types.ts`; `sanitize()` in `src/mcp/toolset.ts`    |
| MCP client + namespacing                         | ✅     | `StdioToolset`, `HttpToolset`, `AggregateToolset` (`src/mcp/`)        |
| Single execution seam                            | ✅     | `AgentRuntime.execute` (`src/runtime.ts`); golden rule in `AGENTS.md` |
| Result classification                            | ✅     | `ToolExecutionResult`; QC e2e `src/mcp/qc-mcp.integration.test.ts`    |
| Annotations → risk → floor                       | ✅     | `seedToolAnnotations`, `applyServerMetadata`, `serverPolicySummary`   |
| Model seam                                       | ✅     | `AiSdkModel` + `ModelCatalog` (`src/provider/`, `src/models/`)        |
| Human-facing `title` separate from model payload | ❌     | no such field                                                         |
| Declared-vs-discovered provenance                | ❌     | everything is discovered from a server                                |
| Server pooling / cooldowns across runs           | ❌     | a fresh process per run (fine for a CLI, not a daemon)                |

## Gap

The tool-agent layer is the strongest part of the agent. The three gaps are
refinements rather than capabilities:

1. **Human-facing `title`** kept out of the model payload (agno's allowlist
   serializer) — matters once the same tool is shown in a UI or an approval
   prompt.
2. **Provenance** (`declared` vs `discovered`) on each tool — matters once a
   policy needs to say "only tools a human declared may run unattended".
3. **Connection pooling / cooldowns** — matters only if a long-lived host (not
   the CLI) reuses servers; `llama.cpp` is the reference.

None of these blocks another archetype.
