import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent/loop.js";
import type {
  AgentEvent,
  AgentExecutor,
  ChatMessage,
  ChatModel,
  DecodingProvider,
  ToolSpec,
} from "./types.js";

export interface ReplOptions {
  model: ChatModel;
  tools: ToolSpec[];
  executor: AgentExecutor;
  decoding?: DecodingProvider;
  system?: string;
  maxSteps?: number;
  stream?: boolean;
  /** Text for `/metadata` (e.g. the derived tools-metadata view). */
  metadata?: () => string;
  /** Text for `/decoding <tool>` (a decoding recommendation, if any). */
  decodingFor?: (toolName: string) => string | undefined;
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
  const system = options.system ?? DEFAULT_SYSTEM;
  let messages: ChatMessage[] = [{ role: "system", content: system }];

  const rl = createInterface({
    input,
    output,
    terminal: Boolean((output as NodeJS.WriteStream).isTTY),
  });
  rl.on("SIGINT", () => rl.close());

  output.write(
    `${color.bold("adaptivemcp-agent")} ${color.dim("— interactive")}\n` +
      `${color.dim("model:")} ${options.model.name}  ${color.dim("tools:")} ${options.tools.length}  ` +
      `${color.dim("commands: /help, /tools, /metadata, /decoding <tool>, /reset, /exit")}\n\n`,
  );

  let lineStart = true;
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
                "  /metadata           print the derived tools-metadata view\n" +
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
          case "/metadata":
            output.write(options.metadata ? `${options.metadata()}\n` : color.dim("(no metadata view)\n"));
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
            messages = [{ role: "system", content: system }];
            output.write(color.dim("(conversation reset)\n"));
            continue;
          default:
            output.write(color.dim(`unknown command: ${command} (try /help)\n`));
            continue;
        }
      }

      const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
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
          stream: options.stream,
          onEvent: render,
        });
        messages = result.messages;
        ensureNewline();
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
