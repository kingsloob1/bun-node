/**
 * `responseOutput: "parsed"` (bun-validate V13, plan `docs/plans/bun-validate/`
 * §6 row 8a, Q5): a buffered JSON body that passes is sent as the schema's
 * output — unknown keys stripped, defaults and transforms applied — for every
 * response, per validator, router or adapter. Negative controls: the same
 * handlers with `"as-sent"` send the value the handler wrote; a body that
 * fails under `"warn"` goes as it is; streams and non-JSON bodies are out.
 */
import type { BunResponse } from "../lib/index";
import {
  BunRouter,
  chunks,
  createTestLogger,
  validate,
  variants,
} from "../lib/index";
import { describe, expect, it } from "bun:test";
import { z } from "zod";

/** A value no answer may keep. */
const SECRET = "hunter2-the-password";

/** `id` plus a defaulted `role`; zod strips an unknown key. */
const User = z.object({
  id: z.number(),
  role: z.string().default("user"),
});

/** A router with a `/user` route answering `{ id: 1, password: SECRET }`. */
function app(options?: {
  responseValidation?: "off" | "warn" | "error";
  responseOutput?: "as-sent" | "parsed";
  routerOutput?: "as-sent" | "parsed";
}) {
  const router = new BunRouter({
    logger: createTestLogger().logger,
    ...(options?.routerOutput === undefined
      ? {}
      : { responseOutput: options.routerOutput }),
  });
  router.get(
    "/user",
    validate(
      {},
      {
        responses: { 200: { content: { "application/json": User } } },
        responseValidation: options?.responseValidation ?? "error",
        ...(options?.responseOutput === undefined
          ? {}
          : { responseOutput: options.responseOutput }),
      },
    ),
    (_req, res) => {
      res.json({ id: 1, password: SECRET });
    },
  );
  return router;
}

/** The parsed body of `router`'s answer to GET /user. */
async function bodyOf(router: BunRouter, path = "/user"): Promise<unknown> {
  const response = await router.fetch(path);
  return response.json();
}

