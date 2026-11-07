import { describe, it, expect } from "vitest";
import {
  buildContextCatalog,
  formatContextCatalog,
  loadedContextTokens,
  type ContextItem,
} from "./context-catalog.js";
import type { Skill } from "./skills.js";

function skill(name: string, description: string): Skill {
  return {
    name,
    description,
    dir: `/skills/${name}`,
    origin: "project",
    files: [],
  };
}

function catalogInput(overrides: Partial<Parameters<typeof buildContextCatalog>[0]> = {}) {
  return buildContextCatalog({
    sections: [
      { id: "base", kind: "base", source: "built-in", tokens: 12, reason: "role" },
      { id: "skills", kind: "skills", source: "2 skill(s)", tokens: 30, reason: "listing" },
    ],
    skills: [skill("deploy", "Ship a service"), skill("audit", "Audit a repo")],
    resources: [{ uri: "file:///notes.md", name: "notes", serverName: "fixture" }],
    tools: [{ name: "fixture_echo", serverName: "fixture", inputSchema: { type: "object" } }],
    ...overrides,
  });
}

describe("context catalog", () => {
  it("keeps sections in prompt order, then sorts each source by name", () => {
    const items = catalogInput();

    expect(items.map((item) => `${item.kind}:${item.name}`)).toEqual([
      "section:base",
      "section:skills",
      "skill:audit",
      "skill:deploy",
      "resource:notes",
      "tool:fixture_echo",
    ]);
  });

  it("marks sections loaded and everything else discovered", () => {
    const items = catalogInput();

    expect(items.filter((item) => item.state === "loaded").map((item) => item.name)).toEqual([
      "base",
      "skills",
    ]);
    expect(items.filter((item) => item.state === "discovered")).toHaveLength(4);
  });

  it("counts a skill's listing line, but not its body or an unread resource", () => {
    const items = catalogInput();
    const skillItem = items.find((item) => item.name === "deploy")!;
    const resourceItem = items.find((item) => item.name === "notes")!;

    // `- deploy: Ship a service` = 23 characters → 6 tokens (ceil).
    expect(skillItem.tokens).toBe(6);
    expect(resourceItem.tokens).toBe(0);
    expect(items.find((item) => item.name === "fixture_echo")?.tokens).toBe(0);
  });

  it("records where a skill came from, including its level", () => {
    const deploy = catalogInput().find((item) => item.name === "deploy")!;

    expect(deploy.source).toBe("project (/skills/deploy)");
  });

  it("totals only what is actually loaded", () => {
    // 12 + 30 from the sections; the skill listing lines are already inside the
    // skills section, so counting them again would double-count the prompt.
    expect(loadedContextTokens(catalogInput())).toBe(42);
  });

  it("formats tab-separated rows and a loaded-only footer", () => {
    const text = formatContextCatalog(catalogInput());

    expect(text).toContain("loaded\tsection\tbase\tbuilt-in\t12tok(est)");
    expect(text).toContain("discovered\tskill\tdeploy\tproject (/skills/deploy)\t6tok(est)");
    expect(text).toContain("[context] 6 item(s); 2 loaded, ~42tok(est) in the prompt");
  });

  it("shows what a budget removed, and why, after the loaded sections", () => {
    const items = catalogInput({
      dropped: [
        { id: "tasks", kind: "tasks", tokens: 40, reason: "total-budget" },
        { id: "skills", kind: "skills", tokens: 30, reason: "kind-budget" },
      ],
    });

    const dropped = items.filter((item) => item.state === "dropped");

    expect(dropped.map((item) => item.name)).toEqual(["tasks", "skills"]);
    // A dropped section costs nothing now — reporting its old cost would double-count.
    expect(dropped.every((item) => item.tokens === 0)).toBe(true);
    expect(dropped[0]?.source).toBe("dropped: total budget");
    expect(dropped[1]?.source).toBe("dropped: kind budget");
    // And the footer says how many, so a cap is never silent.
    expect(formatContextCatalog(items)).toContain("2 dropped by budget");
  });

  it("says nothing about drops when the budget removed nothing", () => {
    expect(formatContextCatalog(catalogInput())).not.toContain("dropped by budget");
  });

  it("echoes the run summary's own numbers when given them", () => {
    const text = formatContextCatalog(catalogInput(), {
      summary: "context=42tok(est) context_kinds=base:12,skills:30",
    });

    expect(text).toContain("[context] context=42tok(est) context_kinds=base:12,skills:30");
    // The catalog footer still comes first, so the listing is unchanged for readers
    // that never pass a summary.
    expect(text.indexOf("item(s)")).toBeLessThan(text.indexOf("context_kinds"));
  });

  it("adds a loads column when the store reports load counts", () => {
    const text = formatContextCatalog(catalogInput(), {
      loads: new Map([
        ["base", 3],
        ["deploy", 1],
      ]),
    });

    expect(text.split("\n")[0]).toBe("state\tkind\tname\tsource\tcost\tloads");
    // A section that is in the prompt and has been loaded before.
    expect(text).toContain("loaded\tsection\tbase\tbuilt-in\t12tok(est)\t3");
    // A discovered skill the store has seen once.
    expect(text).toContain("discovered\tskill\tdeploy\tproject (/skills/deploy)\t6tok(est)\t1");
    // Never loaded is reported honestly as zero, not omitted.
    expect(text).toContain("discovered\tskill\taudit\tproject (/skills/audit)\t6tok(est)\t0");
  });

  it("omits the column entirely without load counts, so old output is unchanged", () => {
    const text = formatContextCatalog(catalogInput());

    expect(text).not.toContain("loads");
    expect(text.split("\n")[0]).not.toContain("state\tkind");
  });

  it("says so when there is nothing to list", () => {
    const empty: ContextItem[] = [];
    expect(formatContextCatalog(empty)).toBe("[context] nothing discovered");
  });
});
