import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKILL_FILE,
  agentDefinition,
  discoverSkills,
  skillDirs,
  skillsPrompt,
  skillsToolset,
  userSkillsDir,
  type SkillDir,
} from "./skills.js";

/** Project-level directories, the common case in these tests. */
function dirs(...paths: string[]): SkillDir[] {
  return paths.map((path) => ({ path, origin: "project" }));
}

/** Write `<root>/<name>/SKILL.md` and return its directory. */
function makeSkill(
  root: string,
  name: string,
  description: string,
  body = "Do the thing.",
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SKILL_FILE),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
  return dir;
}

describe("skills", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-skills-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("discovery", () => {
    it("finds <name>/SKILL.md, sorted, and ignores everything else", () => {
      makeSkill(root, "deploy", "Deploy a service safely");
      makeSkill(root, "audit", "Audit a repository");
      mkdirSync(join(root, "not-a-skill")); // a directory without SKILL.md
      writeFileSync(join(root, "loose.md"), "ignored"); // not a directory

      const skills = discoverSkills(dirs(root));

      expect(skills.map((skill) => skill.name)).toEqual(["audit", "deploy"]);
      expect(skills[0]?.description).toBe("Audit a repository");
    });

    it("skips a SKILL.md it cannot understand, with a warning, rather than failing", () => {
      makeSkill(root, "good", "Fine");
      const bad = join(root, "bad");
      mkdirSync(bad);
      writeFileSync(join(bad, SKILL_FILE), "no frontmatter here");
      const warnings: string[] = [];

      const skills = discoverSkills(dirs(root), (message) => warnings.push(message));

      expect(skills.map((skill) => skill.name)).toEqual(["good"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("frontmatter");
    });

    it("requires a description, not just a name", () => {
      const dir = join(root, "half");
      mkdirSync(dir);
      writeFileSync(join(dir, SKILL_FILE), "---\nname: half\n---\nbody");
      const warnings: string[] = [];

      expect(discoverSkills(dirs(root), (message) => warnings.push(message))).toEqual([]);
      expect(warnings).toHaveLength(1);
    });

    it("ignores a directory that does not exist", () => {
      expect(discoverSkills(dirs(join(root, "nope")))).toEqual([]);
    });

    it("keeps the first of two skills that share a name", () => {
      makeSkill(root, "deploy", "First");
      const second = mkdtempSync(join(tmpdir(), "agent-skills-"));
      makeSkill(second, "deploy", "Second");
      const warnings: string[] = [];

      const skills = discoverSkills(dirs(root, second), (message) => warnings.push(message));

      expect(skills).toHaveLength(1);
      expect(skills[0]?.description).toBe("First");
      expect(warnings[0]).toContain("duplicate");
      rmSync(second, { recursive: true, force: true });
    });

    it("lists bundled files, excluding SKILL.md itself", () => {
      const dir = makeSkill(root, "deploy", "Deploy");
      writeFileSync(join(dir, "checklist.md"), "- item");
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts", "run.sh"), "echo hi");

      const [skill] = discoverSkills(dirs(root));

      expect(skill?.files).toEqual(["checklist.md", "scripts/run.sh"]);
    });
  });

  describe("read_skill", () => {
    it("returns the body and signs the bundled files", async () => {
      const dir = makeSkill(root, "deploy", "Deploy a service safely", "Step 1: check.");
      writeFileSync(join(dir, "checklist.md"), "- item");
      const toolset = skillsToolset(discoverSkills(dirs(root)));

      expect((await toolset.listTools())[0]?.name).toBe("read_skill");
      const result = await toolset.callTool("read_skill", { skill: "deploy" });

      expect(result.ok).toBe(true);
      expect(String(result.output)).toContain("Step 1: check.");
      expect(String(result.output)).toContain("Bundled files");
      expect(String(result.output)).toContain("checklist.md");
    });

    it("reads one bundled file", async () => {
      const dir = makeSkill(root, "deploy", "Deploy");
      writeFileSync(join(dir, "checklist.md"), "- item");
      const toolset = skillsToolset(discoverSkills(dirs(root)));

      const result = await toolset.callTool("read_skill", {
        skill: "deploy",
        file: "checklist.md",
      });

      expect(result.ok).toBe(true);
      expect(String(result.output)).toBe("- item");
    });

    it("refuses to leave the skill directory", async () => {
      makeSkill(root, "deploy", "Deploy");
      writeFileSync(join(root, "secret.txt"), "s3cret");
      const toolset = skillsToolset(discoverSkills(dirs(root)));

      const up = await toolset.callTool("read_skill", { skill: "deploy", file: "../secret.txt" });

      expect(up.ok).toBe(false);
      expect(up.error).toContain("outside the skill directory");
    });

    it("refuses a sibling directory that merely shares the prefix", async () => {
      makeSkill(root, "deploy", "Deploy");
      const sibling = join(root, "deploy-other");
      mkdirSync(sibling);
      writeFileSync(join(sibling, "secret.txt"), "s3cret");
      const toolset = skillsToolset(discoverSkills(dirs(root)));

      const result = await toolset.callTool("read_skill", {
        skill: "deploy",
        file: "../deploy-other/secret.txt",
      });

      expect(result.ok).toBe(false);
    });

    it("reports an unknown skill instead of throwing", async () => {
      makeSkill(root, "deploy", "Deploy");
      const toolset = skillsToolset(discoverSkills(dirs(root)));

      const result = await toolset.callTool("read_skill", { skill: "nope" });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("unknown skill");
    });

    it("bounds a very large skill file", async () => {
      const dir = makeSkill(root, "huge", "Huge");
      writeFileSync(
        join(dir, SKILL_FILE),
        `---\nname: huge\ndescription: Huge\n---\n${"x".repeat(30_000)}`,
      );
      const toolset = skillsToolset(discoverSkills(dirs(root)));

      const result = await toolset.callTool("read_skill", { skill: "huge" });

      expect(String(result.output)).toContain("[truncated");
    });

    it("rejects an unknown tool name", async () => {
      const toolset = skillsToolset(discoverSkills(dirs(root)));
      expect((await toolset.callTool("write_skill", {})).ok).toBe(false);
      await toolset.close();
    });
  });

  describe("tool policy — a skill that is also an agent definition", () => {
    /** A SKILL.md with whatever frontmatter the test needs. */
    function writeSkill(name: string, frontmatter: string, body = "Do the thing."): void {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, SKILL_FILE), `---\n${frontmatter}\n---\n\n${body}\n`);
    }

    it("reads tools and deny from the frontmatter", () => {
      writeSkill(
        "reviewer",
        "name: reviewer\ndescription: reads only\ntools:\n  - search_customer\ndeny:\n  - deploy_service",
      );

      const [skill] = discoverSkills(dirs(root));

      expect(skill?.tools).toEqual(["search_customer"]);
      expect(skill?.deny).toEqual(["deploy_service"]);
    });

    it("treats a malformed tool policy as a hard error, never as 'unrestricted'", () => {
      // `tools: search_customer` (a string, not a list) is a typo, and silently
      // ignoring it would mean the opposite of what the author asked for.
      writeSkill("typo", "name: typo\ndescription: d\ntools: search_customer");
      const warnings: string[] = [];

      const skills = discoverSkills(dirs(root), (message) => warnings.push(message));

      expect(skills).toEqual([]);
      expect(warnings).toHaveLength(1);
    });

    it("leaves the policy absent for an ordinary skill", () => {
      makeSkill(root, "plain", "no policy");

      const [skill] = discoverSkills(dirs(root));

      expect(skill?.tools).toBeUndefined();
      expect(skill?.deny).toBeUndefined();
    });

    it("exposes a skill as an agent definition, with its instructions", () => {
      const dir = join(root, "reviewer");
      mkdirSync(dir);
      writeFileSync(
        join(dir, SKILL_FILE),
        "---\nname: reviewer\ndescription: reads only\ntools:\n  - search_customer\n---\n\nRead, then report.\n",
      );

      const definition = agentDefinition(discoverSkills(dirs(root))[0]!);

      expect(definition).toEqual({
        name: "reviewer",
        description: "reads only",
        instructions: "Read, then report.",
        tools: ["search_customer"],
        deny: undefined,
      });
    });
  });

  describe("skillsPrompt", () => {
    it("lists names and descriptions and how to open one — never a body", () => {
      makeSkill(root, "deploy", "Deploy a service safely", "SECRET BODY");

      const prompt = skillsPrompt(discoverSkills(dirs(root)));

      expect(prompt).toContain("deploy: Deploy a service safely");
      expect(prompt).toContain("skills_read_skill");
      expect(prompt).not.toContain("SECRET BODY");
    });

    it("is empty with no skills", () => {
      expect(skillsPrompt([])).toBe("");
    });

    it("names the level each skill came from, so a name that looks local is not mistaken for one", () => {
      const project = join(root, "project");
      const user = join(root, "user");
      makeSkill(project, "review", "Review a diff");
      makeSkill(user, "commit-style", "Write commit messages this way");

      const prompt = skillsPrompt(
        discoverSkills([
          { path: project, origin: "project" },
          { path: user, origin: "user" },
        ]),
      );

      expect(prompt).toContain("Project skills:");
      expect(prompt).toContain("- review: Review a diff");
      expect(prompt).toContain("User skills:");
      expect(prompt).toContain("- commit-style: Write commit messages this way");
    });
  });
});

