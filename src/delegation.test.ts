import { describe, it, expect } from "vitest";
import {
  TASK_TOOL,
  childSessionId,
  describeCompletion,
  narrowTools,
  subagentApproval,
  taskToolset,
  type DelegationContext,
  type SubagentResult,
  type SubagentTask,
} from "./delegation.js";
import type { AgentDefinition } from "./skills.js";
import type { ToolSpec } from "./types.js";

function completed(sessionId: string, summary = "done"): SubagentResult {
  return { status: "completed", summary, steps: 2, sessionId };
}

/** A production-shaped parent tool list: namespaced MCP tools + delegation. */
const PARENT_TOOLS: ToolSpec[] = [
  { name: "delegate_task", inputSchema: {} },
  { name: "adaptive_search_customer", inputSchema: {} },
  { name: "adaptive_deploy_service", inputSchema: {} },
];

function toolset(
  run: (
    task: SubagentTask,
    sessionId: string,
    context: DelegationContext,
  ) => Promise<SubagentResult>,
  extra: {
    notify?: (message: string) => void;
    maxBackground?: number;
    agents?: AgentDefinition[];
  } = {},
) {
  return taskToolset({
    session: "s1",
    tools: () => PARENT_TOOLS,
    taskToolName: "delegate_task",
    run,
    ...extra,
  });
}

