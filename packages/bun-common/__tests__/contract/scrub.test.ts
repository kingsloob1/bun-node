/**
 * Rule 1 of plan §4.1.6: an issue never carries the received value (C11,
 * C12). Every supported vendor is run on a value its own messages quote, and
 * the core's issues must not contain it; `messages: "generic"` and
 * `redactPaths` (Q-C2, Q-C3) are checked beside it.
 *
 * Each vendor case first asserts that the vendor's **raw** issue does quote
 * the value, so a case that stops proving anything (a vendor that no longer
 * quotes) fails rather than passing vacuously.
 */
import type { StandardSchemaV1 } from "../../lib/types/standardSchema";
import { type } from "arktype";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { toStandardSchema } from "../../lib/BunValidate";
import { createReceiver } from "../../lib/contract/guard";
import { validateStandard } from "../../lib/contract/issues";
import { createTestLogger } from "../../lib/logging";
import { broker } from "./fixtures";

const SECRET = "SECRET-7731";

/** A `toStandardSchema` check whose message quotes what it was given, as a careless one would. */
const quoting = toStandardSchema<{ n: number }>((input) => {
  const n = (input as { n?: unknown } | null)?.n;
  return typeof n === "number"
    ? { value: { n } }
    : {
        issues: [
          { message: `n must be a number, got ${String(n)}`, path: ["n"] },
        ],
      };
});

/** `[vendor, case, schema, received, the received token its message quotes]`. */
const CASES: [string, string, StandardSchemaV1, unknown, string][] = [
  [
    "zod 4",
    "unknown key",
    z.strictObject({ a: z.string() }),
    { a: "x", [SECRET]: 1 },
    SECRET,
  ],
  ["valibot 1", "type", v.object({ n: v.number() }), { n: SECRET }, SECRET],
  [
    "valibot 1",
    "email",
    v.object({ e: v.pipe(v.string(), v.email()) }),
    { e: SECRET },
    SECRET,
  ],
  [
    "valibot 1",
    "unknown key",
    v.strictObject({ a: v.string() }),
    { a: "x", [SECRET]: 1 },
    SECRET,
  ],
  [
    "valibot 1",
    "short string",
    v.object({ n: v.number() }),
    { n: "ab" },
    '"ab"',
  ],
  [
    "valibot 1",
    "one-digit number",
    v.object({ n: v.string() }),
    { n: 7 },
    "received 7",
  ],
  [
    "valibot 1",
    "boolean",
    v.object({ n: v.string() }),
    { n: true },
    "received true",
  ],
  [
    "valibot 1",
    "bigint",
    v.object({ n: v.string() }),
    { n: 12345678901234567890n },
    "12345678901234567890",
  ],
  ["arktype 2", "email", type({ e: "string.email" }), { e: SECRET }, SECRET],
  ["arktype 2", "enum", type({ k: "'a'|'b'" }), { k: SECRET }, SECRET],
  [
    "arktype 2",
    "unknown key",
    type({ "+": "reject", a: "string" }),
    { a: "x", [SECRET]: 1 },
    SECRET,
  ],
  ["arktype 2", "range", type({ k: "number < 5" }), { k: 98765 }, "98765"],
  [
    "yup 1.7",
    "number",
    yup.object({ n: yup.number().required() }),
    { n: SECRET },
    SECRET,
  ],
  [
    "yup 1.7",
    "short string",
    yup.object({ n: yup.number().required() }),
    { n: "ab" },
    '"ab"',
  ],
  [
    "yup 1.7",
    "boolean",
    yup.object({ n: yup.string().strict().required() }),
    { n: true },
    "`true`",
  ],
  ["toStandardSchema", "careless message", quoting, { n: SECRET }, SECRET],
  ["toStandardSchema", "short value", quoting, { n: "ab" }, "got ab"],
];

