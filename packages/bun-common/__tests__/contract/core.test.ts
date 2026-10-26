import type { IssueContext, ValidationIssue } from "../../lib/contract/model";
/**
 * The contract core at runtime: declarations, the runner, guards and their
 * policies, `onIssues`, `checksKey`, carrying contracts, an in-process
 * broker and a flow (the spike's C7–C10, C16, C19–C22; plan §4.1).
 */
import type { StandardSchemaV1 } from "../../lib/types/standardSchema";
import { type } from "arktype";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import {
  ContractError,
  createReceiver,
  createSender,
} from "../../lib/contract/guard";
import { andThen, validateStandard } from "../../lib/contract/issues";
import {
  attachContract,
  defineTransport,
  forwardContract,
  getContract,
} from "../../lib/contract/transport";
import { createTestLogger } from "../../lib/logging";
import { broker, flow, http, jobs } from "./fixtures";
import "reflect-metadata";

/** A hand-rolled Standard Schema, sync or async, whose input is `unknown`. */
function custom<T>(
  check: (value: unknown) => value is T,
  async = false,
): StandardSchemaV1<unknown, T> {
  const run = (value: unknown): StandardSchemaV1.Result<T> =>
    check(value)
      ? { value }
      : { issues: [{ message: "Rejected by custom check", path: [] }] };
  return {
    "~standard": {
      version: 1,
      vendor: async ? "custom-async" : "custom",
      validate: async ? async (x: unknown) => run(x) : run,
    },
  };
}
const isPoint = (x: unknown): x is { x: number } =>
  typeof (x as { x?: unknown } | null)?.x === "number";

const kind = (x: unknown): string =>
  x instanceof Promise ? "Promise" : "sync";

describe("defineTransport and contract(): declaration mistakes are TypeErrors (C22)", () => {
  it("refuses a key that is also a part", () => {
    expect(() =>
      defineTransport({
        name: "x",
        inbound: { key: "payload", parts: ["payload"] },
      }),
    ).toThrow(
      new TypeError(
        'defineTransport("x").inbound: the key "payload" cannot also be a part',
      ),
    );
  });

  it("refuses a media part, or an encoding, that is not a part", () => {
    expect(() =>
      defineTransport({ name: "x", inbound: { parts: ["a"], media: ["b"] } }),
    ).toThrow('media part "b" is not a part');
    expect(() =>
      defineTransport({
        name: "x",
        inbound: { parts: ["a"], encodings: { b: "body" } },
      }),
    ).toThrow('the encoding for "b" names no part');
  });

  it("refuses a repeated part, an empty name and an unknown wire", () => {
    expect(() =>
      defineTransport({ name: "x", inbound: { parts: ["a", "a"] } }),
    ).toThrow('the part "a" is listed twice');
    expect(() => defineTransport({ name: "" })).toThrow(TypeError);
    expect(() => defineTransport({ name: "x", wire: "xml" as never })).toThrow(
      '"wire" is "json" or "identity"',
    );
  });

  it("refuses an undeclared part, an undeclared side and a media map where none is allowed", () => {
    expect(() =>
      http.contract({ inbound: { bdy: z.string() } } as never),
    ).toThrow(
      new TypeError(
        'http.contract().inbound: "bdy" is not a part (headers, cookies, signedCookies, params, query, body)',
      ),
    );
    expect(() => jobs.contract({ sideways: {} } as never)).toThrow(
      "jobs.contract(): no sideways side",
    );
    expect(() =>
      http.contract({
        inbound: { query: { "application/json": z.string() } },
      } as never),
    ).toThrow('"query" must be a Standard Schema or null');
    expect(() =>
      http.contract({
        outbound: { 200: { body: { "application/json": {} } } },
      } as never),
    ).toThrow('media type "application/json" must be a Standard Schema');
    expect(() => http.contract({ outbound: { 200: "x" } } as never)).toThrow(
      "expected an object of parts",
    );
  });

  it("carries its spec, def and meta, and itself", () => {
    const c = jobs.contract(
      { inbound: { data: z.string() } },
      { name: "send-mail" },
    );
    expect(c.transport).toBe(jobs.spec);
    expect(c.meta).toEqual({ name: "send-mail" });
    expect(getContract(c)).toBe(c);
    expect(Object.keys(c)).toEqual(["transport", "def", "meta"]);
  });
});

