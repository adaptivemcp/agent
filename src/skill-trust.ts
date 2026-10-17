/**
 * Skill trust: whether the host offers a skill to the model at all.
 *
 * Containment (`src/skills.ts`) bounds what a skill can *reach*; trust decides
 * whether it is offered in the first place, and that is the control that matters
 * for the real threat — a `SKILL.md` is instructions the model obeys. So an
 * untrusted skill is **not listed in the prompt and not readable**: it never enters
 * the context window, rather than entering it with a warning attached. (The prompt
 * listing is itself a foothold — only `name` and `description` are needed to steer
 * a model, and those are injected for every discovered skill.)
 *
 * Trust is **declared by the operator, never by the skill**: a `SKILL.md` cannot
 * vouch for itself, because a malicious one would simply say it is trusted. The
 * record therefore lives outside the skill, in the host's config directory, and is
 * keyed by the skill's **content hash** — "I reviewed this" is worth nothing if the
 * thing can change underneath the review.
 *
 * The default is that the operator's own trees are trusted: the `--skills`
 * directories they pointed at, the project's `./skills`, and their user-level
 * shelf. Nothing arrives here without them putting it there (there is no fetch),
 * so requiring a promotion for every skill they wrote would be friction with no
 * threat behind it. A directory they *did* get from elsewhere is named with
 * `--skills-untrusted`, and a blocking verdict from a scan refuses a skill
 * whatever else says.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { SKILL_FILE, userSkillsDir, type Skill } from "./skills.js";

/** What a trust entry says about one content hash. */
export type TrustStatus = "trusted" | "blocked";

export interface TrustEntry {
  name: string;
  /** `sha256:…` over the skill's instructions and bundled files. */
  hash: string;
  status: TrustStatus;
  /** Why, in the operator's words — a scan verdict, a date, a note. */
  note?: string;
  /** When the entry was written. */
  at: string;
}

/** The host's trust record, as stored on disk. */
export interface TrustRecord {
  version: 1;
  entries: TrustEntry[];
}

export function emptyTrust(): TrustRecord {
  return { version: 1, entries: [] };
}

/** The record's path: `$XDG_CONFIG_HOME/agent/skills.trust.json`, beside the user skills dir. */
export function trustFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(dirname(userSkillsDir(env, home)), "skills.trust.json");
}

/**
 * Read the trust record. A file that cannot be understood is an **error**, not an
 * empty record: silently ignoring it would quietly un-block whatever it blocked.
 */
export function readTrust(path: string): TrustRecord {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyTrust(); // no record yet is the normal first-run case
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`trust record "${path}" is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`trust record "${path}" must be a JSON object`);
  }
  const record = parsed as { version?: unknown; entries?: unknown };
  if (record.version !== 1) {
    throw new Error(`trust record "${path}" has an unsupported version: ${String(record.version)}`);
  }
  if (!Array.isArray(record.entries)) {
    throw new Error(`trust record "${path}" needs an "entries" array`);
  }
  const entries: TrustEntry[] = [];
  for (const raw of record.entries) {
    const entry = raw as Partial<TrustEntry>;
    const ok =
      typeof entry?.name === "string" &&
      typeof entry.hash === "string" &&
      (entry.status === "trusted" || entry.status === "blocked") &&
      typeof entry.at === "string" &&
      (entry.note === undefined || typeof entry.note === "string");
    if (!ok) throw new Error(`trust record "${path}" has a malformed entry`);
    entries.push({
      name: entry.name as string,
      hash: entry.hash as string,
      status: entry.status as TrustStatus,
      note: entry.note,
      at: entry.at as string,
    });
  }
  return { version: 1, entries };
}

export function writeTrust(record: TrustRecord, path: string): void {
  mkdirSync(dirname(path), { recursive: true }); // the config dir may not exist yet
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** Record `entry`, replacing any earlier entry for the same skill name. */
export function addTrustEntry(record: TrustRecord, entry: TrustEntry): TrustRecord {
  return {
    version: 1,
    entries: [...record.entries.filter((existing) => existing.name !== entry.name), entry],
  };
}

/**
 * A skill's identity for a trust decision: its instructions, plus the bundled
 * files the read tool advertises, hashed in a fixed order. `undefined` when the
 * skill cannot be read back — a skill that cannot be vouched for is not vouched
 * for.
 */
export function skillHash(skill: Skill): string | undefined {
  try {
    const hash = createHash("sha256");
    hash.update(`skill: ${skill.name}\n`);
    hash.update(readFileSync(join(skill.dir, SKILL_FILE)));
    for (const file of [...skill.files].sort()) {
      hash.update(`\nfile: ${file}\n`);
      hash.update(readFileSync(join(skill.dir, file)));
    }
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return undefined;
  }
}

export interface WithheldSkill {
  skill: Skill;
  /** Why it was withheld, for the host to say out loud. */
  reason: string;
}

export interface TrustDecision {
  /** Skills the model may see: listed in the prompt, readable by the tool. */
  trusted: Skill[];
  /** Skills withheld, with the reason, so the host can report them. */
  withheld: WithheldSkill[];
}

/**
 * Split discovered skills into those the model may see and those it may not.
 *
 * Precedence, in order: a **blocked** verdict refuses regardless of anything else
 * (a positive finding is not overridden by a directory being trusted); an explicit
 * **trusted** entry vouches for exactly those bytes; a directory named with
 * `--skills-untrusted` withholds what is under it; everything else is trusted.
 */
export function decideTrust(
  skills: Skill[],
  {
    untrustedDirs = [],
    record = emptyTrust(),
  }: { untrustedDirs?: string[]; record?: TrustRecord } = {},
): TrustDecision {
  const marked = untrustedDirs.map(realDir).filter((dir): dir is string => dir !== undefined);
  const trusted: Skill[] = [];
  const withheld: WithheldSkill[] = [];

  for (const skill of skills) {
    const hash = skillHash(skill);
    const entry = hash
      ? record.entries.find((candidate) => candidate.name === skill.name && candidate.hash === hash)
      : undefined;
    if (entry?.status === "blocked") {
      withheld.push({
        skill,
        reason: entry.note ? `blocked by the trust record (${entry.note})` : "blocked by the trust record",
      });
    } else if (entry?.status === "trusted") {
      trusted.push(skill);
    } else if (marked.some((dir) => inside(dir, skill.dir))) {
      withheld.push({
        skill,
        reason: "in a directory marked untrusted — vouch for it with --skills-trust or scan it",
      });
    } else {
      trusted.push(skill);
    }
  }
  return { trusted, withheld };
}

/** The real path of a directory, or `undefined` when it does not exist. */
function realDir(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Whether `path` is `root` or sits under it. Both must already be real paths. */
function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}
