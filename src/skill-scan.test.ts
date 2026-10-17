import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_FILE, discoverSkills, type Skill } from "./skills.js";
import {
  SCAN_MIME_TYPES,
  parseScanReport,
  scanDocument,
  scanTargets,
  verdictEntries,
} from "./skill-scan.js";

/** A scanner report in the shape `cisco-ai-defense/mcp-scanner` emits. */
function report(
  results: Array<{ uri: string; safe?: boolean; severity?: string; threats?: string[] }>,
  analyzers = ["yara"],
): string {
  return JSON.stringify({
    server_url: "https://example.invalid",
    requested_analyzers: analyzers,
    scan_results: results.map(({ uri, safe = true, severity = "SAFE", threats = [] }) => ({
      status: "completed",
      is_safe: safe,
      findings: {
        yara_analyzer: {
          severity,
          threat_names: threats,
          threat_summary: threats.length ? `Detected ${threats.length}` : "No threats detected",
          total_findings: threats.length,
        },
      },
      resource_uri: uri,
      resource_name: uri,
      resource_mime_type: "text/markdown",
      item_type: "resource",
    })),
  });
}

describe("skill scan", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-skill-scan-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeSkill(name: string, body = "Do the thing.", bundled?: string): Skill {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, SKILL_FILE),
      `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\n${body}\n`,
    );
    if (bundled) writeFileSync(join(dir, "notes.md"), bundled);
    return discoverSkills([{ path: root, origin: "project" }]).find(
      (skill) => skill.name === name,
    )!;
  }

  describe("scanTargets", () => {
    it("offers SKILL.md and every bundled file, with the MIME the scanner filters on", () => {
      const skill = makeSkill("deploy", "Go.", "- item");

      const targets = scanTargets([skill]);

      expect(targets.map((target) => target.file)).toEqual([SKILL_FILE, "notes.md"]);
      expect(targets.map((target) => target.mimeType)).toEqual(["text/markdown", "text/plain"]);
      expect(targets[0]?.uri).toBe("deploy/SKILL.md");
      expect(targets[1]?.text).toContain("- item");
      // The scanner only looks at the MIME types it is told about.
      expect(SCAN_MIME_TYPES).toBe("text/markdown,text/plain");
    });

    it("skips a file it cannot read, rather than offering it empty", () => {
      const skill = makeSkill("deploy");
      rmSync(join(skill.dir, "notes.md"), { force: true });

      expect(scanTargets([skill])).toHaveLength(1);
    });
  });

  it("writes the document the scanner's static resources mode reads", () => {
    const skill = makeSkill("deploy");
    const document = JSON.parse(scanDocument(scanTargets([skill]))) as {
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    };

    expect(document.contents).toHaveLength(1);
    expect(document.contents[0]?.text).toContain("deploy does a thing");
    expect(document.contents[0]?.mimeType).toBe("text/markdown");
  });

  describe("parseScanReport", () => {
    it("blocks a skill when any one of its files is flagged", () => {
      const skill = makeSkill("deploy", "Go.", "- item");
      const targets = scanTargets([skill]);
      const raw = report([
        { uri: "deploy/SKILL.md" },
        {
          uri: "deploy/notes.md",
          safe: false,
          severity: "HIGH",
          threats: ["DATA EXFILTRATION"],
        },
      ]);

      const scanned = parseScanReport(raw, targets);

      expect(scanned.verdicts).toHaveLength(1);
      expect(scanned.verdicts[0]?.status).toBe("blocked");
      expect(scanned.verdicts[0]?.severity).toBe("HIGH");
      expect(scanned.verdicts[0]?.threats).toEqual(["DATA EXFILTRATION"]);
      expect(scanned.unscanned).toEqual([]);
    });

    it("keeps the worst severity and every threat name across files", () => {
      const skill = makeSkill("deploy", "Go.", "- item");
      const targets = scanTargets([skill]);
      const raw = report([
        {
          uri: "deploy/SKILL.md",
          safe: false,
          severity: "MEDIUM",
          threats: ["PROMPT INJECTION"],
        },
        {
          uri: "deploy/notes.md",
          safe: false,
          severity: "HIGH",
          threats: ["CREDENTIAL HARVESTING", "PROMPT INJECTION"],
        },
      ]);

      const verdict = parseScanReport(raw, targets).verdicts[0]!;

      expect(verdict.severity).toBe("HIGH");
      expect(verdict.threats).toEqual(["PROMPT INJECTION", "CREDENTIAL HARVESTING"]);
    });

    it("clears a skill only when every file it offered came back safe", () => {
      const skill = makeSkill("deploy", "Go.", "- item");
      const targets = scanTargets([skill]);
      const raw = report([{ uri: "deploy/SKILL.md" }]); // notes.md is missing

      const scanned = parseScanReport(raw, targets);

      // A file the report never mentions is not cleared — it is not checked.
      expect(scanned.unscanned.map((target) => target.file)).toEqual(["notes.md"]);
      // The skill itself still has a verdict from the file that *was* checked.
      expect(scanned.verdicts.map((verdict) => verdict.status)).toEqual(["trusted"]);
    });

    it("refuses a report it cannot understand instead of reading it as clean", () => {
      const targets = scanTargets([makeSkill("deploy")]);

      expect(() => parseScanReport("not json", targets)).toThrow(/did not return JSON/);
      expect(() => parseScanReport("{}", targets)).toThrow(/scan_results/);
      expect(() => parseScanReport(JSON.stringify({ scan_results: 3 }), targets)).toThrow(
        /scan_results/,
      );
    });
  });

  describe("verdictEntries", () => {
    it("records a flag as blocked, with the detail, bound to the bytes", () => {
      const skill = makeSkill("sketchy");
      const targets = scanTargets([skill]);
      const raw = report(
        [
          {
            uri: "sketchy/SKILL.md",
            safe: false,
            severity: "HIGH",
            threats: ["CREDENTIAL HARVESTING"],
          },
        ],
        ["yara"],
      );

      const entries = verdictEntries(parseScanReport(raw, targets), "2026-10-17T00:00:00.000Z");

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        name: "sketchy",
        status: "blocked",
        at: "2026-10-17T00:00:00.000Z",
      });
      expect(entries[0]?.hash).toMatch(/^sha256:/);
      expect(entries[0]?.note).toBe("blocked by yara: HIGH — CREDENTIAL HARVESTING");
    });

    it("records a clean scan as exactly that — not as a guarantee", () => {
      const skill = makeSkill("deploy");
      const raw = report([{ uri: "deploy/SKILL.md" }]);

      const entries = verdictEntries(parseScanReport(raw, scanTargets([skill])), "now");

      expect(entries[0]?.status).toBe("trusted");
      expect(entries[0]?.note).toBe("cleared by yara: no known pattern matched");
    });
  });
});