/** The raw vendor issues, as JSON. */
async function rawIssues(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<string> {
  const result = await schema["~standard"].validate(value);
  return (result.issues ?? []).map((i) => i.message).join(" | ");
}

describe("the value scrub, per supported vendor (C11)", () => {
  for (const [vendor, name, schema, value, token] of CASES) {
    it(`${vendor}, ${name}: the vendor quotes it, the core does not`, async () => {
      // The control: the vendor's own message carries the value.
      expect(await rawIssues(schema, value)).toContain(token);
      const outcome = await validateStandard(schema, value, "payload");
      expect(outcome.ok).toBe(false);
      const issues = outcome.ok ? [] : outcome.issues;
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue.message).not.toContain(token);
        expect(issue.message).toMatch(/^Invalid value( \([\w.:-]+\))?$/);
        expect(Object.keys(issue).sort()).toEqual([
          "message",
          "path",
          "target",
        ]);
      }
    });
  }

  it("keeps a message that quotes nothing received", async () => {
    const outcome = await validateStandard(
      z.object({ n: z.number() }),
      { n: SECRET },
      "payload",
    );
    expect(outcome).toEqual({
      ok: false,
      issues: [
        {
          target: "payload",
          path: "n",
          message: "Invalid input: expected number, received string",
        },
      ],
    });
  });

  it("names the vendor's code in the generic message when it has a safe one", async () => {
    const outcome = await validateStandard(
      type({ e: "string.email" }),
      { e: SECRET },
      "payload",
    );
    expect(outcome.ok ? [] : outcome.issues.map((i) => i.message)).toEqual([
      "Invalid value (pattern)",
    ]);
  });

  it("keeps the path (Q-C2): an unknown key's name is still there, which redactPaths removes", async () => {
    const schema = v.strictObject({ a: v.string() });
    const kept = await validateStandard(
      schema,
      { a: "x", [SECRET]: 1 },
      "payload",
    );
    expect(kept.ok ? [] : kept.issues.map((i) => i.path)).toEqual([SECRET]);
    const redacted = await validateStandard(
      schema,
      { a: "x", [SECRET]: 1 },
      "payload",
      undefined,
      undefined,
      {
        redactPaths: true,
      },
    );
    expect(redacted.ok ? [] : redacted.issues.map((i) => i.path)).toEqual([""]);
  });
});

describe('messages: "generic" (Q-C3)', () => {
  it("replaces every message, even one that quotes nothing", async () => {
    const outcome = await validateStandard(
      z.object({ n: z.number() }),
      { n: "x" },
      "payload",
      undefined,
      undefined,
      {
        messages: "generic",
      },
    );
    expect(outcome).toEqual({
      ok: false,
      issues: [
        {
          target: "payload",
          path: "n",
          message: "Invalid value (invalid_type)",
        },
      ],
    });
  });

  it("applies through a guard, with redactPaths", () => {
    const c = broker.contract({
      inbound: { t: { payload: z.object({ n: z.number(), m: z.string() }) } },
    });
    const guard = createReceiver(c, "inbound", {
      messages: "generic",
      redactPaths: true,
    });
    const out = guard({ topic: "t", payload: { n: "x", m: 1 } });
    expect((out as { issues: unknown }).issues).toEqual([
      {
        target: "payload",
        path: "",
        key: "t",
        message: "Invalid value (invalid_type)",
      },
      {
        target: "payload",
        path: "",
        key: "t",
        message: "Invalid value (invalid_type)",
      },
    ]);
  });

  it("is plain `Invalid value` when the vendor has no code (yup)", async () => {
    const outcome = await validateStandard(
      yup.object({ n: yup.string().email().required() }),
      { n: "no" },
      "payload",
      undefined,
      undefined,
      {
        messages: "generic",
      },
    );
    expect(outcome.ok ? [] : outcome.issues.map((i) => i.message)).toEqual([
      "Invalid value",
    ]);
  });
});

describe("what a warn log holds (C12)", () => {
  it("holds transport, side, key and each issue's target, path, message and key: no value", () => {
    const { logger, events } = createTestLogger();
    const c = broker.contract({
      inbound: {
        t: { payload: v.object({ card: v.pipe(v.string(), v.length(16)) }) },
      },
    });
    createReceiver(c, "inbound", { policy: "warn", logger })({
      topic: "t",
      payload: { card: "4111-1111-1111" },
    });
    expect(events).toHaveLength(1);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("4111");
    const fields = events[0].fields as { issues: Record<string, unknown>[] };
    expect(Object.keys(fields).sort()).toEqual([
      "issues",
      "key",
      "side",
      "transport",
    ]);
    expect(Object.keys(fields.issues[0]).sort()).toEqual([
      "key",
      "message",
      "path",
      "target",
    ]);
  });
});
