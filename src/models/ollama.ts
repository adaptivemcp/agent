import type { ModelIntegration } from "./types.js";

/** Built-in Ollama location; override with `$OLLAMA_BASE_URL`. */
export const OLLAMA_DEFAULTS = {
  baseURL: "http://127.0.0.1:11434",
} as const;

/** One entry of Ollama's `GET /api/tags` response. */
export interface OllamaTag {
  name?: string;
  model?: string;
}

export interface OllamaDiscoveryOptions {
  /** Ollama root URL, e.g. `http://127.0.0.1:11434`. Defaults to `$OLLAMA_BASE_URL`. */
  baseURL?: string;
  /** Abort the probe after this long. Default 1500ms so startup never hangs. */
  timeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Turn an Ollama model tag into a stable, `--model`-friendly catalog id. */
export function ollamaId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `ollama-${slug}`;
}

/**
 * Discover the models a running Ollama server has pulled via `GET /api/tags`
 * and turn each into a catalog integration (OpenAI-compatible, no API key,
 * zero cost — it is local). Best-effort: any failure (server down, timeout,
 * malformed body) yields `[]` so the catalog still starts offline.
 */
export async function discoverOllamaIntegrations(
  options: OllamaDiscoveryOptions = {},
): Promise<ModelIntegration[]> {
  const env = options.env ?? process.env;
  const baseURL = (options.baseURL ?? env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULTS.baseURL).replace(
    /\/+$/,
    "",
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);
  try {
    const response = await fetchImpl(`${baseURL}/api/tags`, { signal: controller.signal });
    if (!response.ok) return [];
    const body = (await response.json()) as { models?: OllamaTag[] };
    const names = (body.models ?? [])
      .map((tag) => tag.name ?? tag.model)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    return names.map((name) => ({
      id: ollamaId(name),
      label: `Ollama ${name}`,
      provider: "openai-compatible" as const,
      baseURL: `${baseURL}/v1`,
      model: name,
      // Local inference: free, and a fair latency baseline. The Router treats
      // lower costWeight as cheaper; local resources are attractive for fast tools.
      costWeight: 0.5,
      latencyWeight: 1,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
