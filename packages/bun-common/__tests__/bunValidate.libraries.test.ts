import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { type } from "arktype";
import { describe, expect, it } from "bun:test";
import * as s from "superstruct";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { BunRouter } from "../lib/BunRouter";
import {
  toStandardSchema,
  validate,
  ValidationError,
} from "../lib/BunValidate";

/**
 * `BunValidate` against the validation libraries people actually use.
 *
 * The point of building on [Standard Schema](https://standardschema.dev) was
 * that no library needs adapting, so the interesting question is not whether
 * our code works — it is whether that claim survives contact with four
 * independent implementations. Each one below is the library's own schema,
 * passed straight in.
 *
 * The type-level half is `bunValidate.libraries.type-test.ts`.
 */

/** One library's schemas for the shared suite below. */
interface Library {
  /** The library's name, which is also the vendor it reports. */
  name: string;
  /** A schema for `?page=…`, producing a number. */
  query: StandardSchemaV1;
  /** A schema for a JSON body with a `title` of at least three characters. */
  body: StandardSchemaV1;
}

/** The libraries that implement Standard Schema themselves. */
const NATIVE: Library[] = [
  {
    name: "zod",
    query: z.object({ page: z.coerce.number().int().min(1) }),
    body: z.object({ title: z.string().min(3) }),
  } as Library,
  {
    name: "yup",
    query: yup.object({ page: yup.number().integer().min(1).required() }),
    body: yup.object({ title: yup.string().min(3).required() }),
  },
  {
    name: "valibot",
    query: v.object({
      page: v.pipe(
        v.unknown(),
        v.transform(Number),
        v.number(),
        v.integer(),
        v.minValue(1),
      ),
    }),
    body: v.object({ title: v.pipe(v.string(), v.minLength(3)) }),
  },
  {
    name: "arktype",
    // A morph from the string a query string carries to a number. arktype
    // rejects a bound after a morph, so the range check lives in the
    // definition's own vocabulary rather than being appended.
    query: type({ page: "string.integer.parse" }),
    body: type({ title: "string >= 3" }),
  },
] as Library[];

/** Runs a request through a router carrying `middleware`, capturing the result. */
async function run(
  middleware: ReturnType<typeof validate>,
  request: { url: string; method?: string; body?: unknown },
): Promise<{ status: number; payload: unknown }> {
  const router = new BunRouter();
  router.useMethod(
    request.method ?? "GET",
    "/check",
    middleware,
    (req, res) => {
      res.json({ query: req.query, body: req.body, params: req.params });
    },
  );

  const response = await router.fetch({
    url: request.url,
    method: request.method ?? "GET",
    ...(request.body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request.body),
        }),
  });

  return { status: response.status, payload: await response.json() };
}

for (const library of NATIVE) {
  describe(`BunValidate with ${library.name}`, () => {
    it("exposes a version 1 Standard Schema", () => {
      const standard = (library.query as StandardSchemaV1)["~standard"];

      expect(standard.version).toBe(1);
      expect(standard.vendor).toBe(library.name);
      expect(typeof standard.validate).toBe("function");
    });

    it("replaces the query with the parsed value", async () => {
      const { status, payload } = await run(
        validate({ query: library.query as StandardSchemaV1 }),
        { url: "/check?page=2" },
      );

      expect(status).toBe(200);
      // The string from the URL is a number by the time the handler sees it.
      expect((payload as { query: { page: unknown } }).query.page).toBe(2);
    });

    it("reports a failure as Standard Schema issues", async () => {
      const { status, payload } = await run(
        validate(
          { query: library.query as StandardSchemaV1 },
          {
            onFailure: "respond",
          },
        ),
        { url: "/check?page=not-a-number" },
      );

      expect(status).toBe(400);

      const issues = (
        payload as {
          issues: { target: string; message: string; path: string }[];
        }
      ).issues;
      expect(issues.length).toBeGreaterThan(0);

      for (const issue of issues) {
        expect(issue.target).toBe("query");
        // The spec requires a message and allows a path; both survive the
        // journey from the library to the response body.
        expect(typeof issue.message).toBe("string");
        expect(issue.message.length).toBeGreaterThan(0);
        expect(typeof issue.path).toBe("string");
      }

      expect(issues.some((issue) => issue.path === "page")).toBe(true);
    });

    it("validates a body as readily as a query", async () => {
      const ok = await run(
        validate({ body: library.body as StandardSchemaV1 }),
        {
          url: "/check",
          method: "POST",
          body: { title: "hello" },
        },
      );
      expect(ok.status).toBe(200);
      expect((ok.payload as { body: { title: string } }).body.title).toBe(
        "hello",
      );

      const bad = await run(
        validate(
          { body: library.body as StandardSchemaV1 },
          {
            onFailure: "respond",
          },
        ),
        { url: "/check", method: "POST", body: { title: "no" } },
      );
      expect(bad.status).toBe(400);
    });

    it("carries the issues on the thrown error", async () => {
      const middleware = validate(
        { query: library.query as StandardSchemaV1 },
        { onFailure: "throw" },
      );

      const router = new BunRouter();
      router.get("/boom", middleware, (_req, res) => res.send("unreachable"));

      let caught: unknown;
      router.use(((error, _req, res, _next) => {
        caught = error;
        res.status(500).send("handled");
      }) satisfies import("../lib/types/general").RouterErrorMiddlewareHandler);

      await router.fetch("/boom?page=nope");

      expect(caught).toBeInstanceOf(ValidationError);
      const error = caught as ValidationError;
      expect(error.targets).toEqual(["query"]);
      expect(error.status).toBe(400);
      expect(error.message).toContain("query");
      expect(error.issues[0].message.length).toBeGreaterThan(0);
    });
  });
}

