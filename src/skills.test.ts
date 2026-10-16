import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_FILE, discoverSkills, skillsPrompt, skillsToolset } from "./skills.js";

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

      const skills = discoverSkills([root]);

      expect(skills.map((skill) => skill.name)).toEqual(["audit", "deploy"]);
      expect(skills[0]?.description).toBe("Audit a repository");
    });

    it("skips a SKILL.md it cannot understand, with a warning, rather than failing", () => {
      makeSkill(root, "good", "Fine");
      const bad = join(root, "bad");
      mkdirSync(bad);
      writeFileSync(join(bad, SKILL_FILE), "no frontmatter here");
      const warnings: string[] = [];

      const skills = discoverSkills([root], (message) => warnings.push(message));

      expect(skills.map((skill) => skill.name)).toEqual(["good"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("frontmatter");
    });

    it("requires a description, not just a name", () => {
      const dir = join(root, "half");
      mkdirSync(dir);
      writeFileSync(join(dir, SKILL_FILE), "---\nname: half\n---\nbody");
      const warnings: string[] = [];

      expect(discoverSkills([root], (message) => warnings.push(message))).toEqual([]);
      expect(warnings).toHaveLength(1);
    });

    it("ignores a directory that does not exist", () => {
      expect(discoverSkills([join(root, "nope")])).toEqual([]);
    });

    it("keeps the first of two skills that share a name", () => {
      makeSkill(root, "deploy", "First");
      const second = mkdtempSync(join(tmpdir(), "agent-skills-"));
      makeSkill(second, "deploy", "Second");
      const warnings: string[] = [];

      const skills = discoverSkills([root, second], (message) => warnings.push(message));

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

      const [skill] = discoverSkills([root]);

      expect(skill?.files).toEqual(["checklist.md", "scripts/run.sh"]);
    });
  });

  describe("read_skill", () => {
    it("returns the body and signs the bundled files", async () => {
      const dir = makeSkill(root, "deploy", "Deploy a service safely", "Step 1: check.");
      writeFileSync(join(dir, "checklist.md"), "- item");
      const toolset = skillsToolset(discoverSkills([root]));

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
      const toolset = skillsToolset(discoverSkills([root]));

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
      const toolset = skillsToolset(discoverSkills([root]));

      const up = await toolset.callTool("read_skill", { skill: "deploy", file: "../secret.txt" });

      expect(up.ok).toBe(false);
      expect(up.error).toContain("outside the skill directory");
    });

    it("refuses a sibling directory that merely shares the prefix", async () => {
      makeSkill(root, "deploy", "Deploy");
      const sibling = join(root, "deploy-other");
      mkdirSync(sibling);
      writeFileSync(join(sibling, "secret.txt"), "s3cret");
      const toolset = skillsToolset(discoverSkills([root]));

      const result = await toolset.callTool("read_skill", {
        skill: "deploy",
        file: "../deploy-other/secret.txt",
      });

      expect(result.ok).toBe(false);
    });

    it("reports an unknown skill instead of throwing", async () => {
      makeSkill(root, "deploy", "Deploy");
      const toolset = skillsToolset(discoverSkills([root]));

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
      const toolset = skillsToolset(discoverSkills([root]));

      const result = await toolset.callTool("read_skill", { skill: "huge" });

      expect(String(result.output)).toContain("[truncated");
    });

    it("rejects an unknown tool name", async () => {
      const toolset = skillsToolset(discoverSkills([root]));
      expect((await toolset.callTool("write_skill", {})).ok).toBe(false);
      await toolset.close();
    });
  });

  describe("skillsPrompt", () => {
    it("lists names and descriptions and how to open one — never a body", () => {
      makeSkill(root, "deploy", "Deploy a service safely", "SECRET BODY");

      const prompt = skillsPrompt(discoverSkills([root]));

      expect(prompt).toContain("deploy: Deploy a service safely");
      expect(prompt).toContain("skills_read_skill");
      expect(prompt).not.toContain("SECRET BODY");
    });

    it("is empty with no skills", () => {
      expect(skillsPrompt([])).toBe("");
    });
  });
});
