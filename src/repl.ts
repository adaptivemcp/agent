import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { runAgent } from "./agent/loop.js";
import type { RunAgentOptions } from "./agent/loop.js";
import { createReplRenderer, makeColor, preview } from "./render.js";
import type { AgentExecutor, ChatMessage } from "./types.js";

/** The runtime hooks the REPL uses for human-in-the-loop approvals. */
export interface ApprovalHost {
  setRequestApproval(requestApproval: (toolName: string) => boolean | Promise<boolean>): void;
  approvalReason?(toolName: string): string | undefined;
}

/**
 * A REPL is a *host*: it runs the same loop as a one-shot turn, so it takes the
 * loop's options rather than re-listing the useful ones.
 *
 * That is deliberate. A hand-picked list silently dropped `steer` (so
 * `--plan-interval` did nothing in the REPL) and `stopGuard` (so `--mode tasks`
 * could end a turn with its list unfinished) — the same class of bug as a mode
 * whose tools were wired but whose runner was not. Inheriting the loop's options
 * means a new seam is forwarded by default, and omitting one has to be written
 * down here.
 */
export interface ReplOptions extends Omit<RunAgentOptions, "messages" | "onEvent" | "executor"> {
  executor: AgentExecutor & Partial<ApprovalHost>;
  /** System prompt for the turn (the REPL keeps the conversation across turns). */
  system?: string;
  /** Prompt y/n when the gate returns require_confirmation (default true). */
  approvals?: boolean;
  /** Learned context injected into the system message each turn. */
  context?: () => string;
  /** Text for `/cost`. */
  cost?: () => string;
  /** Text for `/policy` (server-governed policy in effect). */
  policy?: () => string;
  /** Text for `/drift` (recent-vs-lifetime metric drift). */
  drift?: () => string;
  /** Retrieve a compressed tool output's original by hash (`/retrieve <hash>`). */
  retrieve?: (hash: string) => Promise<string>;
  /** JSON file to persist/restore the conversation across runs. */
  historyPath?: string;
  /** Text for `/metadata` (e.g. the derived tools-metadata view). */
  metadata?: () => string;
  /** Text for `/decoding <tool>`. */
  decodingFor?: (toolName: string) => string | undefined;
  /** Text for `/decoding-report` (accumulated decoding telemetry). */
  decodingReport?: () => string;
  /** Text for `/graph` (the session's execution-graph tree). */
  graph?: () => string;
  /** Text for `/steps` (the session's typed memory steps, read back). */
  steps?: () => string;
  /** Text for `/models` (the model catalog). */
  models?: () => string;
  /** Text for `/decision` (the last System One decision). */
  decision?: () => string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const DEFAULT_SYSTEM =
  "You are an MCP-native agent. Use the available tools when helpful. " + "Keep answers concise.";

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
      `${color.dim("commands: /help, /tools, /models, /graph, /metadata, /cost, /policy, /drift, /retrieve <hash>, /decoding <tool>, /decoding-report, /decision, /reset, /exit")}\n\n`,
  );

  // One shared renderer (src/render.ts), the same one the one-shot CLI uses at
  // a lower density. It owns the "am I mid-line?" state, so a prompt always
  // starts on a fresh line after streamed text.
  const { render, ensureNewline, prompt, reset } = createReplRenderer({ output, color });

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
                "  /steps              show this session's tasks, actions and plans\n" +
                "  /metadata           print the derived tools-metadata view\n" +
                "  /cost               show recorded cost per tool\n" +
                "  /policy             show the server-governed policy in effect\n" +
                "  /drift              show recent-vs-lifetime metric drift\n" +
                "  /retrieve [hash]     fetch a compressed tool output's original (default: last)\n" +
                "  /decoding <tool>    show the learned decoding recommendation for a tool\n" +
                "  /decoding-report    summarized applied-decoding telemetry\n" +
                "  /decision           show the last System One decision\n" +
                "  /reset              clear the conversation\n" +
                "  /exit               quit\n",
            );
            continue;
          case "/tools":
            for (const tool of options.tools) {
              output.write(
                `  ${tool.name}${tool.serverName ? color.dim(` [${tool.serverName}]`) : ""}\n`,
              );
              if (tool.description)
                output.write(color.dim(`    ${preview(tool.description, 160)}\n`));
            }
            continue;
          case "/models":
            output.write(
              options.models ? `${options.models()}\n` : color.dim("(no model catalog)\n"),
            );
            continue;
          case "/graph":
            output.write(options.graph ? `${options.graph()}\n` : color.dim("(no graph view)\n"));
            continue;
          case "/metadata":
            output.write(
              options.metadata ? `${options.metadata()}\n` : color.dim("(no metadata view)\n"),
            );
            continue;
          case "/cost":
            output.write(options.cost ? `${options.cost()}\n` : color.dim("(no cost data)\n"));
            continue;
          case "/steps":
            output.write(options.steps ? `${options.steps()}\n` : color.dim("(no history)\n"));
            continue;
          case "/policy":
            output.write(options.policy ? `${options.policy()}\n` : color.dim("(no policy)\n"));
            continue;
          case "/drift":
            output.write(options.drift ? `${options.drift()}\n` : color.dim("(no drift data)\n"));
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
              output.write(
                suggestion ? `${suggestion}\n` : color.dim(`(no recommendation for ${arg} yet)\n`),
              );
            }
            continue;
          case "/decoding-report":
            output.write(
              options.decodingReport
                ? `${options.decodingReport()}\n`
                : color.dim("(no decoding telemetry)\n"),
            );
            continue;
          case "/decision":
            output.write(
              options.decision ? `${options.decision()}\n` : color.dim("(no decision layer)\n"),
            );
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
      reset();
      prompt(color.dim("agent> "));
      try {
        // Every run seam is forwarded, not re-listed: a hand-picked list is how
        // `steer` and `stopGuard` went missing here (see `ReplOptions`).
        const result = await runAgent({ ...options, messages: next, onEvent: render });
        messages = result.messages;
        ensureNewline();
        persistHistory();
      } catch (error) {
        ensureNewline();
        output.write(
          color.red(`error: ${error instanceof Error ? error.message : String(error)}\n`),
        );
      }
    }
  } finally {
    rl.close();
    output.write("\n");
  }
}