describe("BunValidate across libraries at once", () => {
  it("validates each target with a different library", async () => {
    const { status, payload } = await run(
      validate({
        query: z.object({ page: z.coerce.number() }) as StandardSchemaV1,
        body: yup.object({
          title: yup.string().required(),
        }) as unknown as StandardSchemaV1,
      }),
      { url: "/check?page=3", method: "POST", body: { title: "mixed" } },
    );

    expect(status).toBe(200);
    expect(payload).toMatchObject({
      query: { page: 3 },
      body: { title: "mixed" },
    });
  });

  it("collects issues from every failing target", async () => {
    const { payload } = await run(
      validate(
        {
          query: z.object({ page: z.number() }) as StandardSchemaV1,
          body: v.object({ title: v.string() }) as StandardSchemaV1,
        },
        { onFailure: "respond" },
      ),
      { url: "/check?page=nope", method: "POST", body: { title: 42 } },
    );

    const issues = (payload as { issues: { target: string }[] }).issues;
    expect(new Set(issues.map((issue) => issue.target))).toEqual(
      new Set(["query", "body"]),
    );
  });

  it("stops at the first failing target when asked", async () => {
    const { payload } = await run(
      validate(
        {
          query: z.object({ page: z.number() }) as StandardSchemaV1,
          body: v.object({ title: v.string() }) as StandardSchemaV1,
        },
        { onFailure: "respond", abortEarly: true },
      ),
      { url: "/check?page=nope", method: "POST", body: { title: 42 } },
    );

    const issues = (payload as { issues: { target: string }[] }).issues;
    expect(new Set(issues.map((issue) => issue.target))).toEqual(
      new Set(["query"]),
    );
  });
});

describe("toStandardSchema", () => {
  /** superstruct has no `~standard`, so it stands in for "everything else". */
  const Page = s.object({ page: s.number() });

  const wrapped = toStandardSchema<unknown, { page: number }>(
    (input) => {
      const coerced = {
        page: Number((input as { page?: unknown } | null)?.page),
      };
      const [error] = s.validate(coerced, Page);

      return error
        ? {
            issues: error.failures().map((failure) => ({
              message: failure.message,
              path: failure.path,
            })),
          }
        : { value: coerced };
    },
    { vendor: "superstruct" },
  );

  it("produces a schema that satisfies the spec", () => {
    expect(wrapped["~standard"].version).toBe(1);
    expect(wrapped["~standard"].vendor).toBe("superstruct");

    // superstruct itself does not implement the standard — which is the whole
    // reason this helper exists.
    expect(
      (Page as unknown as { "~standard"?: unknown })["~standard"],
    ).toBeUndefined();
  });

  it("validates through BunValidate like a native schema", async () => {
    const ok = await run(validate({ query: wrapped }), {
      url: "/check?page=4",
    });
    expect(ok.status).toBe(200);
    expect((ok.payload as { query: { page: number } }).query.page).toBe(4);

    const bad = await run(
      validate({ query: wrapped }, { onFailure: "respond" }),
      {
        url: "/check?page=oops",
      },
    );
    expect(bad.status).toBe(400);
    expect((bad.payload as { issues: { path: string }[] }).issues[0].path).toBe(
      "page",
    );
  });

  it("accepts an async validate function", async () => {
    const asyncSchema = toStandardSchema<unknown, { token: string }>(
      async (input) => {
        await Bun.sleep(1);
        const token = (input as { token?: unknown } | null)?.token;
        return typeof token === "string"
          ? { value: { token } }
          : {
              issues: [{ message: "token must be a string", path: ["token"] }],
            };
      },
    );

    const ok = await run(validate({ query: asyncSchema }), {
      url: "/check?token=abc",
    });
    expect(ok.status).toBe(200);
  });
});
