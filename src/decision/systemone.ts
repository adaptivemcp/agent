/**
 * Ollama System One: fast, local classification/scoring decisions over a shared
 * "state" document. The endpoint (`POST /v1/systemone`) returns one JSON object
 * and supports no streaming, tools, or generation controls, which makes it a
 * good *System-1* decision layer in front of the slower chat model.
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
  | SystemOneChoiceQuestion
  | SystemOneNoulQuestion
  | SystemOneScoreQuestion;

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
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SystemOneClientOptions) {
    const env = options.env ?? process.env;
    this.baseURL = (options.baseURL ?? env.OLLAMA_BASE_URL ?? SYSTEM_ONE_DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.model = options.model;
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
}

/**
 * A pluggable System One decision backend. Ollama is the only implementation
 * today; remote backends (jev, laya, an OpenAI decision endpoint) implement the
 * same interface later and can be tried in tier order.
 */
export interface DecisionBackend {
  readonly id: string;
  readonly model: string;
  answer(state: unknown, questions: Record<string, SystemOneQuestion>): Promise<SystemOneResponse>;
}

/** `DecisionBackend` backed by a local Ollama System One model. */
export class OllamaSystemOneBackend implements DecisionBackend {
  readonly id: string;
  readonly model: string;
  private readonly client: SystemOneClient;

  constructor(options: SystemOneClientOptions & { id?: string }) {
    this.client = new SystemOneClient(options);
    this.model = options.model;
    this.id = options.id ?? `ollama:${options.model}`;
  }

  answer(
    state: unknown,
    questions: Record<string, SystemOneQuestion>,
  ): Promise<SystemOneResponse> {
    return this.client.answer(state, questions);
  }
}
