import { describe, expect, it } from "vitest";
import {
  coerceAnswer,
  createElicitationHandler,
  readForm,
  renderForm,
  isHttpUrl,
  readUrlRequest,
  renderReview,
  schemaDefaults,
  validateValue,
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

describe("per-field re-edit from the review", () => {
  const TWO = {
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
    },
  };

  it("re-asks one field and keeps the others", async () => {
    const asked: string[] = [];
    const answers = ["Ada", "41", "edit name", "Grace", "y"];
    const result = await readForm(TWO, async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    });

    expect(result).toEqual({ action: "accept", content: { name: "Grace", age: 41 } });
    // Only `name` was asked again, not the whole form.
    expect(asked.filter((line) => line.startsWith("  name")).length).toBe(2);
    expect(asked.filter((line) => line.startsWith("  age")).length).toBe(1);
  });

  it("drops a field cleared during an edit instead of sending a stale value", async () => {
    const answers = ["Ada", "41", "edit name", "", "y"];
    const result = await readForm(TWO, async () => answers.shift() ?? "");
    expect(result).toEqual({ action: "accept", content: { age: 41 } });
  });

  it("reports an unknown field name and asks again without spending the review", async () => {
    const notes: string[] = [];
    const answers = ["Ada", "41", "edit nope", "y"];
    const result = await readForm(
      TWO,
      async () => answers.shift() ?? "",
      (line) => notes.push(line),
    );

    expect(result.action).toBe("accept");
    expect(notes.some((line) => line.includes('no field named "nope"'))).toBe(true);
  });

  it("declines when the edited value is rejected twice", async () => {
    const answers = ["Ada", "41", "edit age", "nope", "still-nope"];
    const result = await readForm(TWO, async () => answers.shift() ?? "");
    expect(result).toEqual({ action: "decline" });
  });

  it("bounds the number of edits", async () => {
    // Six edits to the same field: the sixth is refused rather than letting the review loop.
    const answers = ["Ada", "41"];
    for (let i = 0; i < 6; i += 1) answers.push("edit name", `N${i}`);
    const result = await readForm(TWO, async () => answers.shift() ?? "");
    expect(result).toEqual({ action: "decline" });
  });
});

describe("url-mode elicitation", () => {
  const URL_REQUEST = {
    mode: "url",
    message: "Authorize this device",
    url: "https://auth.example.com/device?code=ABCD",
    elicitationId: "el-1",
  };

  it("shows the link and accepts only when the person confirms", async () => {
    const notes: string[] = [];
    const asked: string[] = [];
    const result = await readUrlRequest(
      URL_REQUEST,
      async (question) => {
        asked.push(question);
        return "y";
      },
      (line) => notes.push(line),
    );

    expect(result).toEqual({ action: "accept" });
    expect(notes.join("\n")).toContain("https://auth.example.com/device?code=ABCD");
    expect(notes.join("\n")).toContain("Authorize this device");
    expect(asked.at(-1)).toContain("completed the flow");
  });

  it("declines when the person did not complete it (the default answer)", async () => {
    const result = await readUrlRequest(URL_REQUEST, async () => "");
    expect(result).toEqual({ action: "decline" });
  });

  it("refuses a non-http(s) URL without showing it", async () => {
    const notes: string[] = [];
    let asked = 0;
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
      const result = await readUrlRequest(
        { mode: "url", url },
        async () => {
          asked += 1;
          return "y";
        },
        (line) => notes.push(line),
      );
      expect(result).toEqual({ action: "decline" });
    }
    // Nothing was offered and nothing was asked.
    expect(asked).toBe(0);
    expect(notes.join("\n")).not.toContain("/etc/passwd");
    expect(notes.join("\n")).toContain("non-http(s)");
  });

  it("only prompt mode can answer a url request; headless modes decline", async () => {
    expect(await createElicitationHandler("defaults")(URL_REQUEST)).toEqual({ action: "decline" });
    expect(await createElicitationHandler("decline")(URL_REQUEST)).toEqual({ action: "decline" });
    // prompt mode without a reader (no TTY) also declines rather than claiming consent.
    expect(await createElicitationHandler("prompt")(URL_REQUEST)).toEqual({ action: "decline" });
    expect(await createElicitationHandler("prompt", async () => "y")(URL_REQUEST)).toEqual({
      action: "accept",
    });
  });

  it("recognises only absolute http(s) URLs", () => {
    expect(isHttpUrl("https://example.com/x")).toBe(true);
    expect(isHttpUrl("http://127.0.0.1:8080/cb")).toBe(true);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("/relative")).toBe(false);
  });
});

