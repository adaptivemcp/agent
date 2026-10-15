/**
 * System One: fast, low-latency classification/scoring decisions over a shared
 * "state" document, kept deliberately off the chat-model seam. Two transports
 * exist behind the same `DecisionBackend` contract:
 *
 * - **Local** (`OllamaSystemOneBackend`, tier 0): the native
 *   `POST /v1/systemone` endpoint. It returns one JSON object and supports no
 *   streaming, tools, or generation controls, which makes it a good *System-1*
 *   layer in front of the slower chat model.
 * - **Remote** (`OpenAiSystemOneBackend`, tier 1): any OpenAI-compatible
 *   `POST /chat/completions` endpoint (hosted `gpt-4o-mini`, a self-hosted
 *   vLLM/llama-server, …). The same questions are rendered into one prompt and
 *   the reply is coerced back into the System One response shape, so hosts
 *   without a local Ollama + `tev1` model can still use the decision layer.
 *
 * @see https://docs.ollama.com/api/systemone
 */

export interface SystemOneChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option key → description (`null` uses the key itself). 2–26 options. */
  criteria: Record<string, string | null>;
}

export interface SystemOneNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { false?: string; true?: string };
}

export interface SystemOneScoreQuestion {
  type: "score";
  instructions: string;
  /** Descriptions ordered lowest → highest. 2–26 items. */
  criteria: string[];
}

export type SystemOneQuestion =
  SystemOneChoiceQuestion | SystemOneNoulQuestion | SystemOneScoreQuestion;

export interface SystemOneChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface SystemOneNoulAnswer {
  type: "noul";
  /** Probability of `true`, in [0, 1]. */
  noul: number;
}

export interface SystemOneScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type SystemOneAnswer = SystemOneChoiceAnswer | SystemOneNoulAnswer | SystemOneScoreAnswer;

export interface SystemOneUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: SystemOneUsage;
}

export interface SystemOneClientOptions {
  /** Ollama root URL (no `/v1`). Defaults to `$OLLAMA_BASE_URL`, else localhost. */
  baseURL?: string;
  /** A local model trained for System One, e.g. `tev1:0.8b`. */
  model: string;
  /** Bearer token for the `/chat/completions` transport. Never sent to a local host. */
  apiKey?: string;
  /** Extra headers merged over the defaults (e.g. a vendor key). */
  headers?: Record<string, string>;
  /** Abort the request after this long. Default 8000ms. */
  timeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** The default Ollama host used when no base URL is configured. */
export const SYSTEM_ONE_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

/** The decision model this repo targets today. */
export const SYSTEM_ONE_DEFAULT_MODEL = "tev1:0.8b";

/**
 * Low-level client for Ollama's System One endpoint. Requests must fit within
 * 64 KiB and the rendered prompts must fit the loaded context window; callers
 * (see `SystemOneAdvisor`) keep the state compact.
 */
export class SystemOneClient {
  private readonly baseURL: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SystemOneClientOptions) {
    const env = options.env ?? process.env;
    this.baseURL = (options.baseURL ?? env.OLLAMA_BASE_URL ?? SYSTEM_ONE_DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async answer(
    state: unknown,
    questions: Record<string, SystemOneQuestion>,
  ): Promise<SystemOneResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseURL}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`system one ${response.status}: ${detail || response.statusText}`);
      }
      return (await response.json()) as SystemOneResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One OpenAI-compatible chat-completions call. This is the transport the
   * remote tier (`OpenAiSystemOneBackend`) reuses; it stays on the same
   * `DecisionBackend` seam and never enters the agent's chat loop.
   */
  async chat(
    model: string,
    body: {
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      temperature?: number;
    },
  ): Promise<ChatCompletionsResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: { ...headers, ...this.extraHeaders },
        body: JSON.stringify({ model, ...body }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`system one ${response.status}: ${detail || response.statusText}`);
      }
      return (await response.json()) as ChatCompletionsResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A pluggable System One decision backend. Two are wired today — the local
 * Ollama backend (`tev1:0.8b` by default) and a remote, hosted backend that
 * speaks the OpenAI-compatible chat-completions shape (its model is an explicit
 * option, e.g. `gpt-4o-mini`; there is no guessed default, because a wrong
 * hosted model name is a runtime 404 on a remote endpoint). A `tier` orders
 * them so a host can try cheap/local first and fall back to remote; every tier
 * answers through the same `answer()` contract, so `SystemOneAdvisor` never
 * learns which one produced a verdict.
 */
