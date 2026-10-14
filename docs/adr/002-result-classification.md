# ADR-002: In-band error envelopes count as failures

**Status:** Accepted (2026-10-14).

## Context

The agent learns from every tool execution: a call recorded as a success feeds
the failure-rate, insight, routing, and drift signals. But many MCP servers (for
example QueryCleaner/QC) report *logical* failures **in-band** — a successful
transport result whose JSON payload carries `status: "error"` — instead of the
protocol-level `isError` flag. Treating the transport's `ok` as the truth
recorded those denials as successes, corrupting everything derived from them.

## Decision

Add a **result-classification seam** in `@adaptivemcp/thin-client`
(`ThinClientOptions.classifyResult`), applied on each attempt *before* the
outcome is recorded and *before* the retry decision, plus an
`envelopeClassifier()` helper for the common status/error shape (object **or**
JSON-string payloads). The agent wires `envelopeClassifier()` in by default.

The seam lives in the library (generic, reusable); the agent supplies the
classifier. A corrected failure also drives the retry policy, because
classification runs inside the retry loop.

## Consequences

- Denials/budget/validation failures are learned as failures for real servers.
- The agent stays correct whether a server uses `isError` or an in-band envelope.
- The classifier is advisory machinery (a host opts in by supplying one); it does
  not change the wire protocol.

## Alternatives considered

- **Per-server adapters.** Rejected: `(host, server)`-specific glue in the
  agent; the library seam is reusable and testable.
- **Ask servers to set `isError`.** Pursued in parallel (QC does now), but the
  agent cannot assume third-party servers do; classification is still needed.
