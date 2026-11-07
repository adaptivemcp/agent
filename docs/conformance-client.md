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
npx @modelcontextprotocol/conformance@0.1.11 client \
  --command "node scripts/conformance-client.mjs" --scenario initialize

# tool call path: the adapter stands in a scripted model that asks for the tool once
npx @modelcontextprotocol/conformance@0.1.11 client \
  --command "node scripts/conformance-client.mjs --call" --scenario tools_call
```

The adapter runs `--list-tools` for the handshake scenario and a one-tool prompt for
`--call`, so no inference and no GPU are involved: the scenarios are about the MCP
connection, not about what a model does with the answer.

## Measured 2026-11-07

```
$ conformance client --command "node scripts/conformance-client.mjs" --scenario initialize
[ mcp-client-initialization ] SUCCESS Validates that MCP client properly initializes with server
Passed: 1/1, 0 failed
✅ OVERALL: PASSED
```

`initialize` passes: the client negotiates the protocol version, declares its capabilities
(including the `dev.adaptivemcp/tools-metadata` extension) and completes the handshake.

**`tools_call` does not pass yet, and not because of this client.** The harness's scripted
server answers the first `POST /mcp` and then refuses the next one:

```
Sent 500 response for POST /mcp (method: initialize)
StreamableHTTPError: Streamable HTTP error: Error POSTing to endpoint:
  Error: Already connected to a transport. Call close() before connecting to a new transport
```

Its handler calls `server.connect(transport)` per request, so the second request of a
session (`notifications/initialized`, then `tools/list`, then `tools/call`) hits a server
that is still connected. A single-request scenario passes; a multi-request one cannot. That
is a harness limitation to work around or upstream, and it is recorded rather than papered
over — the adapter and its `--call` mode are ready for it once the harness can serve a
session.

## What running it found in the agent

The adapter's first version hung against a real HTTP server, and the cause was a genuine
bug: **listing commands printed and returned without closing their toolsets.** A stdio
child exits with the parent, so the leak never showed; a remote toolset keeps its HTTP
transport (and keep-alive sockets) open, and the process never exits. `--list-tools` and
`--list-context` now close every toolset before returning, and
`src/conformance-client.e2e.test.ts` reproduces the harness contract offline so the adapter
cannot silently rot. The multi-request gap is tracked as [#99](https://github.com/adaptivemcp/agent/issues/99).

## Scope

- Covered: one live server exercised over Streamable HTTP, with the client's own handshake
  judged by the harness.
- Not covered: OAuth client flows (`auth/*` scenarios) — the agent supports a static token
  and `OAuthMiddleware`, but the scenarios need an authorization server the harness runs;
  and multi-request scenarios until the harness can serve them.
