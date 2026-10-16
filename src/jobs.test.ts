import { describe, it, expect } from "vitest";
import type { MiddlewareContext } from "@adaptivemcp/middleware";
import { jobPollingMiddleware, parseJobHandle, type JobCaller } from "./jobs.js";

const ctx = { store: {} as MiddlewareContext["store"], toolName: "gen", serverName: "qc" };

function planned(output: unknown) {
  return { toolName: "gen", serverName: "qc", input: {}, output };
}

/** A caller that returns a scripted sequence of outputs. */
function scripted(
  outputs: unknown[],
): JobCaller & { calls: Array<{ name: string; input: unknown }> } {
  const calls: Array<{ name: string; input: unknown }> = [];
  let index = 0;
  return {
    calls,
    async callTool(name, input) {
      calls.push({ name, input });
      const output = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      return { ok: true, output };
    },
  };
}

describe("parseJobHandle", () => {
  it("reads a job id and status from an object or JSON text", () => {
    expect(parseJobHandle({ job_id: "j1", status: "running" })).toEqual({
      id: "j1",
      status: "running",
    });
    expect(parseJobHandle('{"job_id":"j2","status":"completed"}')).toEqual({
      id: "j2",
      status: "completed",
    });
  });

  it("returns undefined when there is no handle", () => {
    expect(parseJobHandle({ status: "running" })).toBeUndefined();
    expect(parseJobHandle({ job_id: "j1" })).toBeUndefined();
    expect(parseJobHandle("plain text")).toBeUndefined();
    expect(parseJobHandle(null)).toBeUndefined();
  });
});

describe("jobPollingMiddleware", () => {
  it("polls a running job to completion and replaces the output", async () => {
    const caller = scripted([
      { job_id: "j1", status: "running" },
      { job_id: "j1", status: "completed", data: { rows: 10 } },
    ]);
    const mw = jobPollingMiddleware(caller, { sleep: async () => {}, now: () => 0 });
    const result: { ok: boolean; error?: string; output?: unknown } = { ok: true };
    const call = planned({ job_id: "j1", status: "running" });

    await mw.afterCall!(result, call, ctx);

    expect(result.ok).toBe(true);
    expect(call.output).toEqual({ job_id: "j1", status: "completed", data: { rows: 10 } });
    expect(caller.calls).toHaveLength(2);
    expect(caller.calls[0]?.name).toBe("get_job_status");
    expect(caller.calls[0]?.input).toEqual({ job_id: "j1" });
  });

  it("marks a terminally failed job as a failure", async () => {
    const caller = scripted([{ job_id: "j1", status: "failed" }]);
    const mw = jobPollingMiddleware(caller, { sleep: async () => {}, now: () => 0 });
    const result: { ok: boolean; error?: string; output?: unknown } = { ok: true };
    const call = planned({ job_id: "j1", status: "pending" });

    await mw.afterCall!(result, call, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed");
  });

  it("does nothing when the output is not a running job", async () => {
    const caller = scripted([{ job_id: "j1", status: "completed" }]);
    const mw = jobPollingMiddleware(caller, { sleep: async () => {} });
    const result: { ok: boolean; error?: string; output?: unknown } = { ok: true };
    const call = planned({ result: "done" });

    await mw.afterCall!(result, call, ctx);

    expect(caller.calls).toHaveLength(0);
    expect(call.output).toEqual({ result: "done" });
  });

  it("parses a JSON-string handle and resolves the namespaced status tool", async () => {
    const caller = scripted(['{"job_id":"j9","status":"running"}', '{"status":"completed"}']);
    const mw = jobPollingMiddleware(caller, {
      sleep: async () => {},
      now: () => 0,
      statusToolFor: () => "qc_get_job_status",
    });
    const result: { ok: boolean; error?: string; output?: unknown } = { ok: true };
    const call = planned('{"job_id":"j9","status":"running"}');

    await mw.afterCall!(result, call, ctx);

    expect(caller.calls[0]?.name).toContain("get_job_status");
  });

  it("keeps the last handle when the job outlasts maxWaitMs", async () => {
    let clock = 0;
    const caller = scripted([{ job_id: "j1", status: "running" }]);
    const mw = jobPollingMiddleware(caller, {
      sleep: async () => {
        clock += 60;
      },
      now: () => clock,
      pollIntervalMs: 50,
      maxWaitMs: 100,
    });
    const result: { ok: boolean; error?: string; output?: unknown } = { ok: true };
    const call = planned({ job_id: "j1", status: "running" });

    await mw.afterCall!(result, call, ctx);

    expect(result.ok).toBe(true);
    expect(call.output).toEqual({ job_id: "j1", status: "running" });
    expect(caller.calls.length).toBeGreaterThan(0);
  });

  it("skips polling when no status tool is available for the server", async () => {
    const caller = scripted([{ job_id: "j1", status: "completed" }]);
    const mw = jobPollingMiddleware(caller, {
      sleep: async () => {},
      statusToolFor: () => undefined,
    });
    const result: { ok: boolean; error?: string; output?: unknown } = { ok: true };
    const call = planned({ job_id: "j1", status: "running" });

    await mw.afterCall!(result, call, ctx);

    expect(caller.calls).toHaveLength(0);
  });
});
