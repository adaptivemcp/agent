import { describe, it, expect, vi } from "vitest";
import { HELP_TEXT, parseArgs, printHelp, system1BackendFor, type CliArgs } from "./cli-args.js";
import type { SystemOneQuestion, SystemOneResponse } from "./decision/systemone.js";

/** Minimal resolver input: only the system1 fields matter. */
function args(
  overrides: Partial<Pick<CliArgs, "system1Backend" | "system1Model">> = {},
): Pick<CliArgs, "system1Backend" | "system1Model"> {
  return { system1Backend: undefined, system1Model: undefined, ...overrides };
}

/** A `fetch` stub that records the request and returns a canned body. */
function stubFetch(reply: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const QUESTIONS: Record<string, SystemOneQuestion> = {
  route: {
    type: "choice",
    instructions: "Route the request.",
    criteria: { fast: null, safe: null },
  },
};

describe("parseArgs --system1-backend", () => {
  it("accepts ollama and openai", () => {
    expect(parseArgs(["--system1-backend", "ollama"]).system1Backend).toBe("ollama");
    expect(parseArgs(["--system1-backend", "openai"]).system1Backend).toBe("openai");
  });

  it("rejects any other tier with a usage error", () => {
    expect(() => parseArgs(["--system1-backend", "anthropic"])).toThrow(/ollama\|openai/);
  });
});

describe("parseArgs coverage of the full flag surface", () => {
  it("parses every documented flag", () => {
    const args = parseArgs([
      "--prompt",
      "hello",
      "--model",
      "gpt-4o",
      "--models",
      "catalog.json",
      "--no-ollama",
      "--await-jobs",
      "--system1",
      "--system1-model",
      "tev1:0.8b",
      "--system1-backend",
      "openai",
      "--base-url",
      "http://localhost:1234/v1",
      "--api-key",
      "sk-test",
      "--server",
      "fs=npx fs",
      "--server",
      "qc=qc mcp",
      "--default-risk",
      "high",
      "--db",
      "agent.db",
      "--yaml",
      "meta.yaml",
      "--max-steps",
      "3",
      "--router-min-invocations",
      "5",
      "--session",
      "s1",
      "--history",
      "hist.json",
      "--workflow",
      "wf1",
      "--compress",
      "--report",
      "--no-server-policy",
      "--list-tools",
      "--interactive",
      "--no-stream",
      "--yes",
      "--no-context",
      "--verbose",
      "--help",
    ]);
    expect(args).toMatchObject({
      prompt: "hello",
      model: "gpt-4o",
      models: "catalog.json",
      noOllama: true,
      awaitJobs: true,
      system1: true,
      system1Model: "tev1:0.8b",
      system1Backend: "openai",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "sk-test",
      servers: ["fs=npx fs", "qc=qc mcp"],
      defaultRisk: "high",
      db: "agent.db",
      yaml: "meta.yaml",
      maxSteps: 3,
      routerMinInvocations: 5,
      session: "s1",
      history: "hist.json",
      workflow: "wf1",
      compress: true,
      report: true,
      serverPolicy: false,
      listTools: true,
      interactive: true,
      noStream: true,
      autoApprove: true,
      context: false,
      verbose: true,
      help: true,
    });
  });

  it("uses safe defaults when no flags are given", () => {
    const args = parseArgs([]);
    expect(args).toMatchObject({
      servers: [],
      listTools: false,
      interactive: false,
      defaultRisk: "medium",
      awaitJobs: false,
      noStream: false,
      autoApprove: false,
      context: true,
      compress: false,
      report: false,
      serverPolicy: true,
      noOllama: false,
      system1: false,
      verbose: false,
      help: false,
    });
    expect(args.prompt).toBeUndefined();
    expect(args.system1Backend).toBeUndefined();
  });

  it("takes the first bare word as the prompt and ignores later ones", () => {
    expect(parseArgs(["first", "second"]).prompt).toBe("first");
  });

  it("ignores unknown --flags", () => {
    expect(parseArgs(["--unknown"]).prompt).toBeUndefined();
  });

  it("throws when a value flag is missing its value", () => {
    expect(() => parseArgs(["--prompt"])).toThrow(/missing value for --prompt/);
    expect(() => parseArgs(["--system1-backend"])).toThrow(/missing value/);
  });

  it("rejects an invalid --default-risk", () => {
    expect(() => parseArgs(["--default-risk", "extreme"])).toThrow(/low\|medium\|high\|none/);
  });

  it("accepts the short aliases", () => {
    const args = parseArgs(["-i", "-y", "-v", "-h"]);
    expect(args).toMatchObject({ interactive: true, autoApprove: true, verbose: true, help: true });
  });
});

describe("system1BackendFor", () => {
  it("defaults to the local Ollama tier (undefined = runtime default)", () => {
    expect(system1BackendFor(args(), {})).toBeUndefined();
  });

  it("keeps the ollama tier as undefined even when explicitly selected", () => {
    expect(system1BackendFor(args({ system1Backend: "ollama" }), {})).toBeUndefined();
  });

  it("falls back to $SYSTEM1_BACKEND for the tier", () => {
    expect(
      system1BackendFor(args(), { SYSTEM1_BACKEND: "openai", SYSTEM1_MODEL: "gpt-4o-mini" }),
    ).toBeDefined();
    expect(system1BackendFor(args(), { SYSTEM1_BACKEND: "ollama" })).toBeUndefined();
  });

  it("lets the flag win over $SYSTEM1_BACKEND", () => {
    const flagWins = system1BackendFor(args({ system1Backend: "ollama" }), {
      SYSTEM1_BACKEND: "openai",
      SYSTEM1_MODEL: "gpt-4o-mini",
    });
    expect(flagWins).toBeUndefined();
  });

  it("rejects an invalid $SYSTEM1_BACKEND value", () => {
    expect(() => system1BackendFor(args(), { SYSTEM1_BACKEND: "gemini" })).toThrow(
      /\$SYSTEM1_BACKEND/,
    );
  });

  it("fails fast when the openai tier has no configured model", () => {
    expect(() => system1BackendFor(args({ system1Backend: "openai" }), {})).toThrow(
      /--system1-model/,
    );
  });

  it("takes the model from --system1-model before $SYSTEM1_MODEL", () => {
    const backend = system1BackendFor(
      args({ system1Backend: "openai", system1Model: "flag-model" }),
      { SYSTEM1_MODEL: "env-model" },
    );
    expect(backend?.model).toBe("flag-model");
  });

  it("takes the model from $SYSTEM1_MODEL when the flag is absent", () => {
    const backend = system1BackendFor(args({ system1Backend: "openai" }), {
      SYSTEM1_MODEL: "env-model",
    });
    expect(backend?.model).toBe("env-model");
  });

  it("builds the remote tier with tier=1 and an openai id", () => {
    const backend = system1BackendFor(
      args({ system1Backend: "openai", system1Model: "gpt-4o-mini" }),
      {},
    );
    expect(backend?.tier).toBe(1);
    expect(backend?.id).toBe("openai:gpt-4o-mini");
  });
});

describe("openai tier end-to-end (injected fetch)", () => {
  it("reaches /chat/completions with auth, prompt, and coerces the reply", async () => {
    const reply = {
      model: "gpt-4o-mini",
      choices: [
        {
          message: {
            content: 'thinking...\n{"answers":{"route":{"choice":"fast","confidence":0.9}}}',
          },
        },
      ],
      usage: { prompt_tokens: 42, completion_tokens: 7 },
    };
    const { fetchImpl, calls } = stubFetch(reply);
    const backend = system1BackendFor(
      args({ system1Backend: "openai", system1Model: "gpt-4o-mini" }),
      { SYSTEM1_BASE_URL: "https://gw.example/v1", SYSTEM1_API_KEY: "sk-test" },
      fetchImpl,
    );
    expect(backend).toBeDefined();

    const res: SystemOneResponse = await backend!.answer({ note: "hi" }, QUESTIONS);

    // Wire shape: OpenAI-compatible chat completions + bearer auth.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gw.example/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(calls[0].init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("gpt-4o-mini");
    const userContent = body.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userContent).toContain('"route"'); // questions reach the prompt

    // Coercion: JSON extracted from prose, answers normalized, usage mapped.
    expect(res.model).toBe("gpt-4o-mini");
    expect(res.answers.route).toMatchObject({ type: "choice", choice: "fast" });
    expect(res.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
  });

  it("drops answers whose choice is not a criteria key", async () => {
    const reply = {
      choices: [
        { message: { content: '{"answers":{"route":{"choice":"bogus","confidence":1}}}' } },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const { fetchImpl } = stubFetch(reply);
    const backend = system1BackendFor(
      args({ system1Backend: "openai", system1Model: "m" }),
      {},
      fetchImpl,
    );

    const res = await backend!.answer({}, QUESTIONS);
    expect(res.answers.route).toBeUndefined(); // advisor will decline this signal
  });

  it("throws when the reply carries no JSON object", async () => {
    const { fetchImpl } = stubFetch({
      choices: [{ message: { content: "I refuse to decide." } }],
    });
    const backend = system1BackendFor(
      args({ system1Backend: "openai", system1Model: "m" }),
      {},
      fetchImpl,
    );
    await expect(backend!.answer({}, QUESTIONS)).rejects.toThrow(/no JSON object/);
  });

  it("surfaces a non-2xx status as an error", async () => {
    const failing: typeof fetch = async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
    const backend = system1BackendFor(
      args({ system1Backend: "openai", system1Model: "m" }),
      {},
      failing,
    );
    await expect(backend!.answer({}, QUESTIONS)).rejects.toThrow(/system one 429/);
  });
});

describe("HELP_TEXT", () => {
  it("documents the --system1-backend tier selector", () => {
    expect(HELP_TEXT).toContain("--system1-backend <tier>");
    expect(HELP_TEXT).toContain("ollama|openai");
    expect(HELP_TEXT).toContain("$SYSTEM1_BACKEND");
  });
});

describe("printHelp", () => {
  it("writes the help text to stdout", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      printHelp();
      expect(log).toHaveBeenCalledWith(HELP_TEXT);
    } finally {
      log.mockRestore();
    }
  });
});
