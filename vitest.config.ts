import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const siblingPackages = fileURLToPath(new URL("../adaptive-mcp/packages", import.meta.url));

// Resolve every sibling `@adaptivemcp/*` package to its TypeScript source. The
// packages are consumed via `link:` and would otherwise resolve to their built
// `dist/`, which imports `node:sqlite`; Vite externalizes `node:` builtins from
// node_modules and bypasses the alias below. Testing against source means the
// alias applies (and matches how the adaptive-mcp repo tests its own packages).
const workspaceAliases = existsSync(siblingPackages)
  ? Object.fromEntries(
      readdirSync(siblingPackages)
        .filter((name) => existsSync(join(siblingPackages, name, "src", "index.ts")))
        .map((name) => [`@adaptivemcp/${name}`, join(siblingPackages, name, "src", "index.ts")]),
    )
  : {};

// Vite 5.x does not recognize `node:sqlite` as a builtin and tries to resolve it
// as the bare package `sqlite`. Alias it to a runtime shim that loads the
// builtin via createRequire (resolved by Node, not Vite's bundler).
export default defineConfig({
  resolve: {
    alias: {
      "node:sqlite": fileURLToPath(new URL("./vitest.sqlite-shim.mjs", import.meta.url)),
      ...workspaceAliases,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    reporters: ["dot"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "**/dist/**",
        // Type-only modules.
        "src/types.ts",
        "src/models/types.ts",
        // Process/IO entry points, exercised via the CLI/REPL and the
        // integration tests rather than unit tests.
        "src/cli.ts",
        "src/repl.ts",
      ],
      // Ratcheted just below the current aggregate (2026-10-14): a regression
      // gate, not an aspiration. Raise as coverage improves.
      thresholds: { statements: 77, branches: 73, functions: 73, lines: 77 },
    },
  },
});
