import { describe, it, expect } from "vitest";
import { discoverOllamaIntegrations, ollamaId } from "./ollama.js";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("discoverOllamaIntegrations", () => {
  it("maps /api/tags models to OpenAI-compatible integrations", async () => {
    const integrations = await discoverOllamaIntegrations({
      fetchImpl: jsonFetch({ models: [{ name: "qwen3.5:4b" }, { name: "tev1:0.8b" }] }),
    });

    expect(integrations.map((integration) => integration.id)).toEqual([
      "ollama-qwen3-5-4b",
      "ollama-tev1-0-8b",
    ]);
    const first = integrations[0]!;
    expect(first.provider).toBe("openai-compatible");
    expect(first.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(first.model).toBe("qwen3.5:4b");
    expect(first.label).toBe("Ollama qwen3.5:4b");
    expect(first.pricing).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
  });

  it("honors a custom base URL from the environment", async () => {
    const integrations = await discoverOllamaIntegrations({
      env: { OLLAMA_BASE_URL: "http://ollama.test:1234/" },
      fetchImpl: jsonFetch({ models: [{ name: "tev1:0.8b" }] }),
    });
    expect(integrations[0]?.baseURL).toBe("http://ollama.test:1234/v1");
  });

  it("degrades to [] when the server is down or errors", async () => {
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await discoverOllamaIntegrations({ fetchImpl: boom })).toEqual([]);
    expect(await discoverOllamaIntegrations({ fetchImpl: jsonFetch({}, 500) })).toEqual([]);
    expect(await discoverOllamaIntegrations({ fetchImpl: jsonFetch({ models: [] }) })).toEqual([]);
  });

  it("slugs model names into stable ids", () => {
    expect(ollamaId("Qwen3.5:4b")).toBe("ollama-qwen3-5-4b");
    expect(ollamaId("tev1:0.8b")).toBe("ollama-tev1-0-8b");
  });
});
