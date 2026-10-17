/**
 * scripts/scan-skills.ts — scan the discovered skills and record the verdicts.
 *
 *   pnpm skills:scan [--skills <dir>]... [--scanner <command>]
 *
 * Run through `tsx` (like `pnpm dev`), because it imports the loader from `src/`.
 *
 * Deliberately out of band. The agent never scans and never fetches at run time, so
 * a run stays offline and deterministic; this writes the verdicts it *is* willing to
 * consume into `$XDG_CONFIG_HOME/agent/skills.trust.json`. A flagged skill is
 * recorded as blocked, and a clean one as vouched for — bounded to the content hash
 * of exactly what was read.
 *
 * The default scanner is `cisco-ai-defense/mcp-scanner` (`uv tool install
 * cisco-ai-mcp-scanner`). `yara` is the keyless detection engine; the `llm` analyzer
 * catches more but wants an endpoint, and `prompt_defense` is *not* an analyzer
 * (passing it silently does nothing) — it checks for missing defences, not for
 * malice.
 *
 * Exits non-zero when anything is blocked, so it can gate a CI job.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, skillDirs } from "../src/skills.js";
import {
  SCAN_MIME_TYPES,
  parseScanReport,
  scanDocument,
  scanTargets,
  verdictEntries,
} from "../src/skill-scan.js";
import { addTrustEntry, readTrust, trustFilePath, writeTrust } from "../src/skill-trust.js";

const DEFAULT_ANALYZERS = "yara";

function usage(message: string): never {
  console.error(`[scan-skills] ${message}`);
  console.error("usage: pnpm skills:scan [--skills <dir>]... [--scanner <command>]");
  process.exit(2);
}

function readArgs(argv: string[]): { skills: string[]; scanner: string[] } {
  const skills: string[] = [];
  let scanner = ["mcp-scanner"];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skills") {
      const value = argv[i + 1];
      if (!value) usage("--skills needs a directory");
      skills.push(value!);
      i += 1;
    } else if (arg === "--scanner") {
      const value = argv[i + 1];
      if (!value) usage("--scanner needs a command");
      scanner = value!.split(/\s+/);
      i += 1;
    } else {
      usage(`unknown argument "${arg}"`);
    }
  }
  return { skills, scanner };
}

const { skills: explicit, scanner } = readArgs(process.argv.slice(2));
const dirs = skillDirs(explicit);
const skills = discoverSkills(dirs, (message) => console.warn(`[scan-skills] ${message}`));
if (skills.length === 0) {
  console.log(`[scan-skills] no skills found under ${dirs.map((dir) => dir.path).join(", ")}`);
  process.exit(0);
}

const targets = scanTargets(skills);
const staging = mkdtempSync(join(tmpdir(), "agent-scan-"));
const documentPath = join(staging, "resources.json");
writeFileSync(documentPath, scanDocument(targets));

let raw: string;
try {
  raw = execFileSync(
    scanner[0]!,
    [
      ...scanner.slice(1),
      "--analyzers",
      DEFAULT_ANALYZERS,
      "--format",
      "raw",
      "static",
      "--resources",
      documentPath,
      "--mime-types",
      SCAN_MIME_TYPES,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (error) {
  const stderr = String((error as { stderr?: string }).stderr ?? "");
  console.error(`[scan-skills] the scanner failed: ${stderr.trim() || String(error)}`);
  process.exit(1);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const report = parseScanReport(raw, targets);
const at = new Date().toISOString();
const recordPath = trustFilePath();
let record = readTrust(recordPath);
for (const entry of verdictEntries(report, at)) record = addTrustEntry(record, entry);
writeTrust(record, recordPath);

for (const verdict of report.verdicts) {
  const detail = [verdict.severity, verdict.threats.join(", ")].filter(Boolean).join(" — ");
  console.log(`[scan-skills] ${verdict.status}\t${verdict.skill.name}\t${detail}`);
}
if (report.unscanned.length > 0) {
  console.log(
    `[scan-skills] ${report.unscanned.length} file(s) were not in the report, so they are ` +
      "not cleared: " +
      report.unscanned.map((target) => target.file).join(", "),
  );
}
const blocked = report.verdicts.filter((verdict) => verdict.status === "blocked");
console.log(`[scan-skills] recorded ${report.verdicts.length} verdict(s) in ${recordPath}`);
if (blocked.length > 0) {
  console.error(`[scan-skills] ${blocked.length} skill(s) blocked — see the record`);
  process.exit(1);
}
