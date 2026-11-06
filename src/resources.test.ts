import { describe, it, expect } from "vitest";
import {
  listAllResources,
  READ_RESOURCE_TOOL,
  RESOURCES_SERVER,
  resourcesPrompt,
  resourcesToolset,
} from "./resources.js";
import type { ResourceToolset } from "./mcp/toolset.js";

function toolset(
  serverName: string,
  resources: Record<string, string>,
  options: { listThrows?: boolean; onList?: () => void } = {},
): ResourceToolset {
  return {
    serverName,
    async listTools() {
      return [];
    },
    async callTool() {
      return { ok: true };
    },
    async listResources() {
      options.onList?.();
      if (options.listThrows) throw new Error("list failed");
      return Object.entries(resources).map(([uri, name]) => ({ uri, name, mimeType: "text/plain" }));
    },
    async readResource(uri: string) {
      return resources[uri];
    },
    async instructions() {
      return undefined;
    },
    async close() {
      // nothing
    },
  };
}

describe("resources", () => {
  it("lists across servers and skips one that fails", async () => {
    const resources = await listAllResources([
      toolset("good", { "file:///a.md": "a" }),
      toolset("broken", {}, { listThrows: true }),
      toolset("also", { "file:///b.md": "b" }),
    ]);

    expect(resources).toEqual([
      { uri: "file:///a.md", name: "a", mimeType: "text/plain", serverName: "good" },
      { uri: "file:///b.md", name: "b", mimeType: "text/plain", serverName: "also" },
    ]);
  });

  it("indexes them in the prompt, and says nothing when there are none", () => {
    expect(resourcesPrompt([])).toBe("");

    const prompt = resourcesPrompt([
      { uri: "file:///a.md", name: "a", serverName: "srv" },
      { uri: "file:///b.md", serverName: "srv" },
    ]);
    expect(prompt).toContain("- a: file:///a.md");
    // A resource with no name is addressable by its URI.
    expect(prompt).toContain("- file:///b.md: file:///b.md");
    expect(prompt).toContain(`${RESOURCES_SERVER}_${READ_RESOURCE_TOOL}`);
    expect(prompt).toContain('"offset"/"limit"');
  });

  it("reads a whole resource", async () => {
    const toolsetUnderTest = resourcesToolset([toolset("srv", { "file:///a.md": "hello" })]);

    const result = await toolsetUnderTest.callTool(READ_RESOURCE_TOOL, { uri: "file:///a.md" });

    expect(result).toEqual({ ok: true, output: "hello" });
  });

  it("reads part of one, and says where to continue", async () => {
    const toolsetUnderTest = resourcesToolset([
      toolset("srv", { "file:///a.md": "0123456789" }),
    ]);

    const result = await toolsetUnderTest.callTool(READ_RESOURCE_TOOL, {
      uri: "file:///a.md",
      offset: 2,
      limit: 3,
    });

    expect(result.ok).toBe(true);
    expect(String(result.output)).toContain("234");
    expect(String(result.output)).toContain("characters 2–5 of 10");
    expect(String(result.output)).toContain("offset 5");
  });

  it("refuses a URI no server listed — including another server's", async () => {
    const toolsetUnderTest = resourcesToolset([
      toolset("one", { "file:///one.md": "one" }),
      toolset("two", { "file:///two.md": "two" }),
    ]);

    const unknown = await toolsetUnderTest.callTool(READ_RESOURCE_TOOL, { uri: "file:///etc/passwd" });

    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("only resources the servers listed");
    // The listed one still works, through its own server.
    expect((await toolsetUnderTest.callTool(READ_RESOURCE_TOOL, { uri: "file:///two.md" })).ok).toBe(
      true,
    );
  });

  it("reports a resource that cannot be read, rather than throwing", async () => {
    const broken: ResourceToolset = {
      ...toolset("srv", {}),
      async listResources() {
        return [{ uri: "file:///gone.md", name: "gone" }];
      },
      async readResource() {
        throw new Error("gone");
      },
    };
    const toolsetUnderTest = resourcesToolset([broken]);

    const result = await toolsetUnderTest.callTool(READ_RESOURCE_TOOL, { uri: "file:///gone.md" });

    expect(result).toEqual({ ok: false, error: 'cannot read "file:///gone.md"' });
  });

  it("lists a resource once, however many times it is read", async () => {
    let listings = 0;
    const toolsetUnderTest = resourcesToolset([
      toolset("srv", { "file:///a.md": "hello" }, { onList: () => (listings += 1) }),
    ]);

    await toolsetUnderTest.callTool(READ_RESOURCE_TOOL, { uri: "file:///a.md" });
    await toolsetUnderTest.callTool(READ_RESOURCE_TOOL, { uri: "file:///a.md" });

    expect(listings).toBe(1);
  });

  it("validates the arguments and rejects unknown tools", async () => {
    const toolsetUnderTest = resourcesToolset([toolset("srv", { "file:///a.md": "x" })]);

    expect((await toolsetUnderTest.callTool("write_resource", {})).ok).toBe(false);
    expect((await toolsetUnderTest.callTool(READ_RESOURCE_TOOL, {})).error).toContain("uri");
    expect(
      (await toolsetUnderTest.callTool(READ_RESOURCE_TOOL, { uri: "file:///a.md", offset: -1 }))
        .error,
    ).toContain("offset");
    expect(
      (await toolsetUnderTest.callTool(READ_RESOURCE_TOOL, { uri: "file:///a.md", limit: 0 })).error,
    ).toContain("limit");
  });
});