describe("delegation", () => {
  it("exposes one task tool with the delegation schema", async () => {
    const tools = toolset(async (_task, sessionId) => completed(sessionId));
    const specs = await tools.listTools();

    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe(TASK_TOOL);
    expect(specs[0]?.inputSchema?.required).toEqual(["description", "prompt"]);
    // The parent is told not to poll, in the description the model reads.
    expect(specs[0]?.description).toContain("do NOT poll");
  });

  it("runs a child in its own session and returns a result, not a transcript", async () => {
    const sessions: string[] = [];
    const tools = toolset(async (task, sessionId) => {
      sessions.push(sessionId);
      expect(task.prompt).toBe("count the open PRs");
      return completed(sessionId, "3 open PRs");
    });

    const result = await tools.callTool(TASK_TOOL, {
      description: "count PRs",
      prompt: "count the open PRs",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      status: "completed",
      summary: "3 open PRs",
      steps: 2,
      sessionId: "s1/task-1",
    });
    expect(sessions).toEqual(["s1/task-1"]);
  });

  it("names the child session under the parent, and labels a specialist", async () => {
    const tools = toolset(async (_task, sessionId) => completed(sessionId), {
      agents: [{ name: "reviewer", description: "reads only", instructions: "Review." }],
    });

    const result = await tools.callTool(TASK_TOOL, {
      description: "review",
      prompt: "review the diff",
      agent: "reviewer",
    });

    expect((result.output as SubagentResult).sessionId).toBe("s1/task-reviewer-1");
  });

  it("surfaces a failed child as a failed call carrying its summary", async () => {
    const tools = toolset(async (_task, sessionId) => ({
      status: "failed",
      summary: "ran out of steps",
      steps: 6,
      sessionId,
    }));

    const result = await tools.callTool(TASK_TOOL, { description: "x", prompt: "y" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("ran out of steps");
  });

  it("turns a throwing runner into a failed result instead of failing the parent", async () => {
    const tools = toolset(async () => {
      throw new Error("model unavailable");
    });

    const result = await tools.callTool(TASK_TOOL, { description: "x", prompt: "y" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("model unavailable");
  });

  it("validates its arguments before spawning anything", async () => {
    let spawned = 0;
    const tools = toolset(async (_task, sessionId) => {
      spawned += 1;
      return completed(sessionId);
    });

    expect((await tools.callTool(TASK_TOOL, { prompt: "y" })).error).toMatch(/description/);
    expect((await tools.callTool(TASK_TOOL, { description: "x" })).error).toMatch(/prompt/);
    expect((await tools.callTool(TASK_TOOL, null)).error).toMatch(/object/);
    expect(
      (await tools.callTool(TASK_TOOL, { description: "x", prompt: "y", agent: 3 })).error,
    ).toMatch(/agent/);
    expect(
      (await tools.callTool(TASK_TOOL, { description: "x", prompt: "y", background: "yes" })).error,
    ).toMatch(/background/);
    expect((await tools.callTool("other", {})).error).toMatch(/unknown tool/);
    expect(spawned).toBe(0);
  });

  describe("background", () => {
    it("returns immediately and notifies exactly once, on completion", async () => {
      const notifications: string[] = [];
      let finish: ((result: SubagentResult) => void) | undefined;
      const tools = toolset(
        (_task, sessionId) =>
          new Promise<SubagentResult>((resolve) => {
            finish = () => resolve(completed(sessionId, "clean"));
          }),
        { notify: (message) => notifications.push(message) },
      );

      const started = await tools.callTool(TASK_TOOL, {
        description: "audit",
        prompt: "audit the repo",
        background: true,
      });

      expect(started.ok).toBe(true);
      expect((started.output as { status: string }).status).toBe("running");
      expect(notifications).toEqual([]); // nothing to report: the child is still running

      finish?.(completed("s1/task-1"));
      await tools.close(); // close() waits for the child

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain("audit");
      expect(notifications[0]).toContain("clean");
    });

    it("bounds how many children run at once", async () => {
      const tools = toolset(() => new Promise<SubagentResult>(() => {}), { maxBackground: 2 });

      const first = await tools.callTool(TASK_TOOL, {
        description: "a",
        prompt: "a",
        background: true,
      });
      const second = await tools.callTool(TASK_TOOL, {
        description: "b",
        prompt: "b",
        background: true,
      });
      const third = await tools.callTool(TASK_TOOL, {
        description: "c",
        prompt: "c",
        background: true,
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(third.ok).toBe(false);
      expect(third.error).toMatch(/already running/);
    });
  });

  describe("derived permissions", () => {
    it("never auto-approves in a child, whatever the parent does", () => {
      // The anti-escalation rule: a parent that declines to act must not ask a
      // child to act in its place, so an auto-approving parent confers nothing.
      expect(subagentApproval()("deploy_service")).toBe(false);
      expect(subagentApproval()("read_only_tool")).toBe(false);
    });

    it("drops the delegation tool from a child's tools, bounding recursion", () => {
      const names = narrowTools(PARENT_TOOLS, undefined, "delegate_task").map((spec) => spec.name);

      expect(names).toEqual(["adaptive_search_customer", "adaptive_deploy_service"]);
    });

    it("lets a definition narrow the child's tools, never widen them", () => {
      // An allowlist is a filter over the parent's tools. Naming a tool the parent
      // does not have grants nothing — the intersection property, by construction.
      const reviewer: AgentDefinition = {
        name: "reviewer",
        description: "reads, never acts",
        instructions: "Review.",
        tools: ["search_customer", "delete_everything"],
      };

      const names = narrowTools(PARENT_TOOLS, reviewer, "delegate_task").map((spec) => spec.name);

      expect(names).toEqual(["adaptive_search_customer"]);
    });

    it("lets a definition deny tools on top of the parent's policy", () => {
      const readOnly: AgentDefinition = {
        name: "read-only",
        description: "no deploys",
        instructions: "Do not deploy.",
        deny: ["deploy_service"],
      };

      const names = narrowTools(PARENT_TOOLS, readOnly, "delegate_task").map((spec) => spec.name);

      expect(names).toEqual(["adaptive_search_customer"]);
    });

    it("matches a bare name under a server prefix, and a full name as given", () => {
      const exact: AgentDefinition = {
        name: "exact",
        description: "fully named",
        instructions: "X",
        tools: ["adaptive_search_customer"],
      };
      const bare: AgentDefinition = {
        name: "bare",
        description: "bare name",
        instructions: "X",
        tools: ["search_customer"],
      };

      expect(narrowTools(PARENT_TOOLS, exact, "delegate_task").map((s) => s.name)).toEqual([
        "adaptive_search_customer",
      ]);
      expect(narrowTools(PARENT_TOOLS, bare, "delegate_task").map((s) => s.name)).toEqual([
        "adaptive_search_customer",
      ]);
    });
  });

  describe("named agents", () => {
    const reviewer: AgentDefinition = {
      name: "reviewer",
      description: "reads only",
      instructions: "Read, then report findings.",
      tools: ["search_customer"],
    };

    it("hands the definition and the narrowed tools to the runner", async () => {
      let seen: DelegationContext | undefined;
      const tools = toolset(
        async (_task, sessionId, context) => {
          seen = context;
          return completed(sessionId);
        },
        { agents: [reviewer] },
      );

      await tools.callTool(TASK_TOOL, {
        description: "review",
        prompt: "review it",
        agent: "reviewer",
      });

      expect(seen?.definition?.name).toBe("reviewer");
      expect(seen?.definition?.instructions).toBe("Read, then report findings.");
      expect(seen?.tools.map((spec) => spec.name)).toEqual(["adaptive_search_customer"]);
    });

    it("fails an unknown agent instead of acting as a generalist", async () => {
      let spawned = false;
      const tools = toolset(
        async (_task, sessionId) => {
          spawned = true;
          return completed(sessionId);
        },
        { agents: [reviewer] },
      );

      const result = await tools.callTool(TASK_TOOL, {
        description: "x",
        prompt: "y",
        agent: "nope",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('unknown agent "nope"');
      expect(result.error).toContain("reviewer"); // names what is available
      expect(spawned).toBe(false);
    });

    it("with no agent, behaves as an unnarrowed generalist", async () => {
      let seen: DelegationContext | undefined;
      const tools = toolset(
        async (_task, sessionId, context) => {
          seen = context;
          return completed(sessionId);
        },
        { agents: [reviewer] },
      );

      await tools.callTool(TASK_TOOL, { description: "x", prompt: "y" });

      expect(seen?.definition).toBeUndefined();
      expect(seen?.tools.map((spec) => spec.name)).toEqual([
        "adaptive_search_customer",
        "adaptive_deploy_service",
      ]);
    });

    it("says so when no skill declares a tool policy at all", async () => {
      const tools = toolset(async (_task, sessionId) => completed(sessionId));

      const result = await tools.callTool(TASK_TOOL, {
        description: "x",
        prompt: "y",
        agent: "reviewer",
      });

      expect(result.error).toContain("no skill declares a tool policy");
    });
  });

  it("names child sessions under the parent", () => {
    expect(childSessionId("s1", { description: "d", prompt: "p" }, 2)).toBe("s1/task-2");
    expect(childSessionId("s1", { description: "d", prompt: "p", agent: "re viewer" }, 1)).toBe(
      "s1/task-re_viewer-1",
    );
  });

  it("formats the completion notification with status, session and summary", () => {
    const message = describeCompletion(
      { description: "audit", prompt: "p" },
      completed("s1/task-1", "clean"),
    );

    expect(message).toContain("audit");
    expect(message).toContain("Status: completed");
    expect(message).toContain("s1/task-1");
    expect(message).toContain("clean");
  });
});
