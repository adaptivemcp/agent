import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vite 5.x does not recognize `node:sqlite` as a builtin and tries to resolve it
// as the bare package `sqlite`. Alias it to a runtime shim that loads the
// builtin via createRequire (resolved by Node, not Vite's bundler).
export default defineConfig({
  resolve: {
    alias: {
      "node:sqlite": fileURLToPath(new URL("./vitest.sqlite-shim.mjs", import.meta.url)),
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
