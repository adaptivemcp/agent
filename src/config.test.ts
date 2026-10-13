import { describe, it, expect } from "vitest";
import {
  LOCAL_PROVIDER_DEFAULTS,
  exampleServerOptions,
  parseServer,
  parseServers,
  providerConfigFromEnv,
} from "./config.js";

describe("config", () => {
  it("falls back to the local llama.cpp dev defaults", () => {
    const config = providerConfigFromEnv({});
    expect(config.baseURL).toBe(LOCAL_PROVIDER_DEFAULTS.baseURL);
    expect(config.model).toBe(LOCAL_PROVIDER_DEFAULTS.model);
    expect(config.apiKey).toBeUndefined();
  });

  it("lets AI_* env vars override the local defaults", () => {
    const config = providerConfigFromEnv({
      AI_BASE_URL: "http://example.test/v1",
      AI_MODEL: "some-model",
      AI_API_KEY: "ai-key",
      LLAMA_API_KEY: "llama-key",
    });
    expect(config).toEqual({
      baseURL: "http://example.test/v1",
      model: "some-model",
      apiKey: "ai-key",
    });
  });

  it("reads LLAMA_API_KEY when AI_API_KEY is absent", () => {
    expect(providerConfigFromEnv({ LLAMA_API_KEY: "llama-key" }).apiKey).toBe("llama-key");
  });

  it("parses a name=command spec", () => {
    expect(parseServer("fs=npx -y @modelcontextprotocol/server-filesystem /tmp")).toEqual({
      serverName: "fs",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });
    expect(parseServers(["a=cmd --x", "b=cmd2"]).map((server) => server.serverName)).toEqual(["a", "b"]);
  });

  it("rejects malformed server specs", () => {
    expect(() => parseServer("no-equals")).toThrow(/expected/);
    expect(() => parseServer("fs=")).toThrow(/missing command/);
  });

  it("parses the JSON server spec with cwd and env", () => {
    const spec = JSON.stringify({
      name: "qc",
      command: "/opt/qc/.venv/bin/qc",
      args: ["mcp"],
      cwd: "/work/project",
      env: { QC_SQLITE_PATH: "/work/demo.db" },
    });
    expect(parseServer(spec)).toEqual({
      serverName: "qc",
      command: "/opt/qc/.venv/bin/qc",
      args: ["mcp"],
      cwd: "/work/project",
      env: { QC_SQLITE_PATH: "/work/demo.db" },
    });
  });

  it("rejects malformed JSON server specs", () => {
    expect(() => parseServer("{not json")).toThrow(/bad JSON/);
    expect(() => parseServer("[1,2]")).toThrow(/JSON object/);
    expect(() => parseServer('{"command":"qc"}')).toThrow(/'name'/);
    expect(() => parseServer('{"name":"qc"}')).toThrow(/'command'/);
    expect(() => parseServer('{"name":"qc","command":"qc","env":{"A":1}}')).toThrow(/strings/);
    expect(() => parseServer('{"name":"qc","command":"qc","cwd":1}')).toThrow(/'cwd'/);
  });

  it("parses a JSON HTTP server spec", () => {
    const spec = JSON.stringify({
      name: "remote",
      transport: "http",
      url: "http://127.0.0.1:8765/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(parseServer(spec)).toEqual({
      serverName: "remote",
      transport: "http",
      url: "http://127.0.0.1:8765/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("treats a JSON spec with a url as HTTP even without an explicit transport", () => {
    expect(parseServer('{"name":"r","url":"http://x/mcp"}')).toEqual({
      serverName: "r",
      transport: "http",
      url: "http://x/mcp",
    });
  });

  it("rejects an HTTP spec without a url", () => {
    expect(() => parseServer('{"name":"r","transport":"http"}')).toThrow(/url/);
  });

  it("resolves the sibling example server when it is built", () => {
    const server = exampleServerOptions();
    if (server === undefined) return; // fresh checkout without the sibling build
    expect(server.serverName).toBe("adaptive");
    expect(server.command).toBe(process.execPath);
    expect(server.args?.[0]).toContain("adaptive-mcp/examples/dist/server.js");
    expect(server.env?.ADAPTIVE_YAML).toContain("adaptivemcp-agent");
  });
});
