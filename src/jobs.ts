import type { CallResult, Middleware, PlannedCall } from "@adaptivemcp/middleware";

/** Minimal caller the poller uses to reach the server (an injected MCP client). */
export interface JobCaller {
  callTool(name: string, input: unknown): Promise<{ ok: boolean; output?: unknown; error?: string }>;
}

export interface JobPollingOptions {
  /** Tool that reports a job's status. Default `"get_job_status"`. */
  statusTool?: string;
  /**
   * Resolve the status tool for a server (namespaced hosts prefix it). Defaults
   * to `statusTool` for every server.
   */
  statusToolFor?: (serverName?: string) => string | undefined;
  /** Output field carrying the job id. Default `"job_id"`. */
  idField?: string;
  /** Output field carrying the status. Default `"status"`. */
  statusField?: string;
  /** Statuses meaning "still running". Default `running`/`pending`/`queued`/`in_progress`. */
  runningStatuses?: string[];
  /** Statuses meaning terminal failure. Default `failed`/`error`/`cancelled`. */
  failureStatuses?: string[];
  /** How often to poll. Default 500ms. */
  pollIntervalMs?: number;
  /** Give up (and keep the last handle) after this long. Default 120000ms. */
  maxWaitMs?: number;
  /** Sleep, injectable for tests. Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock, injectable for tests. Default `Date.now`. */
  now?: () => number;
}

interface JobHandle {
  id: string;
  status: string;
}

/** Coerce an output (object or JSON text) into a job handle, if it looks like one. */
export function parseJobHandle(
  output: unknown,
  idField = "job_id",
  statusField = "status",
): JobHandle | undefined {
  let record: Record<string, unknown> | undefined;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          record = parsed as Record<string, unknown>;
        }
      } catch {
        return undefined;
      }
    }
  } else if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    record = output as Record<string, unknown>;
  }
  if (!record) return undefined;
  const id = record[idField];
  const status = record[statusField];
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof status !== "string" || status.length === 0) return undefined;
  return { id, status };
}

/**
 * Middleware that turns a *job handle* — a tool result carrying a job id and a
 * running status (many data/ETL tools are asynchronous) — into a synchronous
 * result: after the call, it polls the server's status tool until the job
 * reaches a terminal state, then replaces the output with the final payload.
 *
 * It calls an injected MCP client (like the compressor middleware), never the
 * agent loop, and is advisory machinery: a host opts in by registering it.
 */
export function jobPollingMiddleware(
  caller: JobCaller,
  options: JobPollingOptions = {},
): Middleware {
  const idField = options.idField ?? "job_id";
  const statusField = options.statusField ?? "status";
  const running = new Set(
    (options.runningStatuses ?? ["running", "pending", "queued", "in_progress"]).map((s) =>
      s.toLowerCase(),
    ),
  );
  const failures = new Set(
    (options.failureStatuses ?? ["failed", "error", "cancelled"]).map((s) => s.toLowerCase()),
  );
  const interval = options.pollIntervalMs ?? 500;
  const maxWait = options.maxWaitMs ?? 120_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const statusToolFor = options.statusToolFor ?? (() => options.statusTool ?? "get_job_status");

  const settle = (result: CallResult, call: PlannedCall, handle: JobHandle, output: unknown): void => {
    call.output = output;
    if (failures.has(handle.status.toLowerCase())) {
      result.ok = false;
      result.error = `job ${handle.id} ${handle.status}`;
    }
  };

  return {
    name: "job-polling",
    async afterCall(result, call) {
      if (!result.ok) return;
      const handle = parseJobHandle(call.output, idField, statusField);
      if (!handle || !running.has(handle.status.toLowerCase())) return;

      const statusTool = statusToolFor(call.serverName);
      if (!statusTool) return;

      const deadline = now() + maxWait;
      let latest = handle;
      let latestOutput = call.output;
      while (now() < deadline) {
        await sleep(interval);
        const poll = await caller.callTool(statusTool, { [idField]: handle.id });
        if (!poll.ok) break;
        const next = parseJobHandle(poll.output, idField, statusField);
        if (!next) break;
        latest = next;
        latestOutput = poll.output;
        if (!running.has(next.status.toLowerCase())) break;
      }
      settle(result, call, latest, latestOutput);
    },
  };
}
