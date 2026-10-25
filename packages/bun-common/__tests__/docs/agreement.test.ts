/**
 * The §9.3 agreement tests: each vendor's converted JSON Schema must accept
 * and reject the same values the schema itself does. The converter's output
 * is compiled with ajv (`ajv/dist/2020` + `ajv-formats`, from the workspace
 * lock — not declared here, so the suite skips visibly where they are
 * absent, per §9.1's escape hatch) and a shared value table runs through
 * both the Standard Schema's own `validate` and the compiled document; the
 * two verdicts must agree. A known divergence is allow-listed inline, with
 * the measurement behind it — never silently.
 */
import { describe, expect, it } from "bun:test";
import { toJsonSchema as valibotToJsonSchema } from "@valibot/to-json-schema";
import { type } from "arktype";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import type { StandardSchemaV1 } from "../../lib/types/standardSchema";
import type { ConversionWarning } from "../../lib/docs/index";
import { toJsonSchema, valibotConverter } from "../../lib/docs/index";

const Ajv = (await import("ajv/dist/2020").catch(() => undefined))?.default;
const addFormats = (await import("ajv-formats").catch(() => undefined))
  ?.default;
const ajv =
  Ajv === undefined ? undefined : new Ajv({ strict: false, allErrors: true });
if (ajv !== undefined && addFormats !== undefined) addFormats(ajv);

/** One value in the shared table. */
interface Case {
  readonly label: string;
  readonly value: unknown;
  /** Vendor → why the JSON Schema verdict diverges from the schema's own, with the measurement. */
  readonly except?: Readonly<Record<string, string>>;
}

/** The shared table: one shape, four vendors. */
const CASES: readonly Case[] = [
  { label: "a minimal valid row", value: { name: "alice", role: "admin" } },
  {
    label: "a full valid row",
    value: {
      name: "alice",
      role: "user",
      age: 5,
      tags: ["a", "b"],
      email: "a@b.co",
    },
  },
  { label: "name too short", value: { name: "al", role: "admin" } },
  {
    label: "a role outside the enum",
    value: { name: "alice", role: "root" },
  },
  { label: "a negative age", value: { name: "alice", role: "user", age: -1 } },
  {
    label: "a fractional age",
    value: { name: "alice", role: "user", age: 1.5 },
  },
  {
    label: "too many tags",
    value: { name: "alice", role: "user", tags: ["a", "b", "c", "d"] },
  },
  {
    label: "name of the wrong type",
    value: { name: 42, role: "admin" },
  },
  { label: "not an object at all", value: "a string" },
  {
    label: "an undeclared extra key",
    value: { name: "alice", role: "admin", extra: true },
  },
  {
    label: "a bad email",
    value: { name: "alice", role: "admin", email: "not-an-email" },
  },
  {
    label: "an age as a string",
    value: { name: "alice", role: "user", age: "5" },
    except: {
      // Measured against yup 1.7.1: its validate casts before checking
      // ("5" → 5, which passes integer and min(0)); the JSON Schema sees the
      // value as sent. The wire side is what a document describes, so the
      // JSON Schema is right and yup's own leniency is the divergence. (The
      // reverse cast — a number where a string is declared — yup 1.7.1
      // refuses, so "name of the wrong type" needs no entry here.)
      yup: 'yup casts before checking ("5" → 5)',
    },
  },
];

/** Whether the schema itself accepts `value`. */
async function schemaAccepts(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<boolean> {
  const result = await schema["~standard"].validate(structuredClone(value));
  return result.issues === undefined;
}

const describeAjv = describe.skipIf(ajv === undefined);

describeAjv("converter agreement (§9.3)", () => {
  const shapes = {
    zod: () =>
      z.object({
        name: z.string().min(3),
        role: z.enum(["admin", "user"]),
        age: z.number().int().min(0).optional(),
        tags: z.array(z.string()).max(3).default([]),
        email: z.email().optional(),
      }),
    arktype: () =>
      type({
        name: "string >= 3",
        role: "'admin' | 'user'",
        "age?": "number.integer >= 0",
        "tags?": "string[] <= 3",
        "email?": "string.email",
      }),
    yup: () =>
      yup.object({
        name: yup.string().required().min(3),
        role: yup.string().required().oneOf(["admin", "user"]),
        age: yup.number().integer().min(0),
        tags: yup.array(yup.string()).max(3),
        email: yup.string().email(),
      }),
    valibot: () =>
      v.object({
        name: v.pipe(v.string(), v.minLength(3)),
        role: v.picklist(["admin", "user"]),
        age: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
        tags: v.optional(v.pipe(v.array(v.string()), v.maxLength(3)), []),
        email: v.optional(v.pipe(v.string(), v.email())),
      }),
  } satisfies Record<string, () => StandardSchemaV1>;

  for (const [vendor, make] of Object.entries(shapes)) {
    describe(vendor, () => {
      const schema = make();
      const warnings: ConversionWarning[] = [];
      const json = toJsonSchema(schema, {
        // valibot is per-call here so the process registry stays empty for
        // the resolution tests, whatever order the files run in.
        ...(vendor === "valibot"
          ? { converters: { valibot: valibotConverter(valibotToJsonSchema) } }
          : {}),
        onWarning: (warning) => warnings.push(warning),
      });
      const compiled = ajv!.compile(json);

      it("converts with no warning", () => {
        expect(warnings).toEqual([]);
      });

      for (const testCase of CASES) {
        it(`agrees on ${testCase.label}`, async () => {
          const own = await schemaAccepts(schema, testCase.value);
          const converted = compiled(structuredClone(testCase.value));
          const why = testCase.except?.[vendor];
          if (why !== undefined) {
            // Pinned both ways: the verdicts must differ, and the allow-list
            // comment says why — a vendor release closing the gap fails here
            // loudly rather than widening silently.
            expect(converted, `allow-listed divergence (${why})`).not.toBe(own);
          } else {
            expect(converted).toBe(own);
          }
        });
      }
    });
  }
});
