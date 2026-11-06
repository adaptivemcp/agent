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
export type ContextKind = "base" | "mode" | "server-instructions" | "skills" | "tasks";

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

export interface AssembledContext {
  /** The prompt text: the sections joined by a blank line. */
  text: string;
  /** Estimated tokens for the whole prompt (not the sum of rounded parts). */
  tokens: number;
  sections: AssembledSection[];
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
 */
export function assembleContext(sections: ContextSection[]): AssembledContext {
  const ordered = sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => section.text !== "")
    .sort((a, b) => b.section.priority - a.section.priority || a.index - b.index)
    .map(({ section }) => section);

  const text = ordered.map((section) => section.text).join("\n\n");
  return {
    text,
    tokens: estimateTokens(text),
    sections: ordered.map((section) => ({
      id: section.id,
      kind: section.kind,
      source: section.source,
      tokens: estimateTokens(section.text),
      reason: section.reason,
    })),
  };
}

/** The run-summary suffix — ` context=1234tok(est)` — or `""` for an empty prompt. */
export function contextSummary(context: AssembledContext): string {
  return context.tokens > 0 ? ` context=${context.tokens}tok(est)` : "";
}
