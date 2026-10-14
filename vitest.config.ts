import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vite 5.x does not recognize `node:sqlite` as a builtin and tries to resolve it
// as the bare package `sqlite`. Alias it to a runtime shim that loads the
// builtin via createRequire (resolved by Node, not Vite's bundler).
//
// CI runs Node 26 (the documented recommendation): `node:sqlite` is available
// without a flag there, so the shim always resolves.
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
      // gate, not an aspiration. Leaves headroom for Node/V8 environment
      // variance (local ~77.4%, CI ~76.9%). Raise as coverage improves.
      thresholds: { statements: 76, branches: 73, functions: 73, lines: 76 },
    },
  },
});
