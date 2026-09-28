import type { ChatModel, ChatStep, ToolCall } from "../types.js";

export interface ScriptedToolCall {
  name: string;
  input?: unknown;
}

export interface ScriptedTurn {
  text?: string;
  toolCalls?: ScriptedToolCall[];
}

/**
 * A deterministic `ChatModel` for tests and the offline demo: it replays a fixed
 * list of turns. The final turn repeats once the script is exhausted, so a loop
 * always terminates (with no tool calls) rather than erroring.
 */
export class ScriptedModel implements ChatModel {
  readonly name: string;
  private cursor = 0;

  constructor(private readonly turns: ScriptedTurn[], name = "scripted") {
    this.name = name;
  }

  async step(): Promise<ChatStep> {
    const turn = this.turns[Math.min(this.cursor, this.turns.length - 1)] ?? {};
    this.cursor += 1;
    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((call, index) => ({
      id: `call-${this.cursor}-${index}`,
      name: call.name,
      input: call.input ?? {},
    }));
    return {
      text: turn.text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
    };
  }
}
