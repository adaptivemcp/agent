# Roadmap

What ships next, in order, with the evidence that would justify each step. This is a
**proposal** written on 2026-11-07: the ordering and the scope are the maintainer's call,
and an item leaves this page when it ships or when the evidence stops supporting it.

The frame is the SDK-tier checklist in [`sdk-tiers.md`](sdk-tiers.md) — not because this
repo is an SDK, but because it is a fair list of things a host either has or does not.

## Now

### 1. The remaining OAuth scenarios

Four metadata shapes, resource mismatch, the three token-endpoint auth styles and scope
step-up now pass (13/13, 2/2, 18/18 each, 22/22 for step-up). Each was a real defect before
it was a green check: metadata discovery order, resource binding, client authentication, and
step-up re-authorization.

Still unmeasured, and worth it because each is a distinct trust decision:

- **`auth/basic-cimd`** — Client ID Metadata Documents: using a URL as the client id instead
  of dynamic registration.
- **`auth/pre-registration`**, **`auth/client-credentials-jwt`**,
  **`auth/client-credentials-basic`** — a pre-registered client, and machine-to-machine
  grants where no human is in the loop.
- **`auth/2025-03-26-oauth-*`** — the pre-RFC metadata fallbacks, which older deployments
  still publish.

**Done when:** each runs and either passes or is baselined with a reason, as the last batch
was.

### 2. Roadmap and security posture stay current

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
