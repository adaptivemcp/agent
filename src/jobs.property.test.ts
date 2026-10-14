import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseJobHandle } from "./jobs.js";

describe("parseJobHandle (property)", () => {
  it("returns a handle exactly when a non-empty id and status are present", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (jobId, status) => {
        const handle = parseJobHandle({ job_id: jobId, status });
        if (jobId.length > 0 && status.length > 0) {
          expect(handle).toEqual({ id: jobId, status });
        } else {
          expect(handle).toBeUndefined();
        }
      }),
    );
  });

  it("parses an equivalent JSON-string envelope", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (jobId, status) => {
        const output = JSON.stringify({ job_id: jobId, status });
        expect(parseJobHandle(output)).toEqual({ id: jobId, status });
      }),
    );
  });
});
