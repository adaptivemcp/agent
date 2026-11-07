# Roadmap

What ships next, in order, with the evidence that would justify each step. This is a
**proposal** written on 2026-11-07: the ordering and the scope are the maintainer's call,
and an item leaves this page when it ships or when the evidence stops supporting it.

The frame is the SDK-tier checklist in [`sdk-tiers.md`](sdk-tiers.md) — not because this
repo is an SDK, but because it is a fair list of things a host either has or does not.

## Now

### 1. Token exchange between applications

Every standard client scenario now passes except one: `cross-app-access-complete-flow`,
which needs a `token-exchange` / JWT-bearer exchange into a second application. It is
baselined with its reason, not suppressed.

That is a delegation model rather than a grant: app A holds a token for app B and asks the
authorization server to mint one for app C. It needs a caller that actually delegates —
otherwise it is a protocol feature with no product behind it.

**Done when:** a host can delegate a scoped token to a second server on purpose, the
scenario passes, and the baseline file is empty (and therefore deleted).

### 2. Richer elicitation forms

`--elicitation prompt` now reads a form line by line in the terminal (and through the REPL's
own reader), with schema-typed answers, defaults offered, one retry on a rejected answer,
and a decline rather than a guessed value. `defaults` and `decline` remain for headless runs.

What it does not do yet: **nested objects and arrays** (they read as the raw string), a
multi-field form rendered at once, and `mode: "url"` (declined, since a URL handoff has no
console story). SEP-1034's enum titles are shown; per-field validation messages could be
friendlier.

**Done when:** object/array fields round-trip through a small JSON editor prompt, and a
`mode: "url"` request can be surfaced as a link the person can open.

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
