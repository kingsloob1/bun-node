/**
 * One schema, five libraries — zod, yup, valibot and arktype passed straight
 * in, and superstruct wrapped with `toStandardSchema`.
 *
 * ```bash
 * bun 06-validation/schema-libraries.ts
 * ```
 *
 * `validate()` depends on no validation library. It speaks
 * [Standard Schema](https://standardschema.dev): a schema that exposes a
 * `~standard` property can be passed as it is. zod 4, yup 1.7, valibot 1 and
 * arktype 2 all do. A library that does not — superstruct, joi, a hand-written
 * check — needs one call to `toStandardSchema(validateFn, { vendor })`.
 *
 * Each library below gets the same two routes: `GET /<lib>/posts?page=…`
 * (page must be a whole number ≥ 1) and `POST /<lib>/posts` (a title of at
 * least three characters). The same requests then go to all five, so the
 * messages each library writes can be compared side by side — the issue
 * `target` and `path` are the same everywhere.
 *
 * arktype gotcha: a bound cannot follow a morph, so
 * `"string.integer.parse >= 1"` is a parse error; the bound is checked with
 * `.narrow()` instead.
 */
import type { JsonValue, StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { BunRouter, toStandardSchema, validate } from "@kingsleyweb/bun-common";
import { type } from "arktype";
import * as s from "superstruct";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { show, step, title } from "../shared/console";

/** A validation issue as `onFailure: "respond"` reports it. */
interface ReportedIssue {
  /** Which part of the request failed. */
  target: string;
  /** The library's own message. */
  message: string;
  /** Dotted path within the target. */
  path: string;
}

/** The body `onFailure: "respond"` answers with. */
interface FailureBody {
  /** Always `"Validation failed"` unless `formatError` is given. */
  error: string;
  /** Every issue found. */
  issues: ReportedIssue[];
}

title("Schema libraries");

const router = new BunRouter();
const respond = { onFailure: "respond" } as const;

/* ------------------------------------------------------------------ */
step("zod 4 — native Standard Schema");

const zodPage = z.object({ page: z.coerce.number().int().min(1) });
const zodPost = z.object({ title: z.string().min(3) });

router.get("/zod/posts", validate({ query: zodPage }, respond), (req, res) => {
  res.json({ page: req.query.page });
});
router.post("/zod/posts", validate({ body: zodPost }, respond), (req, res) => {
  res.json({ title: req.body.title });
});
show("vendor", zodPage["~standard"].vendor);

/* ------------------------------------------------------------------ */
step("yup 1.7 — native; casts '2' to 2 on its own");

const yupPage = yup.object({ page: yup.number().integer().min(1).required() });
const yupPost = yup.object({ title: yup.string().min(3).required() });

router.get("/yup/posts", validate({ query: yupPage }, respond), (req, res) => {
  res.json({ page: req.query.page });
});
router.post("/yup/posts", validate({ body: yupPost }, respond), (req, res) => {
  res.json({ title: req.body.title });
});
show("vendor", yupPage["~standard"].vendor);

/* ------------------------------------------------------------------ */
step("valibot 1 — native; coercion is an explicit transform in a pipe");

const valibotPage = v.object({
  page: v.pipe(
    v.unknown(),
    v.transform(Number),
    v.number(),
    v.integer(),
    v.minValue(1),
  ),
});
const valibotPost = v.object({ title: v.pipe(v.string(), v.minLength(3)) });

router.get(
  "/valibot/posts",
  validate({ query: valibotPage }, respond),
  (req, res) => {
    res.json({ page: req.query.page });
  },
);
router.post(
  "/valibot/posts",
  validate({ body: valibotPost }, respond),
  (req, res) => {
    res.json({ title: req.body.title });
  },
);
show("vendor", valibotPage["~standard"].vendor);

/* ------------------------------------------------------------------ */
step("arktype 2 — native; a string-to-integer morph, then a narrow");

const arkPage = type({ page: "string.integer.parse" }).narrow(
  (value, ctx) =>
    value.page >= 1 || ctx.reject({ path: ["page"], expected: "at least 1" }),
);
const arkPost = type({ title: "string >= 3" });

router.get(
  "/arktype/posts",
  validate({ query: arkPage }, respond),
  (req, res) => {
    res.json({ page: req.query.page });
  },
);
router.post(
  "/arktype/posts",
  validate({ body: arkPost }, respond),
  (req, res) => {
    res.json({ title: req.body.title });
  },
);
show("vendor", arkPage["~standard"].vendor);

/* ------------------------------------------------------------------ */
step("superstruct 2 — no ~standard, so wrap it with toStandardSchema");

const PageStruct = s.object({
  page: s.coerce(s.min(s.integer(), 1), s.string(), (raw) => Number(raw)),
});
const PostStruct = s.object({ title: s.size(s.string(), 3, Infinity) });

/**
 * Adapts a superstruct struct into a Standard Schema validate function. Its
 * input is `unknown`: untrusted until the struct accepts it.
 */
function fromStruct<T>(
  struct: s.Struct<T>,
): (input: unknown) => StandardSchemaV1.Result<T> {
  return (input) => {
    const [error, value] = s.validate(input, struct, { coerce: true });
    if (error) {
      return {
        issues: error.failures().map((failure) => {
          return { message: failure.message, path: failure.path };
        }),
      };
    }
    return { value };
  };
}

const structPage = toStandardSchema<s.Infer<typeof PageStruct>>(
  fromStruct(PageStruct),
  { vendor: "superstruct" },
);
const structPost = toStandardSchema<s.Infer<typeof PostStruct>>(
  fromStruct(PostStruct),
  { vendor: "superstruct" },
);

router.get(
  "/superstruct/posts",
  validate({ query: structPage }, respond),
  (req, res) => {
    res.json({ page: req.query.page });
  },
);
router.post(
  "/superstruct/posts",
  validate({ body: structPost }, respond),
  (req, res) => {
    res.json({ title: req.body.title });
  },
);
show("superstruct has no ~standard of its own", !("~standard" in PageStruct));
show("…the wrapper reports", structPage["~standard"]);

/* ------------------------------------------------------------------ */
step("The same requests, every library");

const LIBRARIES = ["zod", "yup", "valibot", "arktype", "superstruct"] as const;

for (const library of LIBRARIES) {
  const good = await router.fetch(`/${library}/posts?page=2`);
  const goodBody = (await good.json()) as { page: JsonValue };

  const bad = await router.fetch(`/${library}/posts?page=zero`);
  const badBody = (await bad.json()) as FailureBody;

  const short = await router.fetch(`/${library}/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "no" }),
  });
  const shortBody = (await short.json()) as FailureBody;

  show(library, {
    "?page=2": `${good.status} → page ${String(goodBody.page)} (${typeof goodBody.page})`,
    "?page=zero": `${bad.status} → ${badBody.issues.map((issue) => `${issue.target}.${issue.path}: ${issue.message}`).join(" | ")}`,
    "title 'no'": `${short.status} → ${shortBody.issues.map((issue) => `${issue.target}.${issue.path}: ${issue.message}`).join(" | ")}`,
  });
}

/* ------------------------------------------------------------------ */
step("Mixing libraries in one validate() call");

router.put(
  "/mixed/:id",
  validate(
    {
      params: v.object({ id: v.pipe(v.string(), v.transform(Number)) }),
      query: zodPage,
      body: yupPost,
    },
    respond,
  ),
  (req, res) => {
    res.json({
      id: req.params.id,
      page: req.query.page,
      title: req.body.title,
    });
  },
);

const mixed = await router.fetch("/mixed/9?page=4", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Mixed" }),
});
show("PUT /mixed/9?page=4 (valibot params, zod query, yup body)", {
  status: mixed.status,
  body: await mixed.json(),
});

/* ------------------------------------------------------------------ */
step("toStandardSchema with an async check");

/** Emails already taken, as a database lookup would report them. */
const taken = new Set(["ada@example.test"]);

const AvailableEmail = toStandardSchema<{ email: string }>(async (input) => {
  const email = (input as { email?: unknown } | null)?.email;
  if (typeof email !== "string") {
    return { issues: [{ message: "email is required", path: ["email"] }] };
  }
  await Bun.sleep(1); // the lookup
  return taken.has(email)
    ? { issues: [{ message: "is already registered", path: ["email"] }] }
    : { value: { email } };
});
show("vendor defaults to", AvailableEmail["~standard"].vendor);

router.post(
  "/signup",
  validate({ body: AvailableEmail }, respond),
  (req, res) => {
    res.status(201).json({ welcome: req.body.email });
  },
);

for (const email of ["grace@example.test", "ada@example.test"]) {
  const response = await router.fetch("/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  show(`POST /signup ${email}`, {
    status: response.status,
    body: await response.json(),
  });
}
