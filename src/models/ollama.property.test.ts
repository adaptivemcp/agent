import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ollamaId } from "./ollama.js";

describe("ollamaId (property)", () => {
  it("produces a stable, safe catalog id for any model name", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const id = ollamaId(name);
        expect(id.startsWith("ollama-")).toBe(true);
        // The remainder is a lowercase slug: no uppercase, spaces, or symbols.
        expect(id.slice("ollama-".length)).toMatch(/^[a-z0-9-]*$/);
        // Deterministic.
        expect(ollamaId(name)).toBe(id);
      }),
    );
  });
});
