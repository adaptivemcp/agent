# Skills agent

**What it is.** A procedure is taught **once**, as a _document_, and repeated on
demand. Unlike a tool (which does one thing), a skill encodes _how to do a
multi-step job_ in this project: conventions to follow, pitfalls to avoid, the
order to do things in. It is loaded when relevant — not always.

**When it is the right one.** When the knowledge is procedural and stable, and a
tool would be too narrow. "Review a diff against this project's conventions" is a
skill; "read a file" is a tool.

## Components

### Skill definition — `SKILL.md` with a trigger

- **Purpose.** One entry point per skill: a short, machine-readable header plus a
  human-readable procedure.
- **Contract (sketch).**

  ```md
  ---
  name: code-review
  description: Review changes against project conventions before a PR. Use when
    the user wants to review a diff, branch, or PR. # ← the trigger lives here
  ---

  # Review changes

  …steps, and hard rules ("NEVER post the notes")…
  ```

- **Reference.** `llama.cpp/skills/code-review/SKILL.md` — note the `description`
  is written as a _dispatch rule_ ("Use when the user wants to…"), and the body
  carries non-negotiable rules inline.
- **Failure mode prevented.** A skill whose purpose is not discoverable by the
  model, so it is never used; and a procedure with no place for its hard rules.

### Progressive disclosure

- **Purpose.** Load the trigger first, the body when the skill is chosen, and
  supporting material only if the work needs it — so 40 reference files do not
  cost context.
- **Contract (sketch).** `SKILL.md` (always) → `reference/*.md`, `scripts/*`
  (on demand).
- **Reference.** A real installed example on this machine:
  `~/.config/opencode/skills/impeccable/` = `SKILL.md` + 40 `reference/*.md` +
  `scripts/` (+ `reference/degraded/` fallbacks). `opencode`'s
  `packages/opencode/src/skill/index.ts` models a skill as
  `{ name, description, content, path[] }`.
- **Failure mode prevented.** A skill library that eats the context window before
  any real work happens.

### Discovery

- **Purpose.** Find the skills available to _this_ run: user-level, project-level,
  or remote.
- **Contract (sketch).** scan a small set of well-known directories (and/or a
  registry), parse frontmatter, reject malformed skills loudly.
- **Reference.** `opencode/packages/opencode/src/skill/discovery.ts` — with
  bounded concurrency (`skillConcurrency = 4`), a cache dir, and transient-read
  retries.
- **Failure mode prevented.** A skill that silently fails to load (typo in
  frontmatter) and is never used.

### Supply chain (fetch / cache / version)

- **Purpose.** Skills that can be shared and updated, without trusting an
  arbitrary URL at run time.
- **Contract (sketch).** `pull(url) → cached path`; a `version` in frontmatter;
  nothing executed at discovery time.
- **Reference.** `opencode`'s discovery service (`pull`, cache under the global
  cache dir) and the `version`/`user-invocable`/`argument-hint` fields in the
  installed `impeccable` skill.
- **Failure mode prevented.** Re-downloading (or worse, executing) remote content
  on every run.
- **Our position.** Deliberately **not built**. This host searches directories the
  operator supplies and shares by declaration — a submodule, a symlink, an npm
  package — because fetching would make content arrive without the act that the
  declared-trust default rests on. Reasoning, alternatives, and the conditions that
  would change the answer: [ADR-004](../adr/004-skill-supply-chain.md).

### Invocation and the skill/tool boundary

- **Purpose.** Decide how a skill enters a run: as instructions injected into the
  current context, or as an isolated sub-session.
- **Contract (sketch).** either `loadSkill(name) → context text`, or
  `runSkill(name) → sub-session` (which is the [delegation](orchestrator-agent.md)
  primitive).
- **Reference.** `opencode` exposes skills to the agent (the environment's own
  skill list is served that way); `llama.cpp` keeps them as instructions the agent
  follows in-place.
- **Failure mode prevented.** A "skill" that is really a hidden sub-agent with its
  own permissions — or the reverse, a procedure that has to run in the caller's
  context when it needed isolation.

