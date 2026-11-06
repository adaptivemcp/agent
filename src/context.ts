/**
 * Context assembly: one place where "what the model sees this turn" is chosen,
 * ordered, counted and attributed.
 *
 * Before this, the system prompt was a string literal in `cli.ts` — sections
 * concatenated inline, nothing counted, nothing recorded why a section was there.
 * The literal was correct and its order was deliberate, but it was invisible, so
 * budgets, provenance and measurement had nowhere to attach.
 *
 * This is deliberately **not** a retrieval engine (ADR-005): it turns sections into
 * one string deterministically and reports what it did. Selection, representation
 * and retention are separate concerns that attach here later.
 */

/** Where a section comes from, for `/context` and for a run record to read back. */
export type ContextKind =
  | "base"
  | "mode"
  | "server-instructions"
  | "skills"
  | "resources"
  | "tasks";

export interface ContextSection {
  /** Stable id, so a test or a report can name one section. */
  id: string;
  kind: ContextKind;
  /** Where it came from, in the operator's words (a flag, a file, a server). */
  source: string;
  text: string;
  /** Higher comes first; ties keep declaration order. */
  priority: number;
  /** Why it is in the prompt at all. */
  reason: string;
}

/** What went in, in the order it appears. */
export interface AssembledSection {
  id: string;
  kind: ContextKind;
  source: string;
  /** Estimated tokens for this section. */
  tokens: number;
  reason: string;
}

/**
 * A cap on what the host will spend on context.
 *
 * `total` is the whole prompt; `perKind` caps one source. Both are estimates, like
 * every other number here.
 */
export interface ContextBudget {
  total?: number;
  perKind?: Partial<Record<ContextKind, number>>;
}

/** A section the budget removed, and which cap removed it. */
export interface DroppedSection {
  id: string;
  kind: ContextKind;
  tokens: number;
  reason: "kind-budget" | "total-budget";
}

export interface AssembledContext {
  /** The prompt text: the kept sections joined by a blank line. */
  text: string;
  /** Estimated tokens for the whole prompt (not the sum of rounded parts). */
  tokens: number;
  sections: AssembledSection[];
  /** Sections the budget removed, in the order they were dropped. */
  dropped: DroppedSection[];
  budget?: ContextBudget;
}

/**
 * A token estimate — roughly four characters per token for English prose.
 *
 * It is an estimate and is labelled as one wherever it is printed. Real usage only
 * exists after the provider reports it (`ChatUsage`), and conflating the two would
 * make a budget look precise when it is a heuristic.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Assemble the prompt from sections.
 *
 * Empty sections are dropped. Order is `priority` descending; equal priorities keep
 * declaration order, so a caller can insert a section without renumbering the rest.
 *
 * With a budget, sections are removed **whole**, lowest priority first: a per-kind cap
 * trims the tail of that kind, then the total trims the tail of what is left. A
 * section is never truncated mid-way — half a skill is worse than none, because the
 * model cannot tell that it is reading a fragment. Everything removed is reported.
 */
export function assembleContext(
  sections: ContextSection[],
  options: { budget?: ContextBudget } = {},
): AssembledContext {
  const ordered = sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => section.text !== "")
    .sort((a, b) => b.section.priority - a.section.priority || a.index - b.index)
    .map(({ section }) => section);

  const budget = options.budget;
  const removed = new Set<ContextSection>();
  const dropped: DroppedSection[] = [];
  const cost = (section: ContextSection): number => estimateTokens(section.text);
  const drop = (section: ContextSection, reason: DroppedSection["reason"]): void => {
    removed.add(section);
    dropped.push({ id: section.id, kind: section.kind, tokens: cost(section), reason });
  };

  for (const [kind, cap] of Object.entries(budget?.perKind ?? {})) {
    if (cap === undefined) continue;
    // Whole sections only, and the cap is measured on the joined text so it matches
    // the total the summary prints (separators included).
    let members = ordered.filter((section) => section.kind === kind && !removed.has(section));
    while (members.length > 0 && estimateTokens(members.map((s) => s.text).join("\n\n")) > cap) {
      const section = members[members.length - 1]!;
      drop(section, "kind-budget");
      members = members.slice(0, -1);
    }
  }

  if (budget?.total !== undefined) {
    let kept = ordered.filter((section) => !removed.has(section));
    while (kept.length > 0 && estimateTokens(kept.map((s) => s.text).join("\n\n")) > budget.total) {
      const section = kept[kept.length - 1]!;
      drop(section, "total-budget");
      kept = kept.slice(0, -1);
    }
  }

  const kept = ordered.filter((section) => !removed.has(section));
  const text = kept.map((section) => section.text).join("\n\n");
  return {
    text,
    tokens: estimateTokens(text),
    sections: kept.map((section) => ({
      id: section.id,
      kind: section.kind,
      source: section.source,
      tokens: estimateTokens(section.text),
      reason: section.reason,
    })),
    dropped,
    ...(budget ? { budget } : {}),
  };
}

/**
 * The run-summary suffix: the total, per-kind spend, and what a budget did.
 *
 * `context=153tok(est) context_kinds=base:17,skills:60` is the shape; a budget adds
 * `context_budget=200`, and anything it removed adds `context_dropped=1`. All of it
 * is an estimate — usage only exists after the provider reports it.
 */
export function contextSummary(context: AssembledContext): string {
  if (context.sections.length === 0 && context.dropped.length === 0) return "";
  const kinds = new Map<ContextKind, number>();
  for (const section of context.sections) {
    kinds.set(section.kind, (kinds.get(section.kind) ?? 0) + section.tokens);
  }
  const parts = [` context=${context.tokens}tok(est)`];
  if (kinds.size > 0) {
    parts.push(
      ` context_kinds=${[...kinds.entries()].map(([kind, tokens]) => `${kind}:${tokens}`).join(",")}`,
    );
  }
  if (context.budget?.total !== undefined) parts.push(` context_budget=${context.budget.total}`);
  if (context.dropped.length > 0) parts.push(` context_dropped=${context.dropped.length}`);
  return parts.join("");
}

