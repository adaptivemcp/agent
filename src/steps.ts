/**
 * Typed memory steps: the host's policy for what a run *planned* and what it
 * *did*.
 *
 * `spec` fixes the shapes — `Task`, `ActionStep`, `PlanStep`, one replayable
 * history — and `memory` persists them; deciding what counts as a step, how it is
 * worded, and when a new plan is produced is ours (ADR-004). This module is that
 * policy, in two halves:
 *
 * - `actionStep` turns one attempted tool call into an `ActionStep`. The runtime
 *   records one per call, so the history reads "what was done" in order. The step
 *   is the *intent-and-outcome* view, not a second copy of telemetry: the bodies
 *   stay in the execution graph and a host can tie the two with `correlationId`.
 * - `PlanningPass` is the configurable planning interval. **Off by default**; when
 *   on, the run plans before its first step and re-plans every N steps, reading the
 *   **recorded** state — the task list, the action steps, the previous plan —
 *   instead of re-deriving it from the conversation. Each plan is recorded as a
 *   `PlanStep` and injected for the step that follows, so a plan is something the
 *   run *has* rather than something it said once.
 *
 * Both are host policy that never fails a run. A planning pass that cannot produce
 * a plan reports why (`onError`) and lets the step proceed unplanned: a run that is
 * only asked to plan is still a run.
 */
import { randomUUID } from "node:crypto";
import type { ActionStep, PlanStep, StepRecord, Store, Task } from "@adaptivemcp/spec";
import type { ChatMessage, ChatModel, ToolExecutionResult } from "./types.js";

/** How much of a tool's error message a step keeps. Enough to act on, not a dump. */
const MAX_ERROR_CHARS = 200;

/** How many recorded steps a planning pass reads. A plan is a summary, not a log. */
const MAX_RECORDED_STEPS = 40;

/** The planning pass's instructions. Kept beside the parser that depends on them. */
export const PLANNING_PROMPT = [
  "You are the planning pass of a tool-using agent. You do not call tools and you do not do the",
  "work: you turn the goal and what the run has already recorded into a short plan.",
  "",
  'Reply with JSON only: {"steps": ["...", "..."], "reasoning": "one clause on why this plan"}.',
  "Two to eight steps, each a short imperative line naming the work (not tool syntax).",
  "If the recorded work already satisfies the goal, say so in one step.",
].join("\n");