describe("validateStandard: sync when the vendor is (C10)", () => {
  const vendors: Record<string, StandardSchemaV1> = {
    "zod 4": z.object({ x: z.number() }),
    "valibot 1": v.object({ x: v.number() }),
    "arktype 2": type({ x: "number" }),
    "yup 1.7": yup.object({ x: yup.number().required() }),
    "custom sync": custom(isPoint),
    "custom async": custom(isPoint, true),
  };
  const expected: Record<string, string> = {
    "zod 4": "sync",
    "valibot 1": "sync",
    "arktype 2": "sync",
    "yup 1.7": "Promise",
    "custom sync": "sync",
    "custom async": "Promise",
  };

  for (const [name, schema] of Object.entries(vendors)) {
    it(`${name}: runner, receiver and sender answer ${expected[name]}`, async () => {
      const c = broker.contract({
        inbound: { t: { payload: schema } },
        outbound: { t: { payload: schema } },
      });
      const msg = { topic: "t", payload: { x: 1 } };
      const runner = validateStandard(schema, msg.payload, "payload");
      const recv = createReceiver(c, "inbound")(msg);
      const send = createSender(c, "outbound")(msg as never);
      expect([kind(runner), kind(recv), kind(send)]).toEqual([
        expected[name],
        expected[name],
        expected[name],
      ]);
      expect(await runner).toEqual({ ok: true, value: { x: 1 } });
      expect<unknown>(await send).toBe(msg);
    });
  }

  it("makes a message async when any one part is", async () => {
    const mixed = broker.contract({
      inbound: {
        t: { payload: vendors["zod 4"], headers: vendors["yup 1.7"] },
      },
    });
    const r = createReceiver(
      mixed,
      "inbound",
    )({
      topic: "t",
      payload: { x: 1 },
      headers: { x: 2 },
    });
    expect(r).toBeInstanceOf(Promise);
    expect(await r).toEqual({
      topic: "t",
      payload: { x: 1 },
      headers: { x: 2 },
    });
  });

  it("flattens issues under the target, key and media type given", () => {
    const outcome = validateStandard(
      z.object({ n: z.number() }),
      { n: "x" },
      "body",
      "201",
      "application/json",
    );
    expect(outcome).toEqual({
      ok: false,
      issues: [
        {
          target: "body",
          path: "n",
          key: "201",
          mediaType: "application/json",
          message: "Invalid input: expected number, received string",
        },
      ],
    });
  });
});

describe("andThen", () => {
  it("stays synchronous for a value and chains a promise", async () => {
    expect(andThen(2, (x) => x * 2)).toBe(4);
    const later = andThen(Promise.resolve(2), (x) => x * 3);
    expect(later).toBeInstanceOf(Promise);
    expect(await later).toBe(6);
  });
});

describe("receivers parse; senders check and hand back the same object", () => {
  const c = broker.contract({
    inbound: { orders: { payload: z.object({ total: z.coerce.number() }) } },
    outbound: { orders: { payload: z.object({ total: z.coerce.number() }) } },
  });

  it("a receiver hands on each part's output, in a copy", () => {
    const msg = { topic: "orders", payload: { total: "12" }, extra: 1 };
    const out = createReceiver(c, "inbound")(msg);
    expect<unknown>(out).toEqual({
      topic: "orders",
      payload: { total: 12 },
      extra: 1,
    });
    expect(out).not.toBe(msg);
  });

  it("a sender hands back the very message it was given", () => {
    const msg = { topic: "orders" as const, payload: { total: 12 } };
    expect(createSender(c, "outbound")(msg)).toBe(msg);
  });

  it("a receiver or sender that is not an object message still answers", () => {
    const r = createReceiver(c, "inbound")(undefined);
    expect(r).toBeInstanceOf(ContractError);
    expect((r as ContractError).issues[0].target).toBe("topic");
  });
});

