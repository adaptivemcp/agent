# ADR-001: One `--server` spec — shorthand plus a JSON object

**Status:** Accepted (2026-10-14).

## Context

The agent hosts MCP servers from the CLI. A minimal spec is pleasant for the
common local case, but real servers need per-server `cwd`/`env` (they resolve
their own config/secrets relative to a working directory) and some are remote
(Streamable HTTP with auth headers). Growing a flag per option
(`--server-cwd`, `--server-env`, …) multiplies CLI surface and is awkward to keep
in sync with the toolset options.

## Decision

Keep `--server "name=command args"` as the shorthand for the common stdio case,
and accept a **JSON object** for anything richer:

- stdio: `{"name","command","args","cwd","env"}`
- HTTP: `{"name","transport":"http","url","headers"}`

`parseServer` dispatches on a leading `{` and returns a `ServerSpec` union; the
CLI builds a `StdioToolset` or `HttpToolset` from it. Everything is validated
with descriptive errors.

## Consequences

- One flag covers local, configured, and remote servers; options mirror the
  toolset option types directly.
- The shorthand stays terse for demos; JSON is the escape hatch.
- Callers must quote the JSON on the command line.

## Alternatives considered

- **A flag per option.** Rejected: unbounded CLI surface.
- **Only JSON.** Rejected: verbose for the common case.
- **TOML/YAML spec files.** Deferred: a single self-contained argument is simpler
  for a host; a config file can be added later without changing the JSON shape.
