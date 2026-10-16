/**
 * Delegation: the `task` tool.
 *
 * A child is a **real sub-agent** — its own session, its own conversation — and
 * the parent receives a *result*, never the child's transcript. That is the
 * point of the pattern (modelled on `opencode`'s `task` tool and `smolagents`'
 * `managed_agents`): a delegate cannot pollute the caller's context, and the
 * caller does not have to ingest a whole transcript to learn what happened.
 *
 * Two rules make it safe rather than merely convenient:
 *
 * - **Delegation never amplifies authority.** The child's tool list drops the
 *   delegation tool itself (no unbounded recursion), and a call the gate marks
 *   `require_confirmation` is **denied inside a child** even when the parent is
 *   auto-approving — a parent that declines to act must not ask a child to act
 *   in its place. The child shares the parent's gate, so everything the policy
 *   denies stays denied too.
 * - **A background child is not polled.** The parent is told exactly that in the
 *   tool description and learns the result once, through a notification.
 */
import { sanitize, type McpToolResult, type Toolset } from "./mcp/toolset.js";
import type { AgentDefinition } from "./skills.js";
import type { ToolSpec } from "./types.js";

/** The tool a parent calls to delegate (the aggregate namespaces it `delegate_task`). */
export const TASK_TOOL = "task";

export interface SubagentTask {
  /** Short label for the work (3–5 words). */
  description: string;
  /** The task itself. The child cannot see the parent's conversation. */
  prompt: string;
  /** Optional specialist label: names the child's session. */
  agent?: string;
  /** Return immediately and notify on completion instead of blocking. */
  background?: boolean;
}

export interface SubagentResult {
  status: "completed" | "failed";
  /** The child's final answer — not its transcript. */
  summary: string;
  /** Model steps the child took. */
  steps: number;
  /** The isolated session the child ran in. */
  sessionId: string;
}

export interface DelegationOptions {
  /** The parent session id; children are named under it. */
  session: string;
  /**
   * The parent's tools, delegation tool included — read at **call** time, because
   * the toolset joins the aggregate before the tool list exists. Narrowed per
   * child.
   */
  tools: () => ToolSpec[];
  /** The namespaced name of the delegation tool itself (never given to a child). */
  taskToolName: string;
  /**
   * Skills that also declare a tool policy, so `agent` can name a *definition*
   * rather than a bare label. Discovered by `src/skills.ts`; a definition can only
   * narrow the child.
   */
  agents?: AgentDefinition[];
  /** Run one child to completion. `context.tools` is what the child may use. */
  run: (
    task: SubagentTask,
    sessionId: string,
    context: DelegationContext,
  ) => Promise<SubagentResult>;
  /** Where a background child's completion is announced to the parent. */
  notify?: (message: string) => void;
  /** How many children may run at once in the background (default 2). */
  maxBackground?: number;
}

export interface DelegationContext {
  /** The agent definition this child was given, when it named one. */
  definition?: AgentDefinition;
  /** The tools the child may use: the parent's, narrowed. */
  tools: ToolSpec[];
}

/**
 * The child's approval prompt: **always deny**.
 *
 * Delegation must not amplify authority, so an auto-approving parent does not
 * confer auto-approval on its children. Everything the gate *allows* still runs
 * in a child; only a call the policy marked `require_confirmation` is refused.
 */
export function subagentApproval(): (toolName: string) => boolean {
  return () => false;
}

/**
 * The tools a child may use: the parent's, narrowed by the child's definition and
 * never widened by it. Two rules hold by construction:
 *
 * - the delegation tool is always removed, so recursion is bounded — a child
 *   cannot spawn children;
 * - an allowlist is a **filter** over the parent's tools, so naming a tool the
 *   parent lacks grants nothing.
 *
 * A definition names tools bare (`search_customer`) or fully namespaced
 * (`adaptive_search_customer`); a bare name matches a namespaced tool whose name
 * ends in `_<name>`, which is how the aggregate namespaces MCP servers.
 */
export function narrowTools(
  parentTools: ToolSpec[],
  definition: AgentDefinition | undefined,
  taskToolName: string,
): ToolSpec[] {
  let allowed = parentTools.filter((spec) => spec.name !== taskToolName);
  if (definition?.tools?.length) {
    const allowlist = definition.tools;
    allowed = allowed.filter((spec) => allowlist.some((name) => namesTool(spec.name, name)));
  }
  if (definition?.deny?.length) {
    const denylist = definition.deny;
    allowed = allowed.filter((spec) => !denylist.some((name) => namesTool(spec.name, name)));
  }
  return allowed;
}

/** Whether a spec name is the given tool, bare or under a server prefix. */
function namesTool(specName: string, name: string): boolean {
  return specName === name || specName.endsWith(`_${name}`);
}

/** The session a child runs in: named under the parent, so the graph reads as a tree. */
export function childSessionId(parent: string, task: SubagentTask, index: number): string {
  const label = task.agent ? `-${sanitize(task.agent)}` : "";
  return `${parent}/task${label}-${index}`;
}

