/**
 * Answering a server's `elicitation/create` request (MCP elicitation, SEP-1034).
 *
 * Three modes, because "the client got a form" has three honest answers:
 *
 * - **defaults** — accept with the schema's declared `default` values. For headless runs.
 * - **decline** — refuse. For a host with nobody to ask.
 * - **prompt** — show the form and read the answers. The interesting one, and the only one
 *   where the values come from a person.
 *
 * Only *declared* defaults are ever filled in. A field with no default is omitted rather
 * than guessed, in every mode.
 */

export type ElicitationMode = "defaults" | "decline" | "prompt";

/** The subset of the request this module needs; the SDK's params are wider. */
export interface ElicitationRequest {
  message?: string;
  mode?: string;
  requestedSchema?: unknown;
}

export type ElicitResult =
  { action: "accept"; content: Record<string, unknown> } | { action: "decline" };

/** Asks a question and returns the raw answer; injected so this is testable without a TTY. */
export type ElicitationAsk = (question: string) => Promise<string>;

interface FieldSchema {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  enumNames?: string[];
  oneOf?: { const?: unknown; title?: string }[];
}

/** Pre-fill from declared defaults only. */
export function schemaDefaults(schema: unknown): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  const properties = (schema as { properties?: Record<string, FieldSchema> } | undefined)
    ?.properties;
  if (!properties) return content;
  for (const [name, field] of Object.entries(properties)) {
    if (field && typeof field === "object" && "default" in field) content[name] = field.default;
  }
  return content;
}

function properties(schema: unknown): Record<string, FieldSchema> {
  return (schema as { properties?: Record<string, FieldSchema> } | undefined)?.properties ?? {};
}

function choices(field: FieldSchema): { value: unknown; label: string }[] {
  if (Array.isArray(field.oneOf)) {
    return field.oneOf
      .filter((entry) => entry && typeof entry === "object" && "const" in entry)
      .map((entry, index) => ({
        value: entry.const,
        label: entry.title ?? field.enumNames?.[index] ?? String(entry.const),
      }));
  }
  return (field.enum ?? []).map((value, index) => ({
    value,
    label: field.enumNames?.[index] ?? String(value),
  }));
}

/** The lines shown to the person before the answers are read. */
export function renderForm(request: ElicitationRequest): string {
  const lines = [`[elicitation] ${request.message ?? "The server is asking for input."}`];
  const fields = properties(request.requestedSchema);
  const names = Object.keys(fields);
  if (names.length === 0) return lines.join("\n");
  for (const name of names) {
    const field = fields[name] as FieldSchema;
    const type = field.type ?? "string";
    const options = choices(field);
    const parts = [`  ${name} (${type})`];
    if (field.title) parts.push(`${field.title}.`);
    if (field.description) parts.push(field.description);
    if (options.length > 0) parts.push(`one of: ${options.map((o) => o.label).join(", ")}`);
    if ("default" in field) parts.push(`default: ${String(field.default)}`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

/**
 * Coerce one answer against the field's schema. Returns `undefined` when the answer is
 * empty and the field has no default (the field is omitted), and throws on a value the
 * schema cannot accept, so the prompt can ask again.
 */
export function coerceAnswer(field: FieldSchema, answer: string): unknown {
  const text = answer.trim();
  if (text === "") {
    if ("default" in field) return field.default;
    return undefined;
  }
  const options = choices(field);
  if (options.length > 0) {
    const match =
      options.find((option) => String(option.value) === text) ??
      options.find((option) => option.label.toLowerCase() === text.toLowerCase());
    if (!match) throw new Error(`expected one of ${options.map((o) => o.label).join(", ")}`);
    return match.value;
  }
  switch (field.type) {
    case "boolean": {
      const lowered = text.toLowerCase();
      if (["y", "yes", "true", "1"].includes(lowered)) return true;
      if (["n", "no", "false", "0"].includes(lowered)) return false;
      throw new Error("expected yes or no");
    }
    case "integer": {
      const value = Number(text);
      if (!Number.isInteger(value)) throw new Error("expected an integer");
      return value;
    }
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error("expected a number");
      return value;
    }
    default:
      return answer;
  }
}

/**
 * Walk the form one field at a time. A blank answer takes the default (or omits the field);
 * an answer the schema rejects is asked again once, then declines rather than sending
 * something the server would reject.
 */
export async function readForm(
  request: ElicitationRequest,
  ask: ElicitationAsk,
  notify: (message: string) => void = () => {},
): Promise<ElicitResult> {
  const fields = properties(request.requestedSchema);
  const content: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const suffix = "default" in field ? ` [${String(field.default)}]` : "";
    let answered = false;
    for (let attempt = 0; attempt < 2 && !answered; attempt += 1) {
      const retry = attempt === 0 ? "" : " (again)";
      const answer = await ask(`  ${name}${suffix}${retry}: `);
      try {
        const value = coerceAnswer(field, answer);
        if (value !== undefined) content[name] = value;
        answered = true;
      } catch (error) {
        if (attempt === 1) {
          // Never send a value the schema rejects: declining is the honest failure.
          return { action: "decline" };
        }
        // Reported out of band: the answer queue is for answers, not diagnostics.
        notify(`  ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { action: "accept", content };
}

/**
 * The handler a toolset uses. `ask` is only consulted in `prompt` mode; without one (or
 * without a terminal) the request is declined rather than answered on the person's behalf.
 */
export function createElicitationHandler(
  mode: ElicitationMode,
  ask?: ElicitationAsk,
  notify?: (message: string) => void,
): (request: ElicitationRequest) => Promise<ElicitResult> {
  return async (request) => {
    if (request.mode === "url") return { action: "decline" };
    if (mode === "decline") return { action: "decline" };
    if (mode === "defaults")
      return { action: "accept", content: schemaDefaults(request.requestedSchema) };
    if (!ask) return { action: "decline" };
    return readForm(request, ask, notify);
  };
}
