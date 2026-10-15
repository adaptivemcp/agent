import { describe, it, expect } from "vitest";
import { AgentRuntime } from "../runtime.js";
import { ModelCatalog } from "../models/catalog.js";
import {
  OpenAiSystemOneBackend,
  SYSTEM_ONE_REMOTE_DEFAULT_BASE_URL,
  extractJsonObject,
  normalizeAnswer,
  systemOnePrompt,
  type SystemOneQuestion,
  type SystemOneResponse,
} from "./systemone.js";

/** A `fetch` stub that records the last request and returns a canned body. */
function stubFetch(reply: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const QUESTIONS: Record<string, SystemOneQuestion> = {
  route: {
    type: "choice",
    instructions: "route",
    criteria: { fast: null, safe: null },
  },
  risky: { type: "noul", instructions: "risky?" },
};

describe("OpenAiSystemOneBackend", () => {
  it("posts the prompt to /chat/completions with a bearer token", async () => {
    const reply = {
      model: "gpt-4o-mini",
      choices: [
        {
          message: {
            content:
              '{"answers":{"route":{"choice":"fast","confidence":0.9},"risky":{"noul":0.2}}}',
          },
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 12 },
    };
    const { fetchImpl, calls } = stubFetch(reply);
    const backend = new OpenAiSystemOneBackend({
      model: "gpt-4o-mini",
      apiKey: "sk-test",
      baseURL: "https://api.example.com/v1",
      fetchImpl,
    });

    const res = await backend.answer({ note: "hi" }, QUESTIONS);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.com/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0].init.body)) as {
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.temperature).toBe(0);
    expect(body.messages[1].content).toContain('"route"');

    expect(res.model).toBe("gpt-4o-mini");
    expect(res.usage).toEqual({ input_tokens: 40, output_tokens: 12 });
    expect(res.answers.route).toMatchObject({ type: "choice", choice: "fast", confidence: 0.9 });
    expect(res.answers.risky).toEqual({ type: "noul", noul: 0.2 });
  });

  it("falls back to $OPENAI_API_KEY and the OpenAI default base URL", async () => {
    const { fetchImpl, calls } = stubFetch({ choices: [{ message: { content: "{}" } }] });
    const backend = new OpenAiSystemOneBackend({
      model: "gpt-4o-mini",
      fetchImpl,
      env: { OPENAI_API_KEY: "sk-env" },
    });
    await backend.answer({}, QUESTIONS);
    expect(calls[0].url).toBe(`${SYSTEM_ONE_REMOTE_DEFAULT_BASE_URL}/chat/completions`);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-env");
  });

  it("throws when the reply carries no JSON object", async () => {
    const { fetchImpl } = stubFetch({
      choices: [{ message: { content: "I refuse to answer." } }],
    });
    const backend = new OpenAiSystemOneBackend({ model: "gpt-4o-mini", fetchImpl });
    await expect(backend.answer({}, QUESTIONS)).rejects.toThrow(/no JSON object/);
  });

  it("surfaces a non-2xx status as an error", async () => {
    const { fetchImpl } = stubFetch({ error: "nope" }, 401);
    const backend = new OpenAiSystemOneBackend({ model: "gpt-4o-mini", fetchImpl });
    await expect(backend.answer({}, QUESTIONS)).rejects.toThrow(/system one 401/);
  });
});

describe("systemOnePrompt", () => {
  it("embeds the state and questions as JSON", () => {
    const prompt = systemOnePrompt({ a: 1 }, QUESTIONS);
    expect(prompt).toContain('{"a":1}');
    expect(prompt).toContain('"fast"');
    expect(prompt).toContain("noul");
  });
});

describe("extractJsonObject", () => {
  it("returns undefined when there is no brace", () => {
    expect(extractJsonObject("no json here")).toBeUndefined();
  });

  it("ignores braces inside strings", () => {
    expect(extractJsonObject('x {"a":"}"} y')).toBe('{"a":"}"}');
  });

  it("returns the first balanced object", () => {
    expect(extractJsonObject('pre {"a":{"b":1}} post')).toBe('{"a":{"b":1}}');
  });
});

describe("normalizeAnswer", () => {
  it("keeps a valid choice", () => {
    const q: SystemOneQuestion = {
      type: "choice",
      instructions: "i",
      criteria: { a: null, b: null },
    };
    expect(normalizeAnswer(q, { choice: "b", confidence: 0.7 })).toMatchObject({
      type: "choice",
      choice: "b",
    });
  });

  it("drops a choice that is not a criterion", () => {
    const q: SystemOneQuestion = {
      type: "choice",
      instructions: "i",
      criteria: { a: null, b: null },
    };
    expect(normalizeAnswer(q, { choice: "zzz" })).toBeUndefined();
  });

  it("clamps noul into [0,1]", () => {
    const q: SystemOneQuestion = { type: "noul", instructions: "i" };
    expect(normalizeAnswer(q, { noul: 5 })).toEqual({ type: "noul", noul: 1 });
  });

  it("clamps a score into the criteria range", () => {
    const q: SystemOneQuestion = { type: "score", instructions: "i", criteria: ["lo", "hi"] };
    expect(normalizeAnswer(q, { score: 9 })).toMatchObject({ type: "score", score: 1 });
  });

  it("drops a non-object answer", () => {
    const q: SystemOneQuestion = { type: "noul", instructions: "i" };
    expect(normalizeAnswer(q, "junk")).toBeUndefined();
  });
});

/** A `DecisionBackend` that records its call and returns a canned verdict. */
class ScriptedBackend {
  readonly id = "scripted";
  readonly model = "gpt-4o-mini";
  calls = 0;
  async answer(): Promise<SystemOneResponse> {
    this.calls += 1;
    return { model: this.model, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

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

describe("AgentRuntime.systemOneProvider backend injection", () => {
  it("uses the injected backend instead of constructing an Ollama one", async () => {
    const runtime = new AgentRuntime({ dbPath: ":memory:", sessionId: "inject" });
    const backend = new ScriptedBackend();
    const provider = runtime.systemOneProvider(CATALOG, { backend });

    await provider({
      messages: [{ role: "user", content: "deploy" }],
      tools: [],
    });

    expect(backend.calls).toBe(1);
  });
});