describe("the policy", () => {
  const c = broker.contract({
    inbound: { t: { payload: z.object({ n: z.number() }) } },
    outbound: { t: { payload: z.object({ n: z.number() }) } },
  });
  const failing = { topic: "t", payload: { n: "x" } };

  it('"error" (the default) returns a ContractError with the context; it never throws', () => {
    for (const make of [createReceiver, createSender] as const) {
      const out = make(
        c,
        make === createReceiver ? "inbound" : "outbound",
      )(failing as never);
      expect(out).toBeInstanceOf(ContractError);
      const error = out as ContractError;
      expect(error.name).toBe("ContractError");
      expect(error.context).toEqual({
        transport: "broker",
        side: make === createReceiver ? "inbound" : "outbound",
        key: "t",
        policy: "error",
      });
      expect(error.message).toBe(
        `broker ${error.context.side} t failed its contract: payload.n: Invalid input: expected number, received string`,
      );
    }
  });

  it('"warn" logs one line with no values and hands on the raw message', () => {
    const { logger, events } = createTestLogger();
    const recv = createReceiver(c, "inbound", { policy: "warn", logger });
    expect(recv(failing)).toBe(failing);
    const send = createSender(c, "outbound", { policy: "warn", logger });
    expect<unknown>(send(failing as never)).toBe(failing);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      level: "warn",
      message: "contract mismatch",
      fields: {
        transport: "broker",
        side: "inbound",
        key: "t",
        issues: [
          {
            target: "payload",
            path: "n",
            message: expect.any(String),
            key: "t",
          },
        ],
      },
    });
  });

  it('"off" compiles to the identity on both guards', () => {
    expect(createReceiver(c, "inbound", { policy: "off" }).checks).toBe(false);
    expect<unknown>(
      createSender(c, "outbound", { policy: "off" })(failing as never),
    ).toBe(failing);
  });

  it("an undeclared key is reported by default, passed with undeclaredKey: allow", () => {
    const r = createReceiver(c, "inbound")({ topic: "nope-SECRET" });
    expect(r).toBeInstanceOf(ContractError);
    expect((r as ContractError).issues).toEqual([
      { target: "topic", path: "", message: "This topic is not declared (t)" },
    ]);
    expect((r as ContractError).context).toEqual({
      transport: "broker",
      side: "inbound",
      policy: "error",
    });
    const msg = { topic: "nope" };
    expect<unknown>(
      createReceiver(c, "inbound", { undeclaredKey: "allow" })(msg),
    ).toBe(msg);
  });
});

describe("onIssues (C16)", () => {
  const c = broker.contract({
    inbound: { typed: { payload: z.object({ n: z.number() }) }, bare: {} },
  });

  it("is called once per failing message, never on a passing one, under warn and error", () => {
    const calls: { issues: readonly ValidationIssue[]; ctx: IssueContext }[] =
      [];
    const hooked = createReceiver(c, "inbound", {
      onIssues: (issues, ctx) => void calls.push({ issues, ctx }),
    });
    void hooked({ topic: "typed", payload: { n: 1 } });
    void hooked({ topic: "bare" });
    expect(calls).toHaveLength(0);
    void hooked({ topic: "typed", payload: { n: "x" } });
    void hooked({ topic: "nope" });
    expect(calls.map((x) => x.ctx)).toEqual([
      { transport: "broker", side: "inbound", key: "typed", policy: "error" },
      { transport: "broker", side: "inbound", policy: "error" },
    ]);
    expect(calls[0].issues.map((i) => i.path)).toEqual(["n"]);

    const { logger } = createTestLogger();
    let warned = 0;
    createReceiver(c, "inbound", {
      policy: "warn",
      logger,
      onIssues: () => void warned++,
    })({
      topic: "typed",
      payload: {},
    });
    expect(warned).toBe(1);
  });

  it("a throwing hook is logged, and the guard answers as without it", () => {
    const { logger, events } = createTestLogger();
    const r = createReceiver(c, "inbound", {
      logger,
      onIssues: () => {
        throw new Error("telemetry down");
      },
    })({ topic: "typed", payload: {} });
    expect(r).toBeInstanceOf(ContractError);
    expect(events.map((e) => [e.level, e.message])).toEqual([
      ["error", "contract onIssues hook failed"],
    ]);
  });
});