describe("skill levels", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-skills-levels-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("computes the user-level directory from $XDG_CONFIG_HOME, or falls back to ~/.config", () => {
    expect(userSkillsDir({ XDG_CONFIG_HOME: "/opt/cfg" }, "/home/u")).toBe("/opt/cfg/agent/skills");
    // A blank variable names no directory; the home fallback is the honest default.
    expect(userSkillsDir({ XDG_CONFIG_HOME: "  " }, "/home/u")).toBe(
      "/home/u/.config/agent/skills",
    );
    expect(userSkillsDir({}, "/home/u")).toBe("/home/u/.config/agent/skills");
  });

  it("orders the levels: explicit first, then ./skills, then the user default", () => {
    const project = join(root, "proj");
    const configHome = join(root, "config");
    const user = join(configHome, "agent", "skills");
    const explicit = join(root, "explicit");
    mkdirSync(join(project, "skills"), { recursive: true });
    mkdirSync(user, { recursive: true });
    mkdirSync(explicit, { recursive: true });

    const listed = skillDirs([explicit], {
      cwd: project,
      env: { XDG_CONFIG_HOME: configHome },
      home: join(root, "home"),
    });

    expect(listed).toEqual([
      { path: explicit, origin: "project" },
      { path: join(project, "skills"), origin: "project" },
      { path: user, origin: "user" },
    ]);
  });

  it("skips a level whose directory does not exist, and never repeats one", () => {
    const project = join(root, "proj");
    mkdirSync(project, { recursive: true });

    // No ./skills and no user default here; the explicit directory is passed twice.
    const listed = skillDirs([root, root], {
      cwd: project,
      env: { XDG_CONFIG_HOME: join(root, "config") },
      home: join(root, "home"),
    });

    expect(listed).toEqual([{ path: root, origin: "project" }]);
  });

  it("records where each skill was found, and keeps the higher level on a collision", () => {
    const project = join(root, "proj", "skills");
    const user = join(root, "config", "agent", "skills");
    makeSkill(project, "review", "Project review");
    makeSkill(user, "review", "User review");
    makeSkill(user, "commit-style", "Write commit messages this way");
    const warnings: string[] = [];

    const skills = discoverSkills(
      [
        { path: project, origin: "project" },
        { path: user, origin: "user" },
      ],
      (message) => warnings.push(message),
    );

    // The project's copy wins; the user's is reported rather than merged.
    expect(skills.map((skill) => [skill.name, skill.description, skill.origin])).toEqual([
      ["commit-style", "Write commit messages this way", "user"],
      ["review", "Project review", "project"],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("duplicate");
    expect(warnings[0]).toContain("already loaded from project");
  });
});
