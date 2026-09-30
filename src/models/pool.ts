import type { ChatMessage, ChatModel, ChatParams, ChatStep, ToolSpec } from "../types.js";

export interface PooledModelOptions {
  /** How long a member is skipped after it throws, in ms. Default 30_000. */
  cooldownMs?: number;
  /** Clock, injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

interface Member {
  model: ChatModel;
  cooldownUntil: number;
}

/**
 * A `ChatModel` that spreads calls across several interchangeable members —
 * typically the *same* provider model reached with different API keys — in
 * round-robin order, skipping a member for a cooldown window after it throws.
 *
 * This is the agent's key pool: a transient rate-limit or auth error on one key
 * fails over to the next key for that model instead of failing the turn. Model
 * selection across *different* models stays Adaptive MCP's routing job.
 */
export class PooledChatModel implements ChatModel {
  readonly name: string;
  readonly capabilities?: ChatModel["capabilities"];
  readonly pricing?: ChatModel["pricing"];
  private readonly members: Member[];
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private cursor = 0;

  constructor(models: ChatModel[], name?: string, options: PooledModelOptions = {}) {
    if (models.length === 0) throw new Error("PooledChatModel needs at least one member");
    this.members = models.map((model) => ({ model, cooldownUntil: 0 }));
    this.name = name ?? models[0]!.name;
    this.capabilities = models[0]!.capabilities;
    this.pricing = models[0]!.pricing;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** Number of pooled resources (keys) behind this model. */
  get size(): number {
    return this.members.length;
  }

  step(messages: ChatMessage[], tools: ToolSpec[], params?: ChatParams): Promise<ChatStep> {
    return this.run((model) => model.step(messages, tools, params));
  }

  stream(
    messages: ChatMessage[],
    tools: ToolSpec[],
    params: ChatParams,
    onTextDelta: (text: string) => void,
  ): Promise<ChatStep> {
    return this.run((model) =>
      model.stream
        ? model.stream(messages, tools, params, onTextDelta)
        : model.step(messages, tools, params),
    );
  }

  /** Try each member in rotated order until one succeeds. */
  private async run(call: (model: ChatModel) => Promise<ChatStep>): Promise<ChatStep> {
    const errors: unknown[] = [];
    for (const member of this.order()) {
      try {
        const result = await call(member.model);
        member.cooldownUntil = 0;
        return result;
      } catch (error) {
        member.cooldownUntil = this.now() + this.cooldownMs;
        errors.push(error);
      }
    }
    const last = errors.at(-1);
    throw last instanceof Error ? last : new Error("no pooled model member succeeded");
  }

  /** Healthy members first (from the rotating cursor); cooled-down ones last. */
  private order(): Member[] {
    const now = this.now();
    const healthy = this.members.filter((member) => member.cooldownUntil <= now);
    const cooling = this.members.filter((member) => member.cooldownUntil > now);
    const pool = healthy.length > 0 ? healthy : this.members;
    const start = this.cursor % pool.length;
    const ordered = [...pool.slice(start), ...pool.slice(0, start)];
    this.cursor = (this.cursor + 1) % this.members.length;
    return cooling.every((member) => !pool.includes(member)) ? [...ordered, ...cooling] : ordered;
  }
}
