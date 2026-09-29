#!/usr/bin/env node
import { AggregateToolset, sanitize } from "./mcp/toolset.js";
import { StdioToolset } from "./mcp/stdio.js";
import {
  HeadroomMiddleware,
  McpHeadroomCompressor,
  type McpCallClient,
  type Middleware,
} from "@adaptivemcp/middleware";
import { TOOLS_METADATA_RESOURCE_URI } from "@adaptivemcp/spec";
import { load as parseYaml } from "js-yaml";
import { AgentRuntime, type ServerToolsMetadata } from "./runtime.js";
import { runAgent } from "./agent/loop.js";
import { runRepl } from "./repl.js";
import { exampleServerOptions, parseServer } from "./config.js";
import { AI_SDK_CAPABILITIES } from "./provider/ai-sdk.js";
import { loadCatalog, type ModelCatalog } from "./models/catalog.js";
import type { AgentEvent, ChatModel } from "./types.js";

interface CliArgs {
  prompt?: string;
  /** Catalog id to pin (disables adaptive model selection). */
  model?: string;
  /** Catalog file for extra/overridden integrations. */
  models?: string;
  baseUrl?: string;
  apiKey?: string;
  servers: string[];
  db?: string;
  yaml?: string;
  maxSteps?: number;
  routerMinInvocations?: number;
  session?: string;
  history?: string;
  workflow?: string;
  compress: boolean;
  report: boolean;
  serverPolicy: boolean;
  listTools: boolean;
  interactive: boolean;
  noStream: boolean;
  autoApprove: boolean;
  context: boolean;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    servers: [],
    listTools: false,
    interactive: false,
    noStream: false,
    autoApprove: false,
    context: true,
    compress: false,
    report: false,
    serverPolicy: true,
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
      case "--models":
        args.models = next();
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
      case "--router-min-invocations":
        args.routerMinInvocations = Number(next());
        break;
      case "--session":
        args.session = next();
        break;
      case "--history":
        args.history = next();
        break;
      case "--workflow":
        args.workflow = next();
        break;
      case "--compress":
        args.compress = true;
        break;
      case "--report":
        args.report = true;
        break;
      case "--no-server-policy":
        args.serverPolicy = false;
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
      case "--yes":
      case "-y":
        args.autoApprove = true;
        break;
      case "--no-context":
        args.context = false;
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
  Adaptive MCP picks the model per tool from the model catalog unless --model
  pins one.

Options:
  --server <name=command args>  MCP server over stdio (repeatable)
                                (default: the sibling adaptive-mcp example server)
  --prompt <text>               One-shot prompt instead of the interactive REPL
  -i, --interactive             Force the interactive REPL
  --model <id>                  Pin one catalog model (disables adaptive selection)
  --models <file>               Catalog file of model integrations (JSON)
  --base-url <url>              Override the local integration's base URL
  --api-key <key>               Override the local integration's API key
  --no-stream                   Disable token streaming
  -y, --yes                     Auto-approve require_confirmation tools (no prompt)
  --no-context                  Don't inject learned tool context into the prompt
  -v, --verbose                 Show decoding, graph, and view after a one-shot run
  --db <path>                   SQLite store path (default: in-memory)
  --yaml <path>                 Write the derived tools-metadata view here
  --max-steps <n>               Max agent steps per turn (default: 8)
  --router-min-invocations <n>  Invocations before the router trusts stats (default: 10)
  --session <id>                Stable session id (accumulate graph/stats across runs)
  --history <file>              Persist/restore the conversation (JSON)
  --workflow <id>               Workflow id for cross-session graph/pattern learning
  --compress                    Compress large tool output via the headroom MCP server
  --report                      Report observations to servers exposing report_observation
  --no-server-policy            Don't read/apply the server's tools-metadata policy
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

  // `--base-url`/`--api-key` override the local integration via the env the
  // built-in catalog reads.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (args.baseUrl) env.AI_BASE_URL = args.baseUrl;
  if (args.apiKey) env.AI_API_KEY = args.apiKey;

