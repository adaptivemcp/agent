import { describe, it, expect } from "vitest";
import type { ChatStep } from "../types.js";
import { PooledChatModel } from "./pool.js";
import { apiKeysFor, createChatModel } from "./factory.js";
import type { ModelIntegration } from "./types.js";

class StubModel {
  calls = 0;
  readonly capabilities = { supports: { temperature: true } };

  constructor(
    readonly name: string,
    private readonly failTimes = 0,
  ) {}

  async step(): Promise<ChatStep> {
    this.calls += 1;
    if (this.calls <= this.failTimes) throw new Error(`${this.name} unavailable`);
    return { text: this.name, toolCalls: [] };
  }
}

describe("PooledChatModel", () => {
  it("rotates across healthy members", async () => {
    const pool = new PooledChatModel([new StubModel("a"), new StubModel("b")], "pool");
    expect(pool.size).toBe(2);
    expect((await pool.step([], [])).text).toBe("a");
    expect((await pool.step([], [])).text).toBe("b");
    expect((await pool.step([], [])).text).toBe("a");
  });

  it("fails over to the next resource and cools the failed one down", async () => {
    let now = 0;
    const a = new StubModel("a", 1);
    const b = new StubModel("b");
    const pool = new PooledChatModel([a, b], "pool", { cooldownMs: 100, now: () => now });

    expect((await pool.step([], [])).text).toBe("b"); // a failed, b served
    now = 50;
    expect((await pool.step([], [])).text).toBe("b"); // a still cooling
    now = 200;
    expect((await pool.step([], [])).text).toBe("a"); // a recovered
  });

  it("throws the last error when every member fails", async () => {
    const pool = new PooledChatModel([new StubModel("a", 1), new StubModel("b", 1)]);
    await expect(pool.step([], [])).rejects.toThrow();
  });

  it("refuses to pool no members", () => {
    expect(() => new PooledChatModel([])).toThrow(/at least one member/);
  });
});

describe("apiKeysFor", () => {
  const openai: ModelIntegration = {
    id: "openai",
    provider: "openai-compatible",
    model: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  };

  it("pools numbered key variants", () => {
    expect(
      apiKeysFor(openai, {
        OPENAI_API_KEY: "k1",
        OPENAI_API_KEY_2: "k2",
        OPENAI_API_KEY_3: "k3",
      }),
    ).toEqual(["k1", "k2", "k3"]);
    expect(apiKeysFor(openai, {})).toEqual([]);
  });

  it("does not pool alternative env names — only the first set one wins", () => {
    const local: ModelIntegration = {
      id: "local",
      provider: "openai-compatible",
      model: "m",
      apiKeyEnv: ["AI_API_KEY", "LLAMA_API_KEY"],
    };
    expect(apiKeysFor(local, { AI_API_KEY: "a", LLAMA_API_KEY: "b" })).toEqual(["a"]);
    expect(apiKeysFor(local, { LLAMA_API_KEY: "b", AI_API_KEY_2: "c" })).toEqual(["b"]);
  });

  it("builds a pooled chat model when several keys are present", () => {
    const single = createChatModel(openai, { OPENAI_API_KEY: "k1" });
    expect(single).not.toBeInstanceOf(PooledChatModel);

    const pooled = createChatModel(openai, { OPENAI_API_KEY: "k1", OPENAI_API_KEY_2: "k2" });
    expect(pooled).toBeInstanceOf(PooledChatModel);
    expect((pooled as PooledChatModel).size).toBe(2);
  });
});
