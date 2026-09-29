import { describe, it, expect } from "vitest";
import { LLAMA_CPP_CAPABILITIES } from "@adaptivemcp/routing";
import type { Middleware } from "@adaptivemcp/middleware";
import { InMemoryToolset } from "../mcp/toolset.js";
import { AgentRuntime } from "../runtime.js";
import { ModelCatalog } from "../models/catalog.js";
import { ScriptedModel, type ScriptedTurn } from "../provider/scripted.js";
import { runAgent } from "./loop.js";
import type { AgentEvent, AgentExecutor, ChatMessage, ChatModel, ChatParams, ChatStep, ToolCall, ToolSpec } from "../types.js";

/** Wraps a model to capture the params the loop passes to each completion. */
class RecordingModel implements ChatModel {
  readonly name = "recording";
  readonly params: Array<ChatParams | undefined> = [];

  constructor(private readonly inner: ChatModel) {}

  step(messages: ChatMessage[], tools: ToolSpec[], params?: ChatParams): Promise<ChatStep> {
    this.params.push(params);
    return this.inner.step(messages, tools, params);
  }
}

/** A scripted model that also implements `stream` by emitting char-by-char. */
class StreamingScriptedModel implements ChatModel {
  readonly name = "streaming-scripted";
  private cursor = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  private next(): ChatStep {
    const turn = this.turns[Math.min(this.cursor, this.turns.length - 1)] ?? {};
    this.cursor += 1;
    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((call, index) => ({
      id: `call-${this.cursor}-${index}`,
      name: call.name,
      input: call.input ?? {},
    }));
    return {
      text: turn.text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
    };
  }

  async step(): Promise<ChatStep> {
    return this.next();
  }

  async stream(
    _messages: ChatMessage[],
    _tools: ToolSpec[],
    _params: ChatParams,
    onTextDelta: (text: string) => void,
  ): Promise<ChatStep> {
    const chat = this.next();
    if (chat.text) for (const char of Array.from(chat.text)) onTextDelta(char);
    return chat;
  }
}

function toolset(failDeploys = 0): InMemoryToolset {
  let deploys = 0;
  return new InMemoryToolset("demo", [
    {
      name: "deploy_service",
      description: "Deploy a service",
      handler: () => {
        deploys += 1;
        if (deploys <= failDeploys) throw new Error("upstream timeout");
        return { deployed: true };
      },
    },
    { name: "search_customer", description: "Search", handler: (input) => ({ query: input }) },
  ]);
}

async function runtimeFor(tools: InMemoryToolset, sessionId = "s1"): Promise<AgentRuntime> {
  return new AgentRuntime({
    dbPath: ":memory:",
    sessionId,
    invoke: (name, input) => tools.callTool(name, input),
  });
}

/** A model that always returns one fixed message; useful for model-selection tests. */
class FixedModel implements ChatModel {
  constructor(
    readonly name: string,
    private readonly text: string,
  ) {}

  async step(): Promise<ChatStep> {
    return { text: this.text, toolCalls: [], finishReason: "stop" };
  }

  async stream(
    _messages: ChatMessage[],
    _tools: ToolSpec[],
    _params: ChatParams,
    onTextDelta: (text: string) => void,
  ): Promise<ChatStep> {
    onTextDelta(this.text);
    return { text: this.text, toolCalls: [], finishReason: "stop" };
  }
}

/** A model that calls one tool (with token usage + pricing) then finishes. */
class PricedToolModel implements ChatModel {
  readonly name = "priced";
  readonly pricing = { inputPerMTok: 1, outputPerMTok: 2 };
  private cursor = 0;

