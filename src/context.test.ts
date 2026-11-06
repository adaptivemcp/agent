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

  it("summarises the total, per-kind spend and the budget", () => {
    const context = assembleContext(
      [
        section({ id: "base", kind: "base", text: "a".repeat(8), priority: 100 }),
        section({ id: "skills", kind: "skills", text: "b".repeat(40), priority: 70 }),
      ],
      { budget: { total: 100 } },
    );

    expect(contextSummary(context)).toBe(
      " context=13tok(est) context_kinds=base:2,skills:10 context_budget=100",
    );
    expect(contextSummary(assembleContext([]))).toBe("");
  });

  it("drops the lowest-priority sections of a kind until it fits its cap", () => {
    const context = assembleContext(
      [
        section({ id: "base", kind: "base", text: "z".repeat(8), priority: 100 }),
        section({ id: "s1", kind: "skills", text: "x".repeat(40), priority: 70 }),
        section({ id: "s2", kind: "skills", text: "y".repeat(40), priority: 70 }),
      ],
      { budget: { perKind: { skills: 12 } } },
    );

    // Both skill sections together are 82 characters (~21 tokens); one fits.
    expect(context.sections.map((entry) => entry.id)).toEqual(["base", "s1"]);
    expect(context.dropped).toEqual([
      { id: "s2", kind: "skills", tokens: 10, reason: "kind-budget" },
    ]);
    expect(contextSummary(context)).toContain("context_dropped=1");
  });

  it("drops the lowest-priority section when the total is exceeded", () => {
    const context = assembleContext(
      [
        section({ id: "base", kind: "base", text: "a".repeat(40), priority: 100 }),
        section({ id: "skills", kind: "skills", text: "c".repeat(40), priority: 70 }),
        section({ id: "tasks", kind: "tasks", text: "b".repeat(40), priority: 60 }),
      ],
      { budget: { total: 25 } },
    );

    // All three are ~31 tokens; dropping the lowest priority (tasks) leaves ~21.
    expect(context.sections.map((entry) => entry.id)).toEqual(["base", "skills"]);
    expect(context.dropped).toEqual([
      { id: "tasks", kind: "tasks", tokens: 10, reason: "total-budget" },
    ]);
    expect(context.tokens).toBeLessThanOrEqual(25);
  });

  it("drops a section that cannot fit the whole budget, rather than truncating it", () => {
    // Half a skill is worse than none: the model cannot tell it is reading a fragment.
    const context = assembleContext([section({ id: "base", text: "x".repeat(400) })], {
      budget: { total: 10 },
    });

    expect(context.sections).toEqual([]);
    expect(context.text).toBe("");
    expect(context.dropped).toEqual([{ id: "base", kind: "base", tokens: 100, reason: "total-budget" }]);
    expect(contextSummary(context)).toBe(
      " context=0tok(est) context_budget=10 context_dropped=1",
    );
  });

  it("removes nothing when no budget is set", () => {
    const context = assembleContext([section({ id: "a" })]);

    expect(context.dropped).toEqual([]);
    expect(context.budget).toBeUndefined();
  });
});