  let catalog: ModelCatalog;
  try {
    catalog = loadCatalog({ file: args.models, env });
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  let pinned: ChatModel | undefined;
  if (args.model) {
    pinned = catalog.get(args.model);
    if (!pinned) {
      console.error(
        `error: unknown model "${args.model}". Available: ${catalog.list().map((m) => m.id).join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const defaultModel = pinned ?? catalog.defaultModel();

  const toolsets = serverSpecs.map((options) => new StdioToolset(options.serverName, options));
  const tools = new AggregateToolset(toolsets);

  // Optional output compression via the headroom MCP server.
  const middleware: Middleware[] = [];
  let headroom: StdioToolset | undefined;
  if (args.compress) {
    headroom = new StdioToolset("headroom", {
      serverName: "headroom",
      command: "headroom",
      args: ["mcp", "serve"],
    });
    const client: McpCallClient = {
      async callTool({ name, arguments: input }) {
        const result = await headroom!.callTool(name, input);
        if (!result.ok) throw new Error(result.error ?? `headroom ${name} failed`);
        return {
          content: [
            {
              type: "text",
              text: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
            },
          ],
        };
      },
    };
    middleware.push(new HeadroomMiddleware({ compressor: new McpHeadroomCompressor(client) }));
  }

  try {
    const specs = await tools.listTools();
    if (args.listTools) {
      for (const spec of specs) {
        console.log(`${spec.name}\t${spec.serverName ?? ""}\t${spec.description ?? ""}`);
      }
      return;
    }

    const sessionId = args.session ?? `cli-${Date.now()}`;
    const reportToolByServer = new Map<string, string>();
    for (const spec of specs) {
      if (spec.name.endsWith("report_observation")) {
        reportToolByServer.set(spec.serverName ?? "", spec.name);
      }
    }

    const runtime = new AgentRuntime({
      dbPath: args.db,
      yamlPath: args.yaml,
      sessionId,
      workflowId: args.workflow,
      invoke: (name, input) => tools.callTool(name, input),
      middleware,
      routerModels: catalog.routingOptions(),
      routerMinInvocations: args.routerMinInvocations,
      onExecuted: args.report
        ? (observation) => {
            const reportTool =
              observation.serverName !== undefined
                ? reportToolByServer.get(observation.serverName)
                : undefined;
            if (!reportTool) return;
            void tools
              .callTool(reportTool, {
                tool: observation.toolName,
                status: observation.status === "completed" ? "success" : "failure",
                duration_ms: observation.durationMs,
                cost: observation.cost?.amount,
                timestamp: new Date().toISOString(),
                client_id: sessionId,
              })
              .catch(() => undefined);
          }
        : undefined,
    });
    // Seed risk from standard MCP annotations so approvals can act immediately.
    runtime.seedToolAnnotations(specs);

    // Server-governed policy: read each server's tools-metadata resource.
    if (args.serverPolicy) {
      for (const toolset of toolsets) {
        let text: string | undefined;
        try {
          text = await toolset.readResource(TOOLS_METADATA_RESOURCE_URI);
        } catch {
          text = undefined;
        }
        if (!text) continue;
        try {
          const doc = parseYaml(text) as ServerToolsMetadata;
          // The server publishes bare tool names; map them onto the agent's
          // namespaced spec names for this server.
          const prefix = `${sanitize(toolset.serverName)}_`;
          const rename = new Map<string, string>();
          for (const spec of specs) {
            if (spec.serverName === toolset.serverName && spec.name.startsWith(prefix)) {
              rename.set(spec.name.slice(prefix.length), spec.name);
            }
          }
          const mapped: ServerToolsMetadata = {
            tools: (doc.tools ?? []).map((tool) => ({
              ...tool,
              name: rename.get(tool.name) ?? tool.name,
            })),
          };
          const applied = runtime.applyServerMetadata(mapped, { serverName: toolset.serverName });
          if (args.verbose) {
            console.log(
              `[policy] ${toolset.serverName}: ${applied.annotations} annotations, ` +
                `${applied.approvals} approvals, ${applied.budgets} budgets`,
            );
          }
        } catch {
          // Ignore a malformed policy document.
        }
      }
    }

    const stream = !args.noStream;
    const maxSteps = args.maxSteps ?? 8;
    // Adaptive MCP selects the model per tool unless one was pinned.
    const selectModel = pinned ? undefined : runtime.modelProvider(catalog);
    const capabilities = defaultModel.capabilities ?? AI_SDK_CAPABILITIES;
    const decoding = runtime.decodingProvider(capabilities);

    if (args.interactive || args.prompt === undefined) {
      const serverByTool = new Map(specs.map((spec) => [spec.name, spec.serverName]));
      await runRepl({
        model: defaultModel,
        tools: specs,
        executor: runtime,
        decoding,
        selectModel,
        maxSteps,
        stream,
        approvals: !args.autoApprove,
        context: args.context ? () => runtime.learnedContext() : undefined,
        cost: () => runtime.costSummary(),
        policy: () => runtime.serverPolicySummary(),
        drift: () => runtime.metricDriftReport(),
        historyPath: args.history,
        retrieve: headroom
          ? async (hash) => {
              const resolved = hash && hash !== "last" ? hash : runtime.lastCompressionHash();
              if (!resolved) return "(no compressed output yet)";
              const result = await headroom!.callTool("headroom_retrieve", { hash: resolved });
              return result.ok ? stringify(result.output) : `error: ${result.error}`;
            }
          : undefined,
        metadata: () => runtime.toolsMetadata(),
        graph: () => runtime.graphView(),
        models: () => catalog.describe(),
        decodingFor: (tool) => {
          const recommendation = runtime.suggestDecoding(tool, capabilities, {
            serverName: serverByTool.get(tool),
          });
          return recommendation ? JSON.stringify(recommendation, null, 2) : undefined;
        },
        decodingReport: () => runtime.decodingReport(),
      });
      runtime.close();
      return;
    }

    const baseSystem = "You are an MCP-native agent. Use the available tools when helpful.";
    const learned = args.context ? runtime.learnedContext() : "";
    const result = await runAgent({
      model: defaultModel,
      tools: specs,
      executor: runtime,
      maxSteps,
      decoding,
      selectModel,
      stream,
      messages: [
        { role: "system", content: learned ? `${baseSystem}\n\n${learned}` : baseSystem },
        { role: "user", content: args.prompt },
      ],
      onEvent: (event) => renderOneShot(event, args.verbose),
    });

    console.log(`\n[agent] stop=${result.stopReason} steps=${result.steps}`);
    if (args.verbose) {
      console.log(`\n[execution-graph]\n${runtime.graphView()}`);
      console.log(`\n[tools-metadata]\n${runtime.toolsMetadata()}`);
    }
    runtime.close();
  } finally {
    await tools.close();
    await headroom?.close();
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
    case "model_selected":
      if (verbose) console.log(`· model ${event.model}`);
      break;
    case "usage":
      if (verbose && event.cost !== undefined) console.log(`· cost $${event.cost.toFixed(6)}`);
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
