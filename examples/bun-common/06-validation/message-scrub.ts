/**
 * Issues never carry the received value: a library message that quotes what
 * was sent becomes `Invalid value (<code>)`, and `messages: "generic"` and
 * `redactPaths` go further — each asserted, per library.
 *
 * ```bash
 * bun 06-validation/message-scrub.ts
 * ```
 *
 * Validation libraries quote the input in some of their messages: yup's
 * "but the final value was …", valibot's `Received "…"`, arktype's
 * `(was "…")`, zod's `Unrecognized key: "…"`. Sent back in a 400 or written
 * to a log, that echoes whatever a client sent, a password or a token
 * included. So bun-common checks each failing message against the value it
 * was given, and replaces one that quotes it with `Invalid value`, plus the
 * library's issue code when it has one (yup's issues have none). A message
 * that quotes nothing is kept as the library wrote it.
 *
 * Every case first shows that the library's own message does quote the value,
 * so a case cannot pass because a library stopped quoting.
 *
 * The scrub is a heuristic. Where a guarantee is needed,
 * `messages: "generic"` replaces every message, and `redactPaths: true`
 * empties paths (a path can name a key the sender chose). `validate()`, the
 * guards and `validateStandard` all take both; this file shows them on
 * `validateStandard` and a guard, and `message-options.ts` on `validate()`:
 * its 400, `formatError`, and its response checks.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import {
  BunRouter,
  ContractError,
  createReceiver,
  defineTransport,
  validate,
  validateStandard,
} from "@kingsleyweb/bun-common";
import { type } from "arktype";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

/** A token each bad value carries, so a leak is easy to spot. */
const SECRET = "SECRET-7731";

/** The 400 body `onFailure: "respond"` answers with. */
interface FailureBody {
  /** Always `"Validation failed"`. */
  error: string;
  /** Every issue found. */
  issues: {
    /** The part of the request that failed. */
    target: string;
    /** The message, scrubbed. */
    message: string;
    /** Dotted path within the part. */
    path: string;
  }[];
}

/** One library's case: a body schema, a body it rejects, and the message expected back. */
interface ScrubCase {
  /** The library, for the output. */
  library: string;
  /** The body schema. */
  schema: StandardSchemaV1;
  /** A body that fails it, carrying {@link SECRET}. */
  body: Record<string, unknown>;
  /** The scrubbed message expected in the 400. */
  expected: string;
}

