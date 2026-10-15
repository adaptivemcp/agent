/**
 * CLI argument parsing and resolution — pure and side-effect-free so it can be
 * unit-tested offline (`src/cli-args.test.ts`). `src/cli.ts` owns process/IO: it
 * imports these, wires them into the runtime, and is exercised via the CLI.
 *
 * Keeping the parser out of `cli.ts` also matters because that entry point runs
 * `main()` at import time, which makes it un-importable from a test.
 */
import { OpenAiSystemOneBackend, type DecisionBackend } from "./decision/systemone.js";

export interface CliArgs {
  prompt?: string;
  /** Catalog id to pin (disables adaptive model selection). */
  model?: string;
  /** Catalog file for extra/overridden integrations. */
  models?: string;
  /** Disable Ollama /api/tags auto-discovery. */
  noOllama: boolean;
  /** Enable the System One fast decision layer. */
  system1: boolean;
  /** System One model id (default: $SYSTEM1_MODEL, else tev1:0.8b). */
  system1Model?: string;
  /** System One decision backend tier (default: ollama). */
  system1Backend?: "ollama" | "openai";
  baseUrl?: string;
  apiKey?: string;
  servers: string[];
  /** Local fallback risk for tools whose server ships no MCP annotations. */
  defaultRisk: "low" | "medium" | "high" | "none";
  /** Poll long-running tool jobs (payloads carrying a job handle) to completion. */
  awaitJobs: boolean;
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

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
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
      case "--no-ollama":
        args.noOllama = true;
        break;
      case "--await-jobs":
        args.awaitJobs = true;
        break;
      case "--system1":
        args.system1 = true;
        break;
      case "--system1-model":
        args.system1Model = next();
        break;
      case "--system1-backend": {
        const value = next();
        if (value !== "ollama" && value !== "openai") {
          throw new Error(`--system1-backend expects ollama|openai, got "${value}"`);
        }
        args.system1Backend = value;
        break;
      }
      case "--base-url":
        args.baseUrl = next();
        break;
      case "--api-key":
        args.apiKey = next();
        break;
      case "--server":
        args.servers.push(next());
        break;
      case "--default-risk": {
        const value = next();
        if (value !== "low" && value !== "medium" && value !== "high" && value !== "none") {
          throw new Error(`--default-risk expects low|medium|high|none, got "${value}"`);
        }
        args.defaultRisk = value;
        break;
      }
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
        if (flag !== undefined && !flag.startsWith("--") && args.prompt === undefined)
          args.prompt = flag;
        break;
    }
  }
  return args;
}

/**
 * Resolve which System One decision backend the CLI should use.
 *
 * Selection precedence: `--system1-backend` > `$SYSTEM1_BACKEND` > `ollama`.
 * For the `ollama` tier this returns `undefined`, meaning "let
 * `AgentRuntime.systemOneProvider` build its local default" — the local tier's
 * model/URL resolution (`$SYSTEM1_MODEL`/`$OLLAMA_BASE_URL`/`tev1:0.8b`) stays
 * owned by the runtime so there is one source of construction.
 *
 * The `openai` tier builds an `OpenAiSystemOneBackend`; its connection
 * defaults (`$SYSTEM1_BASE_URL` else OpenAI, `$SYSTEM1_API_KEY`/`$OPENAI_API_KEY`)
 * resolve inside the backend, and the model must come from `--system1-model`
 * or `$SYSTEM1_MODEL` — there is deliberately no guessed default, because a
 * wrong hosted model name is a runtime 404 on a remote endpoint.
 *
 * @throws Error when the tier value is neither `ollama` nor `openai`, or when
 * the `openai` tier has no model configured (callers map this to
 * `ExitCode.Config`).
 * @param fetchImpl Injectable fetch, for tests (the remote tier's wire shape
 * can then be asserted offline).
 */
export function system1BackendFor(
  args: Pick<CliArgs, "system1Backend" | "system1Model">,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): DecisionBackend | undefined {
  const envTier = env.SYSTEM1_BACKEND || undefined;
  if (envTier !== undefined && envTier !== "ollama" && envTier !== "openai") {
    throw new Error(`$SYSTEM1_BACKEND expects ollama|openai, got "${envTier}"`);
  }
  const tier = args.system1Backend ?? envTier ?? "ollama";
  if (tier === "ollama") return undefined;

  const model = args.system1Model || env.SYSTEM1_MODEL || undefined;
  if (model === undefined) {
    throw new Error(
      "--system1-backend openai needs a decision model: pass --system1-model <id> or set $SYSTEM1_MODEL",
    );
  }
  return new OpenAiSystemOneBackend({ model, env, fetchImpl });
}

export const HELP_TEXT = `adaptivemcp-agent

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
  --no-ollama                   Don't auto-discover models from a local Ollama
  --system1                     Enable the System One fast decision layer (Ollama or OpenAI)
  --system1-model <id>          System One model (default: $SYSTEM1_MODEL, tev1:0.8b)
  --system1-backend <tier>      Decision backend: ollama|openai (default: $SYSTEM1_BACKEND, ollama)
  --default-risk <level>        Risk for tools whose server sends no MCP annotations
                                (low|medium|high|none; default medium)
  --await-jobs                  Poll long-running tool jobs (job handles) to completion
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
`;

export function printHelp(): void {
  console.log(HELP_TEXT);
}
