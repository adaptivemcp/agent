/**
 * The context catalog: what the agent *could* know, and what it currently costs.
 *
 * This is the observability half of ADR-005, not a retrieval engine. It answers
 * "what is available, where did it come from, how big is it, and is any of it in the
 * prompt right now?" — over the sources the host already has: assembled prompt
 * sections, skills, MCP resources and tools.
 *
 * State is deliberately narrow: `loaded` means the text is in the system prompt
 * (sections), `discovered` means the host knows about it but only a pointer or
 * nothing is in the prompt. Per-item load tracking (a skill read at step 4, a
 * resource fetched at step 7) needs context telemetry and is P1; claiming it here
 * would be a lie the listing cannot keep current.
 */
import { estimateTokens, type AssembledSection } from "./context.js";
import type { Skill } from "./skills.js";
import type { ToolSpec } from "./types.js";

export type ContextItemKind = "section" | "skill" | "resource" | "tool";
export type ContextItemState = "loaded" | "discovered" | "dropped";

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  name: string;
  /** Where it came from, in the operator's words. */
  source: string;
  state: ContextItemState;
  /** Estimated tokens it costs in the prompt right now; `0` when it costs none. */
  tokens: number;
}

export interface ContextCatalogInput {
  /** The sections that were actually assembled into the prompt. */
  sections: AssembledSection[];
  /**
   * Sections a budget removed. They cost nothing now, so their `tokens` is `0`, but
   * omitting them entirely would make a budget look like the sections never existed —
   * an operator needs to see what the cap took away.
   */
  dropped?: Array<{ id: string; kind: string; tokens: number; reason: string }>;
  skills: Skill[];
  resources: Array<{ uri: string; name?: string; serverName?: string }>;
  tools: ToolSpec[];
}

/**
 * Build the catalog in a stable order: sections as they appear in the prompt, then
 * each source alphabetically. Stable because a listing that reshuffles between runs
 * is hard to diff and impossible to read.
 */
export function buildContextCatalog(input: ContextCatalogInput): ContextItem[] {
  const sections: ContextItem[] = input.sections.map((section) => ({
    id: `section:${section.id}`,
    kind: "section",
    name: section.id,
    source: section.source,
    state: "loaded",
    tokens: section.tokens,
  }));

  // Dropped sections come after the loaded ones: what the prompt carries first, then
  // what the budget took away and why.
  const dropped: ContextItem[] = (input.dropped ?? []).map((section) => ({
    id: `section:${section.id}`,
    kind: "section",
    name: section.id,
    source: section.reason === "total-budget" ? "dropped: total budget" : "dropped: kind budget",
    state: "dropped",
    tokens: 0,
  }));

  const skills: ContextItem[] = input.skills.map((skill) => ({
    id: `skill:${skill.name}`,
    kind: "skill",
    name: skill.name,
    // The level the skill came from (project/user) is what makes a name local or not.
    source: `${skill.origin} (${skill.dir})`,
    state: "discovered",
    // Its name + description *are* in the prompt — the body is not.
    tokens: estimateTokens(`- ${skill.name}: ${skill.description}`),
  }));

  const resources: ContextItem[] = input.resources.map((resource) => ({
    id: `resource:${resource.uri}`,
    kind: "resource",
    name: resource.name ?? resource.uri,
    source: resource.serverName ?? resource.uri,
    state: "discovered",
    // Nothing about a resource is in the prompt until it is read.
    tokens: 0,
  }));

  const tools: ContextItem[] = input.tools.map((tool) => ({
    id: `tool:${tool.name}`,
    kind: "tool",
    name: tool.name,
    source: tool.serverName ?? "in-process",
    state: "discovered",
    // Tool descriptions ride in the request's tool list, not the system prompt, so
    // they are not counted here — the summary's estimate is prompt-only.
    tokens: 0,
  }));

  const byName = (a: ContextItem, b: ContextItem): number => a.name.localeCompare(b.name);
  return [
    ...sections,
    ...dropped,
    ...skills.sort(byName),
    ...resources.sort(byName),
    ...tools.sort(byName),
  ];
}

/** Total estimated prompt cost of the items that are actually loaded. */
export function loadedContextTokens(items: ContextItem[]): number {
  return items
    .filter((item) => item.state === "loaded")
    .reduce((sum, item) => sum + item.tokens, 0);
}

/**
 * One line per item, tab-separated like `/tools`: `state  kind  name  source  cost`.
 * The footer totals what is actually loaded, which is the number a budget can act on,
 * and names anything the budget removed so a cap is never silent.
 *
 * `summary` appends the run summary's own line (`context=… context_kinds=…`), so the
 * interactive view and the one-shot summary describe the same prompt instead of two
 * near-identical ones.
 */
export function formatContextCatalog(
  items: ContextItem[],
  options: {
    summary?: string;
    /** Recorded load counts, when the store can report them (ADR-005 P1). */
    loads?: ReadonlyMap<string, number>;
  } = {},
): string {
  if (items.length === 0) return "[context] nothing discovered";
  const { loads } = options;
  const row = (item: ContextItem): string => {
    const cells = [item.state, item.kind, item.name, item.source, `${item.tokens}tok(est)`];
    // An item the store has never seen reports 0 rather than being omitted: "never
    // loaded" is information, and a missing column would be indistinguishable from a
    // build that does not record loads at all.
    if (loads) cells.push(String(loads.get(item.name) ?? 0));
    return cells.join("\t");
  };
  const lines: string[] = [];
  if (loads) lines.push(["state", "kind", "name", "source", "cost", "loads"].join("\t"));
  lines.push(...items.map(row));
  const loaded = items.filter((item) => item.state === "loaded");
  const dropped = items.filter((item) => item.state === "dropped").length;
  lines.push(
    `[context] ${items.length} item(s); ${loaded.length} loaded, ~${loadedContextTokens(items)}tok(est) in the prompt` +
      (dropped > 0 ? `; ${dropped} dropped by budget` : ""),
  );
  if (options.summary) lines.push(`[context] ${options.summary}`);
  return lines.join("\n");
}
