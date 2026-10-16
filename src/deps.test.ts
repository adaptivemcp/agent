import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dependency-graph guard.
 *
 * This package is published, so the two failure modes are consumer-visible:
 * an import of an undeclared package resolves locally (hoisted `node_modules`)
 * and then fails for whoever installs us; and a declared-but-unused dependency
 * pins a version we do not actually need, growing every consumer's tree.
 *
 * Both directions are checked across `src/` **and** `examples/` (tests included —
 * excluding tests once hid six real dependencies in the sibling repo).
 */
const REPO = fileURLToPath(new URL("..", import.meta.url));

/** `from "x"`, `import("x")`, `require("x")`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)"([^\s"]+)"/g;

/** Drop comments so prose cannot look like an import. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

function* typescriptFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* typescriptFiles(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function isIgnorable(specifier: string): boolean {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.includes("://")
  );
}

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
/** What a consumer installs — anything here must actually be imported. */
const runtimeDeps = new Set(Object.keys(pkg.dependencies ?? {}));
/** Everything we declare; an import may resolve to either. */
const declared = new Set([...runtimeDeps, ...Object.keys(pkg.devDependencies ?? {})]);

const importedBy = new Map<string, Set<string>>();
for (const dir of ["src", "examples"]) {
  for (const file of typescriptFiles(join(REPO, dir))) {
    for (const match of stripComments(readFileSync(file, "utf8")).matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined || isIgnorable(specifier)) continue;
      const name = packageOf(specifier);
      importedBy.set(name, (importedBy.get(name) ?? new Set()).add(file.slice(REPO.length)));
    }
  }
}
const imported = new Set(importedBy.keys());

describe("dependency graph", () => {
  it("found imports to check (guards against a silent walk failure)", () => {
    expect(imported.size).toBeGreaterThan(5);
  });

  it("declares every package it imports", () => {
    const undeclared = [...imported].filter((name) => !declared.has(name)).sort();
    expect(undeclared, `imported but not declared: ${undeclared.join(", ")}`).toEqual([]);
  });

  it("imports every runtime dependency it declares", () => {
    // devDependencies are tools (tsc, eslint, vitest) invoked from scripts, not
    // imported — only a runtime dep that nothing imports is a real problem: it
    // pins a version every consumer installs for no reason.
    const unused = [...runtimeDeps].filter((name) => !imported.has(name)).sort();
    expect(unused, `runtime deps declared but never imported: ${unused.join(", ")}`).toEqual([]);
  });
});
