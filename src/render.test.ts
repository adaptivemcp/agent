import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import {
  createReplRenderer,
  makeColor,
  preview,
  renderOneShot,
  stringify,
  type RenderSink,
  type TextStyle,
} from "./render.js";
import type { AgentEvent } from "./types.js";

/** Collects everything a renderer writes so a test can assert on it. */
function capture(): { sink: RenderSink; text: () => string } {
  let out = "";
  return {
    sink: { write: (chunk) => (out += chunk) },
    text: () => out,
  };
}

/** A PassThrough wired to a string buffer, for the REPL renderer. */
function buffer(): { output: PassThrough; text: () => string } {
  const output = new PassThrough();
  let out = "";
  output.on("data", (chunk) => (out += String(chunk)));
  return { output, text: () => out };
}

/** No ANSI codes: the REPL renderer only styles when the stream is a TTY. */
const PLAIN: TextStyle = {
  bold: (t) => t,
  dim: (t) => t,
  cyan: (t) => t,
  green: (t) => t,
  red: (t) => t,
};

const TOOL_CALL: AgentEvent = {
  type: "tool_call",
  call: { id: "c1", name: "read_file", input: { path: "a.txt" } },
  spec: { name: "read_file", inputSchema: {} },
  step: 0,
};

describe("renderOneShot", () => {
  it("streams text deltas verbatim with no added newline", () => {
    const { sink, text } = capture();
    renderOneShot({ type: "text_delta", text: "hello ", step: 0 }, false, sink);
    renderOneShot({ type: "text_delta", text: "world", step: 0 }, false, sink);
    expect(text()).toBe("hello world");
  });

  it("writes tool calls and results on their own lines", () => {
    const { sink, text } = capture();
    renderOneShot(TOOL_CALL, false, sink);
    renderOneShot(
      { type: "tool_result", call: TOOL_CALL.call, result: { ok: true, output: "hi" }, step: 0 },
      false,
      sink,
    );
    renderOneShot(
      {
        type: "tool_result",
        call: TOOL_CALL.call,
        result: { ok: false, error: "boom" },
        step: 0,
      },
      false,
      sink,
    );
    expect(text()).toBe('→ read_file({"path":"a.txt"})\n✓ hi\n✗ boom\n');
  });

  it("suppresses verbose-only events when not verbose", () => {
    const { sink, text } = capture();
    renderOneShot({ type: "model_selected", model: "m1", step: 0 }, false, sink);
    renderOneShot({ type: "usage", model: "m1", cost: 0.5, step: 0 }, false, sink);
    renderOneShot({ type: "decision_applied", rationale: "why", step: 0 }, false, sink);
    expect(text()).toBe("");
  });

  it("renders verbose-only events when verbose", () => {
    const { sink, text } = capture();
    renderOneShot({ type: "model_selected", model: "m1", step: 0 }, true, sink);
    renderOneShot({ type: "usage", model: "m1", cost: 0.1234567, step: 0 }, true, sink);
    renderOneShot(
      {
        type: "decision_applied",
        model: "m2",
        tools: ["t1", "t2"],
        rationale: "confident",
        step: 0,
      },
      true,
      sink,
    );
    expect(text()).toBe(
      "· model m1\n" + "· cost $0.123457\n" + "· system1 model m2 | tools t1,t2 | confident\n",
    );
  });

  it("renders an empty tool list as 'none' in the decision line", () => {
    const { sink, text } = capture();
    renderOneShot({ type: "decision_applied", tools: [], step: 0 }, true, sink);
    expect(text()).toBe("· system1 tools none\n");
  });
});

