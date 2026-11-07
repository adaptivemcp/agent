import { describe, expect, it } from "vitest";
import {
  coerceAnswer,
  createElicitationHandler,
  readForm,
  renderForm,
  schemaDefaults,
} from "./elicitation.js";

/**
 * Elicitation answers.
 *
 * The properties that matter: only *declared* defaults are filled, a typed answer is
 * coerced to the schema's type (not passed through as a string), an unparseable answer is
 * asked again rather than sent, and a host with nobody to ask declines instead of inventing
 * consent.
 */

const REQUEST = {
  message: "Please confirm",
  requestedSchema: {
    type: "object",
    properties: {
      name: { type: "string", default: "John Doe" },
      age: { type: "integer", default: 30 },
      newsletter: { type: "boolean", default: true },
      plan: { type: "string", enum: ["free", "pro"], default: "free" },
      note: { type: "string" },
    },
  },
};

describe("elicitation handler", () => {
  it("accepts with declared defaults only, in defaults mode", async () => {
    const result = await createElicitationHandler("defaults")(REQUEST);

    expect(result).toEqual({
      action: "accept",
      content: { name: "John Doe", age: 30, newsletter: true, plan: "free" },
    });
    expect(Object.keys((result as { content: object }).content)).not.toContain("note");
  });

  it("declines in decline mode, and when there is nobody to ask", async () => {
    expect(await createElicitationHandler("decline")(REQUEST)).toEqual({ action: "decline" });
    expect(await createElicitationHandler("prompt")(REQUEST)).toEqual({ action: "decline" });
  });

  it("declines a url-mode elicitation in every mode", async () => {
    for (const mode of ["defaults", "decline", "prompt"] as const) {
      const handler = createElicitationHandler(mode, async () => "x");
      expect(await handler({ ...REQUEST, mode: "url" })).toEqual({ action: "decline" });
    }
  });

  it("reads the form and coerces answers to the schema's types", async () => {
    const answers = ["Ada", "41", "no", "pro", ""];
    const result = await createElicitationHandler(
      "prompt",
      async () => answers.shift() ?? "",
    )(REQUEST);

    expect(result).toEqual({
      action: "accept",
      content: { name: "Ada", age: 41, newsletter: false, plan: "pro" },
    });
  });

  it("takes the default on a blank answer", async () => {
    const answers = ["", "", "", "", ""];
    const result = await createElicitationHandler(
      "prompt",
      async () => answers.shift() ?? "",
    )(REQUEST);

    expect(result).toEqual({
      action: "accept",
      content: { name: "John Doe", age: 30, newsletter: true, plan: "free" },
    });
  });

  it("asks again on an answer the schema rejects", async () => {
    const asked: string[] = [];
    const errors: string[] = [];
    const answers = ["Ada", "not-a-number", "41", "yes", "free", ""];
    const result = await readForm(
      REQUEST,
      async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
      (line) => errors.push(line),
    );

    expect(result.action).toBe("accept");
    expect((result as { content: Record<string, unknown> }).content.age).toBe(41);
    // The diagnostic goes out of band, so it does not consume an answer.
    expect(errors.some((line) => line.includes("expected an integer"))).toBe(true);
    expect(asked.filter((line) => line.includes("age"))).toHaveLength(2);
  });

  it("declines rather than sending a value the schema rejects twice", async () => {
    const answers = ["Ada", "nope", "still-nope"];
    const result = await readForm(REQUEST, async () => answers.shift() ?? "");

    expect(result).toEqual({ action: "decline" });
  });
});

describe("form rendering and coercion", () => {
  it("shows the type, description, options and default for each field", () => {
    const text = renderForm({
      message: "Pick",
      requestedSchema: {
        type: "object",
        properties: {
          plan: {
            type: "string",
            description: "Which plan",
            enum: ["free", "pro"],
            enumNames: ["Free", "Pro"],
            default: "free",
          },
        },
      },
    });

    expect(text).toContain("[elicitation] Pick");
    expect(text).toContain("plan (string)");
    expect(text).toContain("Which plan");
    expect(text).toContain("one of: Free, Pro");
    expect(text).toContain("default: free");
  });

  it("coerces by type and rejects what does not fit", () => {
    expect(coerceAnswer({ type: "integer" }, "7")).toBe(7);
    expect(coerceAnswer({ type: "number" }, "7.5")).toBe(7.5);
    expect(coerceAnswer({ type: "boolean" }, "YES")).toBe(true);
    expect(coerceAnswer({ type: "string", enum: ["a", "b"] }, "B")).toBe("b");
    expect(coerceAnswer({ type: "string", enum: ["a"], default: "a" }, "")).toBe("a");
    expect(coerceAnswer({ type: "string" }, "")).toBeUndefined();
    expect(() => coerceAnswer({ type: "integer" }, "x")).toThrow(/integer/);
    expect(() => coerceAnswer({ type: "boolean" }, "maybe")).toThrow(/yes or no/);
    expect(() => coerceAnswer({ type: "string", enum: ["a"] }, "c")).toThrow(/one of/);
  });

  it("reads defaults from oneOf consts as well as enums", () => {
    expect(
      schemaDefaults({
        type: "object",
        properties: { plan: { oneOf: [{ const: "a", title: "A" }], default: "a" } },
      }),
    ).toEqual({ plan: "a" });
  });
});
