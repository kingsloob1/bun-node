/**
 * `withJsonSchema`'s stamp is the Standard JSON Schema shape on `~standard`,
 * so the core's existing `jsonSchemaOf` readers see the attachment without
 * knowing the converter exists: `mergeContracts`' documented-vs-validator
 * comparison (M3/Q-C12) and `bodyPlacement`'s requiredness probe (V12, m6).
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { toStandardSchema } from "../../lib/BunValidate";
import { mergeContracts } from "../../lib/contract/describe";
import { documented, jsonSchemaOf, recordOf } from "../../lib/contract/schemas";
import { createTestLogger } from "../../lib/logging";
import { bodyPlacement } from "../../lib/routeModel";
import type { ContractEntry } from "../../lib/contract/describe";
import { toJsonSchema, withJsonSchema } from "../../lib/docs/index";
import { http } from "../contract/fixtures";

/** A body row over `schema`, for bodyPlacement. */
function bodyRow(schema: ContractEntry["schema"]): ContractEntry {
  return {
    side: "inbound",
    part: "body",
    kind: "value",
    encoding: "body",
    schema,
  };
}

describe("withJsonSchema: the core's jsonSchemaOf readers see the stamp", () => {
  it("jsonSchemaOf returns the attached converter, non-enumerably", () => {
    const schema = withJsonSchema(
      toStandardSchema((value: unknown) => ({ value })),
      { type: "integer" },
    );
    const converter = jsonSchemaOf(schema);
    expect(converter).toBeDefined();
    expect(converter!.input({ target: "draft-2020-12" })).toEqual({
      type: "integer",
    });
    expect(Object.keys(schema["~standard"])).not.toContain("jsonSchema");
  });

  it("mergeContracts compares the stamp: agreement stays quiet", () => {
    const checking = withJsonSchema(
      toStandardSchema((value: unknown) => ({ value })),
      { type: "object", properties: { id: { type: "string" } } },
    );
    const docs = documented({
      type: "object",
      properties: { id: { type: "string" } },
    });
    const { logger, events } = createTestLogger();
    mergeContracts(
      [
        {
          contract: http.contract({ inbound: { body: docs } }),
          origin: "docs",
        },
        {
          contract: http.contract({ inbound: { body: checking } }),
          origin: "validator",
        },
      ],
      { logger },
    );
    expect(events).toEqual([]);
  });

  it("mergeContracts compares the stamp: a disagreement warns", () => {
    const checking = withJsonSchema(
      toStandardSchema((value: unknown) => ({ value })),
      { type: "object", properties: { id: { type: "string" } } },
    );
    const docs = documented({
      type: "object",
      properties: { id: { type: "number" } },
    });
    const { logger, events } = createTestLogger();
    mergeContracts(
      [
        {
          contract: http.contract({ inbound: { body: docs } }),
          origin: "docs",
        },
        {
          contract: http.contract({ inbound: { body: checking } }),
          origin: "validator",
        },
      ],
      { logger },
    );
    expect(events.map((event) => event.message)).toEqual([
      "documented schema disagrees with the validator, which wins",
    ]);
  });

  it("bodyPlacement reads the stamp: an unconstrained document means not required", () => {
    // The stamp's `{}` is the only affirmative "accepts undefined" JSON
    // Schema can give (bodyPlacement's rule 2) — without it the schema would
    // be asked to validate `undefined`, and this one would refuse.
    const stamped = withJsonSchema(
      toStandardSchema((value: unknown) =>
        value === undefined ? { issues: [{ message: "required" }] } : { value },
      ),
      {},
    );
    expect(bodyPlacement(bodyRow(stamped))).toEqual({
      mediaType: "application/json",
      required: false,
    });
    // Control: the same schema without the stamp is asked, and refuses.
    const bare = toStandardSchema((value: unknown) =>
      value === undefined ? { issues: [{ message: "required" }] } : { value },
    );
    expect(bodyPlacement(bodyRow(bare))).toEqual({
      mediaType: "application/json",
      required: true,
    });
  });

  it("recordOf composes the stamp into its own jsonSchema", () => {
    const stamped = withJsonSchema(
      toStandardSchema((value: unknown) => ({ value })),
      { type: "integer" },
    );
    const record = recordOf({ n: stamped });
    const json = jsonSchemaOf(record)?.input({ target: "draft-2020-12" });
    expect(json).toEqual({
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    });
  });

  it("the schema still validates as itself, and converts as the attachment", () => {
    const base = z.object({ id: z.string() });
    const stamped = withJsonSchema(base, {
      type: "object",
      properties: { id: { type: "string", minLength: 2 } },
      required: ["id"],
    });
    expect(stamped["~standard"].validate({ id: "x" })).toEqual({
      value: { id: "x" },
    });
    expect(toJsonSchema(stamped)).toEqual({
      type: "object",
      properties: { id: { type: "string", minLength: 2 } },
      required: ["id"],
    });
  });
});
