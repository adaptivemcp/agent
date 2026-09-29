import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { runAgent } from "./agent/loop.js";
import type {
  AgentEvent,
  AgentExecutor,
  ChatMessage,
  ChatModel,
  DecodingProvider,
  ModelSelector,
  ToolSpec,
} from "./types.js";

/** The runtime hooks the REPL uses for human-in-the-loop approvals. */
export interface ApprovalHost {
  setRequestApproval(requestApproval: (toolName: string) => boolean | Promise<boolean>): void;
  approvalReason?(toolName: string): string | undefined;
}

export interface ReplOptions {
  model: ChatModel;
  tools: ToolSpec[];
  executor: AgentExecutor & Partial<ApprovalHost>;
  decoding?: DecodingProvider;
  selectModel?: ModelSelector;
  system?: string;
  maxSteps?: number;
  stream?: boolean;
  /** Prompt y/n when the gate returns require_confirmation (default true). */
  approvals?: boolean;
  /** Learned context injected into the system message each turn. */
  context?: () => string;
  /** Text for `/cost`. */
  cost?: () => string;
  /** Retrieve a compressed tool output's original by hash (`/retrieve <hash>`). */
  retrieve?: (hash: string) => Promise<string>;
  /** JSON file to persist/restore the conversation across runs. */
  historyPath?: string;
  /** Text for `/metadata` (e.g. the derived tools-metadata view). */
  metadata?: () => string;
  /** Text for `/decoding <tool>` (a decoding recommendation, if any). */
  decodingFor?: (toolName: string) => string | undefined;
  /** Text for `/graph` (the session's execution-graph tree). */
  graph?: () => string;
  /** Text for `/models` (the model catalog). */
  models?: () => string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const DEFAULT_SYSTEM =
  "You are an MCP-native agent. Use the available tools when helpful. " +
  "Keep answers concise.";

/**
 * A line-based, multi-turn REPL over the same library core as `runAgent`.
 * Streams assistant text, renders tool calls/results, and remembers the
 * conversation between turns. Dependency-free (node:readline).
 */
export async function runRepl(options: ReplOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const color = makeColor(output);
  const baseSystem = options.system ?? DEFAULT_SYSTEM;
  let messages: ChatMessage[] = [{ role: "system", content: baseSystem }];

  // Restore a previous conversation, if any, so sessions persist across runs.
  if (options.historyPath && existsSync(options.historyPath)) {
    try {
      const saved = JSON.parse(readFileSync(options.historyPath, "utf8")) as ChatMessage[];
      if (Array.isArray(saved) && saved.length > 0) messages = saved;
    } catch {
      // Ignore an unreadable/corrupt history file.
    }
  }
  if (messages[0]?.role !== "system") messages.unshift({ role: "system", content: baseSystem });
  const persistHistory = (): void => {
    if (!options.historyPath) return;
    try {
      writeFileSync(options.historyPath, JSON.stringify(messages, null, 2));
    } catch {
      // History persistence is best-effort.
    }
  };

  const rl = createInterface({
    input,
    output,
    terminal: Boolean((output as NodeJS.WriteStream).isTTY),
  });
  rl.on("SIGINT", () => rl.close());

  output.write(
    `${color.bold("adaptivemcp-agent")} ${color.dim("— interactive")}\n` +
      `${color.dim("model:")} ${options.model.name}  ${color.dim("tools:")} ${options.tools.length}  ` +
      `${color.dim("commands: /help, /tools, /models, /graph, /metadata, /cost, /retrieve <hash>, /decoding <tool>, /reset, /exit")}\n\n`,
  );

  let lineStart = true;
  let lastModel: string | undefined;
  const ensureNewline = (): void => {
    if (!lineStart) {
      output.write("\n");
      lineStart = true;
    }
  };
  const render = (event: AgentEvent): void => {
    switch (event.type) {
      case "text_delta":
        output.write(event.text);
        lineStart = event.text.endsWith("\n");
        break;
      case "assistant_text":
        ensureNewline();
        output.write(`${event.text}\n`);
        break;
      case "model_selected":
        if (event.model !== lastModel) {
          lastModel = event.model;
          output.write(color.dim(`[${event.model}] `));
        }
        break;
      case "usage":
        if (event.cost !== undefined) {
          ensureNewline();
          output.write(color.dim(`  · $${event.cost.toFixed(6)} (${event.model})\n`));
        }
        break;
      case "guard":
        ensureNewline();
        output.write(color.dim(`  ⚠ ${event.message}\n`));
        break;
      case "tool_call":
        ensureNewline();
        output.write(
          color.dim(`  → ${event.call.name}(${preview(JSON.stringify(event.call.input ?? {}), 160)})\n`),
        );
        break;
      case "tool_result":
        ensureNewline();
        output.write(
          event.result.ok
            ? color.green(`  ✓ ${preview(stringify(event.result.output), 200)}\n`)
            : color.red(`  ✗ ${preview(event.result.error ?? stringify(event.result.output), 200)}\n`),
        );
        break;
      case "decoding_applied":
        // Silent by default; the model is still adapting. Uncomment to surface:
        // output.write(color.dim(`  · decoding ${JSON.stringify(event.params)}\n`));
        break;
    }
  };

  // Human-in-the-loop approvals: prompt for require_confirmation decisions.
  if (options.approvals !== false && options.executor.setRequestApproval) {
    options.executor.setRequestApproval(async (toolName) => {
      ensureNewline();
      const reason = options.executor.approvalReason?.(toolName);
      const answer = await rl.question(
        `${color.bold(`approve ${toolName}?`)}${reason ? color.dim(` — ${reason}`) : ""} ${color.dim("(y/N)")} `,
      );
      return /^y(es)?$/i.test(answer.trim());
    });
  }

  try {
    for (;;) {
      let answer: string;
      try {
        answer = await rl.question(color.cyan("you> "));
      } catch {
        break; // Ctrl+C / EOF closed the interface
      }
      const trimmed = answer.trim();
      if (trimmed === "") continue;

      if (trimmed.startsWith("/")) {
        const [command, ...rest] = trimmed.split(/\s+/);
        const arg = rest.join(" ").trim();
        switch (command) {
          case "/exit":
          case "/quit":
            return;
          case "/help":
            output.write(
              "commands:\n" +
                "  /tools              list discovered tools\n" +
                "  /models             list model integrations (Adaptive MCP picks per tool)\n" +
                "  /graph              show this session's execution-graph DAG\n" +
                "  /metadata           print the derived tools-metadata view\n" +
                "  /cost               show recorded cost per tool\n" +
                "  /retrieve [hash]     fetch a compressed tool output's original (default: last)\n" +
                "  /decoding <tool>    show the learned decoding recommendation for a tool\n" +
                "  /reset              clear the conversation\n" +
                "  /exit               quit\n",
            );
            continue;
          case "/tools":
            for (const tool of options.tools) {
              output.write(`  ${tool.name}${tool.serverName ? color.dim(` [${tool.serverName}]`) : ""}\n`);
              if (tool.description) output.write(color.dim(`    ${preview(tool.description, 160)}\n`));
            }
            continue;
          case "/models":
            output.write(options.models ? `${options.models()}\n` : color.dim("(no model catalog)\n"));
            continue;
          case "/graph":
            output.write(options.graph ? `${options.graph()}\n` : color.dim("(no graph view)\n"));
            continue;
          case "/metadata":
            output.write(options.metadata ? `${options.metadata()}\n` : color.dim("(no metadata view)\n"));
            continue;
          case "/cost":
            output.write(options.cost ? `${options.cost()}\n` : color.dim("(no cost data)\n"));
            continue;
          case "/retrieve":
            if (!options.retrieve) {
              output.write(color.dim("(compression is not enabled)\n"));
            } else {
              ensureNewline();
              output.write(`${await options.retrieve(arg)}\n`);
            }
            continue;
          case "/decoding":
            if (!arg) {
              output.write(color.dim("usage: /decoding <tool>\n"));
            } else {
              const suggestion = options.decodingFor?.(arg);
              output.write(suggestion ? `${suggestion}\n` : color.dim(`(no recommendation for ${arg} yet)\n`));
            }
            continue;
          case "/reset":
            messages = [{ role: "system", content: baseSystem }];
            persistHistory();
            output.write(color.dim("(conversation reset)\n"));
            continue;
          default:
            output.write(color.dim(`unknown command: ${command} (try /help)\n`));
            continue;
        }
      }

      if (options.context) {
        const learned = options.context();
        messages[0] = {
          role: "system",
          content: learned ? `${baseSystem}\n\n${learned}` : baseSystem,
        };
      }

      const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
      lastModel = undefined;
      output.write(color.dim("agent> "));
      lineStart = false;
      try {
        const result = await runAgent({
          model: options.model,
          tools: options.tools,
          executor: options.executor,
          messages: next,
          maxSteps: options.maxSteps,
          decoding: options.decoding,
          selectModel: options.selectModel,
          stream: options.stream,
          onEvent: render,
        });
        messages = result.messages;
        ensureNewline();
        persistHistory();
      } catch (error) {
        ensureNewline();
        output.write(color.red(`error: ${error instanceof Error ? error.message : String(error)}\n`));
      }
    }
  } finally {
    rl.close();
    output.write("\n");
  }
}

function makeColor(output: NodeJS.WritableStream): {
  bold: (text: string) => string;
  dim: (text: string) => string;
  cyan: (text: string) => string;
  green: (text: string) => string;
  red: (text: string) => string;
} {
  const enabled = Boolean((output as NodeJS.WriteStream).isTTY);
  const wrap =
    (code: string) =>
    (text: string): string =>
      enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    cyan: wrap("36"),
    green: wrap("32"),
    red: wrap("31"),
  };
}

function preview(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
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
