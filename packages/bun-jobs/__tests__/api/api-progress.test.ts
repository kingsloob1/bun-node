import { describe, expect, it } from "bun:test";
import { JobSchema } from "../../lib/api/schemas/jobs";
import { toProgress } from "../../lib/api/serialize";

/**
 * A job's `progress` on the wire is a `RunProgress` or `null` — what
 * `updateProgress()` accepts — rather than `unknown`, in the serializer, the
 * JSON Schema and (see `api-contract.type-test.ts`) the contract types.
 */

describe("a job's progress on the wire", () => {
  it("passes a number or a record through, and reports anything else as null", () => {
    expect(toProgress(42)).toBe(42);
    expect(toProgress({ step: 2, of: 5 })).toEqual({ step: 2, of: 5 });
    expect(toProgress(null)).toBeNull();
    expect(toProgress(undefined)).toBeNull();
    expect(toProgress("half")).toBeNull();
    expect(toProgress([1, 2])).toBeNull();
  });

  it("is described as a number, a record or null in the job schema", () => {
    const json = JSON.stringify(
      (JobSchema.json as { properties: Record<string, unknown> }).properties
        .progress,
    );
    expect(json).toContain('"number"');
    expect(json).toContain('"object"');
    expect(json).toContain('"null"');
  });
});
