# ADR-003: A stable CLI exit-code taxonomy

**Status:** Accepted (2026-10-14).

## Context

Scripts and supervisors branch on a process exit code. Ad-hoc `exitCode = 1` for
every failure forces callers to parse stderr to tell "bad arguments" from "no
server" from "the model catalog failed".

## Decision

A small, **stable** taxonomy in `src/exit-codes.ts`:

| Code | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| `0`  | success                                                            |
| `1`  | unexpected runtime failure                                         |
| `2`  | bad usage (unknown flag, missing value, no server)                 |
| `3`  | provider/catalog/model configuration error                         |
| `4`  | a tool call the host denied (approval)                             |
| `5`  | the run paused for a decision and can be resumed (`--resume <id>`) |

Once published these values are treated as stable.

## Consequences

- Callers can react without parsing output; the values are pinned by a test.
- New failure classes must reuse a code or add one deliberately.

## Alternatives considered

- **Single `1` for all failures.** Rejected: no caller signal.
- **Mirror a general convention (e.g. sysexits).** Deferred: a small agent-specific
  set is clearer than overloading a larger standard.