const TASK_DESCRIPTION = [
  "Delegate a self-contained task to a sub-agent that runs in its own session and returns only its result.",
  "Use it for separable work that would flood this conversation (a broad search, a long review).",
  "The sub-agent cannot see this conversation: put everything it needs in `prompt`.",
  "Pass `agent` to delegate to a named specialist, which may use only the tools its skill allows.",
  "A background task returns immediately — then do NOT poll for progress, ask for its status, or duplicate",
  "its work in the meantime; you will be told when it finishes.",
].join(" ");

/**
 * Expose delegation as an ordinary tool, so the model decides to delegate with the
 * machinery it already understands — and so a call takes the normal path
 * (approval gate, middleware, telemetry, execution graph).
 */
export function taskToolset(options: DelegationOptions): Toolset {
  const maxBackground = options.maxBackground ?? 2;
  const running = new Set<Promise<void>>();
  const agents = new Map((options.agents ?? []).map((agent) => [agent.name, agent]));
  let issued = 0;

  const start = async (
    task: SubagentTask,
    sessionId: string,
    context: DelegationContext,
  ): Promise<SubagentResult> => {
    try {
      return await options.run(task, sessionId, context);
    } catch (error) {
      return {
        status: "failed",
        summary: `the sub-agent failed: ${error instanceof Error ? error.message : String(error)}`,
        steps: 0,
        sessionId,
      };
    }
  };

  return {
    serverName: "delegate",
    async listTools(): Promise<ToolSpec[]> {
      return [
        {
          name: TASK_TOOL,
          description: TASK_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              description: { type: "string", description: "Short label for the work (3-5 words)." },
              prompt: {
                type: "string",
                description:
                  "The task, with any context it needs — the sub-agent sees none of this.",
              },
              agent: {
                type: "string",
                description:
                  "Optional specialist: a skill that declares which tools the sub-agent may " +
                  "use. An unknown name fails the call.",
              },
              background: {
                type: "boolean",
                description: "Return immediately and report the result when it finishes.",
              },
            },
            required: ["description", "prompt"],
          },
          serverName: "delegate",
        },
      ];
    },

    async callTool(name, input): Promise<McpToolResult> {
      if (name !== TASK_TOOL) return { ok: false, error: `unknown tool: ${name}` };
      const parsed = readTask(input);
      if ("error" in parsed) return { ok: false, error: parsed.error };
      const task = parsed.task;

      // Resolve the named specialist *before* spawning: an unknown name is a
      // caller mistake worth reporting, not something to paper over by acting as
      // a generalist.
      const definition = task.agent ? agents.get(task.agent) : undefined;
      if (task.agent && !definition) {
        const available = [...agents.keys()].sort();
        return {
          ok: false,
          error:
            `unknown agent "${task.agent}"` +
            (available.length > 0
              ? `; available: ${available.join(", ")}`
              : " (no skill declares a tool policy)"),
        };
      }
      const context: DelegationContext = {
        definition,
        tools: narrowTools(options.tools(), definition, options.taskToolName),
      };
      const sessionId = childSessionId(options.session, task, (issued += 1));

      if (!task.background) {
        const result = await start(task, sessionId, context);
        return result.status === "completed"
          ? { ok: true, output: result }
          : { ok: false, error: result.summary, output: result };
      }

      // Background: the parent is told once, when the child finishes — never by
      // polling. The notification arrives as a steering message on the next step.
      if (running.size >= maxBackground) {
        return {
          ok: false,
          error: `${running.size} background tasks are already running (max ${maxBackground}); wait for one to finish`,
        };
      }
      const promise = start(task, sessionId, context)
        .then((result) => options.notify?.(describeCompletion(task, result)))
        .finally(() => running.delete(promise));
      running.add(promise);
      return {
        ok: true,
        output: {
          status: "running",
          sessionId,
          note: "Do not poll for this task; you will be told when it finishes.",
        },
      };
    },

    async close(): Promise<void> {
      // Let children finish, so a run does not end mid-delegation.
      await Promise.all([...running]);
    },
  };
}

/** The one notification a background child produces. */
export function describeCompletion(task: SubagentTask, result: SubagentResult): string {
  return [
    `Background task finished: ${task.description}`,
    `Status: ${result.status} (session ${result.sessionId}, ${result.steps} step(s))`,
    "",
    result.summary,
  ].join("\n");
}

function readTask(input: unknown): { task: SubagentTask } | { error: string } {
  if (typeof input !== "object" || input === null) return { error: "task expects an object" };
  const raw = input as Record<string, unknown>;
  const description = raw.description;
  const prompt = raw.prompt;
  if (typeof description !== "string" || !description.trim()) {
    return { error: "description is required" };
  }
  if (typeof prompt !== "string" || !prompt.trim()) return { error: "prompt is required" };
  if (raw.agent !== undefined && typeof raw.agent !== "string") {
    return { error: "agent must be a string" };
  }
  if (raw.background !== undefined && typeof raw.background !== "boolean") {
    return { error: "background must be a boolean" };
  }
  const agent = typeof raw.agent === "string" && raw.agent.trim() ? raw.agent.trim() : undefined;
  return {
    task: { description: description.trim(), prompt, agent, background: raw.background === true },
  };
}
