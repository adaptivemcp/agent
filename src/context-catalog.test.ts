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

  it("says so when there is nothing to list", () => {
    const empty: ContextItem[] = [];
    expect(formatContextCatalog(empty)).toBe("[context] nothing discovered");
  });
});
