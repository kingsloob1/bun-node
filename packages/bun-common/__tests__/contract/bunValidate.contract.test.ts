/**
 * `validate()` rebuilt on the contract core (plan §4.3): its middleware
 * carries an HTTP contract that `getContract` reads back from the router's
 * layer (Q-C10), answers synchronously when every schema does, and reports
 * issues through the core's scrub. Its existing behaviour is pinned by
 * `bunValidate.test.ts` and `bunValidate.libraries.test.ts`, unchanged.
 */
import type { BunRequest } from "../../lib/BunRequest";
import type { BunResponse } from "../../lib/BunResponse";
import type {
  NextFunction,
  RouterErrorMiddlewareHandler,
} from "../../lib/types/general";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { BunValidate, validate, ValidationError } from "../../lib/BunValidate";
import { describeContract } from "../../lib/contract/describe";
import { getContract } from "../../lib/contract/transport";

const Page = z.object({ page: z.coerce.number() });
const Title = z.object({ title: z.string() });

describe("validate() carries its contract", () => {
  it("getContract reads an HTTP contract of the schemas off the middleware", () => {
    const mw = validate({ query: Page, body: Title });
    const contract = getContract(mw);
    expect(contract?.transport.name).toBe("http");
    expect(
      describeContract(contract!).entries.map((e) => [
        e.side,
        e.part,
        e.encoding,
        e.schema,
      ]),
    ).toEqual([
      ["inbound", "query", "querystring", Page],
      ["inbound", "body", "body", Title],
    ]);
    expect(Object.keys(mw)).toEqual([]);
  });

  it("every middleware a BunValidate builds carries the same contract", () => {
    const validator = new BunValidate({ schemas: { params: Page } });
    expect(getContract(validator.middleware())).toBe(
      getContract(validator.middleware()),
    );
  });

  it("is found on the router's layer, where a route listing would read it", () => {
    const router = new BunRouter();
    const mw = validate({ headers: z.object({ "x-a": z.string() }) });
    router.get("/x", mw, (_req, res) => res.send("ok"));
    const route = router.routes().find((r) => r.path === "/x")!;
    const carried = route.callbacks
      .map((cb) => getContract(cb))
      .filter((c) => c !== undefined);
    expect(carried).toEqual([getContract(mw)!]);
  });

  it("leaves a schema given as undefined out of the contract", () => {
    const contract = getContract(validate({ query: Page, body: undefined }))!;
    expect(describeContract(contract).entries.map((e) => e.part)).toEqual([
      "query",
    ]);
  });
});

/** Calls a middleware directly, recording what `next` got. */
function call(mw: ReturnType<typeof validate>, req: Partial<BunRequest>) {
  const seen: unknown[] = [];
  const next = ((value?: unknown) => {
    seen.push(value ?? "next()");
  }) as NextFunction;
  const result = mw(req as BunRequest, {} as BunResponse, next);
  return { result, seen };
}

describe("validate() answers synchronously when the vendor does", () => {
  it("zod and valibot: next() runs before the middleware returns, with no promise", () => {
    for (const schema of [Page, v.object({ page: v.string() })]) {
      const req = { query: { page: "3" } } as Partial<BunRequest>;
      const { result, seen } = call(validate({ query: schema }), req);
      expect(result).not.toBeInstanceOf(Promise);
      expect(seen).toEqual(["next()"]);
    }
  });

  it("a failure under onFailure: next is synchronous too", () => {
    const { result, seen } = call(validate({ query: Page }), {
      query: { page: "x" },
    });
    expect(result).not.toBeInstanceOf(Promise);
    expect(seen[0]).toBeInstanceOf(ValidationError);
  });

  it("yup: the middleware returns a promise, as before", async () => {
    const { result, seen } = call(
      validate({ query: yup.object({ page: yup.number().required() }) }),
      {
        query: { page: "3" },
      },
    );
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(seen).toEqual(["next()"]);
  });

  it("onFailure: throw throws synchronously, and the router still routes it to the error handler", async () => {
    const mw = validate({ query: Page }, { onFailure: "throw" });
    expect(() => call(mw, { query: { page: "x" } })).toThrow(ValidationError);
    const router = new BunRouter();
    router.get("/t", mw, (_req, res) => res.send("unreachable"));
    router.use(((error, _req, res, _next) => {
      res.status(499).json({ name: (error as Error).name });
    }) satisfies RouterErrorMiddlewareHandler);
    const response = await router.fetch("/t?page=x");
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ name: "ValidationError" });
  });
});

describe("validate()'s issues come through the core's scrub", () => {
  it("withholds a vendor message quoting the received value", async () => {
    const router = new BunRouter();
    router.get(
      "/s",
      validate(
        { query: v.object({ email: v.pipe(v.string(), v.email()) }) },
        { onFailure: "respond" },
      ),
      (_req, res) => res.send("unreachable"),
    );
    const response = await router.fetch("/s?email=SECRET-7731");
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("SECRET-7731");
    expect(JSON.parse(text)).toEqual({
      error: "Validation failed",
      issues: [
        { target: "query", path: "email", message: "Invalid value (email)" },
      ],
    });
  });
});
