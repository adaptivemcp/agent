import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_FILE, discoverSkills, type Skill } from "./skills.js";
import {
  addTrustEntry,
  decideTrust,
  readTrust,
  skillHash,
  trustFilePath,
  writeTrust,
  type TrustRecord,
} from "./skill-trust.js";

describe("skill trust", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-skill-trust-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write one skill under `root` and return it as discovery sees it. */
  function makeSkill(name: string, body = "Do the thing."): Skill {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, SKILL_FILE),
      `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\n${body}\n`,
    );
    return discover(root).find((skill) => skill.name === name)!;
  }

  function discover(from: string): Skill[] {
    return discoverSkills([{ path: from, origin: "project" }]);
  }

  describe("skillHash", () => {
    it("is stable for the same content", () => {
      const skill = makeSkill("deploy");
      expect(skillHash(skill)).toBe(skillHash(discover(root)[0]!));
      expect(skillHash(skill)).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("changes with the instructions, and with a bundled file", () => {
      const skill = makeSkill("deploy");
      const before = skillHash(skill)!;

      writeFileSync(join(skill.dir, "notes.md"), "- item");
      const withBundle = discover(root)[0]!;
      const after = skillHash(withBundle)!;
      expect(after).not.toBe(before); // a verdict must cover the files, not just SKILL.md

      makeSkill("deploy", "Do something else.");
      expect(skillHash(discover(root)[0]!)).not.toBe(after);
    });

    it("is undefined when the skill cannot be read back", () => {
      const skill = makeSkill("deploy");
      rmSync(skill.dir, { recursive: true, force: true });
      expect(skillHash(skill)).toBeUndefined();
    });
  });

  describe("decideTrust", () => {
    it("trusts the operator's own trees by default", () => {
      const skill = makeSkill("deploy");
      expect(decideTrust([skill])).toEqual({ trusted: [skill], withheld: [] });
    });

    it("withholds everything under a directory marked untrusted", () => {
      const skill = makeSkill("deploy");
      const { trusted, withheld } = decideTrust([skill], { untrustedDirs: [root] });

      expect(trusted).toEqual([]);
      expect(withheld[0]?.skill).toEqual(skill);
      expect(withheld[0]?.reason).toContain("marked untrusted");
    });

    it("vouches for exactly those bytes — an edit is no longer vouched for", () => {
      const skill = makeSkill("deploy");
      const record: TrustRecord = {
        version: 1,
        entries: [{ name: "deploy", hash: skillHash(skill)!, status: "trusted", at: "now" }],
      };

      expect(decideTrust([skill], { untrustedDirs: [root], record }).trusted).toEqual([skill]);

      // Same name, different content: "I reviewed this" stops being true.
      makeSkill("deploy", "Now with an exfiltration step.");
      const edited = discover(root)[0]!;
      expect(decideTrust([edited], { untrustedDirs: [root], record }).trusted).toEqual([]);
    });

    it("refuses a blocked skill even inside a trusted directory", () => {
      const skill = makeSkill("deploy");
      const record: TrustRecord = {
        version: 1,
        entries: [
          { name: "deploy", hash: skillHash(skill)!, status: "blocked", note: "exfil rule", at: "now" },
        ],
      };

      const { trusted, withheld } = decideTrust([skill], { record });

      expect(trusted).toEqual([]);
      expect(withheld[0]?.reason).toContain("exfil rule");
    });

    it("will not vouch for a skill it cannot read back", () => {
      const skill = makeSkill("deploy");
      rmSync(skill.dir, { recursive: true, force: true });

      const { trusted, withheld } = decideTrust([skill], { untrustedDirs: [root] });

      expect(trusted).toEqual([]);
      expect(withheld).toHaveLength(1);
    });
  });

  describe("the record on disk", () => {
    it("lives beside the user skills directory", () => {
      expect(trustFilePath({ XDG_CONFIG_HOME: "/opt/cfg" }, "/home/u")).toBe(
        "/opt/cfg/agent/skills.trust.json",
      );
      expect(trustFilePath({}, "/home/u")).toBe("/home/u/.config/agent/skills.trust.json");
    });

    it("round-trips, and a missing file means no record yet", () => {
      const path = join(root, "skills.trust.json");
      expect(readTrust(path)).toEqual({ version: 1, entries: [] });

      const record: TrustRecord = {
        version: 1,
        entries: [{ name: "a", hash: "sha256:x", status: "trusted", note: "scanned", at: "now" }],
      };
      writeTrust(record, path);
      expect(readTrust(path)).toEqual(record);
    });

    it("refuses a record it cannot understand, rather than quietly un-blocking", () => {
      const path = join(root, "skills.trust.json");

      writeFileSync(path, "{ not json");
      expect(() => readTrust(path)).toThrow(/not valid JSON/);

      writeFileSync(path, JSON.stringify({ version: 2, entries: [] }));
      expect(() => readTrust(path)).toThrow(/unsupported version/);

      writeFileSync(path, JSON.stringify({ version: 1, entries: [{ name: "a" }] }));
      expect(() => readTrust(path)).toThrow(/malformed entry/);
    });

    it("replaces an entry for a skill instead of accumulating hashes", () => {
      const first = addTrustEntry(
        { version: 1, entries: [] },
        { name: "a", hash: "sha256:1", status: "trusted", at: "t1" },
      );
      const second = addTrustEntry(first, {
        name: "a",
        hash: "sha256:2",
        status: "trusted",
        at: "t2",
      });

      expect(second.entries).toEqual([
        { name: "a", hash: "sha256:2", status: "trusted", at: "t2" },
      ]);
    });
  });
});
