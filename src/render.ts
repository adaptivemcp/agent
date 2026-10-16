import type { AgentEvent } from "./types.js";

/**
 * Event rendering. The one-shot CLI and the interactive REPL render the same
 * `AgentEvent` stream at different densities, so both renderers live here:
 * neither `cli.ts` nor `repl.ts` owns a render switch, and the render layer is
 * directly testable (a precondition for adding a third renderer — the deferred
 * full-screen TUI; see `docs/architecture.md` "Full-screen TUI: deferred").
 */
export interface RenderSink {
  write(text: string): void;
}

/** ANSI styling. Injected so a non-TTY (or a test) renders plain text. */
export interface TextStyle {
  bold: (text: string) => string;
  dim: (text: string) => string;
  cyan: (text: string) => string;
  green: (text: string) => string;
  red: (text: string) => string;
}

/** ANSI wrappers that degrade to identity when the stream is not a TTY. */
export function makeColor(output: NodeJS.WritableStream): TextStyle {
  const enabled = Boolean((output as NodeJS.WriteStream).isTTY);
  const wrap =
    (code: string) =>
    (text: string): string =>
      enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    cyan: wrap("36"),
    green: wrap("32"),
    red: wrap("31"),
  };
}

/** Flatten a value to a single-line string, collapsing whitespace. */
export function preview(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** Render a value the way tool output is shown: JSON when possible. */
export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Compact one-shot rendering: stream text inline, tool lines underneath.
 * Everything goes through `sink` (stdout by default) so tests can capture it.
 */
export function renderOneShot(
  event: AgentEvent,
  verbose: boolean,
  sink: RenderSink = process.stdout,
): void {
  switch (event.type) {
    case "text_delta":
      sink.write(event.text);
      break;
    case "assistant_text":
      sink.write(`${event.text}\n`);
      break;
    case "model_selected":
      if (verbose) sink.write(`· model ${event.model}\n`);
      break;
    case "usage":
      if (verbose && event.cost !== undefined) sink.write(`· cost $${event.cost.toFixed(6)}\n`);
      break;
    case "decoding_applied":
      if (verbose) sink.write(`· decoding ${JSON.stringify(event.params)}\n`);
      break;
    case "decision_applied": {
      if (!verbose) break;
      const parts: string[] = [];
      if (event.model) parts.push(`model ${event.model}`);
      if (event.tools) parts.push(`tools ${event.tools.join(",") || "none"}`);
      if (event.rationale) parts.push(event.rationale);
      sink.write(`· system1 ${parts.join(" | ")}\n`);
      break;
    }
    case "tool_call":
      sink.write(`→ ${event.call.name}(${JSON.stringify(event.call.input ?? {})})\n`);
      break;
    case "tool_result":
      sink.write(
        event.result.ok ? `✓ ${stringify(event.result.output)}\n` : `✗ ${event.result.error}\n`,
      );
      break;
  }
}

export interface ReplRendererOptions {
  output: NodeJS.WritableStream;
  color: TextStyle;
}

export interface ReplRenderer {
  render: (event: AgentEvent) => void;
  /**
   * Start a fresh output line if the last write left one unterminated. Owned
   * here (not by the caller) because only the renderer knows the true line
   * state.
   */
  ensureNewline: () => void;
  /**
   * Write an interactive prompt (no trailing newline) and mark the line
   * unterminated, so the next rendered event starts on its own line.
   */
  prompt: (text: string) => void;
  /** Clear per-turn state: re-announce the model on the next event. */
  reset: () => void;
}

/**
 * The REPL's event renderer: coloured, one block per event, with the streaming
 * text kept inline.
 */
export function createReplRenderer(options: ReplRendererOptions): ReplRenderer {
  const { output, color } = options;
  let lineStart = true;
  let lastModel: string | undefined;
  const ensureNewline = (): void => {
    if (!lineStart) {
      output.write("\n");
      lineStart = true;
    }
  };
  const render = (event: AgentEvent): void => {
    switch (event.type) {
      case "text_delta":
        output.write(event.text);
        lineStart = event.text.endsWith("\n");
        break;
      case "assistant_text":
        ensureNewline();
        output.write(`${event.text}\n`);
        break;
      case "model_selected":
        if (event.model !== lastModel) {
          lastModel = event.model;
          output.write(color.dim(`[${event.model}] `));
        }
        break;
      case "usage":
        if (event.cost !== undefined) {
          ensureNewline();
          output.write(color.dim(`  · $${event.cost.toFixed(6)} (${event.model})\n`));
        }
        break;
      case "guard":
        ensureNewline();
        output.write(color.dim(`  ⚠ ${event.message}\n`));
        break;
      case "tool_call":
        ensureNewline();
        output.write(
          color.dim(
            `  → ${event.call.name}(${preview(JSON.stringify(event.call.input ?? {}), 160)})\n`,
          ),
        );
        break;
      case "tool_result":
        ensureNewline();
        output.write(
          event.result.ok
            ? color.green(`  ✓ ${preview(stringify(event.result.output), 200)}\n`)
            : color.red(
                `  ✗ ${preview(event.result.error ?? stringify(event.result.output), 200)}\n`,
              ),
        );
        break;
      case "decoding_applied":
        // Silent by default; the model is still adapting. Uncomment to surface:
        // output.write(color.dim(`  · decoding ${JSON.stringify(event.params)}\n`));
        break;
      case "decision_applied": {
        // The System One fast path picking a verdict is worth a line — it is the
        // one signal that the decision layer actually fired this turn.
        ensureNewline();
        const bits: string[] = [];
        if (event.model) bits.push(event.model);
        if (event.tools?.length) bits.push(`tools: ${event.tools.join(", ")}`);
        output.write(color.dim(`  ↳ decision${bits.length ? ` ${bits.join(" | ")}` : ""}\n`));
        if (event.rationale) output.write(color.dim(`      ${preview(event.rationale, 160)}\n`));
        break;
      }
      case "suspended":
        // The run stopped for a human. Nothing was executed, so say what is being
        // asked rather than leaving a silent gap in the transcript.
        ensureNewline();
        output.write(color.dim(`  ⏸ paused: ${event.question}\n`));
        break;
      default: {
        // Exhaustiveness: a new `AgentEvent` variant must be handled here rather
        // than silently rendering nothing (which is how `suspended` slipped past
        // this switch when the loop gained it).
        const unhandled: never = event;
        void unhandled;
      }
    }
  };
  const prompt = (text: string): void => {
    ensureNewline();
    output.write(text);
    lineStart = false;
  };
  const reset = (): void => {
    lastModel = undefined;
  };
  return { render, ensureNewline, prompt, reset };
}
