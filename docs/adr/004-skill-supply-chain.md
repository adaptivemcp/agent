# ADR-004: Skills are declared, not fetched

**Status:** Accepted (2026-10-19). The supply chain is **deferred, not rejected** —
see "When to revisit".

## Context

The archetype catalogue lists a skills supply chain — fetch / cache / version — as
the one ❌ in [the skills entry](../archetypes/skills-agent.md), and
[#78](https://github.com/adaptivemcp/agent/issues/78) framed it as the last gap: _a
procedure can only be shared by copying a directory by hand, and there is no way for
a run to say which revision of a procedure it followed._

Since then the security half shipped, and it changed the question:

| Built                                              | What it removed from the gap                                   |
| -------------------------------------------------- | -------------------------------------------------------------- |
| Containment — real paths, regular files only (#81) | a read can no longer leave a skill's directory, links included |
| Declared trust, keyed by content hash (#82)        | "which revision" is answerable: the record pins `sha256:…`     |
| An out-of-band scanner (`pnpm skills:scan`, #83)   | third-party text has a gate before it is usable                |

So the remaining ask is narrower than the issue states: **should this host fetch
skills, and if so from where?**

## Decision

This host does **not** fetch skills. It searches directories the operator supplies —
`--skills`, the project's `./skills`, the user-level shelf — and every skill is either
trusted by construction (the operator put it there) or named as untrusted with
`--skills-untrusted` and withheld until vouched for or scanned.

Sharing is by declaration, using the paths the ecosystem already has. All three end in
a directory, and `--skills <dir>` already takes one, so none needs code here:

| Ingest path                                 | Versioning        | Integrity                       |
| ------------------------------------------- | ----------------- | ------------------------------- |
| Copy a directory                            | —                 | the trust record's content hash |
| `git submodule` or symlink into `./skills`  | git               | the commit the submodule pins   |
| An npm package resolved into `node_modules` | semver + lockfile | `sha512` in the lockfile        |

## Why not a fetcher

1. **It inverts the trust default.** "The operator's own trees are trusted" holds
   _because nothing arrives without them putting it there_ (`src/skill-trust.ts`). A
   fetch makes content appear without that act, so fetched skills would have to be
   quarantined whatever directory they land in — a redesign of the default, not an
   added feature.
2. **A skill is not a dependency.** `pnpm install` runs code; a skill persuades a
   model that already holds the operator's tools. Containment bounds what a read can
   _reach_, not what the model then _does_; the real bounds are that unvetted text
   never enters the context window, and that risky tools stay gated fail-closed.
3. **A hash pinned on first fetch is weak.** It protects against silent change, not
   against a bad first version, so a fetcher's only real defence would be the pattern
   scan — which by design does not make a skill safe.
4. **The lockfile is mostly built.** `skills.trust.json` already pins a content hash
   per skill; only a _source_ is missing, and a source has no use without a fetcher.

## Consequences

- The catalogue's supply-chain row stays ❌, and honestly so: the component is absent
  and the absence is deliberate.
- Sharing a skill means a submodule, a symlink, an npm package, or a `cp` — the
  status quo of most tools, with no code to maintain.
- The scanner is the only path by which third-party text can reach the model, and it
  is out of band: the runtime never fetches and never scans.

## Alternatives considered

- **A lockfile-pinned `git` fetch** (`--skills-fetch`, `skills.lock.json`). The
  issue's proposal. Rejected for now: it adds a `git` dependency, a lockfile format, a
  cache and its lifecycle, and it triggers point 1 above.
- **An HTTP index plus per-file hashes** (the shape `opencode` uses, strengthened).
  The least-bad fetcher, and the one to build _if_ one is ever needed.
- **`fetch-latest`.** Rejected outright: it turns a shared skill into remote code the
  model obeys.

## When to revisit

A concrete need — a second machine, or a pack shared with another person — and not
before. Preference order when it comes: (1) an npm package, (2) a git submodule,
(3) a bespoke fetcher. If (3) is chosen: an HTTP index with a per-file hash pinned on
first fetch (not a `git` shell-out), a cache under `$XDG_CACHE_HOME` with an explicit
`--skills-prune`, and **fetched ⇒ quarantined regardless of directory**.
