import { describe, it, expect } from "vitest";
import { ExitCode } from "./exit-codes.js";

describe("exit codes", () => {
  it("stay stable (callers branch on these)", () => {
    expect(ExitCode).toEqual({
      Ok: 0,
      Runtime: 1,
      Usage: 2,
      Config: 3,
      ApprovalDenied: 4,
    });
  });
});
