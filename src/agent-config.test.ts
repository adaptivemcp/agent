import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig } from "./agent-config.js";
import { parseFlags, resolveArgs, type CliArgs } from "./cli-args.js";

const dirs: string[] = [];
function write(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-config-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadAgentConfig", () => {
  it("reads YAML into the allowed CliArgs subset", () => {
    const file = write(
      "agent.yaml",
      [
        "servers:",
        '  - "qc=qc mcp"',
        "model: gpt-4o-mini",
        "db: .agent/agent.db",
        "maxSteps: 12",
        "compress: true",
        "defaultRisk: high",
        "system1Backend: ollama,openai",
      ].join("\n"),
    );
    expect(loadAgentConfig(file)).toEqual({
      servers: ["qc=qc mcp"],
      model: "gpt-4o-mini",
      db: ".agent/agent.db",
      maxSteps: 12,
      compress: true,
      defaultRisk: "high",
      system1Backend: ["ollama", "openai"],
    });
  });

  it("accepts JSON too (JSON is a YAML subset)", () => {
    const file = write("agent.json", JSON.stringify({ model: "m", session: "dev" }));
    expect(loadAgentConfig(file)).toEqual({ model: "m", session: "dev" });
  });

  it("accepts a single server as a string", () => {
    expect(loadAgentConfig(write("a.yaml", 'servers: "x=cmd"')).servers).toEqual(["x=cmd"]);
  });

  it("treats an empty file as no options", () => {
    expect(loadAgentConfig(write("empty.yaml", ""))).toEqual({});
  });

  it("rejects an unknown key instead of silently ignoring it", () => {
    expect(() => loadAgentConfig(write("typo.yaml", "modle: gpt-4o"))).toThrow(
      /unknown key "modle"/,
    );
  });

  it("rejects wrong types and bad enum values", () => {
    expect(() => loadAgentConfig(write("t.yaml", "maxSteps: many"))).toThrow(/must be a number/);
    expect(() => loadAgentConfig(write("t.yaml", "model: 3"))).toThrow(/must be a string/);
    expect(() => loadAgentConfig(write("t.yaml", "defaultRisk: extreme"))).toThrow(
      /low\|medium\|high\|none/,
    );
    expect(() => loadAgentConfig(write("t.yaml", "system1Backend: gpt"))).toThrow(/ollama\|openai/);
    expect(() => loadAgentConfig(write("t.yaml", "servers: 5"))).toThrow(/servers/);
  });

  it("rejects a non-mapping document", () => {
    expect(() => loadAgentConfig(write("list.yaml", "- a\n- b"))).toThrow(/must be a mapping/);
  });
});

describe("resolveArgs layering", () => {
  const config: Partial<CliArgs> = { model: "from-config", maxSteps: 12, compress: true };

  it("defaults < config < flags", () => {
    const merged = resolveArgs({ model: "from-flag" }, config);
    expect(merged.model).toBe("from-flag"); // flag wins
    expect(merged.maxSteps).toBe(12); // config wins over the default (8)
    expect(merged.compress).toBe(true); // only the config sets it
    expect(merged.context).toBe(true); // untouched default
  });

  it("a flag can override a config value back to the default", () => {
    // config sets compress; --no-compress doesn't exist, but a boolean flag loop
    // proves a flag beats the config even when the value equals the default.
    const merged = resolveArgs({ defaultRisk: "medium" }, { defaultRisk: "high" });
    expect(merged.defaultRisk).toBe("medium");
  });

  it("parseArgs still applies defaults with no config", () => {
    expect(parseFlags(["--model", "m"]).model).toBe("m");
    const merged = resolveArgs(parseFlags(["--model", "m"]));
    expect(merged.context).toBe(true); // a default survives
    expect(merged.maxSteps).toBeUndefined(); // applied later by the CLI (?? 8)
  });
});
