import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import type { CliArgs, System1Tier } from "./cli-args.js";
import { ORCHESTRATION_MODES, isOrchestrationMode } from "./modes.js";

/**
 * Keys a config file may set. `help`, `version`, `prompt`, `listTools`, and
 * `interactive` are deliberately excluded: they select *what to do now*, not
 * how the agent is configured for repeatable runs.
 */
const STRING_KEYS = [
  "model",
  "models",
  "db",
  "yaml",
  "session",
  "workflow",
  "history",
  "baseUrl",
  "apiKey",
  "system1Model",
] as const;
const NUMBER_KEYS = ["maxSteps", "routerMinInvocations"] as const;
const BOOLEAN_KEYS = [
  "system1",
  "awaitJobs",
  "task",
  "tasks",
  "noOllama",
  "noStream",
  "autoApprove",
  "context",
  "serverPolicy",
  "compress",
  "report",
  "verbose",
] as const;
const TIERS: readonly System1Tier[] = ["ollama", "openai"];

/**
 * Read an agent config file (YAML or JSON — JSON is a subset of YAML, so one
 * parser covers both) into the subset of `CliArgs` it is allowed to set.
 *
 * Unknown keys and wrong types are rejected rather than ignored, mirroring the
 * CLI's unknown-flag handling: a silently dropped `modle:` would be worse than
 * an error. `servers` may be a single string or a list.
 */
export function loadAgentConfig(path: string): Partial<CliArgs> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `could not read config "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (text.trim() === "") return {};
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(
      `could not parse config "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config "${path}" must be a mapping of options`);
  }
  const doc = raw as Record<string, unknown>;
  const out: Partial<CliArgs> = {};

  if (doc.servers !== undefined) {
    const value = doc.servers;
    if (typeof value === "string") out.servers = [value];
    else if (Array.isArray(value) && value.every((s) => typeof s === "string"))
      out.servers = value as string[];
    else throw new Error(`config "${path}": "servers" must be a string or a list of strings`);
  }
  for (const key of STRING_KEYS) {
    const value = doc[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`config "${path}": "${key}" must be a string`);
    (out as Record<string, unknown>)[key] = value;
  }
  if (doc.skills !== undefined) {
    const value = doc.skills;
    if (typeof value === "string") out.skills = [value];
    else if (Array.isArray(value) && value.every((s) => typeof s === "string"))
      out.skills = value as string[];
    else throw new Error(`config "${path}": "skills" must be a string or a list of strings`);
  }
  for (const key of NUMBER_KEYS) {
    const value = doc[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`config "${path}": "${key}" must be a number`);
    (out as Record<string, unknown>)[key] = value;
  }
  for (const key of BOOLEAN_KEYS) {
    const value = doc[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error(`config "${path}": "${key}" must be a boolean`);
    (out as Record<string, unknown>)[key] = value;
  }
  if (doc.defaultRisk !== undefined) {
    const value = doc.defaultRisk;
    if (value !== "low" && value !== "medium" && value !== "high" && value !== "none")
      throw new Error(`config "${path}": "defaultRisk" expects low|medium|high|none`);
    out.defaultRisk = value;
  }
  if (doc.mode !== undefined) {
    const value = doc.mode;
    // Mirrors the flag: a mode name we know, or nothing.
    if (typeof value !== "string" || !isOrchestrationMode(value)) {
      throw new Error(
        `config "${path}": "mode" expects ${ORCHESTRATION_MODES.join("|")}`,
      );
    }
    out.mode = value;
  }
  if (doc.system1Backend !== undefined) {
    const value = doc.system1Backend;
    // Mirrors the flag: one tier stays a string, a comma list (or YAML list)
    // becomes an array.
    const tiers =
      typeof value === "string"
        ? value
            .split(",")
            .map((tier) => tier.trim())
            .filter(Boolean)
        : Array.isArray(value)
          ? value
          : undefined;
    if (
      tiers === undefined ||
      tiers.length === 0 ||
      !tiers.every((tier): tier is System1Tier => TIERS.includes(tier as System1Tier))
    ) {
      throw new Error(
        `config "${path}": "system1Backend" expects ollama|openai (or a list of them)`,
      );
    }
    out.system1Backend = tiers.length === 1 ? (tiers[0] as System1Tier) : (tiers as System1Tier[]);
  }

  const known = new Set<string>([
    "servers",
    "skills",
    "defaultRisk",
    "system1Backend",
    "mode",
    ...STRING_KEYS,
    ...NUMBER_KEYS,
    ...BOOLEAN_KEYS,
  ]);
  for (const key of Object.keys(doc)) {
    if (!known.has(key)) throw new Error(`config "${path}": unknown key "${key}"`);
  }
  return out;
}
