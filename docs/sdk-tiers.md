# MCP SDK tiers: where we stand

[The MCP SDK tiering system](https://modelcontextprotocol.io/community/sdk-tiers)
grades SDKs on conformance, feature tracking, triage, releases, documentation,
dependency policy and roadmap, with three tiers and measurable thresholds.

**We are not an SDK.** `@adaptivemcp/agent` is a _host_: an MCP client (stdio and
Streamable HTTP) plus the agent loop that owns the model calls and tool execution. We
depend on the official TypeScript SDK directly (`^1.30.0`) and on the `@adaptivemcp/*`
libraries. There is no tier to apply for; the checklist is still the right frame for
the parts of the protocol we _do_ implement, and it is a fair critique of this repo.

| Requirement                         | Status | Where we stand                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conformance tests**               | ◐      | We run [`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance) against the **client** half, blocking in CI (`.github/workflows/ci.yml` → `conformance-client`): both graded scenarios pass on `0.1.16` (`initialize` 1/1, `tools_call` 1/1 — see `docs/conformance-client.md`). The offline adapter e2e covers the same paths without the network. Server-side conformance is the SDK's job, not ours. |
| **New protocol features**           | ◐      | `@modelcontextprotocol/sdk` is pinned at `^1.30.0` and the core libraries are pinned per release. There is no published timeline for adopting a protocol release — `AGENTS.md` says to keep the ranges current, which is a habit, not a commitment.                                                                                                                                                                                       |
| **Issue triage**                    | ✓      | Type and status labels are the required set: `bug`, `enhancement`, `question`; `needs confirmation`, `needs repro`, `ready for work`, `good first issue`, `help wanted`. Time-to-first-label is therefore measurable; no SLA is claimed.                                                                                                                                                                                                  |
| **Critical bug resolution**         | ◐      | `P0`–`P3` replace the old `priority:high`/`medium`/`low` labels (existing issues migrated: high→`P1`, medium→`P2`, low→`P3`), so the metric is computable. No 7-day resolution commitment is published because we are not claiming a tier.                                                                                                                                                                                                |
| **Stable release**                  | ◐      | `0.5.0`, released by the two-phase script (`pnpm release:prepare` then `pnpm release:publish --otp`), which verifies the registry serves the version before it tags — so a tag is never a claim the registry cannot back. Tiers define stable as `1.0.0`+ without pre-release identifiers.                                                                                                                                                |
| **Documentation**                   | ✓      | `AGENTS.md` (canonical architecture), `README.md`, `docs/architecture.md`, `docs/adr/` (4 ADRs), `docs/archetypes/` (7 files incl. a gap backlog), and a docs guard (`src/docs.test.ts`) that fails on broken links or cited paths that do not exist.                                                                                                                                                                                     |
| **Dependency policy**               | ◐      | `SECURITY.md` states the private reporting path, trust boundaries and mitigations, and private vulnerability reporting is enabled on the repository. Still missing: nothing records _why_ a core range moved — bumps are by hand after each `@adaptivemcp/*` release, and `pnpm audit --prod` is a manual pre-release step.                                                                                                               |
| **Roadmap**                         | ✓      | `docs/roadmap.md`: what ships next, in order, each item with the evidence that would justify it and a "deliberately not doing" list. Written 2026-11-07 as a proposal — ordering and scope are the maintainer's call — with a stated cadence (re-read at each release, delete what no longer matters).                                                                                                                                    |
| **Conformance score / advancement** | N/A    | Only applies to SDKs applying for a tier.                                                                                                                                                                                                                                                                                                                                                                                                 |

## What we would change first

All three original items landed on 2026-11-07:

1. ~~**Add `SECURITY.md`.**~~ Done — reporting path, trust boundaries, mitigations, and
   private vulnerability reporting enabled on the repository.
2. ~~**Write the roadmap.**~~ Done — `docs/roadmap.md`, proposal status stated.
3. ~~**Run the conformance suite against the client.**~~ Done — the `conformance-client`
   CI job runs both graded scenarios, both pass, and the job is blocking.

What is left is smaller and mostly maintenance: record _why_ dependency ranges move, and
extend conformance to the `auth/*` scenarios (the roadmap's first item).