/** Clip a value for a step summary: single line, bounded, never a transcript. */
function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= MAX_ERROR_CHARS ? oneLine : `${oneLine.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

/**
 * One attempted tool call, in the host's words.
 *
 * A gate block and a suspension are *not* failures — the tool never ran — so the
 * summary says what happened and `ActionStep.error` stays unset. That keeps the
 * distinction the gate already makes visible in the history too.
 */
export function actionSummary(
  tool: string,
  result: Pick<ToolExecutionResult, "ok" | "error" | "decision" | "executed" | "suspension">,
  durationMs?: number,
): string {
  if (result.suspension) return `${tool} → paused for approval (${result.suspension.id})`;
  if (result.executed === false) {
    return `${tool} → refused by the gate (${result.decision ?? "denied"})`;
  }
  if (result.ok) {
    return durationMs === undefined ? `${tool} → ok` : `${tool} → ok in ${durationMs}ms`;
  }
  return `${tool} → failed: ${clip(result.error ?? "unknown error")}`;
}

export interface ActionStepInput {
  sessionId: string;
  tool: string;
  result: ToolExecutionResult;
  durationMs?: number;
  /** The execution-graph node this call also recorded, when the host has one. */
  correlationId?: string;
  /** Overridable for tests; defaults to now. */
  createdAt?: string;
  /** Overridable for tests; defaults to a fresh id. */
  id?: string;
}

/** Build the `ActionStep` for one attempted call. */
export function actionStep(input: ActionStepInput): ActionStep {
  const step: ActionStep = {
    id: input.id ?? `act-${randomUUID()}`,
    sessionId: input.sessionId,
    kind: "action",
    summary: actionSummary(input.tool, input.result, input.durationMs),
    toolName: input.tool,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  // An error means the tool *ran and failed*. A block or a pause leaves it unset.
  if (input.result.executed !== false && !input.result.suspension && !input.result.ok) {
    step.error = clip(input.result.error ?? "unknown error");
  }
  if (input.durationMs !== undefined) step.durationMs = input.durationMs;
  if (input.correlationId) step.correlationId = input.correlationId;
  return step;
}

/**
 * Read a session's history back as prompt lines, oldest first.
 *
 * This is what makes an interval meaningful: the planning pass re-plans from what
 * was *recorded*, so a plan survives a restart and a summarized history costs a
 * bounded number of tokens however long the run got.
 */
export function recordedLines(records: StepRecord[]): string[] {
  return records.slice(-MAX_RECORDED_STEPS).map((record) => {
    if (record.kind === "task") {
      const task: Task = record;
      const who = task.assignee ? ` (${task.assignee})` : "";
      const result = task.result ? ` → ${task.result}` : "";
      return `- task ${task.id} [${task.status}] ${task.title}${who}${result}`;
    }
    if (record.kind === "action") return `- ${record.summary}`;
    return `- plan: ${record.steps.join("; ")}`;
  });
}

/** The messages a planning pass sends to the model. */
export function planningMessages(goal: string, lines: string[]): ChatMessage[] {
  return [
    { role: "system", content: PLANNING_PROMPT },
    {
      role: "user",
      content: [
        `Goal: ${goal || "(not stated)"}`,
        "",
        lines.length > 0
          ? `Recorded so far (oldest first):\n${lines.join("\n")}`
          : "Nothing has been recorded yet.",
      ].join("\n"),
    },
  ];
}

/** Strip a code fence, so a model that wraps its JSON in one is still understood. */
function stripFence(text: string): string {
  const fenced = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

/** A plan line without its bullet or number — models format lists either way. */
function cleanLine(line: string): string {
  return line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
}

function fromJson(text: string): { steps: string[]; reasoning?: string } | undefined {
  // The object may be the whole reply or embedded in a sentence; try both.
  const candidates = [text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as { steps?: unknown; reasoning?: unknown };
      if (!Array.isArray(record.steps)) continue;
      const steps = record.steps
        .filter((step): step is string => typeof step === "string")
        .map(cleanLine)
        .filter((step) => step.length > 0);
      if (steps.length === 0) continue;
      const result: { steps: string[]; reasoning?: string } = { steps };
      if (typeof record.reasoning === "string" && record.reasoning.trim().length > 0) {
        result.reasoning = record.reasoning.trim();
      }
      return result;
    } catch {
      // Not JSON: fall through to the line reader.
    }
  }
  return undefined;
}

/**
 * Read a model's answer as a plan.
 *
 * JSON is what the prompt asks for; a plain list is accepted because a model that
 * ignores the format is still trying to help. Anything unusable comes back with no
 * steps, and the caller skips the pass rather than recording an empty plan.
 */
export function parsePlan(text: string): { steps: string[]; reasoning?: string } {
  const cleaned = stripFence(text).trim();
  if (cleaned.length === 0) return { steps: [] };
  const json = fromJson(cleaned);
  if (json) return json;
  return {
    steps: cleaned
      .split("\n")
      .map(cleanLine)
      .filter((line) => line.length > 0),
  };
}

/** The message a plan is injected as, so the next step knows the plan is fresh. */
export function planMessage(plan: PlanStep, step: number): string {
  const why = plan.reasoning ? ` — ${plan.reasoning}` : "";
  return [
    `Plan (asked before step ${step + 1}${why}):`,
    ...plan.steps.map((text, index) => `${index + 1}. ${text}`),
    "Work to this plan, and re-plan if what you learn changes it.",
  ].join("\n");
}

/** The goal is the run's first user turn — the question the plan is for. */
export function goalOf(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  if (!first) return "";
  return typeof first.content === "string" ? first.content : "";
}

/**
 * A session's history for a human: one line per record, oldest first, with the
 * kind in its own column so a plan is not mistaken for a task or a call.
 *
 * The same read the planning pass uses (`getSteps`), rendered differently — the
 * point of typed records is that one history answers both.
 */
export function formatSteps(records: StepRecord[]): string {
  if (records.length === 0) return "(nothing recorded yet)";
  return records
    .map((record) => {
      const at = record.createdAt.slice(11, 19);
      if (record.kind === "task") {
        return `${at} task   ${record.id} [${record.status}] ${record.title}`;
      }
      if (record.kind === "action") return `${at} action ${record.summary}`;
      return `${at} plan   ${record.id}: ${record.steps.join("; ")}`;
    })
    .join("\n");
}

/** Why this plan was produced, from what the run had recorded at the time. */
export function planReasoning(step: number, records: StepRecord[]): string {
  const where = step === 0 ? "the initial plan" : `a re-plan at step ${step}`;
  const lastAction = [...records].reverse().find((record) => record.kind === "action");
  const failed = lastAction?.kind === "action" && lastAction.error ? lastAction.toolName : undefined;
  return failed ? `${where}, after ${failed} failed` : where;
}

export interface PlanningPassOptions {
  /** The model the plan is asked of. The run's own, unless a host passes another. */
  model: ChatModel;
  /** Read at call time: the runtime owns the store (as with the task tools). */
  store: () => Store | undefined;
  session: string;
  /** Plan before step 1, then before every `interval`-th step. Must be ≥ 1. */
  interval: number;
  /** A pass that produced no plan: reported, never fatal. */
  onError?: (error: unknown) => void;
}

/**
 * The configurable planning pass: plan, then re-plan on an interval, from the
 * recorded state.
 *
 * It is used as the loop's `steer` hook, so a plan reaches the model as a turn it
 * can act on — and, because it is recorded first, the next pass reads it back.
 */
export class PlanningPass {
  constructor(private readonly options: PlanningPassOptions) {}

  /**
   * Plan when it is due, record the plan, and return it for injection.
   *
   * Returns `undefined` — leaving the run exactly as it was — when it is not due,
   * when there is no store to record in, or when the pass produced nothing usable.
   */
  steer = async (context: { step: number; messages: ChatMessage[] }): Promise<string | undefined> => {
    const { interval } = this.options;
    if (interval < 1) return undefined;
    if (context.step !== 0 && context.step % interval !== 0) return undefined;
    const store = this.options.store();
    // No store means no recorded state to plan from and nowhere to record the
    // plan, so the pass is skipped rather than run blind.
    if (!store) return undefined;

    const records = store.getSteps?.(this.options.session) ?? [];
    let answer: string;
    try {
      const step = await this.options.model.step(
        planningMessages(goalOf(context.messages), recordedLines(records)),
        [],
      );
      answer = step.text ?? "";
    } catch (error) {
      this.options.onError?.(error);
      return undefined;
    }

    const parsed = parsePlan(answer);
    if (parsed.steps.length === 0) {
      this.options.onError?.(new Error("the planning pass produced no usable steps"));
      return undefined;
    }

    const plan: PlanStep = {
      id: this.nextId(store),
      sessionId: this.options.session,
      kind: "plan",
      steps: parsed.steps,
      reasoning: planReasoning(context.step, records),
      createdAt: new Date().toISOString(),
    };
    store.recordStep?.(plan);
    return planMessage(plan, context.step);
  };

  /** `plan-1`, `plan-2`, … skipping any id already taken, like the task list. */
  private nextId(store: Store): string {
    let n = (store.getSteps?.(this.options.session, { kind: "plan" }) ?? []).length + 1;
    while (store.getStep?.(`plan-${n}`)) n += 1;
    return `plan-${n}`;
  }
}