/** The messages a schema writes itself for `value`. */
async function libraryMessages(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<string[]> {
  const result = await schema["~standard"].validate(value);
  return (result.issues ?? []).map((issue) => issue.message);
}

title("The message scrub");

/* ------------------------------------------------------------------ */
step("validate(): a quoted value never reaches the 400");

const CASES: ScrubCase[] = [
  {
    library: "yup 1.7",
    schema: yup.object({ age: yup.number().required() }),
    body: { age: SECRET },
    expected: "Invalid value",
  },
  {
    library: "valibot 1",
    schema: v.object({ email: v.pipe(v.string(), v.email()) }),
    body: { email: SECRET },
    expected: "Invalid value (email)",
  },
  {
    library: "arktype 2",
    schema: type({ email: "string.email" }),
    body: { email: SECRET },
    expected: "Invalid value (pattern)",
  },
  {
    library: "zod 4",
    schema: z.strictObject({ title: z.string() }),
    body: { title: "Hello", [SECRET]: true },
    expected: "Invalid value (unrecognized_keys)",
  },
];

const router = new BunRouter();
for (const [index, { schema }] of CASES.entries()) {
  router.post(
    `/case/${index}`,
    validate({ body: schema }, { onFailure: "respond" }),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
}

/** POSTs `body` as JSON to `path`. */
const post = (path: string, body: unknown) =>
  router.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

for (const [index, { library, schema, body, expected }] of CASES.entries()) {
  const own = await libraryMessages(schema, body);
  const response = await post(`/case/${index}`, body);
  const text = await response.text();
  const answer = JSON.parse(text) as FailureBody;
  show(`${library} writes`, own[0]);
  show(
    `${library} answers`,
    answer.issues.map((i) => i.message),
  );
  check(
    `${library}: its own message quotes the value (the control)`,
    own.some((m) => m.includes(SECRET)),
    own,
  );
  checkEqual(
    `${library}: the 400 says "${expected}"`,
    [response.status, answer.issues.map((i) => i.message)],
    [400, [expected]],
  );
  check(
    `${library}: and nothing in the response carries the value`,
    !text.includes(SECRET),
    text,
  );
}

const kept = validate(
  { body: yup.object({ age: yup.number().min(18) }) },
  { onFailure: "respond" },
);
router.post("/kept", kept, (_req, res) => {
  res.json({ ok: true });
});
const keptAnswer = (await (
  await post("/kept", { age: 12 })
).json()) as FailureBody;
checkEqual(
  "a message that quotes nothing received is kept as the library wrote it",
  keptAnswer.issues.map((i) => i.message),
  ["age must be greater than or equal to 18"],
);

/* ------------------------------------------------------------------ */
step('messages: "generic": every message replaced, quoting or not');

const Adult = z.object({ age: z.number().min(18) });
const plain = await validateStandard(Adult, { age: 12 }, "body");
const generic = await validateStandard(
  Adult,
  { age: 12 },
  "body",
  undefined,
  undefined,
  { messages: "generic" },
);
show("default", plain);
show("generic", generic);
checkEqual(
  "by default zod's message, which quotes nothing, is kept",
  plain.ok ? [] : plain.issues.map((i) => i.message),
  ["Too small: expected number to be >=18"],
);
checkEqual(
  'with messages: "generic" it is replaced by the code alone',
  generic.ok ? [] : generic.issues.map((i) => [i.message, i.path]),
  [["Invalid value (too_small)", "age"]],
);

const yupGeneric = await validateStandard(
  yup.object({ age: yup.number().min(18) }),
  { age: 12 },
  "body",
  undefined,
  undefined,
  {
    messages: "generic",
  },
);
checkEqual(
  'a yup issue has no code, so it reads just "Invalid value"',
  yupGeneric.ok ? [] : yupGeneric.issues.map((i) => i.message),
  ["Invalid value"],
);

const signup = defineTransport({
  name: "signup",
  inbound: { parts: ["form"] },
}).contract({
  inbound: { form: z.object({ age: z.number().min(18) }) },
});
const strictGuard = createReceiver(signup, "inbound", { messages: "generic" });
const refused = await strictGuard({ form: { age: 12 } });
const strictRouter = new BunRouter();
strictRouter.post(
  "/generic",
  validate({ body: Adult }, { onFailure: "respond", messages: "generic" }),
  (_req, res) => {
    res.json({ ok: true });
  },
);
const strictAnswer = (await (
  await strictRouter.fetch("/generic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ age: 12 }),
  })
).json()) as FailureBody;
checkEqual(
  "validate() takes the same option (more in message-options.ts)",
  strictAnswer.issues.map((i) => i.message),
  ["Invalid value (too_small)"],
);

checkEqual(
  "a guard takes the same option",
  refused instanceof ContractError ? refused.issues.map((i) => i.message) : [],
  ["Invalid value (too_small)"],
);

/* ------------------------------------------------------------------ */
step("redactPaths: a path can name a key the sender chose");

const Strict = v.strictObject({ name: v.string() });
const withKey = { name: "Ada", [SECRET]: 1 };
const pathKept = await validateStandard(Strict, withKey, "body");
const pathRedacted = await validateStandard(
  Strict,
  withKey,
  "body",
  undefined,
  undefined,
  { redactPaths: true },
);
checkEqual(
  "by default valibot's unknown key stays in the path, though not in the message",
  pathKept.ok ? [] : pathKept.issues.map((i) => [i.path, i.message]),
  [[SECRET, "Invalid value (strict_object)"]],
);
checkEqual(
  "with redactPaths: true the path is empty",
  pathRedacted.ok ? [] : pathRedacted.issues.map((i) => i.path),
  [""],
);

const quoting = createReceiver(signup, "inbound");
const leaked = await quoting({ form: { age: SECRET } });
check(
  "a ContractError's own message carries no value either",
  leaked instanceof ContractError && !leaked.message.includes(SECRET),
  leaked,
);

summary();
