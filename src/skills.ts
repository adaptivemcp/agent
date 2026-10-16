/**
 * Skills: instructions a host owns and the model loads on demand.
 *
 * A *skill* is a directory holding `SKILL.md`, whose YAML frontmatter carries a
 * `name` and a `description`, and whose body carries the instructions. The
 * point of the pattern — taken from `llama.cpp` and `opencode` — is **progressive
 * disclosure**: the prompt carries only the names and descriptions (a few tokens
 * a line), and the body is read through a tool when the work calls for it. A
 * large corpus therefore costs almost nothing until it is used, and the
 * instructions never ride along on every request.
 *
 * Skills are **not a protocol concept** (ADR-004): there is no `adaptiveSkill`,
 * no new noun. This is a host-side loader over a filesystem convention, and its
 * files are treated as untrusted input — the read tool cannot escape a skill's
 * own directory.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { load as parseYaml } from "js-yaml";
import type { McpToolResult, Toolset } from "./mcp/toolset.js";
import type { ToolSpec } from "./types.js";

/** The file that marks a directory as a skill. */
export const SKILL_FILE = "SKILL.md";

/** Cap on text returned by the read tool, so one skill cannot flood a context. */
const MAX_OUTPUT_CHARS = 24_000;

/** Caps on the bundled-file listing, which is a signpost, not an inventory. */
const MAX_FILES = 50;
const MAX_DEPTH = 3;

export interface Skill {
  name: string;
  description: string;
  /** Absolute path of the skill directory. */
  dir: string;
  /** Files bundled with the skill (relative paths), for the third disclosure level. */
  files: string[];
}

/**
 * Discover skills under each directory: `<dir>/<name>/SKILL.md`. A missing
 * directory is not an error (the convention may simply not be in use), and a
 * directory without `SKILL.md` is not a skill. A `SKILL.md` that cannot be
 * understood is **skipped with a warning** rather than failing the run: a typo
 * in one skill should not stop the agent.
 */
export function discoverSkills(
  dirs: string[],
  warn: (message: string) => void = () => {},
): Skill[] {
  const found = new Map<string, Skill>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dirPath = join(dir, entry);
      const filePath = join(dirPath, SKILL_FILE);
      let text: string;
      try {
        if (!statSync(dirPath).isDirectory()) continue;
        text = readFileSync(filePath, "utf8");
      } catch {
        continue; // no SKILL.md here — just not a skill
      }
      const parsed = parseSkill(text);
      if (!parsed) {
        warn(`${filePath}: SKILL.md needs YAML frontmatter with "name" and "description"; skipped`);
        continue;
      }
      if (found.has(parsed.name)) {
        warn(`${filePath}: duplicate skill "${parsed.name}" (already found); skipped`);
        continue;
      }
      const root = resolve(dirPath);
      found.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        dir: root,
        files: listSkillFiles(root),
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The prompt-side listing: names and descriptions only, plus how to open one. */
export function skillsPrompt(skills: Skill[], toolName = "skills_read_skill"): string {
  if (skills.length === 0) return "";
  return [
    "Skills — instructions you can load on demand, before doing that kind of work:",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    `Read one with ${toolName} {"skill": "<name>"}; its bundled files can be read with the same tool's "file" argument.`,
  ].join("\n");
}

/**
 * Expose the discovered skills as a toolset, so reading one goes through the same
 * execution seam as any MCP tool (approval gate, telemetry, graph).
 */
export function skillsToolset(skills: Skill[]): Toolset {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    serverName: "skills",
    async listTools(): Promise<ToolSpec[]> {
      return [
        {
          name: "read_skill",
          description:
            "Read a skill's full instructions, or one file bundled with it. Call this before " +
            "doing work a skill covers. Skills are listed in the system prompt.",
          inputSchema: {
            type: "object",
            properties: {
              skill: { type: "string", description: "Skill name, as listed in the system prompt." },
              file: {
                type: "string",
                description: "Optional bundled file to read (relative to the skill directory).",
              },
            },
            required: ["skill"],
          },
          serverName: "skills",
        },
      ];
    },
    async callTool(name, input): Promise<McpToolResult> {
      if (name !== "read_skill") return { ok: false, error: `unknown tool: ${name}` };
      const args = (input ?? {}) as { skill?: unknown; file?: unknown };
      const skill = typeof args.skill === "string" ? byName.get(args.skill) : undefined;
      if (!skill) return { ok: false, error: `unknown skill: ${String(args.skill)}` };

      if (args.file !== undefined) {
        if (typeof args.file !== "string") return { ok: false, error: "file must be a string" };
        const target = resolve(skill.dir, args.file);
        // Untrusted input: a skill may only read inside its own directory, so a
        // `../` in the argument cannot reach the rest of the filesystem.
        if (target !== skill.dir && !target.startsWith(skill.dir + sep)) {
          return { ok: false, error: `refused: "${args.file}" is outside the skill directory` };
        }
        try {
          return { ok: true, output: bounded(readFileSync(target, "utf8")) };
        } catch {
          return { ok: false, error: `cannot read "${args.file}"` };
        }
      }

      let body: string;
      try {
        const parsed = parseSkill(readFileSync(join(skill.dir, SKILL_FILE), "utf8"));
        if (!parsed) return { ok: false, error: `"${skill.name}" no longer loads` };
        body = parsed.body;
      } catch {
        return { ok: false, error: `cannot read ${skill.name}/${SKILL_FILE}` };
      }
      const bundled =
        skill.files.length > 0
          ? `\n\nBundled files (read with the "file" argument):\n${skill.files.join("\n")}`
          : "";
      return { ok: true, output: bounded(body + bundled) };
    },
    async close(): Promise<void> {
      // Nothing to release.
    },
  };
}

/** Split a `SKILL.md` into its frontmatter and body, or `undefined` if malformed. */
function parseSkill(text: string): { name: string; description: string; body: string } | undefined {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return undefined;
  let meta: unknown;
  try {
    meta = parseYaml(text.slice(3, end));
  } catch {
    return undefined;
  }
  if (typeof meta !== "object" || meta === null) return undefined;
  const { name, description } = meta as { name?: unknown; description?: unknown };
  if (typeof name !== "string" || !name.trim()) return undefined;
  if (typeof description !== "string" || !description.trim()) return undefined;
  return { name: name.trim(), description: description.trim(), body: text.slice(end + 4).trim() };
}

/** The skill's bundled files (relative, `/`-separated), breadth-capped. */
function listSkillFiles(dir: string, prefix = "", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;
    const path = join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) files.push(...listSkillFiles(path, relative, depth + 1));
    else if (relative !== SKILL_FILE) files.push(relative);
  }
  return files.slice(0, MAX_FILES);
}

function bounded(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated: the file is ${text.length} characters]`
    : text;
}