describe("createReplRenderer", () => {
  it("keeps streamed text inline and prints assistant text on its own line", () => {
    const { output, text } = buffer();
    const { render } = createReplRenderer({ output, color: PLAIN });
    render({ type: "text_delta", text: "partial", step: 0 });
    render({ type: "assistant_text", text: "done", step: 0 });
    expect(text()).toBe("partial\ndone\n");
  });

  it("announces the model once per change and re-announces after reset()", () => {
    const { output, text } = buffer();
    const { render, reset } = createReplRenderer({ output, color: PLAIN });
    render({ type: "model_selected", model: "m1", step: 0 });
    render({ type: "model_selected", model: "m1", step: 1 });
    expect(text()).toBe("[m1] ");
    render({ type: "model_selected", model: "m2", step: 2 });
    expect(text()).toBe("[m1] [m2] ");
    reset();
    render({ type: "model_selected", model: "m2", step: 3 });
    expect(text()).toBe("[m1] [m2] [m2] ");
  });

  it("starts a new line before a block event if streamed text was unterminated", () => {
    const { output, text } = buffer();
    const { render } = createReplRenderer({ output, color: PLAIN });
    render({ type: "text_delta", text: "no newline", step: 0 });
    render(TOOL_CALL);
    expect(text()).toBe('no newline\n  → read_file({"path":"a.txt"})\n');
  });

  it("renders tool results, guards, usage, and decisions with their markers", () => {
    const { output, text } = buffer();
    const { render } = createReplRenderer({ output, color: PLAIN });
    render({
      type: "tool_result",
      call: TOOL_CALL.call,
      result: { ok: true, output: "contents" },
      step: 0,
    });
    render({
      type: "tool_result",
      call: TOOL_CALL.call,
      result: { ok: false, error: "denied" },
      step: 1,
    });
    render({ type: "guard", message: "careful", step: 2 });
    render({ type: "usage", model: "m1", cost: 0.25, step: 3 });
    render({ type: "decision_applied", model: "m1", tools: ["t1"], rationale: "fast", step: 4 });
    expect(text()).toBe(
      "  ✓ contents\n" +
        "  ✗ denied\n" +
        "  ⚠ careful\n" +
        "  · $0.250000 (m1)\n" +
        "  ↳ decision m1 | tools: t1\n" +
        "      fast\n",
    );
  });

  it("renders a bare decision line when nothing but the verdict is present", () => {
    const { output, text } = buffer();
    const { render } = createReplRenderer({ output, color: PLAIN });
    render({ type: "decision_applied", step: 0 });
    expect(text()).toBe("  ↳ decision\n");
  });

  it("stays silent on decoding_applied", () => {
    const { output, text } = buffer();
    const { render } = createReplRenderer({ output, color: PLAIN });
    render({ type: "decoding_applied", params: { temperature: 0.2 }, step: 0 });
    expect(text()).toBe("");
  });

  it("puts a prompt on its own line and the next event on a fresh one", () => {
    const { output, text } = buffer();
    const { render, prompt } = createReplRenderer({ output, color: PLAIN });
    render({ type: "text_delta", text: "streamed", step: 0 });
    prompt("agent> ");
    render({ type: "assistant_text", text: "reply", step: 1 });
    expect(text()).toBe("streamed\nagent> \nreply\n");
  });

  it("applies ANSI styling only when the stream is a TTY", () => {
    const styled = makeColor({ write: () => true, isTTY: true } as NodeJS.WriteStream);
    const plain = makeColor({ write: () => true } as NodeJS.WriteStream);
    expect(styled.dim("x")).toBe("\u001b[2mx\u001b[0m");
    expect(plain.dim("x")).toBe("x");
  });
});

describe("preview / stringify", () => {
  it("collapses whitespace and trims", () => {
    expect(preview("  a\n\tb  ", 100)).toBe("a b");
  });

  it("truncates with an ellipsis at the limit", () => {
    expect(preview("abcdefghij", 5)).toBe("abcd…");
  });

  it("stringifies objects, passes strings through, and maps undefined to empty", () => {
    expect(stringify({ a: 1 })).toBe('{"a":1}');
    expect(stringify("raw")).toBe("raw");
    expect(stringify(undefined)).toBe("");
  });

  it("falls back to String() for circular values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stringify(circular)).toContain("[object Object]");
  });
});
