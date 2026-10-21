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

/** The schema of the narrowed-scope repro: refuses `state` unless it is one of {@link STATES}. */
const STATES = ["waiting", "active"];
/** Its message, which quotes the schema's own values and nothing received. */
const ONE_OF = `Expected one of ${STATES.map((s) => JSON.stringify(s)).join(", ")}`;
/** A `toStandardSchema` check that says {@link ONE_OF}, or echoes the value with `echo`. */
const oneOf = (echo: boolean) =>
  toStandardSchema((input: unknown) => {
    const state = (input as { state?: unknown }).state;
    return STATES.includes(state as string)
      ? { value: input }
      : {
          issues: [
            {
              message: echo ? `${JSON.stringify(state)}: ${ONE_OF}` : ONE_OF,
              path: ["state"],
            },
          ],
        };
  });

/** A `toStandardSchema` check reporting one issue, `message` at `path`, whatever it receives. */
const reporting = (
  message: string,
  path?: (PropertyKey | { key: PropertyKey })[],
) =>
  toStandardSchema(() => ({
    issues: [path === undefined ? { message } : { message, path }],
  }));

/** The messages the core reports for `value`. */
async function messagesOf(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<string[]> {
  const outcome = await validateStandard(schema, value, "payload");
  expect(outcome.ok).toBe(false);
  return outcome.ok ? [] : outcome.issues.map((i) => i.message);
}

describe("the scrub compares a message with what its issue is about", () => {
  it("the repro's control: nothing else holds a schema word, the message survives", async () => {
    expect(
      await messagesOf(oneOf(false), { state: "bogus", note: "hello" }),
    ).toEqual([ONE_OF]);
  });

  // The negative control: on develop's issues.ts (a scrub over the whole
  // value) this test fails, with "Invalid value".
  it('the repro: another field holding "waiting" no longer withholds the schema\'s own words', async () => {
    expect(
      await messagesOf(oneOf(false), { state: "bogus", note: "waiting" }),
    ).toEqual([ONE_OF]);
  });

  it("the repro: a message echoing the value at the path is still withheld", async () => {
    expect(
      await messagesOf(oneOf(true), { state: "waiting!", note: "waiting" }),
    ).toEqual(["Invalid value"]);
    expect(await messagesOf(oneOf(true), { state: "waiting!" })).toEqual([
      "Invalid value",
    ]);
  });

  /** `[vendor, schema, received, the raw message]`: a message about `k` that quotes a sibling's value only. */
  const SIBLINGS: [string, StandardSchemaV1, unknown, string][] = [
    [
      "zod 4",
      z.object({ k: z.enum(["waiting", "active"]) }),
      { k: "bogus", note: "waiting" },
      'Invalid option: expected one of "waiting"|"active"',
    ],
    [
      "valibot 1",
      v.object({ k: v.number() }),
      { k: {}, note: "number" },
      "Invalid type: Expected number but received Object",
    ],
    [
      "arktype 2",
      type({ k: "number" }),
      { k: "x", note: "number" },
      "k must be a number (was a string)",
    ],
    [
      "yup 1.7",
      yup.object({ k: yup.string().oneOf(["waiting", "active"]) }),
      { k: "bogus", note: "waiting" },
      "k must be one of the following values: waiting, active",
    ],
    [
      "toStandardSchema",
      oneOf(false),
      { state: "bogus", note: "waiting" },
      ONE_OF,
    ],
  ];
  for (const [vendor, schema, value, raw] of SIBLINGS) {
    it(`${vendor}: a word another field holds does not withhold the message`, async () => {
      expect(await rawIssues(schema, value)).toBe(raw);
      expect(await messagesOf(schema, value)).toEqual([raw]);
    });
  }

  /** `[vendor, schema, received, the token at the issue's path its message quotes]`, each beside an unrelated field. */
  const AT_PATH: [string, StandardSchemaV1, unknown, string][] = [
    [
      "zod 4",
      z.object({
        k: z.string().refine(() => false, {
          error: (issue) => `bad value ${String(issue.input)}`,
        }),
      }),
      { k: SECRET, other: "unrelated" },
      SECRET,
    ],
    [
      "valibot 1",
      v.object({ k: v.pipe(v.string(), v.email()) }),
      { k: SECRET, other: "unrelated" },
      SECRET,
    ],
    [
      "arktype 2",
      type({ k: "'a'|'b'" }),
      { k: SECRET, other: "unrelated" },
      SECRET,
    ],
    [
      "yup 1.7",
      yup.object({ k: yup.number().required() }),
      { k: SECRET, other: "unrelated" },
      SECRET,
    ],
    ["toStandardSchema", quoting, { n: SECRET, other: "unrelated" }, SECRET],
  ];
  for (const [vendor, schema, value, token] of AT_PATH) {
    it(`${vendor}: a message quoting the value at the issue's path is still withheld`, async () => {
      expect(await rawIssues(schema, value)).toContain(token);
      for (const message of await messagesOf(schema, value)) {
        expect(message).not.toContain(token);
        expect(message).toMatch(/^Invalid value( \([\w.:-]+\))?$/);
      }
    });
  }

  it("zod 4: an unrecognized key, quoted, is still withheld (at the root, and inside an object)", async () => {
    const root = z.strictObject({ a: z.string() });
    const atRoot = { a: "x", [SECRET]: 1 };
    expect(await rawIssues(root, atRoot)).toBe(`Unrecognized key: "${SECRET}"`);
    expect(await messagesOf(root, atRoot)).toEqual([
      "Invalid value (unrecognized_keys)",
    ]);
    // Zod reports it at the object's path (`o`): the keys at the path are compared.
    const nested = z.object({
      o: z.strictObject({ a: z.string() }),
      other: z.string(),
    });
    const inside = { o: { a: "x", [SECRET]: 1 }, other: "unrelated" };
    expect(await rawIssues(nested, inside)).toBe(
      `Unrecognized key: "${SECRET}"`,
    );
    expect(await messagesOf(nested, inside)).toEqual([
      "Invalid value (unrecognized_keys)",
    ]);
  });

  it("an unknown key reported at its own path is withheld through the path's keys (valibot, arktype)", async () => {
    const value = { o: { a: "x", [SECRET]: 1 }, other: "unrelated" };
    const valibot = v.object({ o: v.strictObject({ a: v.string() }) });
    expect(await rawIssues(valibot, value)).toBe(
      `Invalid key: Expected never but received "${SECRET}"`,
    );
    expect(await messagesOf(valibot, value)).toEqual([
      "Invalid value (strict_object)",
    ]);
    const arktype = type({ o: { "+": "reject", a: "string" } });
    expect(await rawIssues(arktype, value)).toBe(
      `o["${SECRET}"] must be removed`,
    );
    expect(await messagesOf(arktype, value)).toEqual([
      "Invalid value (predicate)",
    ]);
    // The key is the path's last segment, which is compared quoted.
    expect(
      await messagesOf(
        reporting(`"holder-key" is not allowed`, ["o", "holder-key"]),
        { o: { "holder-key": 1, x: 2 } },
      ),
    ).toEqual(["Invalid value"]);
  });

  // The negative control: on develop's issues.ts (#505, which compared the
  // keys of the object holding the value too) this test fails, with
  // "Invalid value" for the second input.
  it('the keys beside the path are not compared: a schema\'s `Expected "job"` survives a sibling named job', async () => {
    const kind = toStandardSchema((input: unknown) => {
      const k = (input as { kind?: unknown }).kind;
      return k === "job"
        ? { value: input }
        : { issues: [{ message: 'Expected "job"', path: ["kind"] }] };
    });
    expect(await messagesOf(kind, { kind: "run" })).toEqual(['Expected "job"']);
    expect(await messagesOf(kind, { kind: "run", job: {} })).toEqual([
      'Expected "job"',
    ]);
    // Nor at a nested path: `o.x`'s message naming `o`'s other key is kept,
    // as no vendor reports an unknown key at a sibling's path.
    expect(
      await messagesOf(reporting(`"holder-key" is not allowed`, ["o", "x"]), {
        o: { "holder-key": 1, x: 2 },
      }),
    ).toEqual(['"holder-key" is not allowed']);
    // The value at the path is still compared, sibling or not.
    const quotingKind = toStandardSchema((input: unknown) => ({
      issues: [
        {
          message: `Expected "job", got ${JSON.stringify((input as { kind?: unknown }).kind)}`,
          path: ["kind"],
        },
      ],
    }));
    expect(
      await messagesOf(quotingKind, { kind: "run-away", job: {} }),
    ).toEqual(["Invalid value"]);
  });

  it("a nested path (a.b[2].c) compares that leaf's value, not its siblings'", async () => {
    const value = {
      a: { b: [{ c: "first-leaf" }, { c: "second-leaf" }, { c: SECRET }] },
      top: "top-level",
    };
    const path = ["a", "b", 2, "c"];
    expect(await messagesOf(reporting(`c is ${SECRET}`, path), value)).toEqual([
      "Invalid value",
    ]);
    // Vendors spell segments differently: `{ key }` (valibot) and a string index (yup).
    expect(
      await messagesOf(
        reporting(`c is ${SECRET}`, [
          { key: "a" },
          { key: "b" },
          { key: "2" },
          { key: "c" },
        ]),
        value,
      ),
    ).toEqual(["Invalid value"]);
    for (const elsewhere of ["second-leaf", "first-leaf", "top-level"]) {
      expect(
        await messagesOf(reporting(`c is not ${elsewhere}`, path), value),
      ).toEqual([`c is not ${elsewhere}`]);
    }
    // The real vendors, at that path.
    const nested = {
      a: { b: [{ c: 1 }, { c: 2 }, { c: SECRET }] },
      note: "number",
    };
    const valibot = v.object({
      a: v.object({ b: v.array(v.object({ c: v.number() })) }),
    });
    expect(await rawIssues(valibot, nested)).toContain(SECRET);
    expect(await messagesOf(valibot, nested)).toEqual([
      "Invalid value (number)",
    ]);
    const yupNested = yup.object({
      a: yup.object({
        b: yup.array(yup.object({ c: yup.number().required() })),
      }),
    });
    expect(await rawIssues(yupNested, nested)).toContain(SECRET);
    expect(await messagesOf(yupNested, nested)).toEqual(["Invalid value"]);
    const zodNested = z.object({
      a: z.object({ b: z.array(z.object({ c: z.number() })) }),
    });
    // zod's own message names a type, and the decoy elsewhere holds that word.
    expect(await messagesOf(zodNested, { ...nested, note: "string" })).toEqual([
      "Invalid input: expected number, received string",
    ]);
  });

  it("a root issue, or one with an empty path, compares the whole value", async () => {
    const value = { deep: { inside: [SECRET] } };
    expect(await messagesOf(reporting(`refused ${SECRET}`), value)).toEqual([
      "Invalid value",
    ]);
    expect(await messagesOf(reporting(`refused ${SECRET}`, []), value)).toEqual(
      ["Invalid value"],
    );
    expect(await messagesOf(reporting("refused nothing"), value)).toEqual([
      "refused nothing",
    ]);
  });

  it("a path the value does not lead along compares the whole value", async () => {
    // `a` is a string, so `a.b` leads nowhere: the path cannot say what the issue is about.
    expect(
      await messagesOf(reporting(`refused ${SECRET}`, ["a", "b"]), {
        a: "a-string",
        other: SECRET,
      }),
    ).toEqual(["Invalid value"]);
  });

  it("keeps the short-token rule at the path", async () => {
    expect(await messagesOf(reporting("got u9", ["k"]), { k: "u9" })).toEqual([
      "Invalid value",
    ]);
    expect(
      await messagesOf(reporting("u9 is wrong", ["k"]), { k: "u9" }),
    ).toEqual(["u9 is wrong"]);
    // A short token elsewhere is not compared.
    expect(
      await messagesOf(reporting("got u9", ["k"]), { k: "x", other: "u9" }),
    ).toEqual(["got u9"]);
  });

  it("stays bounded at the path (MAX_LEAVES)", async () => {
    const big = Array.from(
      { length: 300 },
      (_, i) => `leaf-${String(i).padStart(3, "0")}`,
    );
    expect(
      await messagesOf(reporting("refused leaf-010", ["k"]), { k: big }),
    ).toEqual(["Invalid value"]);
    expect(
      await messagesOf(reporting("refused leaf-299", ["k"]), { k: big }),
    ).toEqual(["refused leaf-299"]);
  });
});

describe("a whole-value comparison, and the value at an issue's path, also name the keys, unquoted", () => {
  // The negative control: on the path-scoped issues.ts before this rule
  // (keys compared only quoted), this test fails with yup's raw message.
  it("yup 1.7, noUnknown: an unknown key named unquoted is withheld", async () => {
    const schema = yup.object({ a: yup.string() }).noUnknown().strict();
    const value = { a: "x", [SECRET]: 1 };
    expect(await rawIssues(schema, value)).toBe(
      `this field has unspecified keys: ${SECRET}`,
    );
    expect(await messagesOf(schema, value)).toEqual(["Invalid value"]);
  });

  it("the trade-off: a root message whose own word is also a key of 3+ characters is withheld", async () => {
    expect(
      await messagesOf(reporting("total must equal the item count"), {
        total: 3,
        items: [],
      }),
    ).toEqual(["Invalid value"]);
    // A nested key counts too, at any depth `collect` walks.
    expect(
      await messagesOf(reporting("the cart is empty"), { order: { cart: [] } }),
    ).toEqual(["Invalid value"]);
  });

  it("matches a key only as a whole word", async () => {
    expect(
      await messagesOf(reporting("a statement is required"), { state: 1 }),
    ).toEqual(["a statement is required"]);
  });

  it("never withholds a root message for a key of 1 or 2 characters", async () => {
    expect(
      await messagesOf(reporting("id and a must agree"), {
        id: 5000,
        a: "zzz",
      }),
    ).toEqual(["id and a must agree"]);
  });

  it("applies to a path the value does not lead along (the whole-value fallback)", async () => {
    expect(
      await messagesOf(reporting("unspecified keys: extra-key", ["a", "b"]), {
        a: "a-string",
        "extra-key": 1,
      }),
    ).toEqual(["Invalid value"]);
  });

  // The negative control: with the value at the path collected without its
  // bare keys (develop before this rule), this test fails with yup's raw
  // message.
  it("yup 1.7, nested noUnknown: an unknown key named unquoted at the object's path is withheld", async () => {
    const schema = yup.object({
      o: yup.object({ a: yup.string() }).noUnknown().strict(),
      other: yup.string(),
    });
    const value = { o: { a: "x", [SECRET]: 1 }, other: "unrelated" };
    expect(await rawIssues(schema, value)).toBe(
      `o field has unspecified keys: ${SECRET}`,
    );
    expect(await messagesOf(schema, value)).toEqual(["Invalid value"]);
  });

  it("the trade-off at a path: a refine on an object naming one of its keys is withheld, unless it reports at that key's path", async () => {
    const Range = z.object({ start: z.number(), end: z.number() });
    const value = { o: { start: 5, end: 1 } };
    const atObject = z.object({
      o: Range.refine((r) => r.start < r.end, {
        message: "start must be before end",
      }),
    });
    expect(await rawIssues(atObject, value)).toBe("start must be before end");
    expect(await messagesOf(atObject, value)).toEqual([
      "Invalid value (custom)",
    ]);
    const atKey = z.object({
      o: Range.refine((r) => r.start < r.end, {
        message: "start must be before end",
        path: ["start"],
      }),
    });
    expect(await messagesOf(atKey, value)).toEqual([
      "start must be before end",
    ]);
  });

  it("keeps the bound with the keys at the path: they never crowd out a leaf", async () => {
    const wide = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => {
        const n = String(i).padStart(3, "0");
        return [`key-${n}`, `leaf-${n}`];
      }),
    );
    // Each entry adds its quoted key and its leaf to the leaf bound
    // (MAX_LEAVES); its bare key is counted apart, so the same leaves are
    // compared as before the bare keys, and the walk stops where it did.
    for (const message of ["refused leaf-100", "unknown key-100"]) {
      expect(await messagesOf(reporting(message, ["o"]), { o: wide })).toEqual([
        "Invalid value",
      ]);
    }
    expect(
      await messagesOf(reporting("refused leaf-200", ["o"]), { o: wide }),
    ).toEqual(["refused leaf-200"]);
  });

  it("never withholds a path-scoped message for a key of 1 or 2 characters at the path", async () => {
    expect(
      await messagesOf(reporting("id and a must agree", ["o"]), {
        o: { id: 5000, a: "zzz" },
      }),
    ).toEqual(["id and a must agree"]);
  });

  it("gives a path-scoped issue nothing new: a sibling key named unquoted is kept", async () => {
    expect(
      await messagesOf(reporting("items must not exceed total", ["items"]), {
        items: 3,
        total: 4,
      }),
    ).toEqual(["items must not exceed total"]);
  });
});
