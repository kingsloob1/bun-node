/**
 * `toStandardSchema` (bun-common's `lib/BunValidate.ts`) takes an optional
 * JSON Schema. It stays here; `recordOf`'s JSON Schema tests live with the
 * core in `packages/bun-contract/__tests__/describe.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { toStandardSchema } from "../../lib/BunValidate";

describe("JSON Schema on toStandardSchema (m10)", () => {
  it("toStandardSchema takes an optional jsonSchema", () => {
    const Page = toStandardSchema<{ page: number }>(
      (input) => ({ value: input as { page: number } }),
      {
        jsonSchema: {
          type: "object",
          properties: { page: { type: "integer" } },
        },
      },
    );
    const converter = (
      Page["~standard"] as unknown as {
        jsonSchema: { input: (o: { target: string }) => unknown };
      }
    ).jsonSchema;
    expect(converter.input({ target: "draft-2020-12" })).toEqual({
      type: "object",
      properties: { page: { type: "integer" } },
    });
    expect(
      "jsonSchema" in toStandardSchema(() => ({ value: 1 }))["~standard"],
    ).toBe(false);
  });
});
