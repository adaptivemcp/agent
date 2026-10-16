import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { load as parseYaml } from "js-yaml";
import { TOOLS_METADATA_RESOURCE_URI } from "@adaptivemcp/spec";
import type { ToolSpec } from "../types.js";
import { AgentRuntime } from "../runtime.js";
import type { ServerToolsMetadata } from "../runtime.js";
import { StdioToolset } from "../mcp/stdio.js";
import { isHttpServerSpec, parseServer } from "../config.js";

/**
 * End-to-end against a *real* third-party MCP server (QueryCleaner/QC), spoken
 * over stdio as a child process — the first server the agent hosts that is not
 * the Adaptive MCP example. It exercises the JSON `--server` spec (per-server
 * `cwd`/`env`) and the result-classification seam: QC reports policy denials
 * in-band (`status: "error"`), which must be learned as failures.
 *
 * Skipped unless `QC_MCP_INTEGRATION=1` and the sibling QC checkout/venv exist,
 * so the default `pnpm test` stays offline. Run it with `pnpm test:integration`.
 *
 * It also reads QC's `dev.adaptivemcp/tools-metadata` resource and applies it
 * as a policy floor — the cross-repo half of adaptivemcp/qc#3.
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
    const spec = parseServer(
      JSON.stringify({ name: "qc", command: qcBin, args: ["mcp"], cwd: qcRepo }),
    );
    if (isHttpServerSpec(spec)) throw new Error("expected a stdio server spec");
    toolset = new StdioToolset("qc", spec);
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

    // QC reports a denial the protocol way: isError with the envelope as
    // structured content (adaptivemcp/qc#1). Both layers must agree — the
    // transport-level result is a failure, and the envelope keeps the stable
    // error code for the client to inspect.
    const raw = await toolset.callTool("profile_dataset", args);
    expect(raw.ok).toBe(false);
    const payload = (typeof raw.output === "string" ? JSON.parse(raw.output) : raw.output) as {
      status?: string;
    };
    expect(payload.status).toBe("error");

    // Through AgentRuntime, that failure must be recorded as a failure — and
    // servers that report it *only* in-band (success + status:"error") are
    // caught by the envelope classifier for the same reason.
    const result = await runtime.execute({ id: "c1", name: "profile_dataset", input: args }, spec!);
    expect(result.ok).toBe(false);
    expect(runtime.adaptive.memory.getTool("profile_dataset", "qc")?.stats.failureRate).toBe(1);
  });

  it("reads the server-published tools-metadata and applies it as a policy floor", async () => {
    // QC publishes the dev.adaptivemcp/tools-metadata resource: static,
    // server-authored risk/owner/approval suggestions (SEP-2133).
    const text = await toolset.readResource(TOOLS_METADATA_RESOURCE_URI);
    expect(text).toBeTruthy();
    const doc = parseYaml(text as string) as ServerToolsMetadata;
    expect((doc.tools ?? []).map((tool) => tool.name)).toContain("preview_sanitized_data");

    // This is the `--server-policy` path: parse, then apply as a floor.
    const applied = runtime.applyServerMetadata(doc, { serverName: "qc" });
    expect(applied.approvals).toBe(2); // preview_sanitized_data + generate_synthetic_data
    expect(applied.budgets).toBe(0); // QC publishes no budgets (unit mismatch)

    const record = runtime.adaptive.memory.getTool("preview_sanitized_data", "qc");
    expect(record?.annotation.risk).toBe("high");
    expect(record?.annotation.owner).toBe("qc");
    // …and the gate honours it, without the client configuring anything.
    expect(runtime.adaptive.approval.gate("preview_sanitized_data", "qc")).toBe(
      "require_confirmation",
    );
  });
});
