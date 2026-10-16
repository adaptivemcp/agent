/**
 * CLI argument parsing and resolution — pure and side-effect-free so it can be
 * unit-tested offline (`src/cli-args.test.ts`). `src/cli.ts` owns process/IO: it
 * imports these, wires them into the runtime, and is exercised via the CLI.
 *
 * Keeping the parser out of `cli.ts` also matters because that entry point runs
 * `main()` at import time, which makes it un-importable from a test.
 */
import {
  OpenAiSystemOneBackend,
  localSystemOneBackend,
  type DecisionBackend,
} from "./decision/systemone.js";

/** A System One decision tier selectable via `--system1-backend`. */
export type System1Tier = "ollama" | "openai";

/**
 * Thrown when a tier selector (`--system1-backend`/`$SYSTEM1_BACKEND`) is
 * malformed: an unknown tier, a duplicate, or more than two tiers (the
 * structural one-fallback cap). `cli.ts` maps it to `ExitCode.Usage`.
 */
export class System1TierError extends Error {}

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
  /** System One decision backend tier(s): one tier, or a comma list for failover (default: ollama). */
  system1Backend?: System1Tier | System1Tier[];
  baseUrl?: string;
  apiKey?: string;
  servers: string[];
  /**
   * Skill directories to load (repeatable). Each holds `<name>/SKILL.md`; the
   * prompt carries the names and descriptions, and the body is read on demand.
   * `./skills` is added automatically when it exists.
   */
  skills: string[];
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
  /** Print the version and exit. */
  version: boolean;
  /** Config file (YAML or JSON) for repeatable runs; flags override it. */
  config?: string;
}

/**
 * Parse a tier selector: a single tier (`ollama`), or a comma list
 * (`ollama,openai`) that selects a failover chain. Whitespace around each
 * element is trimmed (an empty element is invalid, not skipped).
 *
 * @throws System1TierError when an element is not a known tier, the list
 * exceeds two tiers (the structural one-fallback cap of
 * `TieredSystemOneBackend`), or a tier repeats.
 */
export function parseTierList(raw: string, source: string): System1Tier[] {
  const tiers = raw.split(",").map((tier) => tier.trim());
  for (const tier of tiers) {
    if (tier !== "ollama" && tier !== "openai") {
      throw new System1TierError(`${source} expects ollama|openai, got "${raw}"`);
    }
  }
  if (tiers.length > 2) {
    throw new System1TierError(
      `${source} allows at most two tiers (one fallback per decision call), got ${tiers.length} in "${raw}"`,
    );
  }
  if (new Set(tiers).size !== tiers.length) {
    throw new System1TierError(`${source} lists a duplicate tier: "${raw}"`);
  }
  return tiers as System1Tier[];
}

const DEFAULT_ARGS: CliArgs = {
  servers: [],
  skills: [],
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
  version: false,
};

/**
 * Parse argv into only the options actually present, without applying the
 * defaults, so a config file can be merged underneath the flags (flags win).
 */
export function parseFlags(argv: string[]): Partial<CliArgs> {
  const args: Partial<CliArgs> = {};
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
      case "--config":
      case "-c":
        args.config = next();
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
        const tiers = parseTierList(next(), "--system1-backend");
        // Single value stays a string (#21 contract); a comma list becomes an array.
        args.system1Backend = tiers.length === 1 ? tiers[0]! : tiers;
        break;
      }
      case "--base-url":
        args.baseUrl = next();
        break;
      case "--api-key":
        args.apiKey = next();
        break;
      case "--server":
        (args.servers ??= []).push(next());
        break;
      case "--skills":
        (args.skills ??= []).push(next());
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
      case "--version":
      case "-V":
        args.version = true;
        break;
      default:
        // A bare word is the positional prompt shorthand; anything else that
        // looks like an option is a typo — fail loudly rather than silently
        // ignoring it (a dropped `--prompt` used to start the REPL instead).
        if (flag === undefined) break;
        if (flag.startsWith("-")) throw new Error(`unknown option "${flag}"`);
        if (args.prompt === undefined) args.prompt = flag;
        break;
    }
  }
  return args;
}

/**
 * Merge the configuration layers: built-in defaults, then a config file, then
 * the flags (flags win). Pure, so the caller loads the config file itself.
 */
export function resolveArgs(flags: Partial<CliArgs>, config: Partial<CliArgs> = {}): CliArgs {
  return { ...DEFAULT_ARGS, ...config, ...flags };
}

/** Parse argv and apply the defaults (the historical, config-free API). */
export function parseArgs(argv: string[]): CliArgs {
  return resolveArgs(parseFlags(argv));
}

/**
 * Normalize the tier selector into a validated tier list.
 *
 * Precedence: `--system1-backend` > `$SYSTEM1_BACKEND` > `ollama`. The env
 * value is validated eagerly (even when the flag wins) — a garbage
 * `$SYSTEM1_BACKEND` is a config bug worth surfacing either way, matching the
 * single-tier semantics of #21.
 */
function normalizeSystem1Tiers(
  args: Pick<CliArgs, "system1Backend">,
  env: NodeJS.ProcessEnv,
): System1Tier[] {
  const envValue = env.SYSTEM1_BACKEND || undefined;
  const envTiers = envValue !== undefined ? parseTierList(envValue, "$SYSTEM1_BACKEND") : undefined;
  const flag = args.system1Backend;
  if (flag !== undefined) {
    // Re-validate through the same parser so programmatic callers (including
    // an empty array) fail fast with the same messages as parsed input.
    return parseTierList(Array.isArray(flag) ? flag.join(",") : flag, "--system1-backend");
  }
  return envTiers ?? ["ollama"];
}

