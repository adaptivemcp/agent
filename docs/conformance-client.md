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

# OAuth discovery + PKCE — see "Auth" below
npx -y @modelcontextprotocol/conformance@0.1.16 client \
  --command "node scripts/conformance-client.mjs --auth" --scenario auth/metadata-default \
  --timeout 60000 --output-dir conformance-results/auth-metadata-default
# ...and the same loop for auth/metadata-var1 .. var3, resource-mismatch,
# token-endpoint-auth-basic|post|none, and (with --call) auth/scope-step-up
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

### Auth: discovery and the authorization-code grant

```
$ conformance client --command "node scripts/conformance-client.mjs --auth" \
    --scenario auth/metadata-default
Passed: 13/13 — ✅ OVERALL: PASSED

$ ... --scenario auth/metadata-var1   Passed: 13/13
$ ... --scenario auth/metadata-var2   Passed: 13/13
$ ... --scenario auth/metadata-var3   Passed: 13/13

$ ... --scenario auth/resource-mismatch         Passed: 2/2
$ ... --scenario auth/token-endpoint-auth-basic Passed: 18/18
$ ... --scenario auth/token-endpoint-auth-post  Passed: 18/18
$ ... --scenario auth/token-endpoint-auth-none  Passed: 18/18
$ ... --scenario auth/scope-step-up             Passed: 22/22   (with --call)
```

Those last five are security properties rather than plumbing, and each one found something:

| Scenario                         | What it caught                                                                                              | Fix                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth/resource-mismatch`         | the client ignored `resource` in the PRM and would happily authorize against `https://evil.example.com/mcp` | a PRM naming a different resource is refused before any authorization request                                                                                |
| `auth/token-endpoint-auth-basic` | the secret always went in the body (`client_secret_post`)                                                   | the registration response's `token_endpoint_auth_method`, then the server's advertised list, chooses basic/post/none; basic keeps the secret out of the body |
| `auth/scope-step-up`             | the 401's `scope` was ignored, and a `403 insufficient_scope` was treated as a refusal                      | the initial grant requests the challenge's scope; a 403 naming more scopes re-runs the grant and retries once                                                |

`auth/scope-step-up` is the one that needs a **tool call** rather than a listing: `tools/list`
only requires `mcp:basic`, while `tools/call` requires `mcp:write` too. CI runs it with
`--auth --call` and a scripted model asking for the harness's tool.

The variants are the point rather than a bonus: each publishes the metadata somewhere
else, and the client has to find all four shapes.

| Scenario           | What is different                                                         | How the client copes                                                               |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `metadata-default` | PRM path-based, named in `WWW-Authenticate`                               | uses the challenge URL; never probes the root                                      |
| `metadata-var1`    | no challenge metadata; AS metadata only as **OpenID configuration**       | falls back to the path-based PRM, then tries the OIDC document                     |
| `metadata-var2`    | PRM only at the **root**; issuer has a **path**                           | falls back path-based → root; RFC 8414 puts the well-known segment before the path |
| `metadata-var3`    | custom PRM path named in the challenge; **tenant-prefixed** OIDC metadata | uses the challenge URL, then the appended OIDC spelling                            |

The first measurement of this scenario **failed 0/5**: the client stopped at the harness's
`401`. That was accurate at the time — `HttpToolset` only sent static headers. It now
implements the flow (`src/mcp/oauth.ts`), opted into per server with `oauth` in the JSON
spec:

```json
{ "name": "remote", "url": "https://host/mcp", "oauth": { "authorize": "browser" } }
```

- **Protected-resource metadata** at the RFC 9728 path-based location
  (`/.well-known/oauth-protected-resource/mcp`), never the root — the root is the
  harness's trap in this scenario.
