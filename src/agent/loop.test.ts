import { describe, it, expect } from "vitest";
import { LLAMA_CPP_CAPABILITIES } from "@adaptivemcp/routing";
import { InMemoryToolset } from "../mcp/toolset.js";
import { AgentRuntime } from "../runtime.js";
import { ScriptedModel } from "../provider/scripted.js";
import { runAgent } from "./loop.js";
import type { AgentEvent, ChatMessage, ChatModel, ChatParams, ChatStep, ToolSpec } from "../types.js";

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
});
