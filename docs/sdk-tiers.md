# MCP SDK tiers: where we stand

[The MCP SDK tiering system](https://modelcontextprotocol.io/community/sdk-tiers)
grades SDKs on conformance, feature tracking, triage, releases, documentation,
dependency policy and roadmap, with three tiers and measurable thresholds.

**We are not an SDK.** `@adaptivemcp/agent` is a _host_: an MCP client (stdio and
Streamable HTTP) plus the agent loop that owns the model calls and tool execution. We
depend on the official TypeScript SDK directly (`^1.30.0`) and on the `@adaptivemcp/*`
libraries. There is no tier to apply for; the checklist is still the right frame for
the parts of the protocol we _do_ implement, and it is a fair critique of this repo.

| Requirement                         | Status | Where we stand                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conformance tests**               | ✗      | We do not run [`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance). Our coverage is behavioural: `src/cli.e2e.test.ts` spawns the real CLI against a stdio MCP fixture, `src/mcp/http.integration.test.ts` round-trips Streamable HTTP in-process, and `src/mcp/qc-mcp.integration.test.ts` (opt-in) drives a real server. Thorough, but not protocol conformance. |
| **New protocol features**           | ◐      | `@modelcontextprotocol/sdk` is pinned at `^1.30.0` and the core libraries are pinned per release. There is no published timeline for adopting a protocol release — `AGENTS.md` says to keep the ranges current, which is a habit, not a commitment.                                                                                                                                                      |
| **Issue triage**                    | ✓      | Type and status labels are the required set: `bug`, `enhancement`, `question`; `needs confirmation`, `needs repro`, `ready for work`, `good first issue`, `help wanted`. Time-to-first-label is therefore measurable; no SLA is claimed.                                                                                                                                                                 |
| **Critical bug resolution**         | ◐      | `P0`–`P3` replace the old `priority:high                                                                                                                                                                                                                                                                                                                                                                 | medium | low` labels (existing issues migrated: high→`P1`, medium→`P2`, low→`P3`), so the metric is computable. No 7-day resolution commitment is published 2014 we are not claiming a tier. |
| **Stable release**                  | ◐      | `0.5.0`, released by the two-phase script (`pnpm release:prepare` then `pnpm release:publish --otp`), which verifies the registry serves the version before it tags — so a tag is never a claim the registry cannot back. Tiers define stable as `1.0.0`+ without pre-release identifiers.                                                                                                               |
| **Documentation**                   | ✓      | `AGENTS.md` (canonical architecture), `README.md`, `docs/architecture.md`, `docs/adr/` (4 ADRs), `docs/archetypes/` (7 files incl. a gap backlog), and a docs guard (`src/docs.test.ts`) that fails on broken links or cited paths that do not exist.                                                                                                                                                    |
| **Dependency policy**               | ✗      | There is no `SECURITY.md` and no published policy. Core ranges are bumped by hand after each `@adaptivemcp/*` release, and nothing automates or records why a version moved.                                                                                                                                                                                                                             |
| **Roadmap**                         | ✗      | No roadmap document. `docs/archetypes/README.md` (gap backlog) and ADR-004 (deferred supply chain) are the closest thing, but they are a catalogue and a decision, not "what ships next".                                                                                                                                                                                                                |
| **Conformance score / advancement** | N/A    | Only applies to SDKs applying for a tier.                                                                                                                                                                                                                                                                                                                                                                |

## What we would change first

1. **Add `SECURITY.md`.** A published package with no threat model or reporting path
   is the largest single gap here, and the sibling `adaptive-mcp` already has a good
   one to model it on.
2. **Write the roadmap.** The archetype gap table says what is _missing_; it does not
   say what is _next_. A short roadmap document with the next few items and their
   status is enough to satisfy the requirement honestly.
3. **Run the conformance suite against the client.** The host is the interesting side:
   pointing the official harness at a client that drives a real server would turn the
   e2e confidence into protocol evidence.
