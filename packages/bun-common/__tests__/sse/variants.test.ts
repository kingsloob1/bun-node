/**
 * Per-event variants on server-sent events (bun-validate V11, the SSE side
 * of plan §4.4.6): `sseVariants()`, an event declared as several whole
 * variants, chosen per event. Each behaviour with the case that would fail
 * without it:
 *
 * - the declaration: its `TypeError`s, the union it is as a Standard Schema
 *   (what a client checks with), and `describeContract`'s variant rows;
 * - the writer: the first applicable variant taken; `variant` narrowing
 *   the check (and never sent); `when` on the request, asked once per
 *   stream; the leak's diagnosis (with its negative control: the same
 *   event sent where the variant applies); `"warn"` and `"off"`; a failed
 *   `when`; an asynchronous `when` and vendor keeping the order;
 * - `res.sse()` and `sseResponse()` handing `when` the request;
 * - the response gate (`validate()`'s `responses`), checking the stream's
 *   events by the same rules, `when` on `req.valid`;
 * - the documents: OpenAPI's `x-sse-events` and AsyncAPI's messages.
 */
import type { LogEvent } from "../../lib/logging";
import { describe, expect, it } from "bun:test";
import * as yup from "yup";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import { describeContract } from "../../lib/contract/describe";
import { ContractError, createSender } from "../../lib/contract/guard";
import { nestedOf } from "../../lib/contract/schemas";
import { generateAsyncApi } from "../../lib/docs/asyncapi";
import { generateOpenApi } from "../../lib/docs/openapi";
import { createTestLogger } from "../../lib/logging";
import { sse, sseVariants } from "../../lib/responseBodies";
import { SseParser, sseResponse, SseWriter } from "../../lib/sse";

const decoder = new TextDecoder();

/** Reads a writer's body until it ends, or `ms` pass (then cancels). */
async function readAll(
  readable: ReadableStream<Uint8Array>,
  ms = 2000,
): Promise<{ text: string; ended: "done" | "error" | "timeout" }> {
  const reader = readable.getReader();
  let text = "";
  const deadline = Date.now() + ms;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      reader.read().then(
        (r) => r,
        () => "error" as const,
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(
          resolve,
          Math.max(0, deadline - Date.now()),
          "timeout",
        );
      }),
    ]);
    clearTimeout(timer);
    if (next === "timeout") {
      await reader.cancel().catch(() => undefined);
      return { text, ended: "timeout" };
    }
    if (next === "error") return { text, ended: "error" };
    if (next.done) return { text, ended: "done" };
    text += decoder.decode(next.value, { stream: true });
  }
}

/** The events the standard parser dispatches from `text`, as `[event, data]`. */
function eventsOf(text: string): [string, string][] {
  return new SseParser()
    .push(text)
    .filter((item) => item.kind === "event")
    .map((item) => {
      const event = item as { event: string; data: string };
      return [event.event, event.data];
    });
}

const AdminTick = z.strictObject({
  n: z.number(),
  secret: z.string(),
});
const UserTick = z.strictObject({ n: z.number() });

/** `admin` applies when the stream's request parsed `x-admin: 1`; `user` always. */
function adminWhen(valid: { headers?: { "x-admin"?: string } }): boolean {
  return valid.headers?.["x-admin"] === "1";
}

const Ticks = sse({
  tick: sseVariants({
    admin: {
      when: adminWhen,
      data: AdminTick,
      description: "Sent to administrators",
    },
    user: { data: UserTick },
  }),
  done: null,
});

const ADMIN = { headers: { "x-admin": "1" } };

/** A writer for `Ticks`, no heartbeat or opening comment. */
function writer(
  options: Partial<
    ConstructorParameters<typeof SseWriter<typeof Ticks>>[0]
  > = {},
) {
  return new SseWriter<typeof Ticks>({
    contract: Ticks,
    heartbeatMs: 0,
    open: false,
    ...options,
  });
}

/** The `ContractError` a call throws (or its promise rejects with). */
async function refusal(call: () => unknown): Promise<ContractError> {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    return error as ContractError;
  }
  throw new Error("expected a refusal");
}

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