### Trust and containment

- **Purpose.** Decide whether a skill's instructions may enter the model's context at
  all, and bound what reading one can reach.
- **Contract (sketch).** Containment: resolve real paths and refuse anything that is
  not a regular file inside the skill's own directory. Trust: declared by the operator
  (never by the skill — a hostile `SKILL.md` would simply claim to be trusted), keyed
  by the skill's content hash, with a scan verdict able to refuse a skill regardless.
  Scanning is out of band (`pnpm skills:scan`, `cisco-ai-defense/mcp-scanner`), never
  at run time.
- **Reference.** `opencode`'s discovery service trusts a publisher-declared `version`
  string and downloads over HTTPS — the weakest useful model; `llama.cpp` ships skills
  as local files and never fetches, so it has no trust model to get wrong. In this host
  the untrusted case is a skill _copied_ in — a vendored or submoduled pack — which is
  where both a hostile instruction and a symlink arrive.
- **Failure mode prevented.** A hostile procedure entering the context window, and a
  read escaping the skill's directory through a link.

## Our coverage

| Component                                     | Status | Evidence                                                                                                        |
| --------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `SKILL.md` definition + trigger description   | ✅     | `src/skills.ts`: frontmatter `name`/`description`, the `description` used as the trigger                        |
| Progressive disclosure                        | ✅     | the prompt carries names + descriptions only; the body loads through `skills_read_skill`, bundled files by name |
| Discovery (user / project / remote)           | 🟡     | `--skills <dir>` (repeatable), the `./skills` convention, and a user-level default; nothing remote             |
| Trust and containment                         | ✅     | operator-declared and hash-keyed (`src/skill-trust.ts`); an untrusted skill is neither listed nor readable, and the read tool resolves real paths, refusing anything that is not a regular file inside the skill. Scanning is out of band (`src/skill-scan.ts`, `pnpm skills:scan`) and a flag blocks regardless |
| Supply chain (fetch / cache / version)        | ❌     | deliberately absent: sharing is by declaration (submodule / symlink / npm package), not by fetch ([ADR-004](../adr/004-skill-supply-chain.md)) |
| Invocation (context injection vs sub-session) | ✅     | both, explicitly: the body enters the current context via `skills_read_skill`, or the skill runs as an isolated sub-session when a `task` names it (`agent`), where its `tools`/`deny` narrows what that child may use |

The loader is deliberately outside the runtime: a skill set becomes an ordinary
**toolset** (`skillsToolset`), so reading one takes the same path as any MCP tool
— approval gate, telemetry, execution graph — and no protocol noun was added
(ADR-004). A malformed `SKILL.md` warns and is skipped rather than failing the
run, and the read tool cannot leave a skill's directory: real paths are resolved,
so a symlink out is refused rather than followed.

## Gap

Skills are a **document format plus a loader**, not a runtime:

1. **Definition + discovery** — a `skills/` convention (project + user),
   frontmatter parsing, and the `description`-as-trigger rule. **Done:**
   `src/skills.ts` + `--skills` / `./skills` / the user default
   (`$XDG_CONFIG_HOME/agent/skills`), searched in precedence order so a project
   skill wins over a user one of the same name.
2. **Progressive disclosure** — expose only `name` + `description` up front; load
   the body on selection; expose `reference/` only when the procedure asks.
   **Done:** the prompt lists names + descriptions, and `skills_read_skill` reads
   the body or one named bundled file.
3. **Supply chain** — **not built, on purpose.** This host shares by declaration,
   not by fetch: a `git submodule`, a symlink, or an npm package that ends in a
   directory `--skills` already reads. Fetching would make content arrive without
   the operator act that the declared-trust default rests on.
   [ADR-004](../adr/004-skill-supply-chain.md) records the options, the risk, and
   what would change the answer.

The invocation question (does a skill run _in_ the current context or as an
isolated sub-session?) is the point where this archetype meets
[orchestrator-agent](orchestrator-agent.md) — worth deciding once, deliberately.
