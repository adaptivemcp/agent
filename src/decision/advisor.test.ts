import { describe, it, expect } from "vitest";
import { SystemOneAdvisor } from "./advisor.js";
import type {
  DecisionBackend,
  SystemOneQuestion,
  SystemOneResponse,
} from "./systemone.js";

class FakeBackend implements DecisionBackend {
  readonly id = "fake";
  readonly model = "tev1";
  lastQuestions?: Record<string, SystemOneQuestion>;

  constructor(private readonly response: SystemOneResponse) {}

  async answer(
    _state: unknown,
    questions: Record<string, SystemOneQuestion>,
  ): Promise<SystemOneResponse> {
    this.lastQuestions = questions;
    return this.response;
  }
}

class ThrowingBackend implements DecisionBackend {
  readonly id = "boom";
  readonly model = "tev1";
  async answer(): Promise<SystemOneResponse> {
    throw new Error("system one 404");
  }
}

const INPUT = {
  message: "deploy the billing service to prod",
  models: [
    { id: "alpha", label: "Alpha", costWeight: 1, latencyWeight: 1 },
    { id: "beta", label: "Beta", costWeight: 4, latencyWeight: 0.6 },
  ],
  tools: [
    { toolName: "search", description: "Search the catalog" },
    { toolName: "deploy", description: "Deploy a service", risk: "high" },
  ],
};

function response(answers: SystemOneResponse["answers"]): SystemOneResponse {
  return { model: "tev1", answers, usage: { input_tokens: 100, output_tokens: 4 } };
}

describe("SystemOneAdvisor", () => {
  it("distills model, tool-intent, and decoding from one System One call", async () => {
    const backend = new FakeBackend(
      response({
        model: { type: "choice", choice: "beta", probabilities: { alpha: 0.1, beta: 0.8 }, confidence: 0.82 },
        use_tools: { type: "noul", noul: 0.95 },
        tool: { type: "choice", choice: "deploy", probabilities: { search: 0.05, deploy: 0.95 }, confidence: 0.9 },
        decoding: {
          type: "choice",
          choice: "deterministic",
          probabilities: { deterministic: 0.7, balanced: 0.2, creative: 0.1 },
          confidence: 0.8,
        },
      }),
    );

    const decision = await new SystemOneAdvisor({ backend }).decide(INPUT);
    expect(decision?.modelId).toBe("beta");
    expect(decision?.toolNames).toEqual(["deploy"]);
    expect(decision?.decodingProfile).toBe("deterministic");
    expect(decision?.confidence).toBeCloseTo(0.8, 5);
    expect(decision?.rationale).toContain("model=beta");

    expect(Object.keys(backend.lastQuestions ?? {}).sort()).toEqual([
      "decoding",
      "model",
      "tool",
      "use_tools",
    ]);
  });

  it("returns no tools when the model decides none are needed", async () => {
    const backend = new FakeBackend(
      response({
        use_tools: { type: "noul", noul: 0.05 },
        tool: { type: "choice", choice: "deploy", probabilities: { search: 0.5, deploy: 0.5 }, confidence: 0.9 },
        decoding: {
          type: "choice",
          choice: "balanced",
          probabilities: { deterministic: 0.3, balanced: 0.6, creative: 0.1 },
          confidence: 0.6,
        },
      }),
    );

    const decision = await new SystemOneAdvisor({ backend }).decide(INPUT);
    expect(decision?.toolNames).toEqual([]);
    expect(decision?.decodingProfile).toBe("balanced");
  });

  it("declines when no answer is confident enough", async () => {
    const backend = new FakeBackend(
      response({
        decoding: {
          type: "choice",
          choice: "creative",
          probabilities: { deterministic: 0.4, balanced: 0.35, creative: 0.25 },
          confidence: 0.1,
        },
      }),
    );
    // Single model/tool: only the decoding question is asked, and it is weak.
    const decision = await new SystemOneAdvisor({ backend }).decide({
      message: "hi",
      models: [{ id: "alpha" }],
      tools: [{ toolName: "search" }],
    });
    expect(decision).toBeUndefined();
  });

  it("declines and reports when the backend fails", async () => {
    const errors: unknown[] = [];
    const decision = await new SystemOneAdvisor({
      backend: new ThrowingBackend(),
      onError: (error) => errors.push(error),
    }).decide(INPUT);
    expect(decision).toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
