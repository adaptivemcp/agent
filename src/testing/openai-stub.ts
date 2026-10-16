/**
 * An offline, OpenAI-compatible `/chat/completions` endpoint for end-to-end CLI
 * tests. Point the CLI at it with `--base-url` and a whole run happens without
 * network: flags → catalog → MCP transport → loop → runtime → renderer.
 *
 * The default policy answers a request whose conversation already carries a tool
 * result with text, and one that does not with a tool call — so a test describes
 * *behaviour* rather than ordering. `respond` overrides it when a test needs to
 * tell conversations apart (a delegated child's, say).
 *
 * Test infrastructure, not product code: `tsconfig.json` excludes
 * `src/testing/**`, so none of this is built or published.
 */
import { createServer, type Server, type ServerResponse } from "node:http";

export interface StubRequest {
  model: string;
  messages: Array<{ role: string; content?: string | null; tool_call_id?: string }>;
}

export type StubAnswer = { text: string } | { toolName: string; toolInput?: unknown };

export interface StubModelOptions {
  /** Tool to call while nothing has been called yet (default `fixture_echo`). */
  toolName?: string;
  toolInput?: unknown;
  /** Text to answer with once a tool has answered (default `done`). */
  finalText?: string;
  /** Answer this request, or return `undefined` for the default policy. */
  respond?: (request: StubRequest) => StubAnswer | undefined;
}

export class StubModelServer {
  /** Every request the CLI made, in order — useful for asserting the turn shape. */
  readonly requests: StubRequest[] = [];
  private server?: Server;

  constructor(private readonly options: StubModelOptions = {}) {}

  /** Start on an ephemeral port; returns the `/v1` base URL to hand to the CLI. */
  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => this.reply(response, body));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}/v1`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = undefined;
  }

  private reply(response: ServerResponse, body: string): void {
    let parsed: StubRequest;
    try {
      parsed = JSON.parse(body) as StubRequest;
    } catch {
      response.writeHead(400).end();
      return;
    }
    const request: StubRequest = {
      model: parsed.model ?? "stub",
      messages: parsed.messages ?? [],
    };
    this.requests.push(request);
    const answer = this.options.respond?.(request) ?? this.defaultAnswer(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(completion(request.model, answer)));
  }

  private defaultAnswer(request: StubRequest): StubAnswer {
    if (request.messages.some((message) => message.role === "tool")) {
      return { text: this.options.finalText ?? "done" };
    }
    return {
      toolName: this.options.toolName ?? "fixture_echo",
      toolInput: this.options.toolInput ?? { text: "hi" },
    };
  }
}

/** An OpenAI-compatible chat completion for one answer. */
function completion(model: string, answer: StubAnswer): object {
  const isToolCall = "toolName" in answer;
  return {
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: isToolCall ? null : answer.text,
          ...(isToolCall
            ? {
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: answer.toolName,
                      arguments: JSON.stringify(answer.toolInput ?? {}),
                    },
                  },
                ],
              }
            : {}),
        },
        finish_reason: isToolCall ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