  async step(): Promise<ChatStep> {
    this.cursor += 1;
    if (this.cursor === 1) {
      return {
        toolCalls: [{ id: "c1", name: "search_customer", input: {} }],
        finishReason: "tool-calls",
        usage: { inputTokens: 1000, outputTokens: 500 },
      };
    }
    return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

describe("agent loop", () => {
  it("executes a tool call, records telemetry, and completes", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools);
    const events: AgentEvent[] = [];
    const model = new ScriptedModel([
      { toolCalls: [{ name: "deploy_service", input: { env: "prod" } }] },
      { text: "Deployed." },
    ]);

    const result = await runAgent({
      model,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "deploy" }],
      onEvent: (event) => events.push(event),
    });

    expect(result.stopReason).toBe("completed");
    expect(events.some((event) => event.type === "tool_result" && event.result.ok)).toBe(true);
    const record = runtime.adaptive.memory.getTool("deploy_service", "demo");
    expect(record?.stats.invocations).toBe(1);
    expect(runtime.toolsMetadata()).toContain("deploy_service");

    runtime.close();
    await tools.close();
  });

  it("records a failed call and feeds the error back to the model", async () => {
    const tools = toolset(1);
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s2");
    const model = new ScriptedModel([
      { toolCalls: [{ name: "deploy_service" }] },
      { text: "It failed." },
    ]);

    const result = await runAgent({
      model,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "deploy" }],
    });

    expect(result.messages.find((message) => message.role === "tool")?.isError).toBe(true);
    expect(runtime.adaptive.memory.getTool("deploy_service", "demo")?.stats.failures).toBe(1);

    runtime.close();
    await tools.close();
  });

  it("stops at maxSteps when the model keeps calling tools", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s3");
    const model = new ScriptedModel([{ toolCalls: [{ name: "search_customer", input: {} }] }]);

    const result = await runAgent({
      model,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "go" }],
      maxSteps: 3,
    });

    expect(result.stopReason).toBe("max_steps");
    expect(result.steps).toBe(3);

    runtime.close();
    await tools.close();
  });

  it("reports unknown tools without executing", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s4");
    const model = new ScriptedModel([{ toolCalls: [{ name: "nope" }] }, { text: "done" }]);

    const result = await runAgent({
      model,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "go" }],
    });

    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.isError).toBe(true);
    expect(toolMessage?.content).toContain("unknown tool");

    runtime.close();
    await tools.close();
  });

  it("suggests a decoding profile from observed failures", async () => {
    const tools = new InMemoryToolset("demo", [
      {
        name: "deploy_service",
        description: "Deploy",
        handler: () => {
          throw new Error("always failing");
        },
      },
    ]);
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s5");
    const spec = specs[0] as ToolSpec;

    for (let i = 0; i < 12; i += 1) {
      await runtime.execute({ id: `c${i}`, name: "deploy_service", input: {} }, spec);
    }

    const recommendation = runtime.suggestDecoding("deploy_service", LLAMA_CPP_CAPABILITIES, {
      serverName: "demo",
    });
    expect(recommendation).toBeDefined();
    expect(recommendation?.profile.id).toBe("deterministic");
    expect(recommendation?.resolved.temperature).toBeTypeOf("number");

    runtime.close();
    await tools.close();
  });

  it("applies a learned decoding profile to the next model step", async () => {
    const tools = new InMemoryToolset("demo", [
      {
        name: "deploy_service",
        description: "Deploy",
        handler: () => {
          throw new Error("always failing");
        },
      },
    ]);
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s6");
    const spec = specs[0] as ToolSpec;

    for (let i = 0; i < 12; i += 1) {
      await runtime.execute({ id: `c${i}`, name: "deploy_service", input: {} }, spec);
    }

    const model = new RecordingModel(new ScriptedModel([{ text: "done" }]));
    const events: AgentEvent[] = [];
    await runAgent({
      model,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "go" }],
      decoding: runtime.decodingProvider(LLAMA_CPP_CAPABILITIES),
      onEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "decoding_applied")).toBe(true);
    expect(model.params[0]?.temperature).toBe(0.2);
    expect(model.params[0]?.topK).toBe(20);

    runtime.close();
    await tools.close();
  });

  it("supplies no decoding override before there is enough observed signal", async () => {
    const tools = toolset();
    const runtime = await runtimeFor(tools, "s7");

    const provider = runtime.decodingProvider(LLAMA_CPP_CAPABILITIES);
    expect(await provider({ step: 0, messages: [], tools: [] })).toBeUndefined();

    runtime.close();
    await tools.close();
  });

  it("streams assistant text as text_delta events", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s8");
    const events: AgentEvent[] = [];
    const model = new StreamingScriptedModel([{ text: "hello" }]);

    const result = await runAgent({
      model,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "hi" }],
      onEvent: (event) => events.push(event),
    });

    const deltas = events
      .filter((event): event is Extract<AgentEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.text)
      .join("");
    expect(deltas).toBe("hello");
    // Streamed text must not be re-emitted whole.
    expect(events.some((event) => event.type === "assistant_text")).toBe(false);
    expect(result.messages.at(-1)?.content).toBe("hello");

    runtime.close();
    await tools.close();
  });

  it("executes tool calls discovered while streaming", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s9");
    const events: AgentEvent[] = [];
    const model = new StreamingScriptedModel([
      { toolCalls: [{ name: "search_customer", input: { q: "acme" } }] },
      { text: "done" },
    ]);

    await runAgent({
      model,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "go" }],
      onEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "tool_result" && event.result.ok)).toBe(true);
    expect(runtime.adaptive.memory.getTool("search_customer", "demo")?.stats.invocations).toBe(1);

    runtime.close();
    await tools.close();
  });

  it("falls back to step() when streaming is disabled", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s10");
    const events: AgentEvent[] = [];
    const model = new StreamingScriptedModel([{ text: "whole" }]);

    await runAgent({
      model,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      onEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "text_delta")).toBe(false);
    expect(
      events.some((event) => event.type === "assistant_text" && event.text === "whole"),
    ).toBe(true);

    runtime.close();
    await tools.close();
  });

  it("groups one turn's tool calls under a single execution-graph root", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s11");
    const model = new ScriptedModel([
      {
        toolCalls: [
          { name: "search_customer", input: { q: "acme" } },
          { name: "deploy_service", input: { env: "prod" } },
        ],
      },
      { text: "done" },
    ]);

    await runAgent({
      model,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "go" }],
    });

    const roots = runtime.adaptive.memory.getRootNodes("s11");
    expect(roots).toHaveLength(1);
    const turn = roots[0]!;
    expect(turn.toolName).toBe("agent_turn_0");
    expect(turn.childrenIds).toHaveLength(2);
    const children = turn.childrenIds.map((id) => runtime.adaptive.memory.getExecutionNode(id)!);
    expect(children.map((child) => child.toolName).sort()).toEqual(["deploy_service", "search_customer"]);
    for (const child of children) expect(child.parentId).toBe(turn.id);

    const view = runtime.graphView();
    expect(view).toContain("agent_turn_0");
    expect(view).toContain("search_customer");
    expect(view).toContain("deploy_service");

    runtime.close();
    await tools.close();
  });

  it("selects the model per step and reports it", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s12");
    const base = new FixedModel("base", "from base");
    const chosen = new FixedModel("chosen", "from chosen");
    const events: AgentEvent[] = [];

    const result = await runAgent({
      model: base,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "hi" }],
      selectModel: () => chosen,
      onEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "model_selected" && event.model === "chosen")).toBe(true);
    expect(result.messages.at(-1)?.content).toBe("from chosen");

    runtime.close();
    await tools.close();
  });

  it("falls back to the default model when the selector declines", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s13");
    const base = new FixedModel("base", "from base");
    const events: AgentEvent[] = [];

    const result = await runAgent({
      model: base,
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "hi" }],
      selectModel: () => undefined,
      onEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "model_selected")).toBe(false);
    expect(result.messages.at(-1)?.content).toBe("from base");

    runtime.close();
    await tools.close();
  });

  it("routes to the model Adaptive MCP learned for the governing tool", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const searchSpec = specs.find((spec) => spec.name === "search_customer")!;
    const runtime = new AgentRuntime({
      dbPath: ":memory:",
      sessionId: "s14",
      invoke: (name, input) => tools.callTool(name, input),
      routerModels: [{ id: "tuned", costWeight: 1, latencyWeight: 1 }],
      routerMinInvocations: 1,
    });

    for (let i = 0; i < 3; i += 1) {
      await runtime.execute({ id: `c${i}`, name: "search_customer", input: {} }, searchSpec);
    }
    expect(runtime.suggestModel("search_customer", { serverName: "demo" })).toBe("tuned");

    const catalog = new ModelCatalog([
      { id: "tuned", provider: "openai-compatible", model: "tiny", baseURL: "http://127.0.0.1:9/v1" },
    ]);
    const selected = await runtime.modelProvider(catalog)({ step: 0, messages: [], tools: [] });
    expect(selected?.name).toBe("tuned");

    runtime.close();
    await tools.close();
  });

  it("records priced token cost on the tool call", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s15");
    const events: AgentEvent[] = [];

    await runAgent({
      model: new PricedToolModel(),
      tools: specs,
      executor: runtime,
      messages: [{ role: "user", content: "go" }],
      onEvent: (event) => events.push(event),
    });

    // 1000 input * $1/MTok + 500 output * $2/MTok = $0.002, attributed to the call.
    expect(runtime.adaptive.memory.getTool("search_customer", "demo")?.stats.totalCost).toBeCloseTo(
      0.002,
      6,
    );
    expect(events.some((event) => event.type === "usage" && event.cost !== undefined)).toBe(true);

    runtime.close();
    await tools.close();
  });

  it("summarizes learned tool context and approval reasons", async () => {
    const tools = new InMemoryToolset("demo", [
      {
        name: "deploy_service",
        description: "Deploy",
        handler: () => {
          throw new Error("boom");
        },
      },
    ]);
    const specs = await tools.listTools();
    const runtime = await runtimeFor(tools, "s16");

    for (let i = 0; i < 3; i += 1) {
      await runtime.execute({ id: `c${i}`, name: "deploy_service", input: {} }, specs[0]!);
    }

    const context = runtime.learnedContext();
    expect(context).toContain("deploy_service");
    expect(context).toContain("% failed");
    expect(runtime.approvalReason("deploy_service", { serverName: "demo" })).toMatch(/% fail/);
    expect(runtime.costSummary()).toContain("deploy_service");

    runtime.close();
    await tools.close();
  });

  it("seeds risk from MCP annotations so the gate prompts", async () => {
    const tools = new InMemoryToolset("demo", [
      { name: "danger", annotations: { destructiveHint: true }, handler: () => ({ ok: true }) },
    ]);
    const specs = await tools.listTools();
    let asked = 0;
    const runtime = new AgentRuntime({
      dbPath: ":memory:",
      sessionId: "s17",
      invoke: (name, input) => tools.callTool(name, input),
      requestApproval: () => {
        asked += 1;
        return true;
      },
    });

    runtime.seedToolAnnotations(specs);
    expect(runtime.adaptive.memory.getTool("danger", "demo")?.annotation.risk).toBe("high");

    const result = await runtime.execute({ id: "c", name: "danger", input: {} }, specs[0]!);
    expect(result.ok).toBe(true);
    expect(asked).toBe(1);

    runtime.close();
    await tools.close();
  });

  it("runs middleware around tool execution", async () => {
    const tools = new InMemoryToolset("demo", [{ name: "echo", handler: () => "hello" }]);
    const specs = await tools.listTools();
    const upper: Middleware = {
      name: "upper",
      async afterCall(_result, call) {
        if (typeof call.output === "string") call.output = call.output.toUpperCase();
      },
    };
    const runtime = new AgentRuntime({
      dbPath: ":memory:",
      sessionId: "s18",
      invoke: (name, input) => tools.callTool(name, input),
      middleware: [upper],
    });

    const result = await runtime.execute({ id: "c", name: "echo", input: {} }, specs[0]!);
    expect(result.output).toBe("HELLO");

    runtime.close();
    await tools.close();
  });

  it("lets the executor inject a post-step guard message", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const base = await runtimeFor(tools, "s19");
    const executor: AgentExecutor = {
      execute: (call, spec, context) => base.execute(call, spec, context),
      runTurn: (label, fn) => base.runTurn(label, fn),
      review: () => "guard message",
    };
    const events: AgentEvent[] = [];
    const model = new ScriptedModel([
      { toolCalls: [{ name: "search_customer", input: {} }] },
      { text: "done" },
    ]);

    const result = await runAgent({
      model,
      tools: specs,
      executor,
      messages: [{ role: "user", content: "go" }],
      onEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "guard" && event.message === "guard message")).toBe(true);
    expect(result.messages.some((message) => message.content === "guard message")).toBe(true);

    base.close();
    await tools.close();
  });

  it("surfaces execution observations and has no graph signals initially", async () => {
    const tools = toolset();
    const specs = await tools.listTools();
    const observations: Array<{ toolName: string; status: string }> = [];
    const runtime = new AgentRuntime({
      dbPath: ":memory:",
      sessionId: "s20",
      invoke: (name, input) => tools.callTool(name, input),
      onExecuted: (observation) => observations.push(observation),
    });

    expect(runtime.graphSignals()).toEqual([]);
    expect(runtime.review()).toBeUndefined();

    const searchSpec = specs.find((spec) => spec.name === "search_customer")!;
    await runtime.execute({ id: "c", name: "search_customer", input: {} }, searchSpec);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.toolName).toBe("search_customer");
    expect(observations[0]?.status).toBe("completed");

    runtime.close();
    await tools.close();
  });
});
