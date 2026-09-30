import type { DecodingProfileId } from "@adaptivemcp/routing";
import type {
  DecisionBackend,
  SystemOneAnswer,
  SystemOneChoiceQuestion,
  SystemOneNoulQuestion,
  SystemOneQuestion,
  SystemOneResponse,
} from "./systemone.js";

/** A tool as summarized from Adaptive MCP metadata for the decision state. */
export interface DecisionToolInfo {
  toolName: string;
  serverName?: string;
  description?: string;
  risk?: string;
  invocations?: number;
  failureRate?: number;
  avgDurationMs?: number;
}

/** A candidate model (catalog resource) for the decision state. */
export interface DecisionModelInfo {
  id: string;
  label?: string;
  costWeight?: number;
  latencyWeight?: number;
}

export interface SystemOneAdvisorInput {
  /** The user's current request (the thing to decide about). */
  message: string;
  tools: DecisionToolInfo[];
  models: DecisionModelInfo[];
}

/** The distilled decision a host can apply to the next completion. */
export interface SystemOneDecision {
  /** Catalog id of the recommended model, when the model was confident. */
  modelId?: string;
  /** Recommended tool subset; `[]` means "no tools", `undefined` means "no opinion". */
  toolNames?: string[];
  /** Recommended decoding profile. */
  decodingProfile?: DecodingProfileId;
  /** Lowest confidence among the signals actually used. */
  confidence: number;
  /** Compact, human-readable explanation for logs/telemetry. */
  rationale: string;
  /** Raw per-question answers, for observability. */
  answers: Record<string, SystemOneAnswer>;
}

export interface SystemOneAdvisorOptions {
  backend: DecisionBackend;
  /** Ignore an answer whose confidence is below this. Default 0.5. */
  minConfidence?: number;
  /** Cap candidates to Ollama's 26-options-per-choice limit. Default 20. */
  maxTools?: number;
  maxModels?: number;
  /** Called when the backend fails; the advisor then declines (returns undefined). */
  onError?: (error: unknown) => void;
}

const DECODING_PROFILES: Record<DecodingProfileId, string> = {
  deterministic: "Precise and repeatable; best when correctness matters or the task is error-prone.",
  balanced: "Even trade-off between precision and variety.",
  creative: "Varied phrasing; best for open-ended writing.",
};

/**
 * A *System-1* decision layer: one fast, local System One call turns the
 * Adaptive MCP metadata (learned tool reliability, annotations, router model
 * pool) plus the user's request into a model / tool-intent / decoding decision.
 *
 * Deliberately advisory: `decide()` declines (`undefined`) when the backend
 * fails or the model is not confident, so the host can fall back to its slower
 * router. It never calls an LLM through the chat path.
 */
export class SystemOneAdvisor {
  private readonly backend: DecisionBackend;
  private readonly minConfidence: number;
  private readonly maxTools: number;
  private readonly maxModels: number;
  private readonly onError?: (error: unknown) => void;

  constructor(options: SystemOneAdvisorOptions) {
    this.backend = options.backend;
    this.minConfidence = options.minConfidence ?? 0.5;
    this.maxTools = options.maxTools ?? 20;
    this.maxModels = options.maxModels ?? 20;
    this.onError = options.onError;
  }

  async decide(input: SystemOneAdvisorInput): Promise<SystemOneDecision | undefined> {
    const tools = [...input.tools]
      .sort((a, b) => (b.invocations ?? 0) - (a.invocations ?? 0))
      .slice(0, this.maxTools);
    const models = input.models.slice(0, this.maxModels);
    const { questions, maps } = buildQuestions(input.message, tools, models);
    if (Object.keys(questions).length === 0) return undefined;

    let response: SystemOneResponse;
    try {
      response = await this.backend.answer(stateFor(input.message, tools, models), questions);
    } catch (error) {
      this.onError?.(error);
      return undefined;
    }

    return this.interpret(response, maps);
  }

