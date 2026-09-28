/**
 * Offline vertical slice: agent loop → Adaptive MCP execution → telemetry →
 * evaluation → derived tools-metadata view → decoding suggestion.
 *
 * No network, no MCP transport, no LLM key: it uses an in-memory toolset and a
 * scripted model. Run with `pnpm demo`.
 */
import { LLAMA_CPP_CAPABILITIES } from "@adaptivemcp/routing";
import { AgentRuntime, InMemoryToolset, ScriptedModel, runAgent } from "../src/index.js";

let deploys = 0;
const toolset = new InMemoryToolset("demo", [
  {
    name: "deploy_service",
    description: "Deploy a service to an environment.",
    inputSchema: {
      type: "object",
      properties: { env: { type: "string" } },
      required: ["env"],
    },
    handler: () => {
      deploys += 1;
      if (deploys % 3 === 0) throw new Error("upstream timeout");
      return { deployed: true, env: "prod" };
    },
  },
  {
    name: "search_customer",
    description: "Search customers by query.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    handler: (input) => ({ results: 1, query: input }),
  },
]);

const tools = await toolset.listTools();
const runtime = new AgentRuntime({
  dbPath: ":memory:",
  sessionId: "demo-session",
  workflowId: "deploy_release",
  invoke: (name, input) => toolset.callTool(name, input),
});

// Accumulate varied telemetry so evaluation has something to learn from.
for (let i = 0; i < 20; i += 1) {
  const deploy = i % 2 === 0;
  const model = new ScriptedModel([
    {
      toolCalls: [
        deploy
          ? { name: "deploy_service", input: { env: "prod" } }
          : { name: "search_customer", input: { query: "acme" } },
      ],
    },
    { text: "done" },
  ]);
  await runAgent({ model, tools, executor: runtime, messages: [{ role: "user", content: "go" }] });
}

runtime.runAdaptation();
runtime.evaluateWorkflows();

// One visible run so the demo prints something.
console.log("=== agent run ===");
const visible = new ScriptedModel([
  { toolCalls: [{ name: "deploy_service", input: { env: "prod" } }] },
  { text: "Deployed the service to prod." },
]);
await runAgent({
  model: visible,
  tools,
  executor: runtime,
  // Apply the learned decoding profile for the tool the demo drives.
  decoding: runtime.decodingProvider(LLAMA_CPP_CAPABILITIES, {
    toolName: "deploy_service",
    serverName: "demo",
  }),
  messages: [{ role: "user", content: "deploy prod" }],
  onEvent: (event) => {
    if (event.type === "decoding_applied") {
      console.log(`· applied decoding ${JSON.stringify(event.params)}`);
    }
    if (event.type === "tool_call") console.log(`→ ${event.call.name}(${JSON.stringify(event.call.input)})`);
    if (event.type === "tool_result") console.log(event.result.ok ? "✓ ok" : `✗ ${event.result.error}`);
    if (event.type === "assistant_text") console.log(event.text);
  },
});

console.log("\n=== derived tools-metadata ===");
console.log(runtime.toolsMetadata());

const decoding = runtime.suggestDecoding("deploy_service", LLAMA_CPP_CAPABILITIES, { serverName: "demo" });
console.log("\n=== decoding suggestion ===");
console.log(decoding ? JSON.stringify(decoding, null, 2) : "(no recommendation yet)");

runtime.close();
await toolset.close();
