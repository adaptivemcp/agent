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
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DELAY_MS = Number(process.env.FIXTURE_DELAY_MS ?? "0");

const server = new Server(
  { name: "fixture", version: "0.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

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
    {
      name: "fixture_deploy",
      description: "Deploy something. Destructive, so the gate has to ask a human.",
      // The agent seeds risk from the protocol's own annotations, so this tool
      // arrives as high risk and therefore requires confirmation.
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as { text?: unknown; target?: unknown };
  if (DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }
  const text =
    request.params.name === "fixture_deploy"
      ? `deployed: ${String(args.target ?? "")}`
      : `echo: ${String(args.text ?? "")}`;
  return { content: [{ type: "text", text }], isError: false };
});

/**
 * One resource, so the context catalog and the lazy-read tool have something real
 * to point at. Long enough that a range read returns a different answer.
 */
const NOTES = `# Fixture notes

Deploys go through the release script; never tag by hand.

The staging database is rebuilt nightly at 02:00 UTC.
`;

server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [
    {
      uri: "file:///notes.md",
      name: "notes",
      mimeType: "text/markdown",
      description: "Operational notes for this fixture server.",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, (request) => {
  if (request.params.uri !== "file:///notes.md") {
    throw new Error(`unknown resource: ${request.params.uri}`);
  }
  return {
    contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: NOTES }],
  };
});

await server.connect(new StdioServerTransport());
