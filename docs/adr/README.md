# Architecture Decision Records

Load-bearing decisions in the agent, what we chose, and why. Where a decision is
still evolving the reasoning lives in `docs/architecture.md`; an ADR here means it
has settled.

| ADR | Decision | Status |
| --- | --- | --- |
| [001](001-server-spec.md) | One `--server` spec: a shorthand plus a JSON object (stdio/HTTP) | Accepted |
| [002](002-result-classification.md) | In-band error envelopes count as failures | Accepted |
| [003](003-exit-codes.md) | A stable CLI exit-code taxonomy | Accepted |
| [004](004-skill-supply-chain.md) | Skills are declared, not fetched — the supply chain stays deferred | Accepted |

Numbers are local to this repo, and one of them is overloaded in prose: the bare
"ADR-004" cited in `src/` and `docs/architecture.md` is the **sibling**
`adaptive-mcp` repo's ADR-004 (the host-versus-library split), not the 004 above.
