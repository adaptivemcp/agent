# Roadmap

What ships next, in order, with the evidence that would justify each step. This is a
**proposal** written on 2026-11-07: the ordering and the scope are the maintainer's call,
and an item leaves this page when it ships or when the evidence stops supporting it.

The frame is the SDK-tier checklist in [`sdk-tiers.md`](sdk-tiers.md) — not because this
repo is an SDK, but because it is a fair list of things a host either has or does not.

## Now

### 1. Cross-application access: done, and what it needs next

`oauth.grant: "jwt_bearer"` implements SEP-990's managed flow: the operator's IdP ID token is
exchanged for an **ID-JAG** (RFC 8693) and presented as the `jwt-bearer` assertion.
`auth/cross-app-access-complete-flow` passes 9/9 and the conformance baseline file is gone —
every client scenario the harness ships now passes.

The IdP token endpoint is **discovered** from the provider's
`{issuer}/.well-known/openid-configuration` when it is not configured, and the discovered
value is reused for a refresh rather than re-fetched. An issuer with no OIDC document fails
with the document URL in the message instead of guessing `/token`.

What remains is not protocol work:

- a host feature that _delegates_ on purpose (app A acting for a user in app B) still has to
  choose the identity provider and decide when delegation is allowed; the grant exists, the
  policy does not;
- token **exchange** in the other direction (accepting an ID-JAG from another app on the QC or
  MCP side) has no caller yet;
- live `jwt_bearer` still needs an IdP that issues ID-JAGs (Keycloak does not); everything else
  in the client is now exercised against a real provider, including the PKCE login through a
  headless login helper.

**Done when:** a caller delegates a scoped token to a second server as policy, not as a
conformance check.

### 2. Elicitation: complete

The review step re-opens a single field (`edit <name>`), keeps every other answer, drops a
field cleared during the edit, and bounds both unknown names and edit count. `mode: "url"`
shows the link in prompt mode (non-http(s) refused unseen), and an accepted url flow now
**waits briefly for the server's `notifications/elicitation/complete`** — a `CompletionTracker`
honours either order, a buffered completion or one that arrives during the wait, and reports
whether the server corroborated the person's answer. A timeout is not a failure: it means the
server did not confirm, and the person's answer stands.

One deliberate choice remains: the completion notification is used as corroboration, not as a
gate. Requiring it would break flows against servers that never send it, and the person
already asserted the outcome.

**Done when:** a host feature needs a _server-gated_ url flow (e.g. resuming a paused tool
only once the server confirms); until then the assertion plus corroboration is the honest
contract.

### 3. Roadmap and security posture stay current

`SECURITY.md` exists (this pass) and the private reporting channel is enabled. The
maintenance cost is small but real: the scope section has to track what the host actually
does, and the supported-versions line has to match the release policy.

**Done when:** a release that changes a trust boundary updates `SECURITY.md` in the same
commit.

## Next

### 3. Per-turn action nesting in the execution graph

A turn's tool calls share one `agent_turn_<n>` root; deeper nesting is not modelled. That
is fine while a turn is flat, and wrong as soon as delegation or orchestration produces a
tree.

**Done when:** `GraphTrackingMiddleware` can represent a child action under its parent
without a schema change in `spec`, and a test asserts the shape for a delegated call.

**Blocker:** needs a real nested caller. Inventing one to justify the work would be
building for a hypothetical.

### 4. Step/pipeline model ([#39](https://github.com/adaptivemcp/agent/issues/39))

Condition, loop, parallel, router as _data_ rather than prose in a system prompt. The
`tasks` mode's `StopGuard` is the first half of this; a pipeline is the general case.

**Done when:** a plan file can express a conditional step and a loop, and the loop's exit
is a fact the guard can check rather than a model promise.

## Later / research

### 5. Context selection, if the benchmark says so

The host records context loads (ADR-005 P1) and reports them in `/context`. Selection
across sessions is deliberately unbuilt: the `context-bench` example in the sibling `adaptive-mcp` repository
measures no headroom for selection over progressive disclosure, and capability routing is
the part that did pay.

**Done when:** a benchmark shows selection beating the routed policy on a corpus that is
not separable by construction. Until then this stays a measurement, not a feature.

### 6. Full-screen TUI (deferred)

The REPL streams and handles the same run policy as a one-shot run. A TUI is a rendering
project, not a protocol one, and nothing measured says it is the next constraint.

## Deliberately not doing

- **A custom protocol concept for skills/context/workflow.** MCP standardises capabilities;
  the host learns behaviour. No `adaptiveTool`, `adaptiveSkill`, `adaptiveIntent`,
  `adaptiveWorkflow`.
- **Auto-approval by default.** The gate fails closed; `--yes` is the operator's explicit
  choice.
- **Hosted agents.** The loop stays in this process, which is what lets routing and
  decoding recommendations actually apply.

## How this list changes

At each release: re-read this page, move what shipped, and delete what no longer matters.
A roadmap that only accumulates is a wish list.