export interface DecisionBackend {
  readonly id: string;
  readonly model: string;
  /**
   * Lower is tried first: Ollama is `0` (free, local), the hosted backend is
   * `1`. Backends that never tier default to `0`.
   */
  readonly tier?: number;
  answer(state: unknown, questions: Record<string, SystemOneQuestion>): Promise<SystemOneResponse>;
}

/** `DecisionBackend` backed by a local Ollama System One model. */
export class OllamaSystemOneBackend implements DecisionBackend {
  readonly id: string;
  readonly model: string;
  readonly tier = 0;
  private readonly client: SystemOneClient;

  constructor(options: SystemOneClientOptions & { id?: string }) {
    this.client = new SystemOneClient(options);
    this.model = options.model;
    this.id = options.id ?? `ollama:${options.model}`;
  }

  answer(state: unknown, questions: Record<string, SystemOneQuestion>): Promise<SystemOneResponse> {
    return this.client.answer(state, questions);
  }
}

/** Overrides accepted by {@link localSystemOneBackend}. */
export interface LocalSystemOneBackendOptions {
  /** Decision model. Defaults to `$SYSTEM1_MODEL`, else `tev1:0.8b`. */
  model?: string;
  /** Ollama root URL. Defaults to `$OLLAMA_BASE_URL`, else localhost. */
  baseURL?: string;
  /** Backend id for observability. Defaults to `ollama:<model>`. */
  id?: string;
  /** Abort the decision call after this long. Default 8000ms. */
  timeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the local Ollama tier with its standard default chain
 * (`$SYSTEM1_MODEL` → `tev1:0.8b`, `$OLLAMA_BASE_URL` → localhost). This is
 * the single source of that construction: `systemOneProvider`'s built-in
 * default and a CLI tier list (`--system1-backend ollama,openai`) both call it,
 * so the defaults cannot drift apart.
 */
export function localSystemOneBackend(
  options: LocalSystemOneBackendOptions = {},
): OllamaSystemOneBackend {
  const env = options.env ?? process.env;
  const model = options.model ?? env.SYSTEM1_MODEL ?? SYSTEM_ONE_DEFAULT_MODEL;
  return new OllamaSystemOneBackend({
    id: options.id ?? `ollama:${model}`,
    baseURL: options.baseURL ?? env.OLLAMA_BASE_URL ?? SYSTEM_ONE_DEFAULT_BASE_URL,
    model,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
}

/** The subset of an OpenAI chat-completions response this client consumes. */
export interface ChatCompletionsResponse {
  model?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAiSystemOneBackendOptions {
  /** OpenAI-compatible root (with `/v1`). Defaults to `$SYSTEM1_BASE_URL`, else OpenAI. */
  baseURL?: string;
  /** A hosted chat model that will be prompted to answer, e.g. `gpt-4o-mini`. */
  model: string;
  /** Bearer token. Defaults to `$SYSTEM1_API_KEY`, else `$OPENAI_API_KEY`. */
  apiKey?: string;
  /** Extra headers (e.g. a vendor key or `HTTP-Referer`), merged over the defaults. */
  headers?: Record<string, string>;
  /** Abort the request after this long. Default 8000ms. */
  timeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  id?: string;
}

/** The hosted System One endpoint when no base URL is configured. */
export const SYSTEM_ONE_REMOTE_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Renders the System One state + questions into a single chat message, asking
 * for the answer as bare JSON in the System One response shape.
 */
export function systemOnePrompt(
  state: unknown,
  questions: Record<string, SystemOneQuestion>,
): string {
  return [
    "You are a decision engine. Decide from the STATE using the QUESTIONS below.",
    "Answer EVERY question with calibrated probabilities that sum to 1.",
    "Respond with ONLY a JSON object (no prose, no markdown fences) of this shape:",
    '{ "answers": { "<questionKey>": { "type": "choice|noul|score", ... } } }',
    '- choice: { "type": "choice", "choice": "<one of the criteria keys>",',
    '  "probabilities": { "<key>": <0..1> }, "confidence": <0..1> }',
    '- noul: { "type": "noul", "noul": <0..1 probability of true> }',
    '- score: { "type": "score", "score": <integer index into criteria>,',
    '  "legend": {}, "probabilities": { "<index>": <0..1> }, "confidence": <0..1> }',
    "",
    "STATE:",
    JSON.stringify(state),
    "",
    "QUESTIONS:",
    JSON.stringify(questions),
  ].join("\n");
}

/**
 * Best-effort extraction of the first balanced JSON object from a model reply.
 * Tolerates the usual chat noise — markdown fences and leading prose — by
 * scanning for the first `{`, then walking braces (ignoring braces inside
 * strings) to the matching close.
 */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Clamp a number into `[min, max]`; anything non-finite becomes `fallback`. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Coerce a parsed answer into the `SystemOneAnswer` union for `question`.
 * Returns `undefined` when the answer cannot be salvaged — the advisor treats a
 * missing answer as "no opinion" and declines, so dropping is always safe.
 */
export function normalizeAnswer(
  question: SystemOneQuestion,
  raw: unknown,
): SystemOneAnswer | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const answer = raw as Record<string, unknown>;

  if (question.type === "noul") {
    return { type: "noul", noul: clamp(answer.noul, 0, 1, 0) };
  }

  if (question.type === "choice") {
    const choice = answer.choice;
    if (typeof choice !== "string" || !(choice in question.criteria)) return undefined;
    const probabilities: Record<string, number> = {};
    if (typeof answer.probabilities === "object" && answer.probabilities !== null) {
      for (const [key, value] of Object.entries(answer.probabilities)) {
        if (key in question.criteria) {
          probabilities[key] = clamp(value, 0, 1, 0);
        }
      }
    }
    if (!(choice in probabilities)) probabilities[choice] = clamp(answer.confidence, 0, 1, 0);
    return {
      type: "choice",
      choice,
      probabilities,
      confidence: clamp(answer.confidence, 0, 1, 0),
    };
  }

  // score
  const rawScore = typeof answer.score === "number" ? answer.score : Number(answer.score);
  if (!Number.isFinite(rawScore)) return undefined;
  const score = Math.round(clamp(rawScore, 0, question.criteria.length - 1, 0));
  const probabilities: Record<string, number> = {};
  if (typeof answer.probabilities === "object" && answer.probabilities !== null) {
    for (const [key, value] of Object.entries(answer.probabilities)) {
      probabilities[key] = clamp(value, 0, 1, 0);
    }
  }
  return {
    type: "score",
    score,
    legend: {},
    probabilities,
    confidence: clamp(answer.confidence, 0, 1, 0),
  };
}

/**
 * `DecisionBackend` backed by a remote, hosted OpenAI-compatible endpoint.
 *
 * The decision seam stays a *local, non-chat* HTTP call: it posts one request
 * to `/v1/chat/completions`, prompting the hosted model to answer the System
 * One questions, and never enters the chat loop. It is the second tier — Ollama
 * is preferred when present — and it is what makes the layer usable on machines
 * without a local Ollama + `tev1` (the original motivating gap).
 */
export class OpenAiSystemOneBackend implements DecisionBackend {
  readonly id: string;
  readonly model: string;
  readonly tier = 1;
  private readonly client: SystemOneClient;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;

  constructor(options: OpenAiSystemOneBackendOptions) {
    const env = options.env ?? process.env;
    this.model = options.model;
    this.id = options.id ?? `openai:${options.model}`;
    this.apiKey = options.apiKey ?? env.SYSTEM1_API_KEY ?? env.OPENAI_API_KEY;
    this.headers = options.headers ?? {};
    this.client = new SystemOneClient({
      baseURL: options.baseURL ?? env.SYSTEM1_BASE_URL ?? SYSTEM_ONE_REMOTE_DEFAULT_BASE_URL,
      model: options.model,
      apiKey: this.apiKey,
      headers: this.headers,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      env,
    });
  }

  async answer(
    state: unknown,
    questions: Record<string, SystemOneQuestion>,
  ): Promise<SystemOneResponse> {
    const answer = await this.client.chat(this.model, {
      messages: [
        { role: "system", content: "You are a precise decision engine." },
        { role: "user", content: systemOnePrompt(state, questions) },
      ],
      temperature: 0,
    });

    const content = extractChatContent(answer);
    const parsed = content ? extractJsonObject(content) : undefined;
    if (!parsed) {
      throw new Error(
        `system one openai: no JSON object in reply (${content?.slice(0, 80) ?? ""})`,
      );
    }

    const answers: Record<string, SystemOneAnswer> = {};
    const document = JSON.parse(parsed) as { answers?: Record<string, unknown> };
    for (const [key, question] of Object.entries(questions)) {
      const normalized = normalizeAnswer(question, document.answers?.[key]);
      if (normalized) answers[key] = normalized;
    }

    return {
      model: answer.model ?? this.model,
      answers,
      usage: {
        input_tokens: answer.usage?.prompt_tokens ?? 0,
        output_tokens: answer.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** Pull the concatenated assistant text out of a chat-completions response. */
function extractChatContent(response: {
  choices?: Array<{ message?: { content?: unknown } }>;
}): string | undefined {
  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : undefined;
}
