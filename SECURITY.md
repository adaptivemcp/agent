# Security

Threat model and reporting for `@adaptivemcp/agent` — the host: an MCP client
(stdio and Streamable HTTP) plus the agent loop that owns model calls and tool
execution.

> **Maintainer note.** This document is a proposal written on 2026-11-07 and the
> underlying reporting channel was enabled at the same time. The scope and the
> "supported versions" window are the maintainer's call; edit them freely rather
> than treating them as commitments made by someone else.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting**: the repository's **Security** tab →
_Report a vulnerability_. That opens a private advisory thread visible only to you and
the maintainer.

Do not open a public issue for anything that could be exploited before it is fixed —
including a prompt-injection payload that escapes a containment rule below, a way to get
a blocked skill read, or a gate that can be lowered without a human.

What to expect: an acknowledgement on the advisory thread, a reproduction of the issue
against `main`, and a fix or a written decision that the behaviour is intended. There is
no paid bounty program.

### Supported versions

Fixes land on `main` and ship in the next release. Only the latest published version is
supported; older minors are not patched. This is a pre-`1.0` project, so minor releases
may contain behaviour changes.

## Trust boundaries

Everything that crosses a process, transport, or model boundary is **untrusted input**:

| Source              | What arrives                                                    | Why it is untrusted                          |
| ------------------- | --------------------------------------------------------------- | -------------------------------------------- |
| MCP servers         | tool definitions, results, resources, `initialize` instructions | a server is replaceable and may be malicious |
| Model output        | text, tool calls, arguments                                     | the model can be steered by anything above   |
| Skills (`SKILL.md`) | instructions the model obeys                                    | text from outside the operator               |
| Config and CLI args | servers, budgets, trust decisions                               | trusted, but only from the operator          |

## Threats and mitigations

### 1. Gate lowering and unapproved execution

A tool flagged `require_confirmation` must not run because a model, server, or skill
asked for it.

- **Fail closed.** With no approver configured, a `require_confirmation` tool is
  **denied**. Auto-approval is the explicit `--yes` opt-in, never a default.
- A denial returns `executed: false` — blocked, not failed — so it is not recorded as a
  tool failure and cannot poison the learned reliability signal.
- Server-published `dev.adaptivemcp/tools-metadata` is applied as a **floor**: a server
  cannot lower a gate the host already applies.
- Static risk is seeded from the protocol's `ToolAnnotations`, which are an untrusted
  hint, not an authority.

### 2. Prompt injection through data

Tool results, resource contents, server `instructions`, skill bodies, task descriptions
and model output are **data, never instructions**.

- Server `initialize` instructions reach the model only as clearly-labelled untrusted
  data.
- Resource reads are confined to URIs the servers actually listed: the catalog is the
  boundary, so a model cannot ask for an arbitrary URI.
- Skill reads are confined to the skill's own directory, with real paths resolved — a
  symlink pointing outside is refused, not followed.
- Middleware that compresses tool output treats it as opaque data and never acts on
  directives found inside it.

### 3. Skill trust

A `SKILL.md` is instructions the model obeys, so the listing itself is a foothold: names
and descriptions enter the system prompt for every skill.

- An untrusted skill is **neither listed nor readable**.
- Trust is **declared by the operator, never by the skill** — a malicious file would
  simply claim to be trusted. The record lives outside the skill tree in
  `$XDG_CONFIG_HOME/agent/skills.trust.json`, keyed by the skill's **content hash**, so a
  reviewed file that changes underneath the review is untrusted again.
- A `blocked` verdict refuses a skill regardless of any other signal.
- Scanning is out of band (`pnpm skills:scan`). A clean pattern scan is recorded as
  exactly that; absence of a finding is not a finding of absence.

### 4. Delegation does not amplify authority

- A delegated child **never auto-approves**: delegation must not widen what may run.
- The child never receives the `task` tool, so recursion is bounded.
- A named agent's `tools`/`deny` frontmatter can only **narrow** the parent's tool list;
  an unknown tool name fails the call rather than falling back to a generalist.

### 5. Credentials and data egress

- API keys are read from the environment (`$AI_API_KEY`, `$LLAMA_API_KEY`, and the
  `OPENAI_API_KEY`/`…_2` family for pooled keys), never from model output or a tool
  result.
- HTTP MCP credentials come from static headers or `OAuthMiddleware`; a token resolved
  per call is injected through a custom `fetch`, so it is not baked into a client
  constructed once.
- Nothing in the loop uploads tool output to a third party. The only outbound calls are
  the model endpoint you configure and the MCP servers you list.
- Telemetry stays in the local store (`--db`, SQLite); it is derived counters and graph
  edges, not a copy of your data.

### 6. Hostile local configuration still wins

The operator's own choices are trusted by design: `--yes`, a permissive approval policy,
or trusting a skill tree are explicit decisions. A report that assumes those flags are
unset is a report about a different configuration.

## Scope

In scope: the gate, skill trust and containment, resource confinement, delegation
bounds, credential handling, and the parser for any artifact this repo reads.

Out of scope: vulnerabilities in MCP servers you choose to run, in the model provider you
configure, or in the third-party CLI tools a `--server` command invokes. Report those to
their maintainers.

## Hardening checklist for operators

- Leave `--yes` off; answer approvals.
- Point `--skills` only at trees you control, and scan third-party ones before trusting.
- Prefer `127.0.0.1` for local servers; require auth for anything reachable off-host.
- Keep `pnpm audit` clean in the project you deploy; this repo pins patched transitive
  versions in `pnpm-workspace.yaml`.