describe("whole-form review", () => {
  const TWO = {
    message: "Confirm",
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
    },
  };

  it("shows the form, then the values, then asks before submitting", async () => {
    const asked: string[] = [];
    const notes: string[] = [];
    const answers = ["Ada", "41", "y"];
    const result = await readForm(
      TWO,
      async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
      (line) => notes.push(line),
    );

    expect(result).toEqual({ action: "accept", content: { name: "Ada", age: 41 } });
    // The form is rendered before any question, with every field visible.
    expect(notes[0]).toContain("[elicitation] Confirm");
    expect(notes[0]).toContain("name (string)");
    expect(notes[0]).toContain("age (integer)");
    // The review shows exactly what will be sent.
    expect(notes.some((line) => line.includes('name: "Ada"') && line.includes("age: 41"))).toBe(
      true,
    );
    expect(asked.at(-1)).toContain("submit?");
  });

  it("re-enters the form once when the review is rejected, then accepts", async () => {
    const notes: string[] = [];
    const answers = ["Ada", "41", "n", "Grace", "85", "y"];
    const result = await readForm(
      TWO,
      async () => answers.shift() ?? "",
      (line) => notes.push(line),
    );

    expect(result).toEqual({ action: "accept", content: { name: "Grace", age: 85 } });
    expect(notes).toContain("[elicitation] re-entering the form");
  });

  it("declines when the review is rejected twice, sending nothing", async () => {
    const answers = ["Ada", "41", "n", "Grace", "85", "n"];
    const result = await readForm(TWO, async () => answers.shift() ?? "");
    expect(result).toEqual({ action: "decline" });
  });

  it("asks again on a non-answer instead of treating it as consent", async () => {
    const answers = ["Ada", "41", "maybe", "y"];
    const result = await readForm(TWO, async () => answers.shift() ?? "");
    expect(result).toEqual({ action: "accept", content: { name: "Ada", age: 41 } });
  });

  it("declines instead of looping on a review answer that is not a decision", async () => {
    const answers = ["Ada", "41", "maybe", "dunno", "?"];
    const result = await readForm(TWO, async () => answers.shift() ?? "");
    expect(result).toEqual({ action: "decline" });
  });

  it("skips the review for a single field", async () => {
    const asked: string[] = [];
    const result = await readForm(
      {
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      },
      async (question) => {
        asked.push(question);
        return "Ada";
      },
    );

    expect(result).toEqual({ action: "accept", content: { name: "Ada" } });
    expect(asked.some((line) => line.includes("submit?"))).toBe(false);
  });

  it("renders omitted fields as omitted, not as a guess", () => {
    const text = renderReview(TWO, { name: "Ada" });
    expect(text).toContain('name: "Ada"');
    expect(text).toContain("age: (omitted)");
  });
});

describe("nested object and array fields", () => {
  const NESTED = {
    message: "Shipping details",
    requestedSchema: {
      type: "object",
      properties: {
        address: {
          type: "object",
          required: ["city"],
          properties: { city: { type: "string" }, postcode: { type: "string" } },
        },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  };

  it("parses JSON object and array answers into real values", async () => {
    const answers = ['{"city":"Berlin","postcode":"10115"}', '["a","b"]'];
    const result = await createElicitationHandler(
      "prompt",
      async () => answers.shift() ?? "",
    )(NESTED);

    expect(result).toEqual({
      action: "accept",
      content: { address: { city: "Berlin", postcode: "10115" }, tags: ["a", "b"] },
    });
  });

  it("re-asks on invalid JSON and accepts the corrected document", async () => {
    const errors: string[] = [];
    const answers = ['{"city":', '{"city":"Berlin"}', "[]"];
    const result = await createElicitationHandler(
      "prompt",
      async () => answers.shift() ?? "",
      (line) => errors.push(line),
    )(NESTED);

    expect(result.action).toBe("accept");
    expect((result as { content: Record<string, unknown> }).content.address).toEqual({
      city: "Berlin",
    });
    expect(errors.some((line) => line.includes("expected JSON object"))).toBe(true);
  });

  it("declines after a second invalid document", async () => {
    const answers = ["not json", "still not"];
    const result = await createElicitationHandler(
      "prompt",
      async () => answers.shift() ?? "",
    )(NESTED);
    expect(result).toEqual({ action: "decline" });
  });

  it("rejects a document missing a required key, and one of the wrong type", () => {
    const address = NESTED.requestedSchema.properties.address;
    expect(() => validateValue(address, { postcode: "10115" })).toThrow(
      /missing required key "city"/,
    );
    expect(() => validateValue(address, "Berlin")).toThrow(/expected a JSON object/);
    expect(() => validateValue(address, ["Berlin"])).toThrow(/expected a JSON object/);
    expect(() => validateValue(address, { city: 7 })).toThrow(/expected a string/);
    expect(() => validateValue({ type: "array", items: { type: "integer" } }, [1, "two"])).toThrow(
      /expected an integer/,
    );
    expect(() => validateValue({ type: "array" }, {})).toThrow(/expected a JSON array/);
  });

  it("takes an object or array default on a blank answer", () => {
    expect(coerceAnswer({ type: "object", default: { city: "Berlin" } }, "")).toEqual({
      city: "Berlin",
    });
    expect(coerceAnswer({ type: "array", default: [] }, "")).toEqual([]);
  });

  it("shows the JSON shape in the form", () => {
    const text = renderForm(NESTED);
    expect(text).toContain("address (object, JSON)");
    expect(text).toContain("required keys: city");
    expect(text).toContain("tags (array, JSON)");
    expect(text).toContain("items: string");
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
