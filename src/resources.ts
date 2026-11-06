/**
 * MCP resources, read on demand.
 *
 * `ResourceToolset.listResources()`/`readResource()` existed on both transports and
 * were called by nothing, so a server could publish documentation and the model had
 * no way to reach it. This is the lazy half of that: the prompt carries a one-line
 * index, and a tool reads one resource when the work calls for it.
 *
 * The read is confined to **resources the servers actually listed** — the model
 * chooses among a catalog, it does not get to name an arbitrary URI. That is the same
 * rule as the skill read tool, for the same reason: a resource is untrusted server
 * content, and the catalog is the boundary.
 *
 * Going through a `Toolset` (rather than a direct read) means the read takes the
 * ordinary execution path: approval gate, telemetry, execution graph.
 */
import type { McpToolResult, ResourceToolset, Toolset } from "./mcp/toolset.js";
import type { ToolSpec } from "./types.js";

/** Cap on what one read returns, so a huge resource cannot flood a context. */
const MAX_OUTPUT_CHARS = 24_000;

export const RESOURCES_SERVER = "resources";
export const READ_RESOURCE_TOOL = "read_resource";

/** One resource a server listed, with the server that owns it. */
export interface ContextResource {
  uri: string;
  name?: string;
  mimeType?: string;
  serverName: string;
}

/**
 * List every resource across the given toolsets.
 *
 * A server that does not support resources, or that fails to list them, is skipped:
 * one broken server must not stop a run that has other servers to talk to.
 */
export async function listAllResources(toolsets: ResourceToolset[]): Promise<ContextResource[]> {
  const resources: ContextResource[] = [];
  for (const toolset of toolsets) {
    try {
      for (const resource of await toolset.listResources()) {
        resources.push({ ...resource, serverName: toolset.serverName });
      }
    } catch {
      // No resources, or none listable — either way the run continues.
    }
  }
  return resources;
}

/** The prompt-side index: one line per resource, plus how to read one. */
export function resourcesPrompt(
  resources: ContextResource[],
  toolName = `${RESOURCES_SERVER}_${READ_RESOURCE_TOOL}`,
): string {
  if (resources.length === 0) return "";
  const lines = resources.map((resource) => {
    const label = resource.name ?? resource.uri;
    return `- ${label}: ${resource.uri}`;
  });
  return [
    "Resources — documents the servers expose; read one before relying on it:",
    ...lines,
    `Read one with ${toolName} {"uri": "<uri>"}; "offset"/"limit" (characters) read part of it.`,
  ].join("\n");
}

/**
 * A toolset exposing `read_resource` over the listed resources.
 *
 * The catalog is fetched lazily on the first call, so a run that never reads a
 * resource does not pay for a listing it already did at startup — the caller passes
 * the resources it discovered, and they are used as the boundary.
 */
export function resourcesToolset(toolsets: ResourceToolset[]): Toolset {
  return {
    serverName: RESOURCES_SERVER,
    async listTools(): Promise<ToolSpec[]> {
      return [
        {
          name: READ_RESOURCE_TOOL,
          description:
            "Read a resource a server listed, or part of one. Call this for documentation " +
            "or data the prompt names but does not include.",
          inputSchema: {
            type: "object",
            properties: {
              uri: { type: "string", description: "Resource URI, as listed in the prompt." },
              offset: {
                type: "number",
                description: "Optional character offset to start reading from.",
              },
              limit: {
                type: "number",
                description: "Optional number of characters to read.",
              },
            },
            required: ["uri"],
          },
          serverName: RESOURCES_SERVER,
        },
      ];
    },
    async callTool(name, input): Promise<McpToolResult> {
      if (name !== READ_RESOURCE_TOOL) return { ok: false, error: `unknown tool: ${name}` };
      const args = (input ?? {}) as { uri?: unknown; offset?: unknown; limit?: unknown };
      if (typeof args.uri !== "string" || !args.uri) {
        return { ok: false, error: "uri must be a non-empty string" };
      }
      const offset = args.offset === undefined ? 0 : args.offset;
      const limit = args.limit;
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
        return { ok: false, error: "offset must be a non-negative integer" };
      }
      if (
        limit !== undefined &&
        (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
      ) {
        return { ok: false, error: "limit must be a positive integer" };
      }

      let owned: ResourceToolset | undefined;
      for (const toolset of toolsets) {
        if ((await listedBy(toolset)).includes(args.uri)) {
          owned = toolset;
          break;
        }
      }
      if (!owned) {
        return {
          ok: false,
          error: `unknown resource: "${args.uri}" (only resources the servers listed can be read)`,
        };
      }

      let text: string | undefined;
      try {
        text = await owned.readResource(args.uri as string);
      } catch {
        text = undefined;
      }
      if (text === undefined) return { ok: false, error: `cannot read "${args.uri}"` };

      const start = Math.min(offset, text.length);
      const end = typeof limit === "number" ? Math.min(start + limit, text.length) : text.length;
      let slice = text.slice(start, end);
      const truncated = slice.length > MAX_OUTPUT_CHARS;
      if (truncated) slice = slice.slice(0, MAX_OUTPUT_CHARS);
      const suffix =
        truncated || end < text.length
          ? `\n\n[returned characters ${start}–${start + slice.length} of ${text.length}; ` +
            `continue with offset ${start + slice.length}]`
          : "";
      return { ok: true, output: slice + suffix };
    },
    async close(): Promise<void> {
      // The owning toolsets are closed by the aggregate; this wrapper owns nothing.
    },
  };
}

/**
 * The URIs a toolset listed at startup, captured the first time it is asked.
 *
 * Caching matters: without it, every resource read would re-list every server just
 * to decide whether the URI is allowed.
 */
const listings = new WeakMap<ResourceToolset, Promise<string[]>>();
function listedBy(toolset: ResourceToolset): Promise<string[]> {
  let listing = listings.get(toolset);
  if (!listing) {
    listing = toolset
      .listResources()
      .then((resources) => resources.map((resource) => resource.uri))
      .catch(() => []);
    listings.set(toolset, listing);
  }
  return listing;
}