/** The `openai` element: model from `--system1-model` else `$SYSTEM1_MODEL`, no guessed default. */
function openAiBackendFor(
  args: Pick<CliArgs, "system1Model">,
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): OpenAiSystemOneBackend {
  const model = args.system1Model || env.SYSTEM1_MODEL || undefined;
  if (model === undefined) {
    throw new Error(
      "--system1-backend openai needs a decision model: pass --system1-model <id> or set $SYSTEM1_MODEL",
    );
  }
  return new OpenAiSystemOneBackend({ model, env, fetchImpl });
}

/**
 * The selection `AgentRuntime.systemOneProvider` consumes: either one
 * `backend` (a single tier — `undefined` defers to the provider's local Ollama
 * default) or `backends` (a two-tier failover chain from a comma list).
 */
export interface System1Selection {
  backend?: DecisionBackend;
  backends?: DecisionBackend[];
}

/**
 * Resolve the System One selection for `--system1-backend` / `$SYSTEM1_BACKEND`.
 *
 * Selection precedence: `--system1-backend` > `$SYSTEM1_BACKEND` > `ollama`;
 * either source may be a single tier or a comma list (`ollama,openai`) that
 * maps to `systemOneProvider({ backends })` — a `TieredSystemOneBackend` with
 * **one fallback per decision call** (the cap `parseTierList` enforces by
 * rejecting more than two tiers).
 *
 * Model semantics:
 * - Single tier: unchanged from #19/#21 — `ollama` defers to the provider's
 *   local default (`--system1-model`/`$SYSTEM1_MODEL`/`tev1:0.8b`); `openai`
 *   requires `--system1-model` or `$SYSTEM1_MODEL` (fail-fast, exit 3).
 * - In a tier list the `ollama` element keeps its local default chain
 *   (`$SYSTEM1_MODEL` else `tev1:0.8b`) — the flag is not applied to it,
 *   because one flag cannot name two models and the remote element has no
 *   usable default; so `--system1-backend ollama,openai --system1-model
 *   gpt-4o-mini` runs the local default locally and `gpt-4o-mini` remotely.
 *
 * @throws {System1TierError} on an invalid/duplicate/oversized tier selector
 * (callers map it to `ExitCode.Usage`).
 * @throws Error when the `openai` element has no configured model (callers map
 * it to `ExitCode.Config`).
 * @param fetchImpl Injectable fetch, for tests (both elements' wire shapes can
 * then be asserted offline).
 */
export function resolveSystem1(
  args: Pick<CliArgs, "system1Backend" | "system1Model">,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): System1Selection {
  const tiers = normalizeSystem1Tiers(args, env);
  if (tiers.length === 1) {
    const tier = tiers[0]!;
    return { backend: tier === "ollama" ? undefined : openAiBackendFor(args, env, fetchImpl) };
  }
  return {
    backends: tiers.map((tier) =>
      tier === "ollama"
        ? localSystemOneBackend({ env, fetchImpl })
        : openAiBackendFor(args, env, fetchImpl),
    ),
  };
}

/**
 * Single-tier selection kept from #21: `undefined` = the provider's local
 * Ollama default, an instance = the `openai` tier. Prefer {@link resolveSystem1},
 * which also handles tier lists.
 *
 * Selection precedence, connection defaults, and the missing-model fail-fast
 * are delegated there (single-tier behavior is unchanged).
 *
 * @throws {System1TierError} when the configuration resolves a tier list.
 * @param fetchImpl Injectable fetch, for tests (the remote tier's wire shape
 * can then be asserted offline).
 */
export function system1BackendFor(
  args: Pick<CliArgs, "system1Backend" | "system1Model">,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): DecisionBackend | undefined {
  const tiers = normalizeSystem1Tiers(args, env);
  if (tiers.length !== 1) {
    throw new System1TierError(
      `system1BackendFor() resolves a single tier; use resolveSystem1() for "${tiers.join(",")}"`,
    );
  }
  const tier = tiers[0]!;
  return tier === "ollama" ? undefined : openAiBackendFor(args, env, fetchImpl);
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
  --skills <dir>                Skills directory: <name>/SKILL.md per skill (repeatable;
                                ./skills is added when it exists). Only names and
                                descriptions enter the prompt; bodies load on demand
  --prompt <text>               One-shot prompt instead of the interactive REPL
  -i, --interactive             Force the interactive REPL
  --model <id>                  Pin one catalog model (disables adaptive selection)
  --models <file>               Catalog file of model integrations (JSON)
  -c, --config <file>           Config file (YAML or JSON); flags override it
  --no-ollama                   Don't auto-discover models from a local Ollama
  --system1                     Enable the System One fast decision layer (Ollama or OpenAI)
  --system1-model <id>          System One model (default: $SYSTEM1_MODEL, tev1:0.8b)
  --system1-backend <tier>      Decision tier(s): ollama|openai; a comma list (ollama,openai)
                                enables failover with one fallback per decision call
                                (default: $SYSTEM1_BACKEND, ollama)
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
  -V, --version                 Print the version and exit
`;

export function printHelp(): void {
  console.log(HELP_TEXT);
}
