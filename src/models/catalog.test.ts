import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog, builtinIntegrations, loadCatalog } from "./catalog.js";
import type { ModelIntegration } from "./types.js";

const LOCAL: ModelIntegration = {
  id: "local",
  provider: "openai-compatible",
  model: "Qwen/Qwen3-8B",
  baseURL: "http://127.0.0.1:9931/v1",
  apiKeyEnv: "LLAMA_API_KEY",
  costWeight: 1,
  latencyWeight: 1,
  default: true,
};

const FAST: ModelIntegration = {
  id: "fast",
  provider: "anthropic",
  model: "claude-x",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  costWeight: 2,
  latencyWeight: 0.5,
};

describe("ModelCatalog", () => {
  it("keeps only integrations whose key is available", () => {
    const catalog = new ModelCatalog([LOCAL, FAST], { LLAMA_API_KEY: "k" });
    expect(catalog.list().map((integration) => integration.id)).toEqual(["local"]);
    expect(catalog.defaultId).toBe("local");
    expect(catalog.has("fast")).toBe(false);
  });

  it("throws when no integration is available", () => {
    expect(() => new ModelCatalog([FAST], {})).toThrow(/no available models/);
  });

  it("exposes routing options with cost/latency weights", () => {
    const catalog = new ModelCatalog([LOCAL, FAST], { LLAMA_API_KEY: "k", ANTHROPIC_API_KEY: "a" });
    expect(catalog.routingOptions()).toEqual([
      { id: "local", costWeight: 1, latencyWeight: 1 },
      { id: "fast", costWeight: 2, latencyWeight: 0.5 },
    ]);
  });

  it("honors an explicit default and describes the catalog", () => {
    const catalog = new ModelCatalog(
      [LOCAL, FAST],
      { LLAMA_API_KEY: "k", ANTHROPIC_API_KEY: "a" },
      "fast",
    );
    expect(catalog.defaultId).toBe("fast");
    expect(catalog.describe()).toContain("fast (default)");
    expect(catalog.describe()).toContain("anthropic/claude-x");
  });

  it("rejects an unknown explicit default", () => {
    expect(() => new ModelCatalog([LOCAL], { LLAMA_API_KEY: "k" }, "nope")).toThrow(/not an available model/);
  });

  it("loads built-ins and merges a catalog file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-models-"));
    const file = join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({
        default: "local",
        models: [
          { id: "local", model: "Qwen/Qwen3-8B", apiKeyEnv: "LLAMA_API_KEY" },
          {
            id: "custom",
            provider: "openai-compatible",
            model: "custom-model",
            baseURL: "http://example.test/v1",
            apiKeyEnv: "CUSTOM_KEY",
            costWeight: 9,
          },
        ],
      }),
    );

    const catalog = loadCatalog({ file, env: { LLAMA_API_KEY: "k", CUSTOM_KEY: "c" } });
    expect(catalog.list().map((integration) => integration.id).sort()).toEqual(["custom", "local"]);
    expect(catalog.defaultId).toBe("local");
    expect(catalog.routingOptions()).toContainEqual({ id: "custom", costWeight: 9, latencyWeight: 1 });
  });

  it("built-ins require their keys (local needs LLAMA/AI key)", () => {
    const withKey = builtinIntegrations({ LLAMA_API_KEY: "k" });
    expect(withKey.map((integration) => integration.id)).toContain("local");
    const noKey = builtinIntegrations({});
    expect(noKey.every((integration) => integration.apiKeyEnv !== undefined)).toBe(true);
  });
});
