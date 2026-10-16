/**
 * A minimal stdio MCP server for end-to-end CLI tests: one echo tool, plus a
 * deliberate delay so a test can keep a delegated child running past its
 * parent's last step.
 *
 * Test infrastructure, not product code: `tsconfig.json` excludes
 * `src/testing/**`, so none of this is built or published. Tests run it through
 * `tsx`, the same way a user runs any stdio MCP server.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DELAY_MS = Number(process.env.FIXTURE_DELAY_MS ?? "0");

const server = new Server({ name: "fixture", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "fixture_echo",
      description: "Echo the given text back, after an optional delay.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as { text?: unknown };
  if (DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }
  return {
    content: [{ type: "text", text: `echo: ${String(args.text ?? "")}` }],
    isError: false,
  };
});

await server.connect(new StdioServerTransport());