describe('responseOutput: "parsed" (V13)', () => {
  it("sends the schema's output: an unknown key stripped, a default applied", async () => {
    expect(await bodyOf(app({ responseOutput: "parsed" }))).toEqual({
      id: 1,
      role: "user",
    });
  });

  it('"as-sent" (the default) sends what the handler wrote (the control)', async () => {
    expect(await bodyOf(app({ responseOutput: "as-sent" }))).toEqual({
      id: 1,
      password: SECRET,
    });
    expect(await bodyOf(app())).toEqual({ id: 1, password: SECRET });
  });

  it('"warn": a failing body goes as it is (and warns); a passing one is parsed', async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({ logger });
    router.get(
      "/bad",
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": User } } },
          responseValidation: "warn",
          responseOutput: "parsed",
        },
      ),
      (_req, res) => {
        // The handler's typed res would refuse this at compile time (that is
        // the types doing their job); the test needs the runtime path.
        (res as BunResponse).json({ id: "x", password: SECRET });
      },
    );
    router.get(
      "/good",
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": User } } },
          responseValidation: "warn",
          responseOutput: "parsed",
        },
      ),
      (_req, res) => {
        res.json({ id: 1, password: SECRET });
      },
    );
    // The failing one is sent as written (not parsed), one warn, no value.
    const bad = await router.fetch("/bad");
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ id: "x", password: SECRET });
    const warned = events.filter((event) => event.level === "warn");
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned)).not.toContain(SECRET);
    // The passing one is parsed.
    expect(await (await router.fetch("/good")).json()).toEqual({
      id: 1,
      role: "user",
    });
  });

  it('"off": a passing body is still parsed; a failing one goes as it is, unreported', async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({ logger });
    router.get(
      "/user",
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": User } } },
          responseValidation: "off",
          responseOutput: "parsed",
        },
      ),
      (_req, res) => {
        res.json({ id: 1, password: SECRET });
      },
    );
    expect(await bodyOf(router)).toEqual({ id: 1, role: "user" });
    expect(events).toHaveLength(0);
  });

  it("a coercion's output goes on the wire (the wire type is the output's)", async () => {
    const Coerced = z.object({ n: z.coerce.number() });
    const router = new BunRouter();
    router.get(
      "/n",
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": Coerced } } },
          responseValidation: "error",
          responseOutput: "parsed",
        },
      ),
      (_req, res) => {
        // Same: the wire-input typing wants a number; the test sends the
        // string to see the coercion land on the wire.
        (res as BunResponse).json({ n: "42" });
      },
    );
    expect(await bodyOf(router, "/n")).toEqual({ n: 42 });
  });

  it("a non-JSON body is never parsed", async () => {
    const router = new BunRouter();
    router.get(
      "/text",
      validate(
        {},
        {
          responses: {
            200: {
              content: {
                "text/plain": z
                  .string()
                  .transform((value) => value.toUpperCase()),
              },
            },
          },
          responseValidation: "error",
          responseOutput: "parsed",
        },
      ),
      (_req, res) => {
        res.send("plain answer");
      },
    );
    const response = await router.fetch("/text");
    expect(await response.text()).toBe("plain answer");
  });

  it("a streamed body is never parsed", async () => {
    const router = new BunRouter();
    router.get(
      "/stream",
      validate(
        {},
        {
          responses: {
            200: {
              content: {
                "application/x-ndjson": chunks(z.object({ n: z.number() }), {
                  framing: "ndjson",
                }),
              },
            },
          },
          responseValidation: "error",
          responseOutput: "parsed",
        },
      ),
      (_req, res) => {
        res.set("content-type", "application/x-ndjson");
        res.send(
          new ReadableStream({
            start(controller) {
              controller.enqueue('{"n":1}\n');
              controller.enqueue('{"n":2}\n');
              controller.close();
            },
          }),
        );
      },
    );
    const response = await router.fetch("/stream");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"n":1}\n{"n":2}\n');
  });

  it("a variant's body is adjusted, then parsed: the literal filled, the default applied, the rest stripped", async () => {
    const Packed = z.object({
      kind: z.literal("packed"),
      id: z.number(),
      tier: z.string().default("free"),
    });
    const router = new BunRouter();
    router.get(
      "/packed",
      validate(
        {},
        {
          responses: {
            200: variants({
              packed: { content: { "application/json": Packed } },
            }),
          },
          responseValidation: "error",
          responseOutput: "parsed",
        },
      ),
      (_req, res) => {
        res.status(200).variant("packed").json({ id: 1, password: SECRET });
      },
    );
    expect(await bodyOf(router, "/packed")).toEqual({
      kind: "packed",
      id: 1,
      tier: "free",
    });
  });

  it("the router's `responseOutput` applies to a validator without its own, and the validator's wins", async () => {
    const router = new BunRouter({ responseOutput: "parsed" });
    router.get(
      "/user",
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": User } } },
          responseValidation: "error",
        },
      ),
      (_req, res) => {
        res.json({ id: 1, password: SECRET });
      },
    );
    router.get(
      "/asis",
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": User } } },
          responseValidation: "error",
          responseOutput: "as-sent",
        },
      ),
      (_req, res) => {
        res.json({ id: 1, password: SECRET });
      },
    );
    expect(await bodyOf(router)).toEqual({ id: 1, role: "user" });
    expect(await (await router.fetch("/asis")).json()).toEqual({
      id: 1,
      password: SECRET,
    });
  });

  it("a bad value is a TypeError, on validate() and on the router", () => {
    expect(() =>
      validate(
        {},
        {
          responses: { 200: User },
          responseOutput: "sometimes" as never,
        },
      ),
    ).toThrow(TypeError);
    expect(
      () => new BunRouter({ responseOutput: "sometimes" as never }),
    ).toThrow(TypeError);
  });
});
