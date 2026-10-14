# Architecture Decision Records

Load-bearing decisions in the agent, what we chose, and why. Where a decision is
still evolving the reasoning lives in `docs/architecture.md`; an ADR here means it
has settled.

| ADR | Decision | Status |
| --- | --- | --- |
| [001](001-server-spec.md) | One `--server` spec: a shorthand plus a JSON object (stdio/HTTP) | Accepted |
| [002](002-result-classification.md) | In-band error envelopes count as failures | Accepted |
| [003](003-exit-codes.md) | A stable CLI exit-code taxonomy | Accepted |
