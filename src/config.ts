import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalPolicy } from "@adaptivemcp/approval";
import type { AiSdkProviderConfig } from "./provider/ai-sdk.js";
import type { StdioToolsetOptions } from "./mcp/stdio.js";

export interface AgentConfig {
  provider: AiSdkProviderConfig;
  servers: StdioToolsetOptions[];
  dbPath?: string;
  yamlPath?: string;
  maxSteps: number;
  approvalPolicy?: ApprovalPolicy;
}

/**
 * Dev defaults for the maintainer's machine: a locally running `llama-server`.
 * These are field-wise fallbacks only — explicit `AI_*` env vars (and CLI flags)
 * always win, so setting `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` fully overrides
 * them. Set `AI_MODEL` (etc.) to use a different backend.
 */
export const LOCAL_PROVIDER_DEFAULTS = {
  baseURL: "http://127.0.0.1:9931/v1",
  model: "Qwen/Qwen3-8B",
  apiKeyEnv: "LLAMA_API_KEY",
} as const;

/** Parse a `name=command arg1 arg2` server spec. */
export function parseServer(spec: string): StdioToolsetOptions {
  const trimmed = spec.trim();
  // Rich form: a JSON object, for options the shorthand cannot express
  // (per-server `cwd` and `env`), e.g.
  //   {"name":"qc","command":"/path/.venv/bin/qc","args":["mcp"],
  //    "cwd":"/path/to/project","env":{"QC_SQLITE_PATH":"/path/demo.db"}}
  if (trimmed.startsWith("{")) return parseServerJson(trimmed);

  const separator = trimmed.indexOf("=");
  if (separator <= 0) {
    throw new Error(`invalid server spec "${spec}" (expected "name=command args" or a JSON object)`);
  }
  const serverName = trimmed.slice(0, separator).trim();
  const tokens = trimmed
    .slice(separator + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const command = tokens[0];
  if (!command) throw new Error(`invalid server spec "${spec}" (missing command)`);
  return { serverName, command, args: tokens.slice(1) };
}

/** Parse the JSON-object server spec (per-server `cwd`/`env`/`args`). */
function parseServerJson(spec: string): StdioToolsetOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch (error) {
    throw new Error(`invalid server spec (bad JSON): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid server spec (expected a JSON object)");
  }
  const obj = parsed as Record<string, unknown>;
  const name = obj.name ?? obj.serverName;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("invalid server spec (missing string 'name')");
  }
  if (typeof obj.command !== "string" || obj.command.trim() === "") {
    throw new Error("invalid server spec (missing string 'command')");
  }
  const options: StdioToolsetOptions = { serverName: name.trim(), command: obj.command };

  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args) || obj.args.some((arg) => typeof arg !== "string")) {
      throw new Error("invalid server spec ('args' must be a string[])");
    }
    options.args = obj.args as string[];
  }
  if (obj.env !== undefined) {
    if (typeof obj.env !== "object" || obj.env === null || Array.isArray(obj.env)) {
      throw new Error("invalid server spec ('env' must be an object of strings)");
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj.env)) {
      if (typeof value !== "string") {
        throw new Error("invalid server spec ('env' values must be strings)");
      }
      env[key] = value;
    }
    options.env = env;
  }
  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== "string") throw new Error("invalid server spec ('cwd' must be a string)");
    options.cwd = obj.cwd;
  }
  return options;
}

export function parseServers(specs: string[]): StdioToolsetOptions[] {
  return specs.map(parseServer);
}

/**
 * The default MCP server: the sibling `adaptive-mcp` example server, if it has
 * been built (`../adaptive-mcp/examples/dist/server.js`). The server keeps its
 * own store in memory and writes its derived view under the OS temp dir so it
 * never litters the working directory. Returns `undefined` when the sibling
 * build is absent, so the CLI can fall back to requiring `--server`.
 */
export function exampleServerOptions(): StdioToolsetOptions | undefined {
  const serverPath = fileURLToPath(
    new URL("../../adaptive-mcp/examples/dist/server.js", import.meta.url),
  );
  if (!existsSync(serverPath)) return undefined;

  const dir = join(tmpdir(), "adaptivemcp-agent");
  mkdirSync(dir, { recursive: true });
  return {
    serverName: "adaptive",
    command: process.execPath,
    args: [serverPath],
    env: { ADAPTIVE_YAML: join(dir, "server-tools-metadata.yaml") },
  };
}

/**
 * Provider settings: `AI_*` env vars, falling back to the local llama.cpp dev
 * defaults (see {@link LOCAL_PROVIDER_DEFAULTS}).
 */
export function providerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiSdkProviderConfig {
  return {
    model: env.AI_MODEL ?? LOCAL_PROVIDER_DEFAULTS.model,
    baseURL: env.AI_BASE_URL ?? LOCAL_PROVIDER_DEFAULTS.baseURL,
    apiKey: env.AI_API_KEY ?? env[LOCAL_PROVIDER_DEFAULTS.apiKeyEnv],
  };
}
