import { describe, it, expect, vi } from "vitest";
import { buildRunConfig, type RunConfigInput } from "./cli-config.js";
import { AI_SDK_CAPABILITIES } from "./provider/ai-sdk.js";
import type { AgentRuntime } from "./runtime.js";
import type { DecisionBackend } from "./decision/systemone.js";
import type { ModelCatalog } from "./models/catalog.js";
import type { ChatModel } from "./types.js";

/**
 * A narrow stand-in for `AgentRuntime` exposing exactly the three seams
 * `buildRunConfig` touches, each recording how it was called so the test can
 * assert the assembly rules without booting a real runtime.
 */
function fakeRuntime(): {
  runtime: AgentRuntime;
  decodingProvider: ReturnType<typeof vi.fn>;
  modelProvider: ReturnType<typeof vi.fn>;
  systemOneProvider: ReturnType<typeof vi.fn>;
} {
  const decodingProvider = vi.fn(() => () => ({ temperature: 0.2 }));
  const modelProvider = vi.fn(() => () => undefined);
  const systemOneProvider = vi.fn(() => () => undefined);
  const runtime = { decodingProvider, modelProvider, systemOneProvider } as unknown as AgentRuntime;
  return { runtime, decodingProvider, modelProvider, systemOneProvider };
}

function modelWithCapabilities(capabilities?: object): ChatModel {
  return {
    name: "m1",
    step: async () => ({ text: "", toolCalls: [], finishReason: "stop" }),
    ...(capabilities ? { capabilities } : {}),
  } as ChatModel;
}

const CATALOG = {} as ModelCatalog;

/** A `DecisionBackend` double: identified, tiered, never answers. */
function fakeBackend(id: string, tier: number): DecisionBackend {
  return {
    id,
    model: id.split(":")[1] ?? id,
    tier,
    answer: async () => {
      throw new Error("not used in this test");
    },
  };
}

function baseInput(overrides: Partial<RunConfigInput> = {}): RunConfigInput {
  return {
    args: {},
    model: modelWithCapabilities(),
    pinned: false,
    tools: [],
    runtime: fakeRuntime().runtime,
    catalog: CATALOG,
    system: "system prompt",
    ...overrides,
  };
}

describe("buildRunConfig", () => {
  it("applies documented defaults: 8 steps, streaming on, base system", () => {
    const config = buildRunConfig(baseInput());
    expect(config.maxSteps).toBe(8);
    expect(config.stream).toBe(true);
    expect(config.system).toBe("system prompt");
  });

  it("honours explicit args: maxSteps and --no-stream", () => {
    const config = buildRunConfig(baseInput({ args: { maxSteps: 3, noStream: true } }));
    expect(config.maxSteps).toBe(3);
    expect(config.stream).toBe(false);
  });

  it("uses the runtime as the executor and passes the model through", () => {
    const runtime = fakeRuntime().runtime;
    const model = modelWithCapabilities();
    const config = buildRunConfig(baseInput({ runtime, model }));
    expect(config.executor).toBe(runtime);
    expect(config.model).toBe(model);
  });

  it("enables per-tool model routing when the model is not pinned", () => {
    const { runtime, modelProvider } = fakeRuntime();
    buildRunConfig(baseInput({ runtime, pinned: false }));
    expect(modelProvider).toHaveBeenCalledTimes(1);
  });

  it("suppresses per-tool routing when --model pinned the model", () => {
    const { runtime, modelProvider } = fakeRuntime();
    const config = buildRunConfig(baseInput({ runtime, pinned: true }));
    expect(modelProvider).not.toHaveBeenCalled();
    expect(config.selectModel).toBeUndefined();
  });

  it("derives decoding from the model's capabilities when present", () => {
    const caps = { supports: { temperature: true } };
    const { runtime, decodingProvider } = fakeRuntime();
    buildRunConfig(baseInput({ runtime, model: modelWithCapabilities(caps) }));
    expect(decodingProvider).toHaveBeenCalledWith(caps);
  });

  it("falls back to the AI SDK capability set when the model declares none", () => {
    const { runtime, decodingProvider } = fakeRuntime();
    buildRunConfig(baseInput({ runtime, model: modelWithCapabilities() }));
    expect(decodingProvider).toHaveBeenCalledWith(AI_SDK_CAPABILITIES);
  });

  it("leaves the decision layer off when no System One selection is given", () => {
    const { runtime, systemOneProvider } = fakeRuntime();
    const config = buildRunConfig(baseInput({ runtime }));
    expect(systemOneProvider).not.toHaveBeenCalled();
    expect(config.decide).toBeUndefined();
  });

  it("wires the decision layer when a System One selection is present", () => {
    const { runtime, systemOneProvider } = fakeRuntime();
    const config = buildRunConfig(
      baseInput({ runtime, system1: {}, args: { system1Model: "gpt-4o-mini" } }),
    );
    expect(systemOneProvider).toHaveBeenCalledTimes(1);
    expect(systemOneProvider).toHaveBeenCalledWith(CATALOG, { model: "gpt-4o-mini" });
    expect(config.decide).toBeTypeOf("function");
  });

  it("forwards a tier list selection as the failover chain", () => {
    const local = fakeBackend("ollama:tev1", 0);
    const remote = fakeBackend("openai:gpt-4o-mini", 1);
    const { runtime, systemOneProvider } = fakeRuntime();
    buildRunConfig(baseInput({ runtime, system1: { backends: [local, remote] } }));
    expect(systemOneProvider).toHaveBeenCalledWith(CATALOG, {
      model: undefined,
      backends: [local, remote],
    });
  });

  it("forwards a single-backend selection without a chain", () => {
    const backend = fakeBackend("openai:gpt-4o-mini", 1);
    const { runtime, systemOneProvider } = fakeRuntime();
    buildRunConfig(baseInput({ runtime, system1: { backend } }));
    expect(systemOneProvider).toHaveBeenCalledWith(CATALOG, {
      model: undefined,
      backend,
    });
  });

  it("surfaces the derived capabilities for renderer hooks", () => {
    const caps = { supports: { temperature: true } };
    const config = buildRunConfig(baseInput({ model: modelWithCapabilities(caps) }));
    expect(config.capabilities).toBe(caps);
  });
});
