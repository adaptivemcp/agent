import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Documentation guards.
 *
 * The docs cite concrete files constantly — `src/runtime.ts`,
 * `docs/archetypes/components.md`, and a catalogue of reference-clone paths — and
 * a citation that has drifted is worse than none, because it reads as verified.
 * Two cheap static checks keep the *in-repo* ones honest:
 *
 * 1. every relative markdown link resolves;
 * 2. every inline-code path rooted at `src/`, `docs/` or `examples/` exists.
 *
 * Paths into the read-only reference clones (`opencode/…`, `agno/…`, …) are
 * deliberately **not** checked: they are not part of this repo and are absent in
 * CI, so checking them would fail on a clean checkout rather than catch drift.
 */
const REPO = fileURLToPath(new URL("..", import.meta.url));

function markdownFiles(): string[] {
  const files = [join(REPO, "README.md"), join(REPO, "AGENTS.md"), join(REPO, "SECURITY.md")];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        files.push(full);
      }
    }
  };
  walk(join(REPO, "docs"));
  return files;
}

/** `[label](target)` — target only. */
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
/** Inline code that looks like an in-repo path. */
const INLINE_PATH = /`((?:src|docs|examples)\/[\w./-]+)`/g;

describe("documentation guards", () => {
  const files = markdownFiles();

  it("has docs to check (guards against a silent glob failure)", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it("every relative markdown link resolves", () => {
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(LINK)) {
        const target = match[1];
        if (target === undefined) continue;
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const resolved = resolve(dirname(file), target.split("#")[0] ?? target);
        if (!existsSync(resolved)) {
          broken.push(`${file.slice(REPO.length)} -> ${target}`);
        }
      }
    }
    expect(broken, `broken links:\n${broken.join("\n")}`).toEqual([]);
  });

  it("every in-repo path cited in inline code exists", () => {
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(INLINE_PATH)) {
        const path = match[1];
        if (path === undefined) continue;
        if (!existsSync(join(REPO, path))) {
          missing.push(`${file.slice(REPO.length)} cites \`${path}\``);
        }
      }
    }
    expect(missing, `cited paths that do not exist:\n${missing.join("\n")}`).toEqual([]);
  });

  /**
   * A doc that says "we do not run X" while CI runs X is worse than no doc: it reads as
   * a deliberate, verified limitation. These three checks bind the prose to the code it
   * describes, which is the drift the path/link guards cannot see.
   */
  it("the conformance claim in docs/sdk-tiers.md matches the CI workflow", () => {
    const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    const tiers = readFileSync(join(REPO, "docs/sdk-tiers.md"), "utf8");
    const runsHarness =
      /^\s{2}conformance-client:/m.test(ci) && /@modelcontextprotocol\/conformance@/.test(ci);
    if (!runsHarness) return;

    // The job must actually have an adapter to drive, and the doc must point at both.
    expect(existsSync(join(REPO, "scripts/conformance-client.mjs"))).toBe(true);
    expect(tiers).toContain("conformance-client");
    expect(tiers).not.toContain("We do not run");
    // AGENTS.md summarised the gaps too; the conformance item is no longer one of them.
    expect(readFileSync(join(REPO, "AGENTS.md"), "utf8")).not.toContain("no conformance run");

    // The gate and the prose must agree: a job that fails the build cannot be described
    // as advisory, and an advisory job must not be sold as a gate.
    const job = ci.slice(ci.indexOf("conformance-client:"));
    const isAdvisory = /continue-on-error:\s*true/.test(job.slice(0, 600));
    const prose = readFileSync(join(REPO, "docs/conformance-client.md"), "utf8");
    if (isAdvisory) {
      expect(prose).toContain("advisory");
    } else {
      expect(prose).toContain("**blocking**");
      expect(prose).not.toContain("continue-on-error: true");
    }
  });

  it("the security and roadmap claims match the files that exist", () => {
    // Same failure mode as the conformance row: a doc saying "there is no SECURITY.md"
    // after one lands reads as a deliberate, verified gap.
    const tiers = readFileSync(join(REPO, "docs/sdk-tiers.md"), "utf8");
    const security = join(REPO, "SECURITY.md");
    const roadmap = join(REPO, "docs", "roadmap.md");

    expect(existsSync(security), "SECURITY.md must exist").toBe(true);
    expect(existsSync(roadmap), "docs/roadmap.md must exist").toBe(true);

    // Both are reachable from the docs a reader actually starts at.
    expect(readFileSync(join(REPO, "README.md"), "utf8")).toContain("SECURITY.md");
    expect(readFileSync(join(REPO, "README.md"), "utf8")).toContain("docs/roadmap.md");

    expect(tiers).not.toContain("There is no `SECURITY.md`");
    expect(tiers).not.toContain("No roadmap document");
    expect(tiers).toContain("docs/roadmap.md");
    expect(readFileSync(security, "utf8")).toContain("Report a vulnerability");
  });

  it("the auth scenario is documented as passing, and CI runs it with --auth", () => {
    // The OAuth flow is easy to regress silently: without `--auth` the scenario still
    // runs but the client never reads its 401 challenge, so it would fail loudly — but the
    // docs would keep claiming a flow that is no longer exercised.
    const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    const docs = readFileSync(join(REPO, "docs/conformance-client.md"), "utf8");
    if (!docs.includes("auth/metadata-default")) return;

    expect(ci).toContain("--scenario auth/metadata-default");
    expect(ci).toContain("conformance-client.mjs --auth");
    // The docs table says all four metadata shapes pass, so CI must run all four.
    for (const variant of ["var1", "var2", "var3"]) {
      expect(ci, `CI must run auth/metadata-${variant}`).toContain(`auth/metadata-${variant}`);
    }
    // Every auth scenario the docs claim must actually be in the workflow.
    for (const scenario of [
      "auth/resource-mismatch",
      "auth/token-endpoint-auth-basic",
      "auth/token-endpoint-auth-post",
      "auth/token-endpoint-auth-none",
      "auth/scope-step-up",
    ]) {
      expect(ci, `CI must run ${scenario}`).toContain(scenario);
    }
    // A baseline that is no longer needed is dead config; the file is gone.
    expect(existsSync(join(REPO, "conformance-client-baseline.yml"))).toBe(false);
  });

  it("the SDK version quoted in docs/sdk-tiers.md is the one we depend on", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const sdk = pkg.dependencies["@modelcontextprotocol/sdk"];
    const tiers = readFileSync(join(REPO, "docs/sdk-tiers.md"), "utf8");

    expect(sdk, "the SDK must be a declared dependency").toBeDefined();
    expect(tiers, `docs/sdk-tiers.md must quote ${String(sdk)}`).toContain(String(sdk));
  });

  it("no doc claims stdio is the only transport while an HTTP client exists", () => {
    // The rule used to be true and is easy to copy forward. `HttpToolset` is real
    // (`src/mcp/http.ts`, `--server` JSON with a `url`), so the claim is now wrong.
    if (!existsSync(join(REPO, "src/mcp/http.ts"))) return;

    const offenders = files.filter((file) => /stdio MCP only/i.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => file.slice(REPO.length))).toEqual([]);
  });
});
