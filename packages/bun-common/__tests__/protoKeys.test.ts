import { describe, expect, it } from "bun:test";
import * as yup from "yup";
import { z } from "zod";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { createReceiver, createSender } from "../lib/contract/guard";
import { validateStandard } from "../lib/contract/issues";
import { stripProtoKeys } from "../lib/contract/protoKeys";
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { jobs } from "./contract/fixtures";

/**
 * The runner strips prototype-pollution keys from what arrived before a
 * schema runs, by the rules of Nest 12.2.0's `stripProtoKeys`
 * (`@nestjs/common/utils/strip-proto-keys.util.js`): yup otherwise crashes
 * on an own `__proto__` key (`field.resolve is not a function`), which
 * `validate()` answered with a 500 where Nest's own pipe answers 201.
 */

/** A JSON body with an own `__proto__` key, as `JSON.parse` builds it. */
const POLLUTED = '{"name":"a","__proto__":{"polluted":"yes"}}';

const User = yup.object({ name: yup.string().required() });

/** A router answering `/x` with what the handler received, behind `validate()`. */
function echo(
  schema: yup.AnyObjectSchema,
  options: { stripProtoKeys?: "nest" | "minimal" } = {},
): BunRouter {
  const router = new BunRouter();
  router.post("/x", validate({ body: schema }, options), (req, res) => {
    const body = req.body as Record<string, unknown>;
    res.json({
      keys: Object.keys(body),
      ownProto: Object.hasOwn(body, "__proto__"),
      ownConstructor: Object.hasOwn(body, "constructor"),
      protoIsObject: Object.getPrototypeOf(body) === Object.prototype,
      polluted: (body as { polluted?: unknown }).polluted ?? null,
      body,
    });
  });
  router.use(((err, _req, res, _next) => {
    res
      .status((err as { status?: number }).status ?? 500)
      .json({ error: "failed" });
  }) satisfies RouterErrorMiddlewareHandler);
  return router;
}

