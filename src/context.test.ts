import { describe, it, expect } from "vitest";
import {
  assembleContext,
  contextSummary,
  estimateTokens,
  type ContextSection,
} from "./context.js";

function section(overrides: Partial<ContextSection> & { id: string }): ContextSection {
  return {
    kind: "base",
    source: "test",
    text: "text",
    priority: 0,
    reason: "because",
    ...overrides,
  };
}

describe("context assembly", () => {
  it("estimates about four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });

  it("orders by priority, keeping declaration order for ties", () => {
    const context = assembleContext([
      section({ id: "third", priority: 10, text: "c" }),
      section({ id: "first", priority: 30, text: "a" }),
      section({ id: "second", priority: 10, text: "b" }),
    ]);

    expect(context.sections.map((entry) => entry.id)).toEqual(["first", "third", "second"]);
    expect(context.text).toBe("a\n\nc\n\nb");
  });

  it("drops empty sections instead of leaving blank separators", () => {
    const context = assembleContext([
      section({ id: "kept", text: "hello" }),
      section({ id: "empty", text: "" }),
    ]);

    expect(context.text).toBe("hello");
    expect(context.sections.map((entry) => entry.id)).toEqual(["kept"]);
  });

  it("reports provenance and per-section cost in the order it appears", () => {
    const context = assembleContext([
      section({
        id: "skills",
        kind: "skills",
        source: "3 skill(s)",
        text: "x".repeat(40),
        priority: 70,
        reason: "names and descriptions only",
      }),
      section({ id: "base", kind: "base", source: "built-in", text: "y".repeat(8), priority: 100 }),
    ]);

    expect(context.sections).toEqual([
      { id: "base", kind: "base", source: "built-in", tokens: 2, reason: "because" },
      {
        id: "skills",
        kind: "skills",
        source: "3 skill(s)",
        tokens: 10,
        reason: "names and descriptions only",
      },
    ]);
  });

  it("accounts for the separators in the total, not just the parts", () => {
    const context = assembleContext([
      section({ id: "a", text: "12345678" }),
      section({ id: "b", text: "12345678" }),
    ]);

    // 8 + 2 (blank line) + 8 = 18 characters → 5 tokens, not 2 + 2.
    expect(context.tokens).toBe(5);
    expect(context.sections.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(4);
  });

  it("summarises an estimated total, and says nothing for an empty prompt", () => {
    expect(contextSummary(assembleContext([section({ id: "a", text: "x".repeat(40) })]))).toBe(
      " context=10tok(est)",
    );
    expect(contextSummary(assembleContext([]))).toBe("");
  });
});
