#!/usr/bin/env node
import { AggregateToolset } from "./mcp/toolset.js";
import { StdioToolset } from "./mcp/stdio.js";
import { AgentRuntime } from "./runtime.js";
import { runAgent } from "./agent/loop.js";
import { runRepl } from "./repl.js";
import { createAiSdkModel } from "./provider/ai-sdk.js";
import { exampleServerOptions, parseServer, providerConfigFromEnv } from "./config.js";
import type { AgentEvent } from "./types.js";

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
  interactive: boolean;
  noStream: boolean;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    servers: [],
    listTools: false,
    interactive: false,
    noStream: false,
    verbose: false,
    help: false,
  };
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
      case "--interactive":
      case "-i":
        args.interactive = true;
        break;
      case "--no-stream":
        args.noStream = true;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
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
  adaptivemcp-agent [--prompt "..."] [--server "name=command args"] [options]

  With no --prompt, starts an interactive REPL (streaming, multi-turn).

Options:
  --server <name=command args>  MCP server over stdio (repeatable)
                                (default: the sibling adaptive-mcp example server)
  --prompt <text>               One-shot prompt instead of the interactive REPL
  -i, --interactive             Force the interactive REPL
  --model <id>                  Model id (default: env AI_MODEL or the local llama.cpp server)
  --base-url <url>              OpenAI-compatible base URL (default: env AI_BASE_URL)
  --api-key <key>               API key (default: env AI_API_KEY or LLAMA_API_KEY)
  --no-stream                   Disable token streaming
  -v, --verbose                 Show applied decoding and metadata after the run
  --db <path>                   SQLite store path (default: in-memory)
  --yaml <path>                 Write the derived tools-metadata view here
  --max-steps <n>               Max agent steps per turn (default: 8)
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

  const envProvider = providerConfigFromEnv();
  const providerConfig = {
    model: args.model ?? envProvider.model,
    baseURL: args.baseUrl ?? envProvider.baseURL,
    apiKey: args.apiKey ?? envProvider.apiKey,
  };

  const fallbackServer = exampleServerOptions();
  const serverSpecs =
    args.servers.length > 0
      ? args.servers.map((spec) => parseServer(spec))
      : fallbackServer
        ? [fallbackServer]
        : [];
  if (serverSpecs.length === 0) {
    console.error(
      "error: no MCP server. Pass --server \"name=command args\", or build the sibling\n" +
        "       adaptive-mcp example server (pnpm --filter @adaptivemcp/examples build).\n",
    );
    printHelp();
    process.exitCode = 1;
    return;
  }

  const toolsets = serverSpecs.map((options) => new StdioToolset(options.serverName, options));
  const tools = new AggregateToolset(toolsets);

  try {
    const specs = await tools.listTools();
    if (args.listTools) {
      for (const spec of specs) {
        console.log(`${spec.name}\t${spec.serverName ?? ""}\t${spec.description ?? ""}`);
      }
      return;
    }

    const runtime = new AgentRuntime({
      dbPath: args.db,
      yamlPath: args.yaml,
      sessionId: `cli-${Date.now()}`,
      invoke: (name, input) => tools.callTool(name, input),
    });
    const model = createAiSdkModel(providerConfig);
    const stream = !args.noStream;
    const maxSteps = args.maxSteps ?? 8;

    if (args.interactive || args.prompt === undefined) {
      const serverByTool = new Map(specs.map((spec) => [spec.name, spec.serverName]));
      await runRepl({
        model,
        tools: specs,
        executor: runtime,
        decoding: runtime.decodingProvider(model.capabilities),
        maxSteps,
        stream,
        metadata: () => runtime.toolsMetadata(),
        decodingFor: (tool) => {
          const recommendation = runtime.suggestDecoding(tool, model.capabilities, {
            serverName: serverByTool.get(tool),
          });
          return recommendation ? JSON.stringify(recommendation, null, 2) : undefined;
        },
      });
      runtime.close();
      return;
    }

    const result = await runAgent({
      model,
      tools: specs,
      executor: runtime,
      maxSteps,
      decoding: runtime.decodingProvider(model.capabilities),
      stream,
      messages: [
        { role: "system", content: "You are an MCP-native agent. Use the available tools when helpful." },
        { role: "user", content: args.prompt },
      ],
      onEvent: (event) => renderOneShot(event, args.verbose),
    });

    console.log(`\n[agent] stop=${result.stopReason} steps=${result.steps}`);
    if (args.verbose) console.log(`\n[tools-metadata]\n${runtime.toolsMetadata()}`);
    runtime.close();
  } finally {
    await tools.close();
  }
}

/** Compact one-shot rendering: stream text inline, tool lines underneath. */
function renderOneShot(event: AgentEvent, verbose: boolean): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "assistant_text":
      console.log(event.text);
      break;
    case "decoding_applied":
      if (verbose) console.log(`· decoding ${JSON.stringify(event.params)}`);
      break;
    case "tool_call":
      console.log(`→ ${event.call.name}(${JSON.stringify(event.call.input ?? {})})`);
      break;
    case "tool_result":
      console.log(event.result.ok ? `✓ ${stringify(event.result.output)}` : `✗ ${event.result.error}`);
      break;
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