/** POSTs `body` as JSON to `/x`. */
function post(router: BunRouter, body: string): Promise<Response> {
  return router.fetch("/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("validate(): a body with prototype-pollution keys (yup)", () => {
  it("control: yup itself crashes on the unstripped value (the 500 before the strip)", async () => {
    let failure: unknown;
    try {
      await User["~standard"].validate(JSON.parse(POLLUTED));
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("resolve is not a function");
  });

  it("an own __proto__ key: validated, and gone from what the handler gets", async () => {
    const res = await post(echo(User), POLLUTED);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      keys: ["name"],
      ownProto: false,
      ownConstructor: false,
      protoIsObject: true,
      polluted: null,
      body: { name: "a" },
    });
  });

  it("nested: in an object and in an array's items", async () => {
    const Nested = yup.object({
      name: yup.string().required(),
      inner: yup.object({ x: yup.number().required() }),
      list: yup.array(yup.object({ y: yup.number().required() })),
    });
    const res = await post(
      echo(Nested),
      '{"name":"a","inner":{"x":1,"__proto__":{"polluted":"yes"}},"list":[{"y":2,"__proto__":{"polluted":"yes"}}]}',
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { body: Record<string, unknown> };
    expect(out.body).toEqual({ name: "a", inner: { x: 1 }, list: [{ y: 2 }] });
  });

  it("a constructor key with a prototype, stripped as Nest strips it", async () => {
    const res = await post(
      echo(User),
      '{"name":"a","constructor":{"prototype":{"polluted":"yes"}}}',
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out.ownConstructor).toBe(false);
    expect(out.body).toEqual({ name: "a" });
  });

  it("params are the route's names and the route cache's object: never stripped", async () => {
    const router = new BunRouter();
    router.get(
      "/p/:constructor",
      validate({ params: z.object({ constructor: z.string() }) }),
      (req, res) => res.json(req.params),
    );
    for (const id of ["one", "two"]) {
      const res = await router.fetch(`/p/${id}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ constructor: id });
    }
  });
});

describe("validateStandard strips only when given a rule, synchronously", () => {
  it("a sync vendor stays sync on a polluted value", () => {
    const value = JSON.parse(POLLUTED) as Record<string, unknown>;
    const outcome = validateStandard(
      z.looseObject({ name: z.string() }),
      value,
      "body",
      undefined,
      undefined,
      { stripProtoKeys: "nest" },
    );
    expect(outcome).not.toBeInstanceOf(Promise);
    expect(outcome).toEqual({ ok: true, value: { name: "a" } });
    expect(Object.hasOwn(value, "__proto__")).toBe(false);
  });

  it("with no rule it strips nothing: a value a server built keeps its __proto__-named key", () => {
    // bun-jobs checks its own response bodies with validateStandard, where a
    // queue named "__proto__" is a record key and data (bun-jobs'
    // api-summon-groups-authz test); stripping there deleted it.
    const queues = JSON.parse(
      '{"__proto__":{"day":1},"renders":{"day":2}}',
    ) as object;
    const body = { queues };
    const outcome = validateStandard(
      z.object({ queues: z.record(z.string(), z.object({ day: z.number() })) }),
      body,
      "body",
    );
    expect(outcome).not.toBeInstanceOf(Promise);
    expect(Object.hasOwn(queues, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(queues, "__proto__")?.value).toEqual(
      {
        day: 1,
      },
    );
  });
});

describe("the contract guards: a receiver strips, a sender hands back its message untouched", () => {
  const c = jobs.contract({
    inbound: { data: z.looseObject({ n: z.number() }) },
    outbound: { result: z.looseObject({ n: z.number() }) },
  });

  it("a receiver strips what arrived", () => {
    const data = JSON.parse('{"n":1,"__proto__":{"polluted":"yes"}}') as object;
    const out = createReceiver(c, "inbound")({ data }) as { data: object };
    expect(Object.hasOwn(data, "__proto__")).toBe(false);
    expect(out.data).toEqual({ n: 1 });
  });

  it("a sender never mutates the owner's message", () => {
    const result = { n: 1, constructor: "kept" };
    const msg = { result };
    expect(createSender(c, "outbound")(msg as never)).toBe(msg);
    expect(result).toEqual({ n: 1, constructor: "kept" });
  });
});

describe("stripProtoKeys: Nest 12.2.0's rules", () => {
  it("deletes own __proto__, prototype and constructor keys, recursively", () => {
    const value = JSON.parse(
      '{"a":{"prototype":1,"constructor":0,"b":[{"__proto__":{"p":1},"c":2}]},"__proto__":{"p":1}}',
    ) as Record<string, unknown>;
    stripProtoKeys(value);
    expect(value).toEqual({ a: { b: [{ c: 2 }] } });
    expect(Object.hasOwn(value, "__proto__")).toBe(false);
  });

  it("leaves an object with nothing to strip as it was", () => {
    const value = { a: 1, b: { c: [1, 2] } };
    const before = structuredClone(value);
    stripProtoKeys(value);
    expect(value).toEqual(before);
  });

  it("leaves typed arrays and built-in instances alone", () => {
    const date = Object.assign(new Date(0), { constructor: 1 });
    const map = Object.assign(new Map(), { prototype: 1 });
    const bytes = new Uint8Array([1, 2]);
    stripProtoKeys({ date, map, bytes });
    expect(Object.hasOwn(date, "constructor")).toBe(true);
    expect(Object.hasOwn(map, "prototype")).toBe(true);
    expect([...bytes]).toEqual([1, 2]);
  });

  it("walks only a sparse array's items, not its length", () => {
    const sparse: unknown[] = [];
    sparse[4294967294 - 1] = JSON.parse('{"__proto__":{"p":1},"k":1}');
    const started = performance.now();
    stripProtoKeys(sparse);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(sparse.at(-1)).toEqual({ k: 1 });
  });

  it("strips a null-prototype object's keys too", () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "__proto__", {
      value: { p: 1 },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    value["constructor" as string] = "x";
    value.k = 1;
    stripProtoKeys(value);
    expect(Object.keys(value)).toEqual(["k"]);
  });
});

/* ---- the stripProtoKeys option: "nest" (default) or "minimal" ------ */

/** A body with every key either rule looks at. */
const MIXED =
  '{"name":"a","__proto__":{"polluted":"yes"},"prototype":1,"constructor":"Acme","inner":{"constructor":{"x":1}},"deep":{"constructor":{"prototype":{"polluted":"yes"}},"k":1}}';

describe("stripProtoKeys: the two rules", () => {
  it('"minimal" deletes own __proto__, and constructor only when it holds a prototype', () => {
    const value = JSON.parse(MIXED) as Record<string, unknown>;
    stripProtoKeys(value, "minimal");
    expect(Object.hasOwn(value, "__proto__")).toBe(false);
    expect(value).toEqual({
      name: "a",
      prototype: 1,
      constructor: "Acme",
      inner: { constructor: { x: 1 } },
      deep: { k: 1 },
    });
  });

  it('negative control: "nest" (the default) deletes the prototype and constructor fields "minimal" keeps', () => {
    const value = JSON.parse(MIXED) as Record<string, unknown>;
    stripProtoKeys(value);
    expect(value).toEqual({ name: "a", inner: {}, deep: { k: 1 } });
  });

  it('"minimal" skips what "nest" skips: built-ins, typed arrays, a sparse array\'s length', () => {
    const date = Object.assign(new Date(0), {
      constructor: { prototype: {} },
    });
    const bytes = new Uint8Array([1]);
    const sparse: unknown[] = [];
    sparse[4294967294 - 1] = JSON.parse('{"__proto__":{"p":1},"k":1}');
    const started = performance.now();
    stripProtoKeys({ date, bytes, sparse }, "minimal");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(Object.hasOwn(date, "constructor")).toBe(true);
    expect(sparse.at(-1)).toEqual({ k: 1 });
  });
});

describe("the stripProtoKeys option on each entry point", () => {
  const Loose = z.looseObject({ name: z.string() });

  it('validate(): "minimal" keeps a prototype field "nest" deletes', async () => {
    for (const [rule, keys] of [
      [undefined, ["name"]],
      ["nest", ["name"]],
      ["minimal", ["name", "prototype"]],
    ] as const) {
      const router = new BunRouter();
      router.post(
        "/x",
        validate(
          { body: Loose },
          rule === undefined ? {} : { stripProtoKeys: rule },
        ),
        (req, res) => res.json(Object.keys(req.body as object)),
      );
      const res = await post(router, '{"name":"a","prototype":1}');
      expect(await res.json()).toEqual(keys as never);
    }
  });

  it('validate() under "minimal" with yup: the __proto__ crash is still fixed, and constructor.prototype is stripped', async () => {
    const router = new BunRouter();
    router.post(
      "/x",
      validate({ body: User }, { stripProtoKeys: "minimal" }),
      (req, res) => res.json(req.body),
    );
    for (const body of [
      POLLUTED,
      '{"name":"a","constructor":{"prototype":{"polluted":"yes"}}}',
    ]) {
      const res = await post(router, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ name: "a" });
    }
  });

  it('the gotcha: under "minimal" a plain constructor field reaches yup, which crashes on it ("nest" deletes it)', async () => {
    // yup crashes on any key naming an Object.prototype member (measured:
    // `constructor`, `toString`, `hasOwnProperty`); "nest" strips the first.
    for (const [rule, status] of [
      ["nest", 200],
      ["minimal", 500],
    ] as const) {
      const res = await post(
        echo(User, { stripProtoKeys: rule }),
        '{"name":"a","constructor":"Acme"}',
      );
      expect(res.status).toBe(status);
    }
  });

  it("validateStandard takes it in its options", () => {
    const value = JSON.parse('{"name":"a","prototype":1}') as object;
    const outcome = validateStandard(
      Loose,
      value,
      "body",
      undefined,
      undefined,
      {
        stripProtoKeys: "minimal",
      },
    );
    expect(outcome).toEqual({ ok: true, value: { name: "a", prototype: 1 } });
    const nest = JSON.parse('{"name":"a","prototype":1}') as object;
    expect(
      validateStandard(Loose, nest, "body", undefined, undefined, {
        stripProtoKeys: "nest",
      }),
    ).toEqual({
      ok: true,
      value: { name: "a" },
    });
  });

  it("a guard receiver takes it; a sender ignores it", () => {
    const c = jobs.contract({
      inbound: { data: z.looseObject({ n: z.number() }) },
      outbound: { result: z.looseObject({ n: z.number() }) },
    });
    const received = (rule: "nest" | "minimal") =>
      (
        createReceiver(c, "inbound", { stripProtoKeys: rule })({
          data: JSON.parse('{"n":1,"prototype":1,"__proto__":{"p":1}}'),
        }) as { data: object }
      ).data;
    expect(received("minimal")).toEqual({ n: 1, prototype: 1 });
    expect(received("nest")).toEqual({ n: 1 });
    const result = { n: 1, prototype: 1, constructor: "kept" };
    const msg = { result };
    expect(
      createSender(c, "outbound", { stripProtoKeys: "nest" })(msg as never),
    ).toBe(msg);
    expect(result).toEqual({ n: 1, prototype: 1, constructor: "kept" });
  });

  it("refuses any other value with a TypeError, at build (at call for validateStandard)", () => {
    const c = jobs.contract({ inbound: { data: z.unknown() } });
    const bad = { stripProtoKeys: "Nest" } as never;
    expect(() => validate({ body: Loose }, bad)).toThrow(
      'validate(): stripProtoKeys must be "nest" or "minimal" (or unset)',
    );
    expect(() => createReceiver(c, "inbound", bad)).toThrow(TypeError);
    expect(() => createSender(c, "inbound", bad)).toThrow(TypeError);
    expect(() =>
      validateStandard(Loose, {}, "body", undefined, undefined, bad),
    ).toThrow(TypeError);
  });
});
