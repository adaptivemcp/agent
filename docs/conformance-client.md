# Client conformance

QC's server is checked against the official harness every PR ([`qc/docs/conformance.md`](https://github.com/adaptivemcp/qc/blob/main/docs/conformance.md)).
This is the client side of the same harness: the agent is an MCP **client**, and its
protocol behaviour — initialize, capability negotiation, discovery — had never been tested
against anything but its own fixtures.

## Running it

`@modelcontextprotocol/conformance client` starts a scripted MCP server, appends its URL to
your command, and judges the client's wire behaviour. `scripts/conformance-client.mjs` is
the adapter: it reads that URL and runs the agent CLI against it.

```bash
# protocol handshake + discovery (no model involved)
npx @modelcontextprotocol/conformance@0.1.16 client \
  --command "node scripts/conformance-client.mjs" --scenario initialize

# tool call path: the adapter stands in a scripted model that asks for the tool once
npx @modelcontextprotocol/conformance@0.1.16 client \
  --command "node scripts/conformance-client.mjs --call" --scenario tools_call
```

The adapter runs `--list-tools` for the handshake scenario and a one-tool prompt for
`--call`, so no inference and no GPU are involved: the scenarios are about the MCP
connection, not about what a model does with the answer.

## In CI

The `conformance-client` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
runs every scenario below on each push and pull request, writing
`conformance-results/<scenario>/` and uploading the lot as an artifact (`checks.json`,
`stdout.txt`, `stderr.txt`).

It is **blocking**. The advisory phase did its job: both failures it surfaced were ours,
not flaky infrastructure — a stale harness pin (0.1.11 connected a shared `Server` per
request) and a `spawnSync` deadlock in the adapter. With both fixed, a red run here means
the client regressed, which is exactly what a gate is for. The offline e2e
(`src/conformance-client.e2e.test.ts`) still covers the same two paths without the
network, so a registry outage is diagnosable from the job log rather than mistaken for a
protocol failure.

```bash
# the exact CI commands
npx -y @modelcontextprotocol/conformance@0.1.16 client \
  --command "node scripts/conformance-client.mjs" --scenario initialize \
  --output-dir conformance-results/initialize
npx -y @modelcontextprotocol/conformance@0.1.16 client \
  --command "node scripts/conformance-client.mjs --call" --scenario tools_call \
  --output-dir conformance-results/tools_call

# measured gap, baselined — see "Auth" below
npx -y @modelcontextprotocol/conformance@0.1.16 client \
  --command "node scripts/conformance-client.mjs" --scenario auth/metadata-default \
  --timeout 60000 --expected-failures conformance-client-baseline.yml \
  --output-dir conformance-results/auth-metadata-default
```

## Measured 2026-11-07

```
$ conformance client --command "node scripts/conformance-client.mjs" --scenario initialize
[ mcp-client-initialization ] SUCCESS Validates that MCP client properly initializes with server
Passed: 1/1 — ✅ OVERALL: PASSED

$ conformance client --command "node scripts/conformance-client.mjs --call" --scenario tools_call
[tool-add-numbers] SUCCESS Validates that the add_numbers tool works correctly
Passed: 1/1 — ✅ OVERALL: PASSED
```

**Both client scenarios pass.** The client negotiates the protocol version, declares its
capabilities (including the `dev.adaptivemcp/tools-metadata` extension), lists tools,
reads a resource, and — in `tools_call` — actually calls the harness's `add_numbers` tool
and returns its result.

Getting there took two fixes, both recorded because each looked like a client bug:

1. **The harness's pinned 0.1.11 could not serve a session.** Its route created a transport
   per request but connected a _shared_ `Server`, so the second `POST /mcp` failed with
   `Already connected to a transport`. **0.1.16 fixes this**; the pin was the problem, not
   the client.
2. **The adapter deadlocked itself in `--call` mode.** It used `spawnSync`, which blocks the
   event loop that its own scripted model server runs on — so the client waited for a model
   reply that could not be produced, and the harness reported "client timed out". The
   adapter now spawns asynchronously.

No proxy was needed. The workaround under consideration (a loopback proxy holding one
upstream session) would have hidden both causes instead of fixing them.

### Auth: measured, and deliberately baselined

```
$ conformance client --command "node scripts/conformance-client.mjs" \
    --scenario auth/metadata-default
Sent 401 response for POST /mcp (method: initialize)
Client exited with code 1
Passed: 0/5, 5 failed
  Expected Check Missing: prm-pathbased-requested
  Expected Check Missing: authorization-server-metadata
  Expected Check Missing: client-registration
  Expected Check Missing: authorization-request
  Expected Check Missing: token-request
```

The harness answers the first `POST /mcp` with `401` + `WWW-Authenticate`, and the client
stops there. That is accurate rather than a surprise: `HttpToolset` sends **static
headers**, and while `OAuthMiddleware` exists in `@adaptivemcp/thin-client` (covered by
`src/mcp/http-oauth.integration.test.ts`, including a 401 → refresh → retry), the CLI has
no per-server OAuth configuration and nothing performs protected-resource-metadata
discovery or dynamic client registration.

CI runs this scenario against `conformance-client-baseline.yml`, which lists
`auth/metadata-default`. That is a **measured gap, not a suppression** — the harness's
rules make it symmetric:

| Outcome                  | Exit                            |
| ------------------------ | ------------------------------- |
| fails and is listed      | 0 (expected)                    |
| fails and is not listed  | 1 (regression)                  |
| **passes and is listed** | **1 (stale entry — delete it)** |

Verified both directions locally: with the baseline the run exits 0 ("Baseline check
passed: all failures are expected"); listing a scenario that passes (`initialize`) exits 1
with "Baseline is stale". So implementing the flow cannot silently leave a stale file
behind.

The roadmap's first item is consequently narrower than "add auth conformance": implement
PRM discovery → AS metadata → registration → authorization request → token request in the
CLI path, then delete the baseline entry.

## What running it found in the agent

The adapter's first version hung against a real HTTP server, and the cause was a genuine
bug: **listing commands printed and returned without closing their toolsets.** A stdio
child exits with the parent, so the leak never showed; a remote toolset keeps its HTTP
transport (and keep-alive sockets) open, and the process never exits. `--list-tools` and
`--list-context` now close every toolset before returning, and
`src/conformance-client.e2e.test.ts` reproduces the harness contract offline so the adapter
cannot silently rot. Agent#99 tracked the multi-request gap and is now closed.

## Scope

- Covered: one live server exercised over Streamable HTTP, with the client's own handshake
  judged by the harness.
- Not covered: OAuth client flows (`auth/*` scenarios) — the agent supports a static token
  and `OAuthMiddleware`, but those scenarios need an authorization server the harness runs.
  The multi-request gap is closed: `tools_call` passes on 0.1.16.