describe("checksKey (Q-C6)", () => {
  const c = http.contract({
    outbound: { 200: { body: z.string() }, 204: {}, 304: { body: null } },
  });

  it("answers per key: a schema, none, undeclared", () => {
    const send = createSender(c, "outbound");
    expect(send.checksKey(200)).toBe(true);
    expect(send.checksKey("200")).toBe(true);
    expect(send.checksKey(204)).toBe(false);
    expect(send.checksKey(304)).toBe(true); // a null part checks absence
    expect(send.checksKey(418)).toBe(true); // reported as undeclared
    const lenient = createSender(c, "outbound", { undeclaredKey: "allow" });
    expect(lenient.checksKey(418)).toBe(false);
  });

  it("is false everywhere on an identity guard, and `checks` on an unkeyed side", () => {
    expect(createSender(c, "outbound", { policy: "off" }).checksKey(200)).toBe(
      false,
    );
    expect(createReceiver(c, "inbound").checksKey("x")).toBe(false);
    const job = jobs.contract({ inbound: { data: z.string() } });
    expect(createReceiver(job, "inbound").checksKey("any")).toBe(true);
  });

  it("agrees with the guard: a key it calls schema-free comes back as the same object", () => {
    const send = createSender(c, "outbound");
    const msg = { status: 204 as const };
    expect(send.checksKey(204)).toBe(false);
    expect(send(msg)).toBe(msg);
  });
});

describe("HTTP's model at runtime (C19)", () => {
  const User = z.object({ id: z.string() });
  const route = http.contract({
    inbound: { params: z.object({ id: z.string() }) },
    outbound: {
      200: {
        body: { "application/json": User, "text/plain": z.string() },
        headers: z.object({ "x-rate-limit-remaining": z.coerce.number() }),
      },
      201: {
        headers: z.object({ location: z.string() }),
        body: { "application/json": User },
      },
      204: { body: null },
    },
  });
  const send = createSender(route, "outbound");
  const issues = (x: unknown) => (x instanceof ContractError ? x.issues : "ok");

  it("checks status, headers and the body by media type", () => {
    expect(
      issues(
        send({
          status: 200,
          headers: { "x-rate-limit-remaining": 3 },
          body: { mediaType: "text/plain", value: "u1" },
        }),
      ),
    ).toBe("ok");
    expect(
      issues(
        send({
          status: 200,
          headers: { "x-rate-limit-remaining": 3 },
          body: { mediaType: "Text/Plain; charset=utf-8", value: "u1" },
        } as never),
      ),
    ).toBe("ok");
    expect(
      issues(
        send({
          status: 200,
          headers: { "x-rate-limit-remaining": 3 },
          body: { mediaType: "text/plain", value: 42 },
        } as never),
      ),
    ).toEqual([
      {
        target: "body",
        path: "",
        key: "200",
        mediaType: "text/plain",
        message: "Invalid input: expected string, received number",
      },
    ]);
    expect(
      issues(
        send({
          status: 200,
          headers: { "x-rate-limit-remaining": 3 },
          body: { mediaType: "text/html", value: "<p>" },
        } as never),
      ),
    ).toEqual([
      {
        target: "body",
        path: "",
        key: "200",
        message:
          "This media type is not declared (application/json, text/plain)",
      },
    ]);
    expect(
      issues(
        send({
          status: 201,
          headers: {},
          body: { mediaType: "application/json", value: { id: "1" } },
        } as never),
      ),
    ).toEqual([
      {
        target: "headers",
        path: "location",
        key: "201",
        message: "Invalid input: expected string, received undefined",
      },
    ]);
    expect(
      issues(
        send({
          status: 204,
          body: { mediaType: "application/json", value: {} },
        } as never),
      ),
    ).toEqual([
      {
        target: "body",
        path: "",
        key: "204",
        message: "No body is declared here",
      },
    ]);
    expect(issues(send({ status: 418 } as never))).toEqual([
      {
        target: "status",
        path: "",
        message: "This status is not declared (200, 201, 204)",
      },
    ]);
  });

  it("a client receiver parses a response, coercing a header", () => {
    const parsed = createReceiver(
      route,
      "outbound",
    )({
      status: 200,
      headers: { "x-rate-limit-remaining": "7" },
      body: { mediaType: "application/json", value: { id: "u1" } },
    });
    expect(parsed).toEqual({
      status: 200,
      headers: { "x-rate-limit-remaining": 7 },
      body: { mediaType: "application/json", value: { id: "u1" } },
    });
  });
});