describe("sseVariants(): the declaration", () => {
  it("refuses declaration mistakes with a TypeError", () => {
    const bad: unknown[] = [
      null,
      [],
      {},
      { a: null },
      { a: {} },
      { a: { data: "not a schema" } },
      { a: { data: UserTick, when: true } },
      { a: { data: UserTick, description: 1 } },
      { a: { data: UserTick, by: { header: "x" } } },
    ];
    for (const table of bad) {
      expect(() => sseVariants(table as never)).toThrow(TypeError);
    }
    // Negative control: a well-formed table.
    expect(() => sseVariants({ a: { data: UserTick } })).not.toThrow();
  });

  it("is a Standard Schema of the union: any variant's data passes, `when` aside", async () => {
    const set = Ticks.events.tick;
    const std = set["~standard"];
    expect(std.validate({ n: 1 })).toEqual({ value: { n: 1 } });
    expect(std.validate({ n: 1, secret: "s" })).toEqual({
      value: { n: 1, secret: "s" },
    });
    const refused = std.validate({ n: "x" }) as {
      issues: { message: string }[];
    };
    expect(refused.issues[0].message).toBe("Matches no variant (admin, user)");
    expect(refused.issues.slice(1).map((i) => i.message.split(":")[0])).toEqual(
      ['Variant "admin"', 'Variant "admin"', 'Variant "user"'],
    );
    // An asynchronous vendor: a Promise, settled the same way.
    const async = sseVariants({
      a: { data: yup.object({ n: yup.number().required() }) },
    })["~standard"].validate({});
    expect(async).toBeInstanceOf(Promise);
    expect(((await async) as { issues?: unknown }).issues).toBeDefined();
  });

  it("describeContract lists one row per variant, and the variants table", () => {
    const nested = nestedOf(Ticks)!;
    const described = describeContract(nested);
    const rows = described.entries.filter((e) => e.key === "tick");
    expect(rows.map((r) => [r.part, r.variant])).toEqual([
      ["data", "admin"],
      ["data", "user"],
    ]);
    expect(rows[0].schema).toBe(AdminTick);
    expect(described.sides.outbound?.variants).toEqual({
      tick: {
        names: ["admin", "user"],
        conditional: ["admin"],
        descriptions: { admin: "Sent to administrators" },
      },
    });
    // The core's guards refuse a key with variants: why the writer compiles its own.
    expect(() => createSender(nested, "outbound")).toThrow(/variants/);
  });

  it("an sse() without variants is described exactly as before", () => {
    const plain = describeContract(nestedOf(sse({ tick: UserTick }))!);
    expect(plain.entries.some((e) => e.variant !== undefined)).toBe(false);
    expect(plain.sides.outbound?.variants).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

describe("SseWriter with an sseVariants() event", () => {
  it("takes the first variant that applies and passes; `variant` is never sent", async () => {
    const w = writer({ valid: ADMIN });
    await w.send({ event: "tick", data: { n: 1, secret: "s" } });
    await w.send({ event: "tick", data: { n: 2 } });
    await w.send({
      event: "tick",
      variant: "admin",
      data: { n: 3, secret: "t" },
    });
    await w.send({ event: "done" });
    w.close();
    const { text } = await readAll(w.readable);
    expect(text).not.toContain("variant");
    expect(eventsOf(text)).toEqual([
      ["tick", '{"n":1,"secret":"s"}'],
      ["tick", '{"n":2}'],
      ["tick", '{"n":3,"secret":"t"}'],
      ["done", ""],
    ]);
  });

  it("refuses data no acceptable variant matches, with each variant's issues tagged", async () => {
    const w = writer({ valid: ADMIN });
    const error = await refusal(() =>
      w.send({ event: "tick", data: { n: "x" } as never }),
    );
    expect(error.context).toMatchObject({ transport: "sse", key: "tick" });
    expect(error.issues[0]).toMatchObject({
      target: "event",
      key: "tick",
      message: "The event matches no acceptable variant (admin, user)",
    });
    expect(error.issues[0].variant).toBeUndefined();
    expect(new Set(error.issues.slice(1).map((i) => i.variant))).toEqual(
      new Set(["admin", "user"]),
    );
    expect(error.issues.slice(1).every((i) => i.target === "data")).toBe(true);
    w.close();
    expect((await readAll(w.readable)).text).toBe("");
  });

  it("the leak: data only an excluded variant matches is refused and named; sent where it applies (control)", async () => {
    const leak = { event: "tick", data: { n: 1, secret: "LEAK" } } as const;
    const user = writer({ valid: {} });
    const error = await refusal(() => user.send(leak));
    expect(error.issues.map((i) => i.message)).toContain(
      'The event matches variant "admin", which does not apply to this request',
    );
    expect(JSON.stringify(error.issues)).not.toContain("LEAK");
    expect(error.message).not.toContain("LEAK");
    user.close();
    expect((await readAll(user.readable)).text).toBe("");

    // Negative control: the same event on an admin's stream is sent.
    const admin = writer({ valid: ADMIN });
    await admin.send(leak);
    admin.close();
    expect(eventsOf((await readAll(admin.readable)).text)).toHaveLength(1);
  });

  it("a named variant is the only one checked, and must apply", async () => {
    const w = writer({ valid: {} });
    // Data the user variant would take, but admin was named.
    const named = await refusal(() =>
      w.send({ event: "tick", variant: "admin", data: { n: 1 } as never }),
    );
    expect(named.issues).toEqual([
      {
        target: "event",
        message:
          'Variant "admin" (named by send()) does not apply to this request',
        path: "",
        key: "tick",
        variant: "admin",
      },
    ]);
    const unknown = await refusal(() =>
      w.send({ event: "tick", variant: "other" as never, data: { n: 1 } }),
    );
    expect(unknown.issues[0].message).toBe(
      'variant("other") is not declared (admin, user)',
    );
    // A strict user view refuses the admin's field even when named.
    const strict = await refusal(() =>
      w.send({
        event: "tick",
        variant: "user",
        data: { n: 1, secret: "s" } as never,
      }),
    );
    expect(strict.issues[0].message).toBe(
      "The event matches no acceptable variant (user)",
    );
    expect(strict.issues.slice(1).every((i) => i.variant === "user")).toBe(
      true,
    );
    // A variant on an event that declares none.
    const none = await refusal(() =>
      w.send({ event: "done", variant: "user" } as never),
    );
    expect(none.issues[0].message).toMatch(/this event declares none/);
    w.close();
  });

  it("asks each `when` once per stream, with valid and the request; a shared `when` once", async () => {
    const calls: unknown[][] = [];
    const when = (valid: unknown, req: unknown): boolean => {
      calls.push([valid, req]);
      return true;
    };
    const Two = sse({
      a: sseVariants({ x: { when, data: UserTick }, y: { data: AdminTick } }),
      b: sseVariants({ x: { when, data: UserTick } }),
    });
    const request = { id: "the request" };
    const w = new SseWriter({
      contract: Two,
      heartbeatMs: 0,
      valid: ADMIN,
      request,
    });
    for (let n = 0; n < 3; n++) {
      await w.send({ event: "a", data: { n } });
      await w.send({ event: "b", data: { n } });
    }
    expect(calls).toEqual([[ADMIN, request]]);
    // A second stream asks again.
    const again = new SseWriter({ contract: Two, heartbeatMs: 0 });
    await again.send({ event: "a", data: { n: 1 } });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([{}, undefined]);
    w.close();
    again.close();
  });

  it("an asynchronous `when` and vendor keep the events' order", async () => {
    const Slow = sse({
      tick: sseVariants({
        a: {
          when: async () => {
            await Bun.sleep(20);
            return true;
          },
          data: yup.object({ n: yup.number().required() }),
        },
      }),
      plain: z.number(),
    });
    const w = new SseWriter({ contract: Slow, heartbeatMs: 0, open: false });
    const sent = [
      w.send({ event: "tick", data: { n: 1 } }),
      w.send({ event: "plain", data: 2 }),
      w.send({ event: "tick", data: { n: 3 } }),
    ];
    await Promise.all(sent);
    const refused = w.send({ event: "tick", data: {} as never });
    await expect(refused).rejects.toBeInstanceOf(ContractError);
    w.close();
    expect(eventsOf((await readAll(w.readable)).text)).toEqual([
      ["tick", '{"n":1}'],
      ["plain", "2"],
      ["tick", '{"n":3}'],
    ]);
  });

  it("a failed `when` fails the check: thrown under error, logged and sent under warn", async () => {
    const boom = new Error("when failed");
    const make = (when: () => unknown) =>
      sse({
        tick: sseVariants({
          a: { when: when as () => boolean, data: UserTick },
        }),
      });
    const thrower = new SseWriter({
      contract: make(() => {
        throw boom;
      }),
      heartbeatMs: 0,
    });
    expect(() => thrower.send({ event: "tick", data: { n: 1 } })).toThrow(boom);
    // Kept for the stream: the next event fails the same way.
    expect(() => thrower.send({ event: "tick", data: { n: 1 } })).toThrow(boom);
    thrower.close();

    const nonBoolean = new SseWriter({
      contract: make(() => "yes"),
      heartbeatMs: 0,
    });
    expect(() => nonBoolean.send({ event: "tick", data: { n: 1 } })).toThrow(
      /when must return a boolean/,
    );
    nonBoolean.close();

    const rejecting = new SseWriter({
      contract: make(async () => Promise.reject(boom)),
      heartbeatMs: 0,
    });
    await expect(
      rejecting.send({ event: "tick", data: { n: 1 } }),
    ).rejects.toBe(boom);
    rejecting.close();

    const { logger, events } = createTestLogger();
    const warn = new SseWriter({
      contract: make(() => {
        throw boom;
      }),
      heartbeatMs: 0,
      open: false,
      validation: "warn",
      logger,
    });
    await warn.send({ event: "tick", data: { n: 1 } });
    warn.close();
    expect(eventsOf((await readAll(warn.readable)).text)).toHaveLength(1);
    expect(events.map((e: LogEvent) => e.level)).toEqual(["error"]);
  });

  it('"warn" logs a mismatch (no value) and sends it; "off" checks nothing and asks no `when`', async () => {
    const { logger, events } = createTestLogger();
    const warned = writer({ validation: "warn", logger, valid: {} });
    await warned.send({ event: "tick", data: { n: 1, secret: "LEAK" } });
    warned.close();
    expect(eventsOf((await readAll(warned.readable)).text)).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe("warn");
    expect(JSON.stringify(events)).toContain("does not apply");
    expect(JSON.stringify(events)).not.toContain("LEAK");

    let asked = 0;
    const off = new SseWriter({
      contract: sse({
        tick: sseVariants({
          a: {
            when: () => {
              asked++;
              return false;
            },
            data: UserTick,
          },
        }),
      }),
      validation: "off",
      heartbeatMs: 0,
      open: false,
    });
    await off.send({ event: "tick", data: { n: "x" } as never });
    off.close();
    expect(eventsOf((await readAll(off.readable)).text)).toHaveLength(1);
    expect(asked).toBe(0);
  });

  it("checks replayed events too", async () => {
    const w = writer({
      lastEventId: "4",
      valid: {},
      resume: () => [{ event: "tick", data: { n: 1, secret: "s" } }],
    });
    w.send({ event: "tick", data: { n: 5 } }).catch(() => undefined);
    const { text, ended } = await readAll(w.readable, 500);
    // The replay is refused (admin does not apply), so the stream closes before the live event.
    expect(ended).toBe("done");
    expect(eventsOf(text)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// res.sse() and sseResponse(): the request reaches `when`
// ---------------------------------------------------------------------------

describe("the request that opened the stream reaches `when`", () => {
  it("res.sse() asks `when` with req.valid and req", async () => {
    const seen: unknown[] = [];
    const router = new BunRouter();
    router.get(
      "/ticks",
      validate({
        headers: z.object({ "x-admin": z.literal("1").optional() }),
      }),
      (req, res) => {
        const stream = res.sse({
          contract: sse({
            tick: sseVariants({
              admin: {
                when: (valid, r) => {
                  seen.push(r === req);
                  return adminWhen(valid as never);
                },
                data: AdminTick,
              },
              user: { data: UserTick },
            }),
          }),
          heartbeatMs: 0,
          open: false,
        });
        void (async () => {
          try {
            await stream.send({ event: "tick", data: { n: 1, secret: "s" } });
          } catch {
            await stream.send({ event: "tick", data: { n: 0 } });
          }
          stream.close();
        })();
      },
    );
    const admin = await router.fetch("/ticks", {
      headers: { "x-admin": "1" },
    });
    expect(eventsOf((await readAll(admin.body!)).text)).toEqual([
      ["tick", '{"n":1,"secret":"s"}'],
    ]);
    // Negative control: without the header the admin event is refused.
    const user = await router.fetch("/ticks");
    expect(eventsOf((await readAll(user.body!)).text)).toEqual([
      ["tick", '{"n":0}'],
    ]);
    expect(seen).toEqual([true, true]);
  });

  it("sseResponse() hands `when` its request, and `{}` as valid", async () => {
    const seen: unknown[][] = [];
    const request = new Request("http://localhost/ticks");
    const response = sseResponse([{ event: "tick", data: { n: 1 } }], {
      contract: sse({
        tick: sseVariants({
          a: {
            when: (valid, req) => {
              seen.push([valid, req]);
              return true;
            },
            data: UserTick,
          },
        }),
      }),
      request,
      heartbeatMs: 0,
      open: false,
    });
    await readAll(response.body!);
    expect(seen).toEqual([[{}, request]]);
  });
});

// ---------------------------------------------------------------------------
// The response gate
// ---------------------------------------------------------------------------

/** A route whose `responses` declare `Ticks`, writing `blocks` raw (an untyped writer). */
function gateRoute(mode: "warn" | "error", blocks: readonly string[]) {
  const { logger, events } = createTestLogger();
  const router = new BunRouter({ logger, responseValidation: mode });
  router.get(
    "/x",
    validate(
      { headers: z.object({ "x-admin": z.literal("1").optional() }) },
      { responses: { 200: { content: { "text/event-stream": Ticks } } } },
    ),
    async (_req, res) => {
      res.set("Content-Type", "text/event-stream");
      for (const block of blocks) res.write(block);
      await res.end();
    },
  );
  return { router, events };
}

describe("validate()'s response gate checks an sseVariants() event", () => {
  const leak = [
    'event: tick\ndata: {"n":1}\n\n',
    'event: tick\ndata: {"n":2,"secret":"LEAK"}\n\n',
  ];

  it("passes an event any applicable variant matches (when on req.valid)", async () => {
    const { router, events } = gateRoute("error", leak);
    const read = await readAll(
      (await router.fetch("/x", { headers: { "x-admin": "1" } })).body!,
    );
    expect(read.ended).toBe("done");
    expect(eventsOf(read.text)).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it("cuts the stream at an event only an excluded variant matches, naming it (no value)", async () => {
    const { router, events } = gateRoute("error", leak);
    const read = await readAll((await router.fetch("/x")).body!);
    expect(read.ended).toBe("error");
    expect(eventsOf(read.text)).toEqual([["tick", '{"n":1}']]);
    const logged = JSON.stringify(events);
    expect(logged).toContain(
      'The event matches variant \\"admin\\", which does not apply to this request',
    );
    expect(logged).not.toContain("LEAK");
  });

  it('"warn" sends it and logs once', async () => {
    const { router, events } = gateRoute("warn", leak);
    const read = await readAll((await router.fetch("/x")).body!);
    expect(read.ended).toBe("done");
    expect(eventsOf(read.text)).toHaveLength(2);
    expect(events.filter((e) => e.level === "warn")).toHaveLength(1);
  });

  it("refuses data no variant matches, each variant's issues tagged", async () => {
    const { router, events } = gateRoute("error", [
      ": open\n\n",
      'event: tick\ndata: {"n":"x"}\n\n',
    ]);
    const read = await readAll(
      (await router.fetch("/x", { headers: { "x-admin": "1" } })).body!,
    );
    expect(read.ended).toBe("error");
    const issues = (
      events[0]?.fields as {
        issues?: { variant?: string; path: string; message: string }[];
      }
    )?.issues;
    expect(issues?.[0]).toMatchObject({
      message: "The event matches no acceptable variant (admin, user)",
      path: "tick",
    });
    expect(new Set(issues?.slice(1).map((i) => i.variant))).toEqual(
      new Set(["admin", "user"]),
    );
    expect(issues?.slice(1).every((i) => i.path.startsWith("tick.data"))).toBe(
      true,
    );
  });

  it("a failed `when` is a failed check", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({ logger, responseValidation: "error" });
    router.get(
      "/x",
      validate(
        {},
        {
          responses: {
            200: {
              content: {
                "text/event-stream": sse({
                  tick: sseVariants({
                    a: {
                      when: () => {
                        throw new Error("boom");
                      },
                      data: UserTick,
                    },
                  }),
                }),
              },
            },
          },
        },
      ),
      async (_req, res) => {
        res.set("Content-Type", "text/event-stream");
        res.write(": open\n\n");
        res.write('event: tick\ndata: {"n":1}\n\n');
        await res.end();
      },
    );
    const read = await readAll((await router.fetch("/x")).body!);
    expect(read.ended).toBe("error");
    expect(events.some((e) => e.level === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

describe("documents", () => {
  /** A router serving `Ticks`. */
  function docsRouter(): BunRouter {
    const router = new BunRouter();
    router.get(
      "/ticks",
      validate(
        {},
        { responses: { 200: { content: { "text/event-stream": Ticks } } } },
      ),
      (_req, res) => res.send(new ReadableStream()),
    );
    return router;
  }

  it("OpenAPI: x-sse-events lists the event once, anyOf its variants, with x-variants", () => {
    const { document, warnings } = generateOpenApi(docsRouter(), {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    const schema = (
      (document.paths as Record<string, unknown>)["/ticks"] as {
        get: {
          responses: Record<
            string,
            { content: Record<string, { schema: Record<string, unknown> }> }
          >;
        };
      }
    ).get.responses["200"].content["text/event-stream"].schema;
    expect(schema.description).toContain("Events: `done`, `tick`.");
    const events = schema["x-sse-events"] as Record<
      string,
      { anyOf?: { properties: object }[]; "x-variants"?: unknown } | null
    >;
    expect(Object.keys(events)).toEqual(["done", "tick"]);
    expect(events.done).toBeNull();
    expect(
      events.tick?.anyOf?.map((s) => Object.keys(s.properties).sort()),
    ).toEqual([["n", "secret"], ["n"]]);
    expect(events.tick?.["x-variants"]).toEqual({
      names: ["admin", "user"],
      conditional: ["admin"],
      descriptions: { admin: "Sent to administrators" },
    });
  });

  it("AsyncAPI: one message per event, its payload anyOf the variants", () => {
    const { document, warnings } = generateAsyncApi(docsRouter(), {
      title: "T",
      version: "1",
    });
    expect(warnings).toEqual([]);
    const messages = Object.values(
      (document.channels as Record<
        string,
        { messages: Record<string, unknown> }
      >) ?? {},
    ).flatMap((channel) => Object.values(channel.messages));
    const resolved = messages.map((message) => {
      const ref = (message as { $ref?: string }).$ref;
      if (ref === undefined) return message;
      const name = ref.split("/").pop()!;
      return (document.components as { messages: Record<string, unknown> })
        .messages[name];
    }) as {
      name: string;
      payload?: { anyOf?: unknown[]; "x-variants"?: unknown };
    }[];
    expect(resolved.map((m) => m.name).sort()).toEqual(["done", "tick"]);
    const tick = resolved.find((m) => m.name === "tick")!;
    expect(tick.payload?.anyOf).toHaveLength(2);
    expect(tick.payload?.["x-variants"]).toMatchObject({
      names: ["admin", "user"],
    });
  });
});
