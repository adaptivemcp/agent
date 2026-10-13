import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolSpec } from "../types.js";
import { AgentRuntime } from "../runtime.js";
import { StdioToolset } from "../mcp/stdio.js";
import { parseServer } from "../config.js";

/**
 * End-to-end against a *real* third-party MCP server (QueryCleaner/QC), spoken
 * over stdio as a child process — the first server the agent hosts that is not
 * the Adaptive MCP example. It exercises the JSON `--server` spec (per-server
 * `cwd`/`env`) and the result-classification seam: QC reports policy denials
 * in-band (`status: "error"`), which must be learned as failures.
 *
 * Skipped unless `QC_MCP_INTEGRATION=1` and the sibling QC checkout/venv exist,
 * so the default `pnpm test` stays offline. Run it with `pnpm test:integration`.
 */
const qcRepo = fileURLToPath(new URL("../../../qc", import.meta.url));
const qcBin = fileURLToPath(new URL("../../../qc/.venv/bin/qc", import.meta.url));
const hasQc = existsSync(qcBin);
const enabled = process.env.QC_MCP_INTEGRATION === "1";

describe.skipIf(!enabled || !hasQc)("qc mcp (real stdio server)", () => {
  let toolset!: StdioToolset;
  let runtime!: AgentRuntime;
  let specs: ToolSpec[] = [];

  beforeAll(async () => {
    toolset = new StdioToolset(
      "qc",
      parseServer(
        JSON.stringify({ name: "qc", command: qcBin, args: ["mcp"], cwd: qcRepo }),
      ),
    );
    specs = await toolset.listTools();
    runtime = new AgentRuntime({
      dbPath: ":memory:",
      sessionId: "qc-it",
      invoke: (name, input) => toolset.callTool(name, input),
    });
  }, 30_000);

  afterAll(async () => {
    runtime?.close();
    await toolset?.close();
  });

  it("lists QC's bounded tool set", () => {
    const names = specs.map((spec) => spec.name);
    expect(names).toContain("profile_dataset");
    expect(names).toContain("list_sources");
  });

  it("reads the server's initialize instructions", async () => {
    const text = await toolset.instructions();
    expect(text ?? "").toContain("QueryCleaner");
  });

  it("classifies a QC policy-denied call as a failure", async () => {
    const spec = specs.find((candidate) => candidate.name === "profile_dataset");
    expect(spec).toBeDefined();
    const args = { source_id: "nope", dataset_id: "nope.tbl" };

    // QC returns a transport-level success whose payload carries status:"error"
    // (as JSON text content, which is why the classifier must parse strings).
    const raw = await toolset.callTool("profile_dataset", args);
    expect(raw.ok).toBe(true);
    const payload = (
      typeof raw.output === "string" ? JSON.parse(raw.output) : raw.output
    ) as { status?: string };
    expect(payload.status).toBe("error");

    // Through AgentRuntime, that in-band error must be recorded as a failure.
    const result = await runtime.execute(
      { id: "c1", name: "profile_dataset", input: args },
      spec!,
    );
    expect(result.ok).toBe(false);
    expect(runtime.adaptive.memory.getTool("profile_dataset", "qc")?.stats.failureRate).toBe(1);
  });
});