  private interpret(
    response: SystemOneResponse,
    maps: QuestionMaps,
  ): SystemOneDecision | undefined {
    const answers = response.answers ?? {};
    const rationale: string[] = [];
    const confidences: number[] = [];
    const decision: SystemOneDecision = { confidence: 0, rationale: "", answers };

    const model = answers.model;
    if (model?.type === "choice" && model.confidence >= this.minConfidence) {
      const id = maps.models.get(model.choice);
      if (id) {
        decision.modelId = id;
        confidences.push(model.confidence);
        rationale.push(`model=${id} (p=${model.probabilities[model.choice]?.toFixed(2) ?? "?"})`);
      }
    }

    const useTools = answers.use_tools;
    let wantsTools: boolean | undefined;
    if (useTools?.type === "noul") {
      wantsTools = useTools.noul >= 0.5;
      confidences.push(Math.abs(useTools.noul - 0.5) * 2);
      rationale.push(`use_tools=${wantsTools}`);
    }

    const tool = answers.tool;
    if (tool?.type === "choice" && tool.confidence >= this.minConfidence && wantsTools !== false) {
      const name = maps.tools.get(tool.choice);
      if (name) {
        decision.toolNames = [name];
        confidences.push(tool.confidence);
        rationale.push(`tool=${name} (p=${tool.probabilities[tool.choice]?.toFixed(2) ?? "?"})`);
      }
    } else if (wantsTools === false) {
      decision.toolNames = [];
    }

    const decoding = answers.decoding;
    if (decoding?.type === "choice" && decoding.confidence >= this.minConfidence) {
      const profile = decoding.choice as DecodingProfileId;
      if (profile in DECODING_PROFILES) {
        decision.decodingProfile = profile;
        confidences.push(decoding.confidence);
        rationale.push(`decoding=${profile}`);
      }
    }

    if (confidences.length === 0) return undefined;
    decision.confidence = Math.min(...confidences);
    decision.rationale = rationale.join("; ");
    return decision;
  }
}

interface QuestionMaps {
  models: Map<string, string>;
  tools: Map<string, string>;
}

interface BuiltQuestions {
  questions: Record<string, SystemOneQuestion>;
  maps: QuestionMaps;
}

function stateFor(
  message: string,
  tools: DecisionToolInfo[],
  models: DecisionModelInfo[],
): Record<string, unknown> {
  return {
    request: message,
    tools: tools.map((tool) => ({ name: tool.toolName, ...describeTool(tool) })),
    models: models.map((model) => ({ id: model.id, ...describeModel(model) })),
  };
}

function buildQuestions(
  message: string,
  tools: DecisionToolInfo[],
  models: DecisionModelInfo[],
): BuiltQuestions {
  const questions: Record<string, SystemOneQuestion> = {};
  const maps: QuestionMaps = { models: new Map(), tools: new Map() };

  if (models.length >= 2) {
    const criteria: SystemOneChoiceQuestion["criteria"] = {};
    for (const model of models) {
      const key = uniqueKey(model.id, maps.models);
      maps.models.set(key, model.id);
      criteria[key] = describeModelText(model);
    }
    questions.model = {
      type: "choice",
      instructions: `Which model best fits this request? Weigh cost, latency, and reliability. Request: ${message}`,
      criteria,
    };
  }

  if (tools.length >= 2) {
    const noul: SystemOneNoulQuestion = {
      type: "noul",
      instructions: `Does this request require calling one of the available tools? Request: ${message}`,
      criteria: { false: "No tool is needed", true: "A tool call is needed" },
    };
    questions.use_tools = noul;

    const criteria: SystemOneChoiceQuestion["criteria"] = {};
    for (const tool of tools) {
      const key = uniqueKey(tool.toolName, maps.tools);
      maps.tools.set(key, tool.toolName);
      criteria[key] = describeToolText(tool);
    }
    questions.tool = {
      type: "choice",
      instructions: `Which tool should handle this request? Request: ${message}`,
      criteria,
    };
  }

  const decoding: SystemOneChoiceQuestion["criteria"] = {};
  for (const [id, description] of Object.entries(DECODING_PROFILES)) {
    decoding[id] = description;
  }
  questions.decoding = {
    type: "choice",
    instructions: `What decoding profile suits this request? Request: ${message}`,
    criteria: decoding,
  };

  return { questions, maps };
}

function uniqueKey(value: string, taken: Map<string, string>): string {
  const base = value.replace(/\s+/g, "_").trim() || "option";
  let key = base;
  let index = 2;
  while (taken.has(key)) {
    key = `${base}_${index}`;
    index += 1;
  }
  return key;
}

function describeModel(model: DecisionModelInfo): Record<string, unknown> {
  return { label: model.label, cost: model.costWeight, latency: model.latencyWeight };
}

function describeModelText(model: DecisionModelInfo): string {
  const parts = [model.label ?? model.id];
  if (model.costWeight !== undefined) parts.push(`cost ${model.costWeight}`);
  if (model.latencyWeight !== undefined) parts.push(`latency ${model.latencyWeight}`);
  return parts.join(", ");
}

function describeTool(tool: DecisionToolInfo): Record<string, unknown> {
  return {
    description: tool.description,
    risk: tool.risk,
    invocations: tool.invocations,
    failure_rate: tool.failureRate,
    avg_ms: tool.avgDurationMs,
  };
}

function describeToolText(tool: DecisionToolInfo): string {
  const parts: string[] = [];
  if (tool.description) parts.push(tool.description);
  if (tool.risk) parts.push(`risk ${tool.risk}`);
  if (tool.failureRate !== undefined) parts.push(`${Math.round(tool.failureRate * 100)}% failed`);
  if (tool.invocations !== undefined) parts.push(`${tool.invocations} prior calls`);
  return parts.length > 0 ? `${tool.toolName}: ${parts.join(", ")}` : tool.toolName;
}