- **Authorization-server metadata** with the RFC 8414 path rule (the well-known segment
  goes before the issuer's path, not after it).
- **Dynamic client registration**, asking for a public client
  (`token_endpoint_auth_method: "none"`).
- **PKCE S256 on every request**, with the verifier asserted to match its challenge in
  `src/mcp/oauth.test.ts`.
- **The resource is named** (RFC 8707 `resource`) on both the authorization and token
  requests, so a token cannot be replayed at a different MCP server by a confused deputy.
- **No token is logged**: only the issuer and the client id reach the operator.

`authorize` is the only mode switch. `"browser"` (the default) starts a loopback listener,
prints the URL, and waits for the redirect a person completes; `"fetch"` performs the
redirect itself, which is what a headless driver — the conformance adapter with `--auth` —
uses. The adapter sets it; no environment variable or test-only branch is involved.

**Scope step-up is a second grant, not a retry with the same token.** `403` with
`error="insufficient_scope"` and a `scope` parameter triggers `escalate()`, which repeats
discovery-free authorization (PKCE, state, resource) with the wider scope set.

**Refresh is wired, on the 401 rather than the clock.** `acquireToken` returns a session
whose `header()` is read per request; `HttpToolset` refreshes once and retries when a
request comes back `401`, then gives up rather than looping. The token endpoint is the
authority on expiry, and a refreshed token reaches the next request without reconnecting
(reconnecting would lose the session id). Tested two ways: the refresh grant itself
(`src/mcp/oauth.test.ts`) and the 401 → refresh → retry path against a real HTTP MCP server
(`src/mcp/http-refresh.integration.test.ts`).

**The loopback path has a test too.** `browser` mode prints a URL and waits on a listener;
the test reads that URL from the log, fetches it the way a browser would, and asserts the
flow completes through the callback. A human is still the intended actor, but the code path
is no longer untested.

CI runs this scenario with `--auth` and without any expected-failures baseline. The
baseline from the measurement above was deleted in the same change, because a stale entry
fails the harness — which is how the removal was caught rather than forgotten.

### The rest of the auth suite

```
scope-from-www-authenticate      14/14      pre-registration                13/13
scope-from-scopes-supported      14/14      2025-03-26 metadata-backcompat  12/12
scope-omitted-when-undefined     14/14      2025-03-26 endpoint-fallback     7/7
scope-retry-limit                22/22      basic-cimd                      13/13
offline-access-scope             14/14
offline-access-not-supported     14/14

client-credentials-basic          9/11      baselined — no client_credentials mode
client-credentials-jwt            9/11      baselined — no signed-JWT assertion
cross-app-access-complete-flow    9/11      baselined — no token exchange
```

Three more defects, all about a server that is older or more configured than the default:

| Finding                                                                                 | Fix                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the client ignored the PRM's `scopes_supported`, so the grant asked for no scope at all | initial scopes now fall back challenge → `scopes_supported` → none                                                                                                                             |
| a 2025-03-26 server publishes **no PRM**, and sometimes **no metadata**                 | absent PRM ⇒ the origin is the authorization server; absent metadata ⇒ the standard endpoints at the origin; a registration `404` falls back to a public identity instead of failing the login |
| there was no way to be a **configured** client                                          | `oauth.clientId` + `oauth.clientSecretEnv` (secret from the environment, never argv) for pre-registration, and `oauth.clientMetadataUrl` for CIMD                                              |

**CIMD and pre-registration are configuration, not cleverness.** Both scenarios hand the
client an identity it cannot discover: a metadata-document URL, or an id/secret pair. The
adapter passes them the way a deployment would — `CONFORMANCE_CLIENT_METADATA_URL`,
`CONFORMANCE_CLIENT_ID`/`CONFORMANCE_CLIENT_SECRET` — and no credential is ever written into
a server spec's `clientId`/argv.

**The three baselined scenarios are extensions, and the reasons are specific.**
`client-credentials-*` wants `grant_type=client_credentials` — machine-to-machine, with no
user, no authorization request and no PKCE; that is a different authentication model
(SEP-1046), and mixing it with the interactive flow would be worse than not having it.
`cross-app-access-complete-flow` wants a token exchange into a second application, which is
a delegation model this host has no caller for. The baseline makes a regression fail and a
fix fail as _stale_ until the line is deleted.

## What running it found in the agent## What running it found in the agent

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
