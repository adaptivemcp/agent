#!/usr/bin/env node
import { AggregateToolset } from "./mcp/toolset.js";
import { StdioToolset } from "./mcp/stdio.js";
import { AgentRuntime } from "./runtime.js";
import { runAgent } from "./agent/loop.js";
import { createAiSdkModel } from "./provider/ai-sdk.js";
import { parseServer, providerConfigFromEnv } from "./config.js";

interface CliArgs {
  prompt?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  servers: string[];
  db?: string;
  yaml?: string;
  maxSteps?: number;
  listTools: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { servers: [], listTools: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${flag}`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--prompt":
        args.prompt = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--base-url":
        args.baseUrl = next();
        break;
      case "--api-key":
        args.apiKey = next();
        break;
      case "--server":
        args.servers.push(next());
        break;
      case "--db":
        args.db = next();
        break;
      case "--yaml":
        args.yaml = next();
        break;
      case "--max-steps":
        args.maxSteps = Number(next());
        break;
      case "--list-tools":
        args.listTools = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (flag !== undefined && !flag.startsWith("--") && args.prompt === undefined) args.prompt = flag;
        break;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`adaptivemcp-agent

Usage:
  adaptivemcp-agent --server "name=command args" [--prompt "..."] [options]

Options:
  --server <name=command args>  MCP server over stdio (repeatable)
  --prompt <text>               User prompt
  --model <id>                  Model id (default: env AI_MODEL or gpt-4o-mini)
  --base-url <url>              OpenAI-compatible base URL (default: env AI_BASE_URL)
  --api-key <key>               API key (default: env AI_API_KEY)
  --db <path>                   SQLite store path (default: in-memory)
  --yaml <path>                 Write the derived tools-metadata view here
  --max-steps <n>               Max agent steps (default: 8)
  --list-tools                  List discovered tools and exit
  -h, --help                    Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.servers.length === 0) {
    console.error("error: at least one --server is required\n");
    printHelp();
    process.exitCode = 1;
    return;
  }

  const envProvider = providerConfigFromEnv();
  const toolsets = args.servers.map((spec) => {
    const options = parseServer(spec);
    return new StdioToolset(options.serverName, options);
  });
  const tools = new AggregateToolset(toolsets);

  try {
    const specs = await tools.listTools();
    if (args.listTools) {
      for (const spec of specs) console.log(`${spec.name}\t${spec.description ?? ""}`);
      return;
    }

    const runtime = new AgentRuntime({
      dbPath: args.db,
      yamlPath: args.yaml,
      sessionId: `cli-${Date.now()}`,
      invoke: (name, input) => tools.callTool(name, input),
    });
    const model = createAiSdkModel({
      model: args.model ?? envProvider.model,
      baseURL: args.baseUrl ?? envProvider.baseURL,
      apiKey: args.apiKey ?? envProvider.apiKey,
    });

    const result = await runAgent({
      model,
      tools: specs,
      executor: runtime,
      maxSteps: args.maxSteps ?? 8,
      // Apply learned decoding recommendations to each completion.
      decoding: runtime.decodingProvider(model.capabilities),
      messages: [
        { role: "system", content: "You are an MCP-native agent. Use the available tools when helpful." },
        { role: "user", content: args.prompt ?? "List the tools you have, then stop." },
      ],
      onEvent: (event) => {
        if (event.type === "assistant_text") console.log(event.text);
        if (event.type === "decoding_applied") {
          console.log(`· decoding ${JSON.stringify(event.params)}`);
        }
        if (event.type === "tool_call") {
          console.log(`→ ${event.call.name}(${JSON.stringify(event.call.input ?? {})})`);
        }
        if (event.type === "tool_result") {
          console.log(event.result.ok ? `✓ ${JSON.stringify(event.result.output)}` : `✗ ${event.result.error}`);
        }
      },
    });

    console.log(`\n[agent] stop=${result.stopReason} steps=${result.steps}`);
    console.log(`\n[tools-metadata]\n${runtime.toolsMetadata()}`);
    runtime.close();
  } finally {
    await tools.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
