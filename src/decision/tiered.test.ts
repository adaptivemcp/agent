import { describe, it, expect, vi } from "vitest";
import { TieredSystemOneBackend } from "./tiered.js";
import type { DecisionBackend, SystemOneResponse } from "./systemone.js";
import { AgentRuntime } from "../runtime.js";
import { ModelCatalog } from "../models/catalog.js";

/** A `DecisionBackend` stub: records calls, runs a scripted behavior. */
function fake(
  id: string,
  tier: number,
  behavior: () => Promise<SystemOneResponse>,
): DecisionBackend & { calls: number } {
  const backend = {
    id,
    model: `${id}-model`,
    tier,
    calls: 0,
    async answer(): Promise<SystemOneResponse> {
      backend.calls += 1;
      return behavior();
    },
  };
  return backend;
}

const OK_RESPONSE: SystemOneResponse = {
  model: "m",
  answers: {},
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** A confident verdict the advisor actually turns into a decision. */
const CONFIDENT_RESPONSE: SystemOneResponse = {
  model: "m",
  answers: {
    decoding: {
      type: "choice",
      choice: "balanced",
      probabilities: { balanced: 0.9 },
      confidence: 0.9,
    },
  },
  usage: { input_tokens: 1, output_tokens: 1 },
};

const hang = (): Promise<SystemOneResponse> => new Promise<SystemOneResponse>(() => {});

describe("TieredSystemOneBackend construction", () => {
  it("rejects an empty backend list", () => {
    expect(() => new TieredSystemOneBackend([])).toThrow(/at least one backend/);
  });

  it("enforces the one-fallback cap structurally (>2 backends throws)", () => {
    const three = ["a", "b", "c"].map((id) => fake(id, 0, async () => OK_RESPONSE));
    expect(() => new TieredSystemOneBackend(three)).toThrow(/one fallback/);
  });

  it("rejects a non-positive budget", () => {
    expect(
      () => new TieredSystemOneBackend([fake("a", 0, async () => OK_RESPONSE)], { budgetMs: 0 }),
    ).toThrow(/budgetMs/);
  });

  it("sorts by tier regardless of caller order (stable)", async () => {
    const order: string[] = [];
    const remote = fake("remote", 1, async () => {
      order.push("remote");
      return OK_RESPONSE;
    });
    const local = fake("local", 0, async () => {
      order.push("local");
      return OK_RESPONSE;
    });
    const tiered = new TieredSystemOneBackend([remote, local]);
    expect(tiered.tier).toBe(0);
    expect(tiered.model).toBe("local-model");
    // Remote was passed first but local (tier 0) must run first.
    await tiered.answer({}, {});
    expect(order).toEqual(["local"]);
    expect(remote.calls).toBe(0);
  });
});

describe("TieredSystemOneBackend.answer", () => {
  it("falls through to the next tier when the primary errors, in the same call", async () => {
    const onFallback = vi.fn();
    const primary = fake("local", 0, async () => {
      throw new Error("connection refused");
    });
    const fallback = fake("remote", 1, async () => OK_RESPONSE);
    const tiered = new TieredSystemOneBackend([primary, fallback], { onFallback });

    const response = await tiered.answer({ request: "hi" }, {});

    expect(response).toBe(OK_RESPONSE);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(onFallback).toHaveBeenCalledTimes(1);
    const [error, from, to] = onFallback.mock.calls[0]!;
    expect((error as Error).message).toBe("connection refused");
    expect(from.id).toBe("local");
    expect(to.id).toBe("remote");
    expect(tiered.answeredBy).toBe("remote");
    expect(tiered.attribution()).toBe("remote (fell back from local)");
  });

  it("does not consult the fallback when the primary answers", async () => {
    const onFallback = vi.fn();
    const fallback = fake("remote", 1, async () => OK_RESPONSE);
    const tiered = new TieredSystemOneBackend(
      [fake("local", 0, async () => OK_RESPONSE), fallback],
      { onFallback },
    );

    await tiered.answer({}, {});

    expect(fallback.calls).toBe(0);
    expect(onFallback).not.toHaveBeenCalled();
    expect(tiered.attribution()).toBe("local");
  });

  it("reports '(no tier answered yet)' before the first successful call", () => {
    const tiered = new TieredSystemOneBackend([fake("local", 0, async () => OK_RESPONSE)]);
    expect(tiered.attribution()).toBe("(no tier answered yet)");
  });

  it("keeps the previous attribution after a fully failed call", async () => {
    let healthy = true;
    const primary = fake("local", 0, async () => {
      if (!healthy) throw new Error("now broken");
      return OK_RESPONSE;
    });
    const tiered = new TieredSystemOneBackend([
      primary,
      fake("remote", 1, async () => {
        throw new Error("remote down");
      }),
    ]);

    await tiered.answer({}, {});
    healthy = false;
    await expect(tiered.answer({}, {})).rejects.toThrow();
    // The summary pairs attribution with the last *successful* decision.
    expect(tiered.attribution()).toBe("local");
  });

  it("rethrows a single-tier failure untouched (no AggregateError)", async () => {
    const tiered = new TieredSystemOneBackend([
      fake("local", 0, async () => {
        throw new Error("plain failure");
      }),
    ]);

    await expect(tiered.answer({}, {})).rejects.toThrow("plain failure");
    await tiered.answer({}, {}).catch((error) => {
      expect(error).not.toBeInstanceOf(AggregateError);
    });
  });

  it("wraps a two-tier failure in an AggregateError naming both tiers", async () => {
    const tiered = new TieredSystemOneBackend([
      fake("local", 0, async () => {
        throw new Error("local down");
      }),
      fake("remote", 1, async () => {
        throw new Error("remote down");
      }),
    ]);

    const error = await tiered.answer({}, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message).toBe("local down");
    expect((aggregate.errors[1] as Error).message).toBe("remote down");
    expect(aggregate.message).toContain("tiered(local,remote)");
  });

  it("shares one budget across tiers: a hung primary cannot starve the fallback", async () => {
    const budgetMs = 400;
    const fallback = fake("remote", 1, async () => OK_RESPONSE);
    const tiered = new TieredSystemOneBackend([fake("local", 0, hang), fallback], { budgetMs });

    const started = Date.now();
    const response = await tiered.answer({}, {});
    const elapsed = Date.now() - started;

    expect(response).toBe(OK_RESPONSE);
    expect(fallback.calls).toBe(1);
    // Fair share: the primary only ever held ~half the budget, so the answer
    // lands inside the single shared budget — never 2× (the double-timeout the
    // cap exists to prevent).
    expect(elapsed).toBeLessThan(budgetMs);
    expect(tiered.attribution()).toBe("remote (fell back from local)");
  }, 5_000);

  it("fails within the shared budget when every tier hangs", async () => {
    const budgetMs = 150;
    const tiered = new TieredSystemOneBackend([fake("local", 0, hang), fake("remote", 1, hang)], {
      budgetMs,
    });

    const started = Date.now();
    const error = await tiered.answer({}, {}).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    // Both attempts together ≈ budget — failover never doubles the latency.
    expect(elapsed).toBeLessThan(budgetMs * 3);
  }, 5_000);
});

describe("TieredSystemOneBackend through SystemOneAdvisor", () => {
  it("low confidence declines without ever consulting the fallback", async () => {
    const fallback = fake("remote", 1, async () => OK_RESPONSE);
    // Answers below minConfidence (0.5): a valid reply, just an unsure one.
    const unsure = fake("local", 0, async () => ({
      model: "m",
      answers: {
        decoding: {
          type: "choice",
          choice: "balanced",
          probabilities: { balanced: 0.2 },
          confidence: 0.2,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const tiered = new TieredSystemOneBackend([unsure, fallback]);
    const { SystemOneAdvisor } = await import("./advisor.js");
    const onError = vi.fn();
    const advisor = new SystemOneAdvisor({ backend: tiered, onError });

    const decision = await advisor.decide({ message: "hi", tools: [], models: [] });

    // The tier answered — declining on confidence is the advisor's job, not a
    // fallback trigger: the second tier is never raced.
    expect(decision).toBeUndefined();
    expect(fallback.calls).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });
});

const CATALOG = new ModelCatalog(
  [
    {
      id: "local",
      provider: "openai-compatible",
      model: "Qwen/Qwen3-8B",
      baseURL: "http://127.0.0.1:9931/v1",
      apiKeyEnv: "LLAMA_API_KEY",
      costWeight: 1,
      latencyWeight: 1,
      default: true,
    },
  ],
  { LLAMA_API_KEY: "k" },
);

describe("AgentRuntime.systemOneProvider tiered composition", () => {
  it("attributes the summary to the tier that answered, including the fallback", async () => {
    const runtime = new AgentRuntime({
      dbPath: ":memory:",
      sessionId: "tiered-sum",
      invoke: async () => ({ ok: false, error: "unused in this test" }),
    });
    const onFallback = vi.fn();
    const provider = runtime.systemOneProvider(CATALOG, {
      backends: [
        fake("local", 0, async () => {
          throw new Error("connection refused");
        }),
        fake("remote", 1, async () => CONFIDENT_RESPONSE),
      ],
      onFallback,
    });

    const applied = await provider({
      step: 0,
      messages: [{ role: "user", content: "deploy" }],
      tools: [],
    });

    expect(applied).toBeDefined();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(runtime.lastDecisionSummary()).toContain("backend remote (fell back from local)");
    runtime.close();
  });

  it("attributes a plain single backend by its id", async () => {
    const runtime = new AgentRuntime({
      dbPath: ":memory:",
      sessionId: "single-sum",
      invoke: async () => ({ ok: false, error: "unused in this test" }),
    });
    const provider = runtime.systemOneProvider(CATALOG, {
      backend: fake("solo", 0, async () => CONFIDENT_RESPONSE),
    });

    await provider({ step: 0, messages: [{ role: "user", content: "deploy" }], tools: [] });

    expect(runtime.lastDecisionSummary()).toContain("backend solo");
    expect(runtime.lastDecisionSummary()).not.toContain("fell back");
    runtime.close();
  });

  it("prefers backends over backend when both are set", async () => {
    const runtime = new AgentRuntime({
      dbPath: ":memory:",
      sessionId: "precedence",
      invoke: async () => ({ ok: false, error: "unused in this test" }),
    });
    const provider = runtime.systemOneProvider(CATALOG, {
      backend: fake("ignored", 0, async () => {
        throw new Error("backend option must lose");
      }),
      backends: [fake("chosen", 0, async () => CONFIDENT_RESPONSE)],
    });

    await provider({ step: 0, messages: [{ role: "user", content: "deploy" }], tools: [] });

    expect(runtime.lastDecisionSummary()).toContain("backend chosen");
    runtime.close();
  });

  it("fails fast when backends is an empty array", () => {
    const runtime = new AgentRuntime({
      dbPath: ":memory:",
      sessionId: "empty",
      invoke: async () => ({ ok: false, error: "unused in this test" }),
    });
    expect(() => runtime.systemOneProvider(CATALOG, { backends: [] })).toThrow(
      /at least one backend/,
    );
    runtime.close();
  });
});
