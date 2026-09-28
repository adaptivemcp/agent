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

/** Parse a `name=command arg1 arg2` server spec. */
export function parseServer(spec: string): StdioToolsetOptions {
  const separator = spec.indexOf("=");
  if (separator <= 0) {
    throw new Error(`invalid server spec "${spec}" (expected "name=command args")`);
  }
  const serverName = spec.slice(0, separator).trim();
  const tokens = spec
    .slice(separator + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const command = tokens[0];
  if (!command) throw new Error(`invalid server spec "${spec}" (missing command)`);
  return { serverName, command, args: tokens.slice(1) };
}

export function parseServers(specs: string[]): StdioToolsetOptions[] {
  return specs.map(parseServer);
}

/** Read provider/store settings from the environment (CLI flags override these). */
export function providerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiSdkProviderConfig {
  return {
    model: env.AI_MODEL,
    baseURL: env.AI_BASE_URL,
    apiKey: env.AI_API_KEY,
  };
}
