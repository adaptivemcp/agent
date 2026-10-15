import { beforeAll, describe, expect, it } from "vitest";
import {
  OpenAiSystemOneBackend,
  SYSTEM_ONE_REMOTE_DEFAULT_BASE_URL,
  type SystemOneQuestion,
  type SystemOneResponse,
} from "./systemone.js";

/**
 * Opt-in live check for the remote decision backend (adaptivemcp/agent#6): it
 * drives a real OpenAI-compatible `/chat/completions` endpoint and asserts the
 * reply is coerced back into the `SystemOneResponse` shape.
 *
 * Skipped unless `SYSTEM1_LIVE=1` and `SYSTEM1_LIVE_BASE_URL` (defaulting to the
 * hosted OpenAI root) answers `GET /models`, so the default `pnpm test` stays
 * offline. Point it at any OpenAI-compatible server — a hosted `gpt-4o-mini`, a
 * self-hosted vLLM/llama-server, or a gateway. Run it with `pnpm test:system1`.
 */
const enabled = process.env.SYSTEM1_LIVE === "1";
const baseURL = process.env.SYSTEM1_LIVE_BASE_URL ?? SYSTEM_ONE_REMOTE_DEFAULT_BASE_URL;
const model = process.env.SYSTEM1_LIVE_MODEL ?? "gpt-4o-mini";
const apiKey = process.env.SYSTEM1_LIVE_API_KEY ?? process.env.OPENAI_API_KEY;

const QUESTIONS: Record<string, SystemOneQuestion> = {
  route: {
    type: "choice",
    instructions: "Choose the routing tier for this request.",
    criteria: { fast: "Prefer low latency.", safe: "Prefer correctness." },
  },
};

/** True when the base URL answers `GET /models` within a short timeout. */
async function reachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
        headers,
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

describe.skipIf(!enabled)("OpenAiSystemOneBackend (live, opt-in)", () => {
  let up = false;

  beforeAll(async () => {
    up = await reachable();
  }, 10_000);

  it(
    "coerces a live chat reply into a SystemOneResponse",
    async ({ skip }) => {
      if (!up) skip();
      const backend = new OpenAiSystemOneBackend({
        model,
        baseURL,
        apiKey,
      });

      const res: SystemOneResponse = await backend.answer({ note: "live probe" }, QUESTIONS);

      expect(res.answers.route).toBeDefined();
      expect(["fast", "safe"]).toContain(res.answers.route?.type === "choice" ? res.answers.route.choice : "");
      expect(res.usage.input_tokens).toBeGreaterThanOrEqual(0);
      expect(res.usage.output_tokens).toBeGreaterThanOrEqual(0);
    },
    30_000,
  );
});