describe("carrying a contract (C20, M5)", () => {
  const route = http.contract({
    inbound: { query: z.object({ q: z.string() }) },
  });

  it("attachContract makes it reachable, non-enumerably, and replaceable", () => {
    const handler = attachContract(() => undefined, route);
    expect(getContract(handler)).toBe(route);
    expect(Object.keys(handler)).toEqual([]);
    const other = http.contract({});
    attachContract(handler, other);
    expect<unknown>(getContract(handler)).toBe(other);
  });

  it("getContract is undefined for anything without one, primitives included", () => {
    for (const x of [undefined, null, 1, "s", {}, () => undefined]) {
      expect(getContract(x)).toBeUndefined();
    }
  });

  it("forwardContract copies a wrapped handler's contract onto its wrapper", () => {
    const inner = attachContract((_req: unknown) => undefined, route);
    const wrapper = (req: unknown) => inner(req);
    expect(getContract(wrapper)).toBeUndefined(); // the negative control: a wrapper hides it
    expect(getContract(forwardContract(wrapper, inner))).toBe(route);
    const bare = () => undefined;
    expect(getContract(forwardContract(bare, () => undefined))).toBeUndefined();
  });

  it("survives a framework's metadata-copying handler wrap (NestJS's copyMetadataToCallback)", () => {
    // reflect-metadata is imported by this file, so the polyfill is up.
    const handler = attachContract(() => undefined, route);
    // Exactly NestJS's copy: every metadata key, onto the wrapper.
    const wrapper = () => undefined;
    for (const key of Reflect.getMetadataKeys(handler)) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, handler), wrapper);
    }
    expect(getContract(wrapper)).toBe(route);
  });
});

describe("an in-process broker on the core (C7–C9)", () => {
  const topics = {
    orders: {
      payload: z.object({ id: z.string(), total: z.coerce.number() }),
      key: z.string(),
      headers: z.object({ "trace-id": z.string() }),
    },
    audit: {},
    slow: { payload: yup.object({ id: yup.string().required() }) },
  } as const;
  const c = broker.contract({ inbound: topics, outbound: topics });
  const check = createSender(c, "outbound");
  const parse = createReceiver(c, "inbound");
  const delivered: unknown[] = [];
  /** Delivers a parsed record, or hands back the refusal. */
  const deliver = (parsed: unknown) => {
    if (parsed instanceof ContractError) return parsed;
    delivered.push(parsed);
    return 1;
  };
  /** Checks a record as the producer, then parses it as the consumer. */
  const afterCheck = (checked: unknown) =>
    checked instanceof ContractError
      ? checked
      : andThen(parse(checked), deliver);
  const publish = (record: unknown) =>
    andThen(check(record as never), afterCheck);

  it("answers synchronously for zod, with the consumer seeing outputs", () => {
    const r = publish({
      topic: "orders",
      payload: { id: "o1", total: "12" },
      key: "o1",
      headers: { "trace-id": "t" },
    });
    expect(r).toBe(1);
    expect(
      (delivered.at(-1) as { payload: { total: unknown } }).payload.total,
    ).toBe(12);
  });

  it("refuses an invalid record synchronously and delivers nothing", () => {
    const before = delivered.length;
    const r = publish({
      topic: "orders",
      payload: { id: "o2", total: "abc" },
      key: "o2",
      headers: { "trace-id": "t" },
    });
    expect(r).toBeInstanceOf(ContractError);
    expect(delivered.length).toBe(before);
  });

  it("answers a yup topic with a Promise, and a schema-less one synchronously", async () => {
    const slow = publish({ topic: "slow", payload: { id: "s1" } });
    expect(slow).toBeInstanceOf(Promise);
    expect(await slow).toBe(1);
    expect(publish({ topic: "audit" })).toBe(1);
  });
});

describe("a flow (C21)", () => {
  const ocr = jobs.contract({
    inbound: { data: z.object({ url: z.string() }) },
    outbound: { result: z.object({ text: z.string() }) },
  });
  const resize = jobs.contract({
    inbound: { data: z.object({ url: z.string() }) },
    outbound: { result: z.object({ width: z.number() }) },
  });
  const publish = flow({
    data: z.object({ docId: z.string() }),
    result: z.object({ ok: z.boolean() }),
    children: { ocr, resize },
  });
  const recv = createReceiver(publish, "inbound");

  it("checks each child's result against the child's own contract", () => {
    expect(
      recv({
        data: { docId: "d1" },
        children: { ocr: { text: "hi" }, resize: { width: 640 } },
      }),
    ).toEqual({
      data: { docId: "d1" },
      children: { ocr: { text: "hi" }, resize: { width: 640 } },
    });
    const bad = recv({
      data: { docId: "d1" },
      children: { ocr: { text: 42 }, resize: { width: 640 } },
    });
    expect((bad as ContractError).issues).toEqual([
      {
        target: "children",
        path: "ocr.text",
        message: "Invalid input: expected string, received number",
      },
    ]);
  });
});
