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
  const files = [join(REPO, "README.md"), join(REPO, "AGENTS.md")];
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
});
